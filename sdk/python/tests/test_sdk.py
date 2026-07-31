from __future__ import annotations

import base64
import json
import threading
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
from agent_feedback.core import _key_parts

KEY = "af_live_0123456789abcdef0123456789abcdef_conformance_secret_0123456789abcdef"
TOKEN = "afr2_0123456789abcdef0123456789abcdef.eyJ2IjoxLCJpIjoiMDE4ZjFmMmUtN2I0YS03YzEyLTljOGQtMTIzNDU2Nzg5YWJjIiwiaWF0IjoxNzE1MDAwMDAwLCJleHAiOjE3MTUwMDcyMDAsIm4iOiJBUUlEQkFVR0J3Z0pDZ3NNRFE0UEVCRVMifQ.wxJ0YGS21x9eW-Cn33t9V1INhyGNj1_U3qoQns3vdWA"


def capability_claims(authorization: str) -> dict:
    payload = authorization.removeprefix("Bearer ").split(".")[1]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


class AgentFeedbackTests(unittest.IsolatedAsyncioTestCase):
    def test_ask_once_consent_key_survives_rotation(self) -> None:
        scope = "a" * 32
        first = f"af_live_{'1' * 32}_{scope}_{'x' * 32}"
        rotated = f"af_live_{'2' * 32}_{scope}_{'y' * 32}"
        other = f"af_live_{'3' * 32}_{'b' * 32}_{'z' * 32}"
        self.assertEqual(_key_parts(first)[2], _key_parts(rotated)[2])
        self.assertNotEqual(_key_parts(first)[2], _key_parts(other)[2])

    def test_legacy_auto_mode_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "never_ask, ask_once, ask_always, or off"):
            AgentFeedback(AgentFeedbackOptions(api_key=KEY, feedback_mode="auto"))

    def test_invalid_cache_mode_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "cache_mode must be safe, private, or request"):
            AgentFeedback(AgentFeedbackOptions(api_key=KEY, cache_mode="surprise"))

    def test_endpoint_env_var_is_default_and_explicit_option_wins(self) -> None:
        import os

        os.environ["AGENT_FEEDBACK_URL"] = "https://canary.epode.test/"
        try:
            from_env = AgentFeedback(AgentFeedbackOptions(api_key=KEY))
            self.assertEqual(from_env.options.endpoint, "https://canary.epode.test")
            explicit = AgentFeedback(
                AgentFeedbackOptions(api_key=KEY, endpoint="https://feedback.test")
            )
            self.assertEqual(explicit.options.endpoint, "https://feedback.test")
        finally:
            del os.environ["AGENT_FEEDBACK_URL"]
        default = AgentFeedback(AgentFeedbackOptions(api_key=KEY))
        self.assertEqual(default.options.endpoint, "https://app.epode.ai")

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

    async def test_asgi_ask_once_is_nonblocking_and_subject_bound_during_outage(self) -> None:
        original = b'{ "answer": "available" }'
        lookup_started = threading.Event()
        release_lookup = threading.Event()

        async def app(_scope, _receive, send):
            await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(original)).encode())]})
            await send({"type": "http.response.body", "body": original})

        customer_ref = "stable-customer"
        middleware = AgentFeedbackASGI(app, api_key=KEY, endpoint="https://feedback.test", include=("/status",), feedback_mode="ask_once", customer_ref=lambda _scope: customer_ref, sender=lambda *_: None)

        def unavailable_lookup(_subject: str) -> str:
            lookup_started.set()
            release_lookup.wait(1)
            return "unavailable"

        middleware.runtime._lookup_consent_subject = unavailable_lookup
        middleware.runtime.resolve_consent = lambda _customer_ref: self.fail("blocking resolver used")
        sent: list[dict] = []

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message):
            sent.append(message)

        await middleware({"type": "http", "method": "GET", "path": "/status"}, receive, send)
        feedback = json.loads(sent[1]["body"])["_agentFeedback"]
        self.assertEqual(feedback["state"], "consent_required")
        self.assertEqual(feedback["mode"], "ask_once")
        self.assertEqual(
            capability_claims(feedback["requiredAction"]["submitDecision"]["authorization"])["s"],
            middleware.runtime.consent_subject(customer_ref),
        )
        self.assertTrue(lookup_started.wait(0.2))
        release_lookup.set()
        middleware.shutdown()

    async def test_asgi_cache_modes_preserve_public_responses_unless_explicit(self) -> None:
        original = b'{"answer":"cached"}'

        async def app(_scope, _receive, send):
            await send({"type": "http.response.start", "status": 200, "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(original)).encode()),
                (b"cache-control", b"public, s-maxage=600"),
            ]})
            await send({"type": "http.response.body", "body": original})

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def invoke(cache_mode: str, opt_in: bool = False):
            middleware = AgentFeedbackASGI(
                app, api_key=KEY, include=("/status",), cache_mode=cache_mode, sender=lambda *_: None
            )
            sent: list[dict] = []
            async def send(message):
                sent.append(message)
            headers = [(b"agent-feedback-request", b"1")] if opt_in else []
            await middleware(
                {"type": "http", "method": "GET", "path": "/status", "headers": headers},
                receive,
                send,
            )
            middleware.shutdown()
            return sent

        safe = await invoke("safe")
        self.assertEqual(safe[1]["body"], original)
        self.assertEqual(dict(safe[0]["headers"])[b"cache-control"], b"public, s-maxage=600")

        ordinary = await invoke("request")
        self.assertEqual(ordinary[1]["body"], original)
        self.assertEqual(dict(ordinary[0]["headers"])[b"cache-control"], b"public, s-maxage=600")

        requested = await invoke("request", True)
        self.assertIn("_agentFeedback", json.loads(requested[1]["body"]))
        self.assertEqual(dict(requested[0]["headers"])[b"cache-control"], b"private, no-store")

        private = await invoke("private")
        self.assertIn("_agentFeedback", json.loads(private[1]["body"]))
        self.assertEqual(dict(private[0]["headers"])[b"cache-control"], b"private, no-store")

    async def test_asgi_ineligible_responses_are_unchanged_without_consent_work(self) -> None:
        original = b'{"answer":"unchanged"}'

        async def app(scope, _receive, send):
            path = scope["path"]
            status = 500 if path == "/error" else 200
            headers = [(b"content-type", b"application/json")]
            if path != "/stream":
                headers.append((b"content-length", str(len(original)).encode()))
            if path == "/shared":
                headers.append((b"cache-control", b"public, max-age=60"))
            await send({"type": "http.response.start", "status": status, "headers": headers})
            if path == "/stream":
                await send({"type": "http.response.body", "body": original[:5], "more_body": True})
                await send({"type": "http.response.body", "body": original[5:]})
            else:
                await send({"type": "http.response.body", "body": original})

        middleware = AgentFeedbackASGI(
            app,
            api_key=KEY,
            feedback_mode="ask_once",
            customer_ref=lambda _scope: "stable-customer",
            sender=lambda *_: None,
        )
        consent_work: list[str] = []
        middleware.runtime.cached_consent = lambda _ref: consent_work.append("cached") or "unknown"
        middleware.runtime.resolve_consent = lambda _ref: consent_work.append("resolved") or "unknown"
        middleware.runtime.warm_consent = lambda _ref: consent_work.append("warmed")

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        for path, method in (("/error", "GET"), ("/head", "HEAD"), ("/stream", "GET"), ("/shared", "GET")):
            sent: list[dict] = []

            async def send(message):
                sent.append(message)

            await middleware(
                {"type": "http", "method": method, "path": path, "headers": []},
                receive,
                send,
            )
            self.assertEqual(b"".join(message.get("body", b"") for message in sent), original)
            self.assertNotIn(b"agent-feedback", dict(sent[0]["headers"]))

        self.assertEqual(consent_work, [])
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

    def test_wsgi_ask_once_is_nonblocking_and_subject_bound_during_outage(self) -> None:
        original = b'{ "answer": "available" }'
        lookup_started = threading.Event()
        release_lookup = threading.Event()

        def app(_environ, start_response):
            start_response("200 OK", [("Content-Type", "application/json"), ("Content-Length", str(len(original)))])
            return [original]

        customer_ref = "stable-customer"
        middleware = AgentFeedbackWSGI(app, api_key=KEY, endpoint="https://feedback.test", include=("/status",), feedback_mode="ask_once", customer_ref=lambda _environ: customer_ref, sender=lambda *_: None)

        def unavailable_lookup(_subject: str) -> str:
            lookup_started.set()
            release_lookup.wait(1)
            return "unavailable"

        middleware.runtime._lookup_consent_subject = unavailable_lookup
        middleware.runtime.resolve_consent = lambda _customer_ref: self.fail("blocking resolver used")
        captured: dict = {}
        output = b"".join(middleware(
            {"PATH_INFO": "/status", "REQUEST_METHOD": "GET", "wsgi.input": BytesIO()},
            lambda status, headers, _exc=None: captured.update(status=status, headers=headers),
        ))
        feedback = json.loads(output)["_agentFeedback"]
        self.assertEqual(feedback["state"], "consent_required")
        self.assertEqual(feedback["mode"], "ask_once")
        self.assertEqual(
            capability_claims(feedback["requiredAction"]["submitDecision"]["authorization"])["s"],
            middleware.runtime.consent_subject(customer_ref),
        )
        self.assertTrue(lookup_started.wait(0.2))
        release_lookup.set()
        middleware.shutdown()

    def test_wsgi_cache_modes_preserve_public_responses_unless_explicit(self) -> None:
        original = b'{"answer":"cached"}'

        def app(_environ, start_response):
            start_response("200 OK", [
                ("Content-Type", "application/json"),
                ("Content-Length", str(len(original))),
                ("Cache-Control", "public, max-age=300"),
            ])
            return [original]

        def invoke(cache_mode: str, opt_in: bool = False):
            middleware = AgentFeedbackWSGI(
                app, api_key=KEY, include=("/status",), cache_mode=cache_mode, sender=lambda *_: None
            )
            captured: dict = {}
            environ = {"PATH_INFO": "/status", "REQUEST_METHOD": "GET", "wsgi.input": BytesIO()}
            if opt_in:
                environ["HTTP_AGENT_FEEDBACK_REQUEST"] = "1"
            output = b"".join(middleware(
                environ,
                lambda status, headers, _exc=None: captured.update(status=status, headers=headers),
            ))
            middleware.shutdown()
            return output, dict(captured["headers"])

        for cache_mode in ("safe", "request"):
            output, headers = invoke(cache_mode)
            self.assertEqual(output, original)
            self.assertEqual(headers["Cache-Control"], "public, max-age=300")

        for cache_mode, opt_in in (("request", True), ("private", False)):
            output, headers = invoke(cache_mode, opt_in)
            self.assertIn("_agentFeedback", json.loads(output))
            self.assertEqual(headers["Cache-Control"], "private, no-store")

    def test_wsgi_ineligible_responses_are_unchanged_without_consent_work(self) -> None:
        original = b'{"answer":"unchanged"}'

        def app(environ, start_response):
            path = environ["PATH_INFO"]
            status = "500 Error" if path == "/error" else "200 OK"
            headers = [("Content-Type", "application/json")]
            if path != "/stream":
                headers.append(("Content-Length", str(len(original))))
            if path == "/shared":
                headers.append(("Cache-Control", "public, max-age=60"))
            start_response(status, headers)
            return [original]

        middleware = AgentFeedbackWSGI(
            app,
            api_key=KEY,
            feedback_mode="ask_once",
            customer_ref=lambda _environ: "stable-customer",
            sender=lambda *_: None,
        )
        consent_work: list[str] = []
        middleware.runtime.cached_consent = lambda _ref: consent_work.append("cached") or "unknown"
        middleware.runtime.resolve_consent = lambda _ref: consent_work.append("resolved") or "unknown"
        middleware.runtime.warm_consent = lambda _ref: consent_work.append("warmed")

        for path, method in (("/error", "GET"), ("/head", "HEAD"), ("/stream", "GET"), ("/shared", "GET")):
            captured: dict = {}
            output = b"".join(middleware(
                {"PATH_INFO": path, "REQUEST_METHOD": method, "wsgi.input": BytesIO()},
                lambda status, headers, _exc=None: captured.update(status=status, headers=headers),
            ))
            self.assertEqual(output, original)
            self.assertNotIn("Agent-Feedback", dict(captured["headers"]))

        self.assertEqual(consent_work, [])
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
        envelope = runtime.prepare(customer_ref="acct_python_ask_once")["envelope"]
        self.assertTrue(envelope["requested"])
        self.assertTrue(envelope["consentRequired"])
        self.assertEqual(envelope["consentPolicy"], "once")
        self.assertEqual(envelope["state"], "consent_required")
        self.assertEqual(envelope["consentManagedBy"], "epode")
        self.assertNotIn("submit", envelope)
        self.assertEqual(envelope["requiredAction"]["type"], "ask_user")
        self.assertEqual(envelope["when"], "after_experience_known_and_consent_resolved")
        self.assertTrue(envelope["instruction"].startswith("First complete the user's product task."))
        self.assertIn("after the product answer", envelope["instruction"])
        self.assertIn("silence, uncertainty, or ambiguity, submit nothing", envelope["instruction"])
        self.assertIn("future uses without asking again", envelope["requiredAction"]["question"])
        self.assertIn("nothing is installed", envelope["requiredAction"]["question"])
        per_use_envelope = runtime.prepare()["envelope"]
        self.assertEqual(per_use_envelope["mode"], "ask_always")
        self.assertEqual(per_use_envelope["configuredMode"], "ask_once")
        self.assertEqual(per_use_envelope["consentPolicy"], "always")
        self.assertEqual(feedback_consent_action(per_use_envelope), "ask")
        self.assertNotIn("future uses", per_use_envelope["requiredAction"]["question"])
        self.assertIn("about this use", per_use_envelope["requiredAction"]["question"])
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

        declined = runtime.prepare(
            customer_ref="acct_python_ask_once", consent_state="declined"
        )["envelope"]
        self.assertFalse(declined["requested"])
        self.assertEqual(declined["state"], "feedback_disabled")
        self.assertEqual(declined["when"], "only_after_explicit_user_request")
        self.assertEqual(declined["manageConsent"]["current"], "declined")
        self.assertEqual(feedback_consent_action(declined), "skip")
        self.assertIs(
            feedback_from_response({}, {"_agentFeedback": declined}), declined
        )

        approved = runtime.prepare(
            customer_ref="acct_python_ask_once", consent_state="approved"
        )["envelope"]
        self.assertEqual(approved["state"], "feedback_ready")
        self.assertEqual(approved["manageConsent"]["current"], "approved")
        runtime.shutdown()

        always = AgentFeedback(AgentFeedbackOptions(
            api_key=KEY,
            endpoint="https://feedback.test",
            feedback_mode="ask_always",
        ))
        always_envelope = always.prepare()["envelope"]
        self.assertEqual(always_envelope["consentPolicy"], "always")
        self.assertNotIn("submit", always_envelope)
        self.assertNotIn("future uses", always_envelope["requiredAction"]["question"])
        self.assertIn("after the product answer", always_envelope["instruction"])
        self.assertEqual(feedback_consent_action(always_envelope), "ask")
        always.shutdown()

    def test_agent_helper_rejects_malformed_consent_contracts(self) -> None:
        runtime = AgentFeedback(AgentFeedbackOptions(api_key=KEY, feedback_mode="ask_always"))
        valid = runtime.prepare()["envelope"]
        malformed = json.loads(json.dumps(valid))
        malformed["consentRequired"] = False
        self.assertIsNone(
            feedback_from_response({}, {"_agentFeedback": malformed})
        )
        self.assertEqual(feedback_consent_action(malformed), "skip")

        missing_action = json.loads(json.dumps(valid))
        missing_action.pop("requiredAction")
        self.assertEqual(feedback_consent_action(missing_action), "skip")

        wrong_policy = json.loads(json.dumps(valid))
        wrong_policy["consentPolicy"] = "once"
        self.assertEqual(feedback_consent_action(wrong_policy), "skip")

        wrong_when = json.loads(json.dumps(valid))
        wrong_when["when"] = "after_experience_known_and_consent_resolved"
        self.assertEqual(feedback_consent_action(wrong_when), "skip")

        bad_authorization = json.loads(json.dumps(valid))
        bad_authorization["requiredAction"]["submitDecision"]["authorization"] = "Bearer untrusted"
        self.assertEqual(feedback_consent_action(bad_authorization), "skip")

        bad_schema = json.loads(json.dumps(valid))
        bad_schema["requiredAction"]["submitDecision"]["bodySchema"] = {
            "decision": ["approved", "declined", "unsure"]
        }
        self.assertEqual(feedback_consent_action(bad_schema), "skip")

        foreign_schema = json.loads(json.dumps(valid))
        foreign_schema["requiredAction"]["submitDecision"]["bodySchema"]["foreign"] = ["unexpected"]
        self.assertEqual(feedback_consent_action(foreign_schema), "skip")

        ready = AgentFeedback(AgentFeedbackOptions(api_key=KEY)).prepare()["envelope"]
        wrong_ready_when = json.loads(json.dumps(ready))
        wrong_ready_when["when"] = "after_experience_known_and_consent_resolved"
        self.assertEqual(feedback_consent_action(wrong_ready_when), "skip")

        mixed_ready = json.loads(json.dumps(ready))
        mixed_ready["requiredAction"] = valid["requiredAction"]
        self.assertEqual(feedback_consent_action(mixed_ready), "skip")
        runtime.shutdown()


if __name__ == "__main__":
    unittest.main()
