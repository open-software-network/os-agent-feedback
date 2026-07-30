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

    def test_agent_helper_allowlists_destination_and_sends_compact_body(self) -> None:
        envelope = {
            "v": 1,
            "mode": "never_ask",
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

    def test_session_label_requires_a_string_and_preserves_internal_whitespace(self) -> None:
        envelope = {
            "v": 1,
            "mode": "never_ask",
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
        for session_label in (True, 123, ["investigation"]):
            with self.assertRaisesRegex(ValueError, "sessionLabel must be a string"):
                submit_product_feedback(
                    envelope,
                    {"summary": "The product completed the task.", "sessionLabel": session_label},
                    allowed_submit_origins=("https://feedback.test",),
                    sender=lambda *_: {"accepted": True},
                )

        sent: list[dict] = []
        submit_product_feedback(
            envelope,
            {"summary": "The product completed the task.", "sessionLabel": "  Search  investigation  "},
            allowed_submit_origins=("https://feedback.test",),
            sender=lambda _url, _headers, body: sent.append(json.loads(body)) or {"accepted": True},
        )
        self.assertEqual(sent[0]["sessionLabel"], "Search  investigation")

    def test_ask_modes_have_distinct_consent_policies(self) -> None:
        runtime = AgentFeedback(AgentFeedbackOptions(
            api_key=KEY,
            endpoint="https://feedback.test",
            feedback_mode="ask_once",
        ))
        envelope = runtime.prepare()["envelope"]
        self.assertEqual(
            envelope["submit"]["reportSchema"]["optional"],
            ["sessionLabel", "impact", "confidence", "findings", "workaround", "consent"],
        )
        self.assertTrue(envelope["requested"])
        self.assertTrue(envelope["consentRequired"])
        self.assertEqual(envelope["consentPolicy"], "once")
        self.assertEqual(envelope["consentScope"], "afcs1_0123456789abcdef0123456789abcdef")
        self.assertEqual(envelope["when"], "after_experience_known_and_consent_resolved")
        self.assertIn("ask the user once", envelope["instruction"])
        self.assertIn("do not ask again", envelope["instruction"])
        self.assertEqual(feedback_consent_action(envelope), "ask")
        self.assertEqual(feedback_consent_action(envelope, "approved"), "submit")
        self.assertEqual(feedback_consent_action(envelope, "refused"), "skip")
        with self.assertRaisesRegex(ValueError, "Explicit user approval is required"):
            submit_product_feedback(
                envelope,
                {"summary": "The product completed the task.", "impact": "helped"},
                allowed_submit_origins=("https://feedback.test",),
                sender=lambda *_: {"accepted": True},
            )
        sent: list[dict] = []
        submit_product_feedback(
            envelope,
            {"summary": "The product completed the task.", "impact": "helped"},
            allowed_submit_origins=("https://feedback.test",),
            user_approved=True,
            approval_source="stored_grant",
            sender=lambda _url, _headers, body: sent.append(json.loads(body)) or {"accepted": True},
        )
        self.assertEqual(
            sent[0]["consent"],
            {
                "userApproved": True,
                "approvalSource": "stored_grant",
                "consentScope": envelope["consentScope"],
            },
        )
        runtime.shutdown()

        always = AgentFeedback(AgentFeedbackOptions(
            api_key=KEY,
            endpoint="https://feedback.test",
            feedback_mode="ask_always",
        ))
        always_envelope = always.prepare()["envelope"]
        self.assertEqual(always_envelope["consentPolicy"], "always")
        self.assertNotIn("consentScope", always_envelope)
        self.assertIn("every future report", always_envelope["instruction"])
        self.assertEqual(feedback_consent_action(always_envelope, "approved"), "ask")
        always_sent: list[dict] = []
        submit_product_feedback(
            always_envelope,
            {"summary": "The product completed the task.", "impact": "helped"},
            allowed_submit_origins=("https://feedback.test",),
            user_approved=True,
            approval_source="granted_now",
            sender=lambda _url, _headers, body: always_sent.append(json.loads(body)) or {"accepted": True},
        )
        self.assertEqual(
            always_sent[0]["consent"],
            {"userApproved": True, "approvalSource": "granted_now"},
        )
        always.shutdown()

    def test_agent_helper_rejects_malformed_consent_contracts(self) -> None:
        runtime = AgentFeedback(AgentFeedbackOptions(api_key=KEY, feedback_mode="ask_always"))
        malformed = runtime.prepare()["envelope"]
        malformed["consentRequired"] = False
        self.assertIsNone(
            feedback_from_response({}, {"_agentFeedback": malformed})
        )
        self.assertEqual(feedback_consent_action(malformed, "approved"), "skip")

        missing_scope = runtime.prepare()["envelope"]
        missing_scope.update(
            mode="ask_once",
            consentPolicy="once",
            when="after_experience_known_and_consent_resolved",
        )
        self.assertEqual(feedback_consent_action(missing_scope), "skip")
        runtime.shutdown()


if __name__ == "__main__":
    unittest.main()
