from __future__ import annotations

import json
import unittest
from io import BytesIO

from agent_feedback import (
    AgentFeedbackASGI,
    AgentFeedbackWSGI,
    feedback_from_response,
    sign_capability,
    submit_product_outcome,
)

KEY = "af_live_0123456789abcdef0123456789abcdef_conformance_secret_0123456789abcdef"
TOKEN = "afr2_0123456789abcdef0123456789abcdef.eyJ2IjoxLCJpIjoiMDE4ZjFmMmUtN2I0YS03YzEyLTljOGQtMTIzNDU2Nzg5YWJjIiwiaWF0IjoxNzE1MDAwMDAwLCJleHAiOjE3MTUwMDcyMDAsIm4iOiJBUUlEQkFVR0J3Z0pDZ3NNRFE0UEVCRVMifQ.wxJ0YGS21x9eW-Cn33t9V1INhyGNj1_U3qoQns3vdWA"


class AgentFeedbackTests(unittest.IsolatedAsyncioTestCase):
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

    def test_agent_helper_allowlists_destination_and_sends_compact_body(self) -> None:
        envelope = {
            "v": 1,
            "submit": {
                "url": "https://feedback.test/api/v2/outcomes",
                "method": "POST",
                "authorization": "Bearer afr2_test.payload.signature",
            },
        }
        sent: list[dict] = []

        def sender(_url, _headers, body):
            sent.append(json.loads(body))
            return {"accepted": True}

        result = submit_product_outcome(
            envelope,
            "success",
            "The product completed the task.",
            allowed_submit_origins=("https://feedback.test",),
            sender=sender,
        )
        self.assertTrue(result["accepted"])
        self.assertEqual(sent, [{"outcome": "success", "note": "The product completed the task."}])


if __name__ == "__main__":
    unittest.main()
