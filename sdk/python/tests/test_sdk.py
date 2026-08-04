from __future__ import annotations

import base64
import json
import threading
import time
import unittest
import sys
import subprocess
from io import BytesIO
from unittest.mock import patch

from agent_feedback import (
    AgentFeedbackASGI,
    AgentFeedbackWSGI,
    AgentFeedback,
    AgentFeedbackOptions,
    feedback_consent_action,
    feedback_from_response,
    inspect_product_feedback,
    sign_capability,
    submit_feedback_consent,
    submit_product_feedback,
)
from agent_feedback.core import _key_parts, inject_html, match_pattern

KEY = "af_live_0123456789abcdef0123456789abcdef_conformance_secret_0123456789abcdef"
TOKEN = "afr2_0123456789abcdef0123456789abcdef.eyJ2IjoxLCJpIjoiMDE4ZjFmMmUtN2I0YS03YzEyLTljOGQtMTIzNDU2Nzg5YWJjIiwiaWF0IjoxNzE1MDAwMDAwLCJleHAiOjE3MTUwMDcyMDAsIm4iOiJBUUlEQkFVR0J3Z0pDZ3NNRFE0UEVCRVMifQ.wxJ0YGS21x9eW-Cn33t9V1INhyGNj1_U3qoQns3vdWA"

HTML_BOUNDARY_CASES = {
    "/raw-before": (
        b"<html><head data-copy='</head>'><!-- </head> -->"
        b"<script>const fake = '</head>';</script>"
        b"<style>.x::after{content:'</head>'}</style></head><body>ok</body></html>"
    ),
    "/raw-after": (
        b"<html><head><title>safe</title></head><body>"
        b"<script>const fake = '</head>';</script>"
        b"<style>.x::after{content:'</head>'}</style>ok</body></html>"
    ),
}
CDN_CACHE_POLICIES = (
    ("CDN-Cache-Control", "public, max-age=300"),
    ("Cloudflare-CDN-Cache-Control", "s-maxage=300"),
    ("Surrogate-Control", "max-age=300, stale-while-revalidate=60"),
)


def capability_claims(authorization: str) -> dict:
    payload = authorization.removeprefix("Bearer ").split(".")[1]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


class AgentFeedbackTests(unittest.IsolatedAsyncioTestCase):
    def test_base_package_does_not_import_optional_mcp(self) -> None:
        completed = subprocess.run(
            [sys.executable, "-c", "import agent_feedback,sys; assert 'mcp' not in sys.modules; assert 'agent_feedback.mcp' not in sys.modules"],
            check=False, capture_output=True, text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_agent_reader_prefers_header_and_invalid_utf8_is_absent(self) -> None:
        runtime = AgentFeedback(AgentFeedbackOptions(api_key=KEY))
        body_envelope = runtime.prepare()["envelope"]
        header_envelope = runtime.prepare()["envelope"]
        encoded = base64.urlsafe_b64encode(
            json.dumps(header_envelope, separators=(",", ":")).encode()
        ).decode().rstrip("=")
        body = (
            '<script id="agent-feedback" type="application/json">'
            f"{json.dumps(body_envelope)}</script>"
        )
        parsed = feedback_from_response({"Agent-Feedback": encoded}, body)
        self.assertEqual(
            parsed["submit"]["authorization"],
            header_envelope["submit"]["authorization"],
        )
        self.assertNotEqual(
            parsed["submit"]["authorization"],
            body_envelope["submit"]["authorization"],
        )
        self.assertIsNone(feedback_from_response({}, b"\xff\xfe\xfa"))
        runtime.shutdown()

    def test_html_insertion_finds_real_closing_head_exactly_once(self) -> None:
        runtime = AgentFeedback(AgentFeedbackOptions(api_key=KEY))
        for path, body in HTML_BOUNDARY_CASES.items():
            with self.subTest(path=path):
                output = inject_html(body.decode(), runtime.prepare()["envelope"])
                marker = output.index('id="agent-feedback"')
                real_head = output.index("</head><body>")
                self.assertEqual(output.lower().count('id="agent-feedback"'), 1)
                self.assertLess(marker, real_head)
                if path == "/raw-before":
                    self.assertGreater(marker, output.index("</style>"))
                else:
                    self.assertLess(marker, output.index("<script>", real_head))
        runtime.shutdown()

    async def test_asgi_skips_encoded_bodies_without_feedback_work(self) -> None:
        for encoding in (b"gzip", b"br", b"identity, GZip"):
            original_body = b"\x1f\x8bencoded-product-body"
            original_headers = [
                (b"content-type", b"text/html"),
                (b"content-encoding", encoding),
                (b"content-length", str(len(original_body)).encode()),
                (b"etag", b'"product"'),
                (b"agent-feedback", b"product-owned"),
            ]

            async def app(_scope, _receive, send):
                await send(
                    {
                        "type": "http.response.start",
                        "status": 200,
                        "headers": original_headers,
                    }
                )
                await send({"type": "http.response.body", "body": original_body})

            identity_reads: list[str] = []
            consent_work: list[str] = []
            telemetry: list[bytes] = []
            middleware = AgentFeedbackASGI(
                app,
                api_key=KEY,
                cache_mode="request",
                feedback_mode="ask_once",
                customer_ref=lambda _scope: identity_reads.append("read") or "acct",
                sender=lambda _url, _headers, body: telemetry.append(body),
            )
            middleware.runtime.cached_consent = (
                lambda _ref: consent_work.append("cached") or "unknown"
            )
            middleware.runtime.warm_consent = lambda _ref: consent_work.append("warmed")
            sent: list[dict] = []

            async def send(message):
                sent.append(message)

            async def receive():
                return {"type": "http.request", "body": b"", "more_body": False}

            await middleware(
                {
                    "type": "http",
                    "method": "GET",
                    "path": "/status",
                    "headers": [(b"agent-feedback-request", b"1")],
                },
                receive,
                send,
            )
            self.assertEqual(sent[0]["headers"], original_headers)
            self.assertEqual(sent[1]["body"], original_body)
            self.assertEqual(identity_reads, [])
            self.assertEqual(consent_work, [])
            middleware.shutdown()
            self.assertEqual(telemetry, [])

    async def test_asgi_prefers_framework_route_template_over_sensitive_raw_path(self) -> None:
        telemetry: list[dict] = []

        async def app(_scope, _receive, send):
            body = b'{"available":true}'
            await send(
                {
                    "type": "http.response.start",
                    "status": 200,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(body)).encode()),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": body})

        class Route:
            path = "/accounts/{account}"

        middleware = AgentFeedbackASGI(
            app,
            api_key=KEY,
            cache_mode="private",
            account_ref=lambda _scope: "org_verified",
            user_ref=lambda _scope: "user_verified",
            anonymous_ref=lambda _scope: "anon_verified",
            sender=lambda _url, _headers, body: telemetry.append(json.loads(body)),
        )

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(_message):
            return None

        await middleware(
            {
                "type": "http",
                "method": "GET",
                "path": "/accounts/alice@example.com",
                "route": Route(),
                "headers": [],
            },
            receive,
            send,
        )
        self.assertTrue(middleware.shutdown())
        event = telemetry[0]["events"][0]
        self.assertEqual(event["operation"], "/accounts/{account}")
        self.assertEqual(event["accountRef"], "org_verified")
        self.assertEqual(event["userRef"], "user_verified")
        self.assertEqual(event["anonymousRef"], "anon_verified")

    async def test_asgi_existing_html_marker_uses_fresh_header_fallback(self) -> None:
        original = b'<html><head></head><body><script ID="AGENT-FEEDBACK">owned</script></body></html>'
        original_headers = [
            (b"content-type", b"text/html"),
            (b"content-length", str(len(original)).encode()),
            (b"etag", b'"product"'),
            (b"agent-feedback", b"stale"),
        ]

        async def app(_scope, _receive, send):
            await send({"type": "http.response.start", "status": 200, "headers": original_headers})
            await send({"type": "http.response.body", "body": original})

        middleware = AgentFeedbackASGI(
            app, api_key=KEY, cache_mode="private", sender=lambda *_: None
        )
        sent: list[dict] = []

        async def send(message):
            sent.append(message)

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        await middleware(
            {"type": "http", "method": "GET", "path": "/status", "headers": []},
            receive,
            send,
        )
        headers = dict(sent[0]["headers"])
        self.assertEqual(sent[1]["body"], original)
        self.assertEqual(headers[b"content-length"], str(len(original)).encode())
        self.assertEqual(headers[b"etag"], b'"product"')
        self.assertNotEqual(headers[b"agent-feedback"], b"stale")
        self.assertIsNotNone(
            feedback_from_response(
                {"Agent-Feedback": headers[b"agent-feedback"].decode()}, original
            )
        )
        middleware.shutdown()

    async def test_asgi_html_injection_uses_real_boundaries_or_header_fallback(self) -> None:
        ambiguous = b"<html><head><script>const fake = '</head>';"

        async def app(scope, _receive, send):
            body = HTML_BOUNDARY_CASES.get(scope["path"], ambiguous)
            await send(
                {
                    "type": "http.response.start",
                    "status": 200,
                    "headers": [
                        (b"content-type", b"text/html"),
                        (b"content-length", str(len(body)).encode()),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": body})

        middleware = AgentFeedbackASGI(
            app, api_key=KEY, cache_mode="private", sender=lambda *_: None
        )

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        for path, original in HTML_BOUNDARY_CASES.items():
            sent: list[dict] = []

            async def send(message):
                sent.append(message)

            await middleware(
                {"type": "http", "method": "GET", "path": path, "headers": []},
                receive,
                send,
            )
            output = sent[1]["body"].decode()
            marker = output.index('id="agent-feedback"')
            real_head = output.index("</head><body>")
            self.assertEqual(output.lower().count('id="agent-feedback"'), 1)
            self.assertLess(marker, real_head)
            if path == "/raw-before":
                self.assertGreater(marker, output.index("</style>"))
            else:
                self.assertLess(marker, output.index("<script>", real_head))
            self.assertNotIn(b"agent-feedback", dict(sent[0]["headers"]))

        sent = []

        async def send_ambiguous(message):
            sent.append(message)

        await middleware(
            {"type": "http", "method": "GET", "path": "/ambiguous", "headers": []},
            receive,
            send_ambiguous,
        )
        self.assertEqual(sent[1]["body"], ambiguous)
        self.assertIn(b"agent-feedback", dict(sent[0]["headers"]))
        middleware.shutdown()

    def test_wsgi_skips_encoded_bodies_without_feedback_work(self) -> None:
        for encoding in ("gzip", "br", "identity, GZip"):
            original_body = b"\x1f\x8bencoded-product-body"
            original_headers = [
                ("Content-Type", "text/html"),
                ("Content-Encoding", encoding),
                ("Content-Length", str(len(original_body))),
                ("ETag", '"product"'),
                ("Agent-Feedback", "product-owned"),
            ]

            def app(_environ, start_response):
                start_response("200 OK", original_headers)
                return [original_body]

            identity_reads: list[str] = []
            consent_work: list[str] = []
            telemetry: list[bytes] = []
            middleware = AgentFeedbackWSGI(
                app,
                api_key=KEY,
                cache_mode="request",
                feedback_mode="ask_once",
                customer_ref=lambda _environ: identity_reads.append("read") or "acct",
                sender=lambda _url, _headers, body: telemetry.append(body),
            )
            middleware.runtime.cached_consent = (
                lambda _ref: consent_work.append("cached") or "unknown"
            )
            middleware.runtime.warm_consent = lambda _ref: consent_work.append("warmed")
            captured: dict = {}
            output = b"".join(
                middleware(
                    {
                        "PATH_INFO": "/status",
                        "REQUEST_METHOD": "GET",
                        "HTTP_AGENT_FEEDBACK_REQUEST": "1",
                        "wsgi.input": BytesIO(),
                    },
                    lambda status, headers, _exc=None: captured.update(
                        status=status, headers=headers
                    ),
                )
            )
            self.assertEqual(captured["headers"], original_headers)
            self.assertEqual(output, original_body)
            self.assertEqual(identity_reads, [])
            self.assertEqual(consent_work, [])
            middleware.shutdown()
            self.assertEqual(telemetry, [])

    def test_wsgi_existing_html_marker_uses_fresh_header_fallback(self) -> None:
        original = b"<html><head></head><body><script id = 'AgEnT-FeEdBaCk'>owned</script></body></html>"
        original_headers = [
            ("Content-Type", "text/html"),
            ("Content-Length", str(len(original))),
            ("ETag", '"product"'),
            ("Agent-Feedback", "stale"),
        ]

        def app(_environ, start_response):
            start_response("200 OK", original_headers)
            return [original]

        middleware = AgentFeedbackWSGI(
            app, api_key=KEY, cache_mode="private", sender=lambda *_: None
        )
        captured: dict = {}
        output = b"".join(
            middleware(
                {"PATH_INFO": "/status", "REQUEST_METHOD": "GET", "wsgi.input": BytesIO()},
                lambda status, headers, _exc=None: captured.update(
                    status=status, headers=headers
                ),
            )
        )
        headers = dict(captured["headers"])
        self.assertEqual(output, original)
        self.assertEqual(headers["Content-Length"], str(len(original)))
        self.assertEqual(headers["ETag"], '"product"')
        self.assertNotEqual(headers["Agent-Feedback"], "stale")
        self.assertIsNotNone(
            feedback_from_response({"Agent-Feedback": headers["Agent-Feedback"]}, original)
        )
        middleware.shutdown()

    def test_wsgi_html_injection_uses_real_boundaries_or_header_fallback(self) -> None:
        ambiguous = b"<html><head><script>const fake = '</head>';"

        def app(environ, start_response):
            body = HTML_BOUNDARY_CASES.get(environ["PATH_INFO"], ambiguous)
            start_response(
                "200 OK",
                [
                    ("Content-Type", "text/html"),
                    ("Content-Length", str(len(body))),
                ],
            )
            return [body]

        middleware = AgentFeedbackWSGI(
            app, api_key=KEY, cache_mode="private", sender=lambda *_: None
        )
        for path, original in HTML_BOUNDARY_CASES.items():
            captured: dict = {}
            output = b"".join(
                middleware(
                    {"PATH_INFO": path, "REQUEST_METHOD": "GET", "wsgi.input": BytesIO()},
                    lambda status, headers, _exc=None: captured.update(
                        status=status, headers=headers
                    ),
                )
            ).decode()
            marker = output.index('id="agent-feedback"')
            real_head = output.index("</head><body>")
            self.assertEqual(output.lower().count('id="agent-feedback"'), 1)
            self.assertLess(marker, real_head)
            if path == "/raw-before":
                self.assertGreater(marker, output.index("</style>"))
            else:
                self.assertLess(marker, output.index("<script>", real_head))
            self.assertNotIn("Agent-Feedback", dict(captured["headers"]))

        captured = {}
        output = b"".join(
            middleware(
                {
                    "PATH_INFO": "/ambiguous",
                    "REQUEST_METHOD": "GET",
                    "wsgi.input": BytesIO(),
                },
                lambda status, headers, _exc=None: captured.update(
                    status=status, headers=headers
                ),
            )
        )
        self.assertEqual(output, ambiguous)
        self.assertIn("Agent-Feedback", dict(captured["headers"]))
        middleware.shutdown()

    def test_wsgi_preserves_interleaved_write_and_yield_order(self) -> None:
        expected = b'{"a":1,"b":2}'
        original_headers = [
            ("Content-Type", "application/json"),
            ("Content-Length", str(len(expected))),
            ("ETag", '"product"'),
        ]

        def app(_environ, start_response):
            write = start_response("200 OK", original_headers)

            def body():
                yield b'{"a":1'
                write(b',"b":2')
                yield b"}"

            return body()

        identity_reads: list[str] = []
        middleware = AgentFeedbackWSGI(
            app,
            api_key=KEY,
            feedback_mode="ask_once",
            customer_ref=lambda _environ: identity_reads.append("read") or "acct",
            sender=lambda *_: None,
        )
        captured: dict = {}
        wire: list[bytes] = []
        result = middleware(
            {"PATH_INFO": "/status", "REQUEST_METHOD": "GET", "wsgi.input": BytesIO()},
            lambda status, headers, _exc=None: (
                captured.update(status=status, headers=headers) or wire.append
            ),
        )
        for chunk in result:
            wire.append(chunk)
        close = getattr(result, "close", None)
        if close:
            close()
        self.assertEqual(b"".join(wire), expected)
        self.assertEqual(captured["headers"], original_headers)
        self.assertEqual(identity_reads, [])
        middleware.shutdown()

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

    def test_telemetry_delivery_defaults_match_the_node_sdk(self) -> None:
        options = AgentFeedbackOptions(api_key=KEY)
        self.assertEqual(options.telemetry_timeout, 30.0)
        self.assertEqual(options.max_telemetry_attempts, 6)
        self.assertEqual(options.shutdown_timeout, 10.0)

    def test_ask_once_without_customer_ref_warns_once(self) -> None:
        runtime = AgentFeedback(
            AgentFeedbackOptions(api_key=KEY, feedback_mode="ask_once", sender=lambda *_: None)
        )
        with self.assertLogs("agent_feedback", level="WARNING") as captured:
            self.assertEqual(runtime.cached_consent(None), "unknown")
            self.assertEqual(runtime.resolve_consent(None), "unknown")
        self.assertEqual(len(captured.records), 1)
        self.assertIn("per-interaction permission", captured.records[0].getMessage())
        runtime.shutdown()

    def test_shutdown_reports_flush_status(self) -> None:
        delivered: list[bytes] = []
        healthy = AgentFeedback(
            AgentFeedbackOptions(
                api_key=KEY,
                endpoint="https://feedback.test",
                sender=lambda _url, _headers, body: delivered.append(body),
            )
        )
        healthy.record(
            healthy.prepare(), surface="http", operation="/status", status_code=200, duration_ms=1
        )
        self.assertTrue(healthy.shutdown())
        self.assertEqual(len(delivered), 1)

        def failing_sender(_url: str, _headers: dict, _body: bytes) -> None:
            raise RuntimeError("telemetry endpoint unreachable")

        failing = AgentFeedback(
            AgentFeedbackOptions(
                api_key=KEY,
                endpoint="https://feedback.test",
                max_telemetry_attempts=1,
                sender=failing_sender,
            )
        )
        failing.record(
            failing.prepare(), surface="http", operation="/status", status_code=200, duration_ms=1
        )
        self.assertFalse(failing.shutdown())

    def test_shutdown_observes_an_in_flight_delivery_failure(self) -> None:
        delivery_started = threading.Event()
        release_delivery = threading.Event()

        def failing_sender(_url: str, _headers: dict, _body: bytes) -> None:
            delivery_started.set()
            release_delivery.wait(2)
            raise RuntimeError("telemetry endpoint unreachable")

        runtime = AgentFeedback(
            AgentFeedbackOptions(
                api_key=KEY,
                endpoint="https://feedback.test",
                flush_interval=0.001,
                max_telemetry_attempts=1,
                sender=failing_sender,
            )
        )
        runtime.record(
            runtime.prepare(),
            surface="http",
            operation="/status",
            status_code=200,
            duration_ms=1,
        )
        self.assertTrue(delivery_started.wait(0.5))
        result: list[bool] = []
        shutdown_thread = threading.Thread(target=lambda: result.append(runtime.shutdown()))
        shutdown_thread.start()
        release_delivery.set()
        shutdown_thread.join(0.5)
        self.assertFalse(shutdown_thread.is_alive())
        self.assertEqual(result, [False])

    def test_shutdown_times_out_while_delivery_is_blocked(self) -> None:
        delivery_started = threading.Event()
        release_delivery = threading.Event()

        def blocked_sender(_url: str, _headers: dict, _body: bytes) -> None:
            delivery_started.set()
            release_delivery.wait(3)

        runtime = AgentFeedback(
            AgentFeedbackOptions(
                api_key=KEY,
                endpoint="https://feedback.test",
                flush_interval=0.001,
                max_telemetry_attempts=1,
                shutdown_timeout=1.0,
                sender=blocked_sender,
            )
        )
        runtime.record(
            runtime.prepare(),
            surface="http",
            operation="/status",
            status_code=200,
            duration_ms=1,
        )
        self.assertTrue(delivery_started.wait(0.5))
        started = time.monotonic()
        self.assertFalse(runtime.shutdown())
        elapsed = time.monotonic() - started
        self.assertGreaterEqual(elapsed, 0.8)
        self.assertLess(elapsed, 1.5)
        release_delivery.set()
        if runtime.telemetry.thread:
            runtime.telemetry.thread.join(0.5)

    def test_partial_telemetry_receipt_is_a_delivery_failure(self) -> None:
        captured_timeouts: list[float] = []

        class PartialReceipt:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self) -> bytes:
                return b'{"accepted":0,"dropped":1}'

        def partial_urlopen(_request, *, timeout):
            captured_timeouts.append(timeout)
            return PartialReceipt()

        runtime = AgentFeedback(
            AgentFeedbackOptions(
                api_key=KEY,
                endpoint="https://feedback.test",
                flush_interval=3600,
                max_telemetry_attempts=1,
                shutdown_timeout=0.25,
            )
        )
        runtime.record(
            runtime.prepare(),
            surface="http_json",
            operation="/search",
            status_code=200,
            duration_ms=1,
        )
        with (
            patch("urllib.request.urlopen", side_effect=partial_urlopen),
            self.assertLogs("agent_feedback", level="WARNING") as captured,
        ):
            self.assertFalse(runtime.shutdown())
        self.assertEqual(len(captured_timeouts), 1)
        self.assertGreater(captured_timeouts[0], 0)
        self.assertLessEqual(captured_timeouts[0], 0.25)
        self.assertIn("product responses were not affected", captured.output[0])

    def test_wildcards_match_one_segment_and_double_wildcards_match_any_depth(self) -> None:
        self.assertTrue(match_pattern("/docs/page", "/docs/*"))
        self.assertFalse(match_pattern("/docs/deep/nested/page", "/docs/*"))
        self.assertTrue(match_pattern("/docs/deep/nested/page", "/docs/**"))
        self.assertTrue(match_pattern("/docs/page", "/docs/**"))
        self.assertTrue(match_pattern("/api/v2/consent/decisions", "/api/v2/consent/*"))
        self.assertFalse(match_pattern("/api/v2/consent/a/b", "/api/v2/consent/*"))
        runtime = AgentFeedback(
            AgentFeedbackOptions(
                api_key=KEY,
                endpoint="https://feedback.test",
                include=("/docs/*",),
                sender=lambda *_: None,
            )
        )
        self.assertTrue(runtime.matches("/docs/page"))
        self.assertFalse(runtime.matches("/docs/deep/nested/page"))
        runtime.shutdown()

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

    async def test_asgi_lifespan_drains_telemetry_before_shutdown_complete(self) -> None:
        telemetry: list[dict] = []
        lifecycle = iter(
            [
                {"type": "lifespan.startup"},
                {"type": "lifespan.shutdown"},
            ]
        )

        def sender(_url: str, _headers: dict[str, str], body: bytes) -> None:
            telemetry.append(json.loads(body))

        async def app(_scope, receive, send):
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                elif message["type"] == "lifespan.shutdown":
                    await send({"type": "lifespan.shutdown.complete"})
                    return

        middleware = AgentFeedbackASGI(
            app,
            api_key=KEY,
            endpoint="https://feedback.test",
            flush_interval=3600,
            sender=sender,
        )
        middleware.runtime.record(
            middleware.runtime.prepare(),
            surface="http_json",
            operation="/search",
            status_code=200,
            duration_ms=1,
        )
        sent: list[dict] = []

        async def receive():
            return next(lifecycle)

        async def send(message):
            if message["type"] == "lifespan.shutdown.complete":
                self.assertEqual(len(telemetry), 1)
            sent.append(message)

        await middleware({"type": "lifespan"}, receive, send)
        self.assertEqual(
            sent,
            [
                {"type": "lifespan.startup.complete"},
                {"type": "lifespan.shutdown.complete"},
            ],
        )

    async def test_asgi_resolves_identity_established_by_wrapped_authentication(self) -> None:
        telemetry: list[dict] = []

        def sender(_url: str, _headers: dict[str, str], body: bytes) -> None:
            telemetry.append(json.loads(body))

        async def app(scope, _receive, send):
            scope.setdefault("state", {})["account_id"] = "acct_after_feedback"
            body = b'{"answer":"available"}'
            await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})

        middleware = AgentFeedbackASGI(
            app,
            api_key=KEY,
            endpoint="https://feedback.test",
            include=("/status",),
            feedback_mode="ask_once",
            customer_ref=lambda scope: scope.get("state", {}).get("account_id"),
            sender=sender,
        )
        middleware.runtime._lookup_consent_subject = lambda _subject: "unknown"
        sent: list[dict] = []

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message):
            sent.append(message)

        await middleware(
            {"type": "http", "method": "GET", "path": "/status"},
            receive,
            send,
        )
        feedback = json.loads(sent[1]["body"])["_agentFeedback"]
        self.assertEqual(feedback["mode"], "ask_once")
        self.assertEqual(feedback["consentPolicy"], "once")
        middleware.shutdown()
        self.assertEqual(telemetry[0]["events"][0]["customerRef"], "acct_after_feedback")

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
        self.assertEqual(
            capability_claims(feedback["requiredAction"]["submitDecision"]["authorization"])["r"],
            0,
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

        async def invoke(cache_mode: str, opt_in: bool = False, method: str = "GET"):
            middleware = AgentFeedbackASGI(
                app, api_key=KEY, include=("/status",), cache_mode=cache_mode, sender=lambda *_: None
            )
            sent: list[dict] = []
            async def send(message):
                sent.append(message)
            headers = [(b"authorization", b"Bearer customer-secret")]
            if opt_in:
                headers.append((b"agent-feedback-request", b"1"))
            await middleware(
                {
                    "type": "http",
                    "method": method,
                    "path": "/status",
                    "raw_path": b"/status",
                    "query_string": b"scope=private",
                    "headers": headers,
                },
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
        self.assertEqual(dict(ordinary[0]["headers"])[b"vary"], b"Agent-Feedback-Request")
        self.assertEqual(
            dict(ordinary[0]["headers"])[b"link"],
            b'</status?scope=private>; rel="agent-feedback"; request-header="Agent-Feedback-Request: 1"',
        )

        requested = await invoke("request", True)
        self.assertIn("_agentFeedback", json.loads(requested[1]["body"]))
        self.assertEqual(dict(requested[0]["headers"])[b"cache-control"], b"private, no-store")
        self.assertEqual(dict(requested[0]["headers"])[b"vary"], b"Agent-Feedback-Request")
        self.assertNotIn(b"link", dict(requested[0]["headers"]))

        ordinary_head = await invoke("request", method="HEAD")
        self.assertIn(b"request-header", dict(ordinary_head[0]["headers"])[b"link"])
        requested_head = await invoke("request", True, "HEAD")
        self.assertIn(b"agent-feedback", dict(requested_head[0]["headers"]))
        self.assertEqual(
            dict(requested_head[0]["headers"])[b"cache-control"], b"private, no-store"
        )

        private = await invoke("private")
        self.assertIn("_agentFeedback", json.loads(private[1]["body"]))
        self.assertEqual(dict(private[0]["headers"])[b"cache-control"], b"private, no-store")

    async def test_asgi_applies_cache_policy_to_cdn_specific_headers(self) -> None:
        original = b'{"answer":"cached"}'
        policies = {
            f"/policy-{index}": (name.lower().encode(), value.encode())
            for index, (name, value) in enumerate(CDN_CACHE_POLICIES)
        }

        async def safe_app(scope, _receive, send):
            policy = policies[scope["path"]]
            await send(
                {
                    "type": "http.response.start",
                    "status": 200,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(original)).encode()),
                        policy,
                    ],
                }
            )
            await send({"type": "http.response.body", "body": original})

        identity_reads: list[str] = []
        consent_work: list[str] = []
        telemetry: list[bytes] = []
        safe = AgentFeedbackASGI(
            safe_app,
            api_key=KEY,
            feedback_mode="ask_once",
            customer_ref=lambda _scope: identity_reads.append("read") or "acct",
            sender=lambda _url, _headers, body: telemetry.append(body),
        )
        safe.runtime.cached_consent = (
            lambda _ref: consent_work.append("cached") or "unknown"
        )
        safe.runtime.warm_consent = lambda _ref: consent_work.append("warmed")

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        for path, policy in policies.items():
            sent: list[dict] = []

            async def send(message):
                sent.append(message)

            await safe(
                {"type": "http", "method": "GET", "path": path, "headers": []},
                receive,
                send,
            )
            self.assertEqual(sent[1]["body"], original)
            self.assertIn(policy, sent[0]["headers"])
            self.assertNotIn(b"agent-feedback", dict(sent[0]["headers"]))

        self.assertEqual(identity_reads, [])
        self.assertEqual(consent_work, [])
        self.assertTrue(safe.shutdown())
        self.assertEqual(telemetry, [])

        async def instrumented_app(_scope, _receive, send):
            await send(
                {
                    "type": "http.response.start",
                    "status": 200,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(original)).encode()),
                        *(
                            (name.lower().encode(), value.encode())
                            for name, value in CDN_CACHE_POLICIES
                        ),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": original})

        for cache_mode, opt_in in (("private", False), ("request", True)):
            middleware = AgentFeedbackASGI(
                instrumented_app,
                api_key=KEY,
                cache_mode=cache_mode,
                sender=lambda *_: None,
            )
            sent = []

            async def send_instrumented(message):
                sent.append(message)

            request_headers = (
                [(b"agent-feedback-request", b"1")] if opt_in else []
            )
            await middleware(
                {
                    "type": "http",
                    "method": "GET",
                    "path": "/status",
                    "headers": request_headers,
                },
                receive,
                send_instrumented,
            )
            response_headers = dict(sent[0]["headers"])
            self.assertIn("_agentFeedback", json.loads(sent[1]["body"]))
            self.assertEqual(response_headers[b"cache-control"], b"private, no-store")
            for name, _value in CDN_CACHE_POLICIES:
                self.assertNotIn(name.lower().encode(), response_headers)
            middleware.shutdown()

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

        identity_reads: list[str] = []
        middleware = AgentFeedbackASGI(
            app,
            api_key=KEY,
            feedback_mode="ask_once",
            customer_ref=lambda _scope: identity_reads.append("read") or "stable-customer",
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
        self.assertEqual(identity_reads, [])
        middleware.shutdown()

    async def test_asgi_partial_and_ranged_successes_pass_through_without_feedback_work(self) -> None:
        bodies = {
            "/no-content": b"",
            "/reset-content": b"",
            "/partial": b'{"answer":"pa"}',
            "/ranged-ok": b'{"answer":"range"}',
        }
        responses = {
            "/no-content": (204, b"text/html", []),
            "/reset-content": (205, b"text/html", []),
            "/partial": (206, b"application/json", []),
            "/ranged-ok": (200, b"application/json", [(b"content-range", b"bytes 0-17/18")]),
        }
        original_headers: dict[str, list[tuple[bytes, bytes]]] = {}

        async def app(scope, _receive, send):
            path = scope["path"]
            status, content_type, range_headers = responses[path]
            headers = [
                (b"content-type", content_type),
                (b"content-length", str(len(bodies[path])).encode()),
                (b"cache-control", b"public, max-age=60"),
                (b"etag", b'"product-etag"'),
                *range_headers,
            ]
            original_headers[path] = headers
            await send({"type": "http.response.start", "status": status, "headers": headers})
            await send({"type": "http.response.body", "body": bodies[path]})

        identity_reads: list[str] = []
        telemetry: list[bytes] = []
        middleware = AgentFeedbackASGI(
            app,
            api_key=KEY,
            endpoint="https://feedback.test",
            feedback_mode="ask_once",
            cache_mode="private",
            customer_ref=lambda _scope: identity_reads.append("read") or "acct",
            sender=lambda _url, _headers, body: telemetry.append(body),
        )
        consent_work: list[str] = []
        middleware.runtime.cached_consent = lambda _ref: consent_work.append("cached") or "unknown"
        middleware.runtime.resolve_consent = lambda _ref: consent_work.append("resolved") or "unknown"
        middleware.runtime.warm_consent = lambda _ref: consent_work.append("warmed")

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        for path, (status, _content_type, _range_headers) in responses.items():
            sent: list[dict] = []

            async def send(message):
                sent.append(message)

            await middleware(
                {"type": "http", "method": "GET", "path": path, "headers": []},
                receive,
                send,
            )
            self.assertEqual(sent[0]["status"], status)
            self.assertEqual(sent[0]["headers"], original_headers[path])
            self.assertEqual(sent[1]["body"], bodies[path])

        self.assertEqual(identity_reads, [])
        self.assertEqual(consent_work, [])
        middleware.shutdown()
        self.assertEqual(telemetry, [])

    async def test_asgi_body_rewrites_strip_validators_but_header_fallback_preserves_them(self) -> None:
        validators = [
            (b"etag", b'"product-etag"'),
            (b"content-md5", b"deadbeef"),
            (b"digest", b"sha-256=deadbeef"),
            (b"content-digest", b"sha-256=:deadbeef:"),
            (b"repr-digest", b"sha-256=:deadbeef:"),
            (b"accept-ranges", b"bytes"),
        ]
        cases = {
            "/json": (b"application/json", b'{"answer":"available"}', True),
            "/html": (b"text/html", b"<html><body>available</body></html>", True),
            "/array": (b"application/json", b'["available"]', False),
        }

        async def app(scope, _receive, send):
            content_type, body, _rewritten = cases[scope["path"]]
            await send(
                {
                    "type": "http.response.start",
                    "status": 200,
                    "headers": [
                        (b"content-type", content_type),
                        (b"content-length", str(len(body)).encode()),
                        *validators,
                    ],
                }
            )
            await send({"type": "http.response.body", "body": body})

        middleware = AgentFeedbackASGI(
            app,
            api_key=KEY,
            endpoint="https://feedback.test",
            cache_mode="private",
            sender=lambda *_: None,
        )

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        validator_names = {name for name, _value in validators}
        expected_validators = dict(validators)
        for path, (_content_type, original, rewritten) in cases.items():
            sent: list[dict] = []

            async def send(message):
                sent.append(message)

            await middleware(
                {"type": "http", "method": "GET", "path": path, "headers": []},
                receive,
                send,
            )
            headers = dict(sent[0]["headers"])
            if rewritten:
                self.assertNotEqual(sent[1]["body"], original)
                self.assertTrue(validator_names.isdisjoint(headers))
            else:
                self.assertEqual(sent[1]["body"], original)
                for name, value in expected_validators.items():
                    self.assertEqual(headers[name], value)
                self.assertIn(b"agent-feedback", headers)

        middleware.shutdown()

    def test_telemetry_retries_transient_delivery_without_changing_event(self) -> None:
        attempts = 0
        bodies: list[bytes] = []
        delivered: list[dict] = []

        def sender(_url: str, _headers: dict[str, str], body: bytes) -> None:
            nonlocal attempts
            attempts += 1
            bodies.append(body)
            if attempts < 2:
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
        # Shutdown is intentionally bounded to one second. One 500 ms retry is
        # guaranteed inside that deadline; requiring a third attempt after a
        # further one-second backoff made this test depend on scheduler jitter.
        self.assertTrue(runtime.shutdown())
        self.assertEqual(attempts, 2)
        self.assertEqual(bodies, [bodies[0], bodies[0]])
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

    def test_wsgi_operation_override_hides_sensitive_raw_path(self) -> None:
        telemetry: list[dict] = []

        def app(_environ, start_response):
            body = b'{"available":true}'
            start_response(
                "200 OK",
                [("Content-Type", "application/json"), ("Content-Length", str(len(body)))],
            )
            return [body]

        middleware = AgentFeedbackWSGI(
            app,
            api_key=KEY,
            endpoint="https://feedback.test",
            cache_mode="private",
            operation=lambda _environ: "/accounts/{account}",
            sender=lambda _url, _headers, body: telemetry.append(json.loads(body)),
        )
        captured: dict = {}
        result = middleware(
            {
                "PATH_INFO": "/accounts/alice@example.com",
                "REQUEST_METHOD": "GET",
                "wsgi.input": BytesIO(),
            },
            lambda status, headers, _exc=None: captured.update(status=status, headers=headers),
        )
        self.assertIn(b"_agentFeedback", b"".join(result))
        self.assertTrue(middleware.shutdown())
        self.assertEqual(telemetry[0]["events"][0]["operation"], "/accounts/{account}")

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

    def test_wsgi_supports_lazy_start_response_and_bounds_a_false_content_length(self) -> None:
        original = b'{"answer":"lazy"}'

        def lazy_app(_environ, start_response):
            def body():
                start_response(
                    "200 OK",
                    [
                        ("Content-Type", "application/json"),
                        ("Content-Length", str(len(original))),
                    ],
                )
                yield original[:5]
                yield original[5:]

            return body()

        middleware = AgentFeedbackWSGI(
            lazy_app,
            api_key=KEY,
            endpoint="https://feedback.test",
            include=("/status",),
            sender=lambda *_: None,
        )
        captured: dict = {}
        output = b"".join(
            middleware(
                {"PATH_INFO": "/status", "REQUEST_METHOD": "GET", "wsgi.input": BytesIO()},
                lambda status, headers, _exc=None: captured.update(
                    status=status, headers=headers
                ),
            )
        )
        self.assertEqual(captured["status"], "200 OK")
        self.assertEqual(json.loads(output)["answer"], "lazy")
        self.assertIn("_agentFeedback", json.loads(output))
        middleware.shutdown()

        oversized = b"x" * (1024 * 1024 + 1)
        identity_reads: list[str] = []
        closed: list[bool] = []

        class LyingBody:
            def __iter__(self):
                yield oversized

            def close(self):
                closed.append(True)

        def lying_app(_environ, start_response):
            start_response(
                "200 OK",
                [("Content-Type", "application/json"), ("Content-Length", "1")],
            )
            return LyingBody()

        middleware = AgentFeedbackWSGI(
            lying_app,
            api_key=KEY,
            feedback_mode="ask_once",
            customer_ref=lambda _environ: identity_reads.append("read") or "acct",
            sender=lambda *_: None,
        )
        captured = {}
        result = middleware(
            {"PATH_INFO": "/status", "REQUEST_METHOD": "GET", "wsgi.input": BytesIO()},
            lambda status, headers, _exc=None: captured.update(status=status, headers=headers),
        )
        self.assertEqual(b"".join(result), oversized)
        close = getattr(result, "close", None)
        if close:
            close()
        self.assertEqual(identity_reads, [])
        self.assertEqual(closed, [True])
        self.assertNotIn("Agent-Feedback", dict(captured["headers"]))
        middleware.shutdown()

    def test_wsgi_resolves_identity_established_by_wrapped_authentication(self) -> None:
        telemetry: list[dict] = []
        original = b'{"answer":"available"}'

        def sender(_url: str, _headers: dict[str, str], body: bytes) -> None:
            telemetry.append(json.loads(body))

        def app(environ, start_response):
            environ["account_id"] = "acct_after_feedback"
            start_response("200 OK", [("Content-Type", "application/json"), ("Content-Length", str(len(original)))])
            return [original]

        middleware = AgentFeedbackWSGI(
            app,
            api_key=KEY,
            endpoint="https://feedback.test",
            include=("/status",),
            feedback_mode="ask_once",
            customer_ref=lambda environ: environ.get("account_id"),
            sender=sender,
        )
        middleware.runtime._lookup_consent_subject = lambda _subject: "unknown"
        captured: dict = {}
        output = b"".join(middleware(
            {"PATH_INFO": "/status", "REQUEST_METHOD": "GET", "wsgi.input": BytesIO()},
            lambda status, headers, _exc=None: captured.update(status=status, headers=headers),
        ))
        feedback = json.loads(output)["_agentFeedback"]
        self.assertEqual(feedback["mode"], "ask_once")
        self.assertEqual(feedback["consentPolicy"], "once")
        middleware.shutdown()
        self.assertEqual(telemetry[0]["events"][0]["customerRef"], "acct_after_feedback")

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
        self.assertEqual(
            capability_claims(feedback["requiredAction"]["submitDecision"]["authorization"])["r"],
            0,
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

        def invoke(cache_mode: str, opt_in: bool = False, method: str = "GET"):
            middleware = AgentFeedbackWSGI(
                app, api_key=KEY, include=("/status",), cache_mode=cache_mode, sender=lambda *_: None
            )
            captured: dict = {}
            environ = {
                "PATH_INFO": "/status",
                "QUERY_STRING": "scope=private",
                "REQUEST_METHOD": method,
                "HTTP_AUTHORIZATION": "Bearer customer-secret",
                "wsgi.input": BytesIO(),
            }
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
            if cache_mode == "request":
                self.assertEqual(headers["Vary"], "Agent-Feedback-Request")
                self.assertEqual(
                    headers["Link"],
                    '</status?scope=private>; rel="agent-feedback"; request-header="Agent-Feedback-Request: 1"',
                )

        for cache_mode, opt_in in (("request", True), ("private", False)):
            output, headers = invoke(cache_mode, opt_in)
            self.assertIn("_agentFeedback", json.loads(output))
            self.assertEqual(headers["Cache-Control"], "private, no-store")
            if cache_mode == "request":
                self.assertEqual(headers["Vary"], "Agent-Feedback-Request")

        _, ordinary_head_headers = invoke("request", method="HEAD")
        self.assertIn("request-header", ordinary_head_headers["Link"])
        _, requested_head_headers = invoke("request", True, "HEAD")
        self.assertIn("Agent-Feedback", requested_head_headers)
        self.assertEqual(requested_head_headers["Cache-Control"], "private, no-store")

    def test_wsgi_applies_cache_policy_to_cdn_specific_headers(self) -> None:
        original = b'{"answer":"cached"}'
        policies = {
            f"/policy-{index}": policy
            for index, policy in enumerate(CDN_CACHE_POLICIES)
        }

        def safe_app(environ, start_response):
            policy = policies[environ["PATH_INFO"]]
            start_response(
                "200 OK",
                [
                    ("Content-Type", "application/json"),
                    ("Content-Length", str(len(original))),
                    policy,
                ],
            )
            return [original]

        identity_reads: list[str] = []
        consent_work: list[str] = []
        telemetry: list[bytes] = []
        safe = AgentFeedbackWSGI(
            safe_app,
            api_key=KEY,
            feedback_mode="ask_once",
            customer_ref=lambda _environ: identity_reads.append("read") or "acct",
            sender=lambda _url, _headers, body: telemetry.append(body),
        )
        safe.runtime.cached_consent = (
            lambda _ref: consent_work.append("cached") or "unknown"
        )
        safe.runtime.warm_consent = lambda _ref: consent_work.append("warmed")

        for path, policy in policies.items():
            captured: dict = {}
            output = b"".join(
                safe(
                    {"PATH_INFO": path, "REQUEST_METHOD": "GET", "wsgi.input": BytesIO()},
                    lambda status, headers, _exc=None: captured.update(
                        status=status, headers=headers
                    ),
                )
            )
            self.assertEqual(output, original)
            self.assertIn(policy, captured["headers"])
            self.assertNotIn("Agent-Feedback", dict(captured["headers"]))

        self.assertEqual(identity_reads, [])
        self.assertEqual(consent_work, [])
        self.assertTrue(safe.shutdown())
        self.assertEqual(telemetry, [])

        def instrumented_app(_environ, start_response):
            start_response(
                "200 OK",
                [
                    ("Content-Type", "application/json"),
                    ("Content-Length", str(len(original))),
                    *CDN_CACHE_POLICIES,
                ],
            )
            return [original]

        for cache_mode, opt_in in (("private", False), ("request", True)):
            middleware = AgentFeedbackWSGI(
                instrumented_app,
                api_key=KEY,
                cache_mode=cache_mode,
                sender=lambda *_: None,
            )
            captured = {}
            environ = {
                "PATH_INFO": "/status",
                "REQUEST_METHOD": "GET",
                "wsgi.input": BytesIO(),
            }
            if opt_in:
                environ["HTTP_AGENT_FEEDBACK_REQUEST"] = "1"
            output = b"".join(
                middleware(
                    environ,
                    lambda status, headers, _exc=None: captured.update(
                        status=status, headers=headers
                    ),
                )
            )
            response_headers = {
                name.lower(): value for name, value in captured["headers"]
            }
            self.assertIn("_agentFeedback", json.loads(output))
            self.assertEqual(response_headers["cache-control"], "private, no-store")
            for name, _value in CDN_CACHE_POLICIES:
                self.assertNotIn(name.lower(), response_headers)
            middleware.shutdown()

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

        identity_reads: list[str] = []
        middleware = AgentFeedbackWSGI(
            app,
            api_key=KEY,
            feedback_mode="ask_once",
            customer_ref=lambda _environ: identity_reads.append("read") or "stable-customer",
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
        self.assertEqual(identity_reads, [])
        middleware.shutdown()

    def test_wsgi_partial_and_ranged_successes_pass_through_without_feedback_work(self) -> None:
        bodies = {
            "/no-content": b"",
            "/reset-content": b"",
            "/partial": b'{"answer":"pa"}',
            "/ranged-ok": b'{"answer":"range"}',
        }
        responses = {
            "/no-content": ("204 No Content", "text/html", []),
            "/reset-content": ("205 Reset Content", "text/html", []),
            "/partial": ("206 Partial Content", "application/json", []),
            "/ranged-ok": ("200 OK", "application/json", [("Content-Range", "bytes 0-17/18")]),
        }
        original_headers: dict[str, list[tuple[str, str]]] = {}

        def app(environ, start_response):
            path = environ["PATH_INFO"]
            status, content_type, range_headers = responses[path]
            headers = [
                ("Content-Type", content_type),
                ("Content-Length", str(len(bodies[path]))),
                ("Cache-Control", "public, max-age=60"),
                ("ETag", '"product-etag"'),
                *range_headers,
            ]
            original_headers[path] = headers
            start_response(status, headers)
            return [bodies[path]]

        identity_reads: list[str] = []
        telemetry: list[bytes] = []
        middleware = AgentFeedbackWSGI(
            app,
            api_key=KEY,
            endpoint="https://feedback.test",
            feedback_mode="ask_once",
            cache_mode="private",
            customer_ref=lambda _environ: identity_reads.append("read") or "acct",
            sender=lambda _url, _headers, body: telemetry.append(body),
        )
        consent_work: list[str] = []
        middleware.runtime.cached_consent = lambda _ref: consent_work.append("cached") or "unknown"
        middleware.runtime.resolve_consent = lambda _ref: consent_work.append("resolved") or "unknown"
        middleware.runtime.warm_consent = lambda _ref: consent_work.append("warmed")

        for path, (status, _content_type, _range_headers) in responses.items():
            captured: dict = {}
            output = b"".join(
                middleware(
                    {"PATH_INFO": path, "REQUEST_METHOD": "GET", "wsgi.input": BytesIO()},
                    lambda response_status, headers, _exc=None: captured.update(
                        status=response_status, headers=headers
                    ),
                )
            )
            self.assertEqual(captured["status"], status)
            self.assertEqual(captured["headers"], original_headers[path])
            self.assertEqual(output, bodies[path])

        self.assertEqual(identity_reads, [])
        self.assertEqual(consent_work, [])
        middleware.shutdown()
        self.assertEqual(telemetry, [])

    def test_wsgi_body_rewrites_strip_validators_but_header_fallback_preserves_them(self) -> None:
        validators = [
            ("ETag", '"product-etag"'),
            ("Content-MD5", "deadbeef"),
            ("Digest", "sha-256=deadbeef"),
            ("Content-Digest", "sha-256=:deadbeef:"),
            ("Repr-Digest", "sha-256=:deadbeef:"),
            ("Accept-Ranges", "bytes"),
        ]
        cases = {
            "/json": ("application/json", b'{"answer":"available"}', True),
            "/html": ("text/html", b"<html><body>available</body></html>", True),
            "/array": ("application/json", b'["available"]', False),
        }

        def app(environ, start_response):
            content_type, body, _rewritten = cases[environ["PATH_INFO"]]
            start_response(
                "200 OK",
                [
                    ("Content-Type", content_type),
                    ("Content-Length", str(len(body))),
                    *validators,
                ],
            )
            return [body]

        middleware = AgentFeedbackWSGI(
            app,
            api_key=KEY,
            endpoint="https://feedback.test",
            cache_mode="private",
            sender=lambda *_: None,
        )
        validator_names = {name.lower() for name, _value in validators}
        expected_validators = dict(validators)
        for path, (_content_type, original, rewritten) in cases.items():
            captured: dict = {}
            output = b"".join(
                middleware(
                    {"PATH_INFO": path, "REQUEST_METHOD": "GET", "wsgi.input": BytesIO()},
                    lambda status, headers, _exc=None: captured.update(
                        status=status, headers=headers
                    ),
                )
            )
            headers = dict(captured["headers"])
            if rewritten:
                self.assertNotEqual(output, original)
                self.assertTrue(
                    validator_names.isdisjoint(name.lower() for name in headers)
                )
            else:
                self.assertEqual(output, original)
                for name, value in expected_validators.items():
                    self.assertEqual(headers[name], value)
                self.assertIn("Agent-Feedback", headers)

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

        def sender(url, _headers, body):
            if url.endswith("/api/v2/capabilities/introspect"):
                return {
                    "state": "feedback_ready",
                    "configuredMode": "never_ask",
                    "consentPolicy": "none",
                    "productName": "Test product",
                    "canonicalQuestion": None,
                    "expiresAt": "2099-01-01T00:00:00Z",
                }
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
        self.assertEqual(feedback_consent_action(per_use_envelope), "skip")
        self.assertNotIn("future uses", per_use_envelope["requiredAction"]["question"])
        self.assertIn("about this use", per_use_envelope["requiredAction"]["question"])
        self.assertEqual(feedback_consent_action(envelope), "skip")
        unknown = inspect_product_feedback(
            envelope,
            allowed_submit_origins=("https://feedback.test",),
            sender=lambda *_: {
                "state": "consent_required",
                "configuredMode": "ask_once",
                "consentPolicy": "once",
                "productName": "Test product",
                "canonicalQuestion": "May I send feedback?",
                "expiresAt": "2099-01-01T00:00:00Z",
            },
        )
        self.assertEqual(unknown["action"], "ask")
        for state, action in (("declined", "skip"), ("feedback_ready", "submit")):
            current = inspect_product_feedback(
                envelope,
                allowed_submit_origins=("https://feedback.test",),
                sender=lambda *_args, state=state: {
                    "state": state,
                    "configuredMode": "ask_once",
                    "consentPolicy": "once" if state == "declined" else "none",
                    "productName": "Test product",
                    "canonicalQuestion": None,
                    "expiresAt": "2099-01-01T00:00:00Z",
                },
            )
            self.assertEqual(current["action"], action)
        with self.assertRaisesRegex(ValueError, "does not allow submission"):
            submit_product_feedback(
                envelope,
                {"summary": "The product completed the task.", "impact": "helped"},
                allowed_submit_origins=("https://feedback.test",),
                sender=lambda *_: unknown,
            )
        approved_envelope = AgentFeedback(AgentFeedbackOptions(api_key=KEY)).prepare()["envelope"]
        decision_body: list[dict] = []
        def decision_sender(url, _headers, body):
            if url.endswith("/api/v2/capabilities/introspect"):
                return unknown
            decision_body.append(json.loads(body))
            return {"state": "approved", "feedback": approved_envelope}

        decision = submit_feedback_consent(
            envelope,
            "approved",
            allowed_submit_origins=("https://feedback.test",),
            sender=decision_sender,
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
        self.assertEqual(feedback_consent_action(always_envelope), "skip")
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
