from __future__ import annotations

import json
import unittest
from io import BytesIO

from agent_feedback import (
    AgentFeedbackASGI,
    AgentFeedbackWSGI,
    AgentFeedback,
    AgentFeedbackOptions,
    feedback_consent_action,
    feedback_from_response,
    sign_capability,
    submit_feedback_consent,
    submit_product_feedback,
)

KEY = "af_live_0123456789abcdef0123456789abcdef_conformance_secret_0123456789abcdef"
TOKEN = "afr2_0123456789abcdef0123456789abcdef.eyJ2IjoxLCJpIjoiMDE4ZjFmMmUtN2I0YS03YzEyLTljOGQtMTIzNDU2Nzg5YWJjIiwiaWF0IjoxNzE1MDAwMDAwLCJleHAiOjE3MTUwMDcyMDAsIm4iOiJBUUlEQkFVR0J3Z0pDZ3NNRFE0UEVCRVMifQ.wxJ0YGS21x9eW-Cn33t9V1INhyGNj1_U3qoQns3vdWA"


class AgentFeedbackTests(unittest.IsolatedAsyncioTestCase):
    def test_legacy_auto_mode_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "never_ask, ask_once, ask_always, or off"):
            AgentFeedback(AgentFeedbackOptions(api_key=KEY, feedback_mode="auto"))

    def test_capability_conformance(self) -> None:
        claims = {
            "v": 1,
            "i": "018f1f2e-7b4a-7c12-9c8d-123456789abc",
            "iat": 1715000000,
            "exp": 1715007200,
            "n": "AQIDBAUGBwgJCgsMDQ4PEBES",
        }
        self.assertEqual(sign_capability(KEY, claims), TOKEN)

    async def test_asgi_json_shape_and_nonblocking_telemetry(self) -> None:
        telemetry: list[dict] = []

        def sender(_url: str, _headers: dict[str, str], body: bytes) -> None:
            telemetry.append(json.loads(body))

        async def app(_scope, _receive, send):
            body = json.dumps({"answer": "available"}).encode()
            await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})

        middleware = AgentFeedbackASGI(app, api_key=KEY, endpoint="https://feedback.test", include=("/status",), sender=sender)
        sent: list[dict] = []

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message):
            sent.append(message)

        await middleware({"type": "http", "method": "GET", "path": "/status"}, receive, send)
        payload = json.loads(sent[1]["body"])
        self.assertEqual(payload["answer"], "available")
        self.assertEqual(payload["_agentFeedback"]["reliability"], "best_effort_without_agent_adapter")
        middleware.shutdown()
        self.assertEqual(telemetry[0]["events"][0]["classification"], "unclassified")
        self.assertEqual(telemetry[0]["events"][0]["sequence"], 1)

    async def test_asgi_without_feedback_envelope_preserves_body_and_content_length(self) -> None:
        original = b'{ "answer": "available" }'

        async def app(_scope, _receive, send):
            await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(original)).encode())]})
            await send({"type": "http.response.body", "body": original})

        middleware = AgentFeedbackASGI(app, api_key=KEY, endpoint="https://feedback.test", include=("/status",), feedback_mode="ask_once", customer_ref=lambda _scope: "declined-customer", sender=lambda *_: None)
        middleware.runtime.resolve_consent = lambda _customer_ref: "declined"
        sent: list[dict] = []

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message):
            sent.append(message)

        await middleware({"type": "http", "method": "GET", "path": "/status"}, receive, send)
        self.assertEqual(sent[1]["body"], original)
        self.assertEqual(dict(sent[0]["headers"])[b"content-length"], str(len(original)).encode())
        middleware.shutdown()

    def test_telemetry_retries_transient_delivery_without_changing_event(self) -> None:
        attempts = 0
        delivered: list[dict] = []

        def sender(_url: str, _headers: dict[str, str], body: bytes) -> None:
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                raise TimeoutError("temporarily unavailable")
            delivered.append(json.loads(body))

        runtime = AgentFeedback(AgentFeedbackOptions(
            api_key=KEY,
            endpoint="https://feedback.test",
            flush_interval=3600,
            sender=sender,
        ))
        prepared = runtime.prepare()
        runtime.record(
            prepared,
            surface="http_json",
            operation="/search",
            status_code=200,
            duration_ms=1,
        )
        runtime.shutdown()
        self.assertEqual(attempts, 3)
        self.assertEqual(delivered[0]["events"][0]["interactionId"], prepared["interactionId"])
        self.assertEqual(delivered[0]["events"][0]["sequence"], 1)

    def test_wsgi_safe_header_fallback(self) -> None:
        def app(_environ, start_response):
            body = b'["available"]'
            start_response("200 OK", [("Content-Type", "application/json"), ("Content-Length", str(len(body)))])
            return [body]

        middleware = AgentFeedbackWSGI(app, api_key=KEY, endpoint="https://feedback.test", include=("/status",), sender=lambda *_: None)
        captured: dict = {}
        result = middleware(
            {"PATH_INFO": "/status", "REQUEST_METHOD": "GET", "wsgi.input": BytesIO()},
            lambda status, headers, _exc=None: captured.update(status=status, headers=headers),
        )
        self.assertEqual(b"".join(result), b'["available"]')
        header = dict(captured["headers"])["Agent-Feedback"]
        self.assertIsNotNone(feedback_from_response({"Agent-Feedback": header}, ["available"]))
        middleware.shutdown()

    def test_wsgi_injects_buffered_json_and_html_iterables(self) -> None:
        class ClosingBody:
            def __init__(self, body: bytes):
                self.body = body

            def __iter__(self):
                yield self.body

            def close(self):
                pass

        for content_type, original in (
            ("application/json", b'{"answer":"available"}'),
            ("text/html; charset=utf-8", b"<!doctype html><html><head></head><body>available</body></html>"),
        ):
            def app(_environ, start_response):
                start_response("200 OK", [("Content-Type", content_type), ("Content-Length", str(len(original)))])
                return ClosingBody(original)

            middleware = AgentFeedbackWSGI(app, api_key=KEY, endpoint="https://feedback.test", include=("/status",), sender=lambda *_: None)
            captured: dict = {}
            result = middleware(
                {"PATH_INFO": "/status", "REQUEST_METHOD": "GET", "wsgi.input": BytesIO()},
                lambda status, headers, _exc=None: captured.update(status=status, headers=headers),
            )
            output = b"".join(result)
            if content_type.startswith("application/json"):
                self.assertIn("_agentFeedback", json.loads(output))
            else:
                self.assertIn(b'id="agent-feedback"', output)
            self.assertEqual(int(dict(captured["headers"])["Content-Length"]), len(output))
            middleware.shutdown()

    def test_wsgi_without_feedback_envelope_preserves_body_and_content_length(self) -> None:
        original = b'{ "answer": "available" }'

        def app(_environ, start_response):
            start_response("200 OK", [("Content-Type", "application/json"), ("Content-Length", str(len(original)))])
            return [original]

        middleware = AgentFeedbackWSGI(app, api_key=KEY, endpoint="https://feedback.test", include=("/status",), feedback_mode="ask_once", customer_ref=lambda _environ: "declined-customer", sender=lambda *_: None)
        middleware.runtime.resolve_consent = lambda _customer_ref: "declined"
        captured: dict = {}
        output = b"".join(middleware(
            {"PATH_INFO": "/status", "REQUEST_METHOD": "GET", "wsgi.input": BytesIO()},
            lambda status, headers, _exc=None: captured.update(status=status, headers=headers),
        ))
        self.assertEqual(output, original)
        self.assertEqual(int(dict(captured["headers"])["Content-Length"]), len(original))
        middleware.shutdown()

    def test_agent_helper_allowlists_destination_and_sends_compact_body(self) -> None:
        envelope = {
            "v": 1,
            "mode": "never_ask",
            "state": "feedback_ready",
            "requested": True,
            "consentRequired": False,
            "consentPolicy": "none",
            "when": "after_experience_known_before_final_response",
            "submit": {
                "url": "https://feedback.test/api/v2/reports",
                "method": "POST",
                "authorization": "Bearer afr2_test.payload.signature",
                "contentType": "application/json",
            },
        }
        sent: list[dict] = []

        def sender(_url, _headers, body):
            sent.append(json.loads(body))
            return {"accepted": True}

        result = submit_product_feedback(
            envelope,
            {
                "summary": "The product completed the task with one workaround.",
                "impact": "helped_with_friction",
                "findings": [{"kind": "friction", "topic": "pagination", "severity": "minor", "detail": "A second request was needed."}],
                "workaround": {"used": True, "detail": "The agent requested the next page."},
            },
            allowed_submit_origins=("https://feedback.test",),
            sender=sender,
        )
        self.assertTrue(result["accepted"])
        self.assertEqual(sent[0]["findings"][0]["topic"], "pagination")

    def test_ask_modes_have_distinct_consent_policies(self) -> None:
        runtime = AgentFeedback(AgentFeedbackOptions(
            api_key=KEY,
            endpoint="https://feedback.test",
            feedback_mode="ask_once",
        ))
        envelope = runtime.prepare()["envelope"]
        self.assertTrue(envelope["requested"])
        self.assertTrue(envelope["consentRequired"])
        self.assertEqual(envelope["consentPolicy"], "once")
        self.assertEqual(envelope["state"], "consent_required")
        self.assertEqual(envelope["consentManagedBy"], "epode")
        self.assertNotIn("submit", envelope)
        self.assertEqual(envelope["requiredAction"]["type"], "ask_user")
        self.assertEqual(envelope["when"], "after_experience_known_and_consent_resolved")
        self.assertTrue(envelope["instruction"].startswith("Ask the user exactly this question"))
        self.assertIn("Do not assume an answer", envelope["instruction"])
        self.assertEqual(feedback_consent_action(envelope), "ask")
        with self.assertRaisesRegex(ValueError, "Invalid Agent Feedback submission contract"):
            submit_product_feedback(
                envelope,
                {"summary": "The product completed the task.", "impact": "helped"},
                allowed_submit_origins=("https://feedback.test",),
                sender=lambda *_: {"accepted": True},
            )
        approved_envelope = AgentFeedback(AgentFeedbackOptions(api_key=KEY)).prepare()["envelope"]
        decision_body: list[dict] = []
        decision = submit_feedback_consent(
            envelope,
            "approved",
            allowed_submit_origins=("https://feedback.test",),
            sender=lambda _url, _headers, body: decision_body.append(json.loads(body)) or {"state": "approved", "feedback": approved_envelope},
        )
        self.assertEqual(decision_body[0], {"decision": "approved"})
        self.assertEqual(feedback_consent_action(decision["feedback"]), "submit")
        runtime.shutdown()

        always = AgentFeedback(AgentFeedbackOptions(
            api_key=KEY,
            endpoint="https://feedback.test",
            feedback_mode="ask_always",
        ))
        always_envelope = always.prepare()["envelope"]
        self.assertEqual(always_envelope["consentPolicy"], "always")
        self.assertNotIn("submit", always_envelope)
        self.assertEqual(feedback_consent_action(always_envelope), "ask")
        always.shutdown()

    def test_agent_helper_rejects_malformed_consent_contracts(self) -> None:
        runtime = AgentFeedback(AgentFeedbackOptions(api_key=KEY, feedback_mode="ask_always"))
        malformed = runtime.prepare()["envelope"]
        malformed["consentRequired"] = False
        self.assertIsNone(
            feedback_from_response({}, {"_agentFeedback": malformed})
        )
        self.assertEqual(feedback_consent_action(malformed), "skip")

        missing_action = runtime.prepare()["envelope"]
        missing_action.pop("requiredAction")
        self.assertEqual(feedback_consent_action(missing_action), "skip")
        runtime.shutdown()


if __name__ == "__main__":
    unittest.main()
