from __future__ import annotations

import json
import time
from typing import Any, Callable, Iterable

from .core import (
    AgentFeedback,
    AgentFeedbackOptions,
    encoded_envelope,
    inject_html,
    normalize_operation,
)

MAX_BODY_BYTES = 1024 * 1024


class AgentFeedbackWSGI:
    """Header-safe WSGI middleware for Flask, Django WSGI, Bottle, and Pyramid."""

    def __init__(self, app: Callable[..., Iterable[bytes]], **options: Any):
        self.app = app
        self.runtime = AgentFeedback(AgentFeedbackOptions(**options))

    def __call__(self, environ: dict[str, Any], start_response: Callable[..., Any]) -> Iterable[bytes]:
        path = environ.get("PATH_INFO", "/")
        if not self.runtime.matches(path):
            return self.app(environ, start_response)
        request_opt_in = str(environ.get("HTTP_AGENT_FEEDBACK_REQUEST", "")).strip() == "1"
        if self.runtime.options.cache_mode == "request" and not request_opt_in:
            return self.app(environ, start_response)
        started = time.perf_counter()
        context = self.runtime.context(environ)
        consent_state = self.runtime.resolve_consent(context.get("customerRef"))
        captured: dict[str, Any] = {}
        writes: list[bytes] = []

        def capture(status: str, headers: list[tuple[str, str]], exc_info: Any = None) -> Callable[[bytes], None]:
            captured.update(status=status, headers=list(headers), exc_info=exc_info)
            return writes.append

        body = self.app(environ, capture)
        status = str(captured.get("status", "500 Error"))
        headers = list(captured.get("headers", []))
        status_code = int(status.split(" ", 1)[0])
        content_length = next((v for k, v in headers if k.lower() == "content-length"), None)
        cache_control = ",".join(v for k, v in headers if k.lower() == "cache-control")
        declared_length = int(content_length) if content_length and content_length.isdigit() else None
        safe_body = not writes and declared_length is not None and declared_length <= MAX_BODY_BYTES
        eligible = (
            200 <= status_code < 300
            and environ.get("REQUEST_METHOD") != "HEAD"
            and safe_body
            and self.runtime.should_instrument_http(
                request_opt_in=request_opt_in, cache_control=cache_control
            )
        )
        prepared = (
            self.runtime.prepare(
                customer_ref=context.get("customerRef"), consent_state=consent_state
            )
            if eligible
            else None
        )
        chunks: list[bytes] | None = None
        if prepared:
            try:
                chunks = list(body)
            finally:
                close = getattr(body, "close", None)
                if close:
                    close()
            if sum(map(len, chunks)) != declared_length:
                prepared = None
        surface: str | None = None
        output: bytes | None = None
        if prepared:
            raw = b"".join(chunks or [])
            envelope = prepared["envelope"]
            content_type = next((v for k, v in headers if k.lower() == "content-type"), "")
            if "application/json" in content_type:
                try:
                    payload = json.loads(raw)
                except Exception:
                    payload = None
                if isinstance(payload, dict) and "_agentFeedback" not in payload:
                    if envelope:
                        payload["_agentFeedback"] = envelope
                        output = json.dumps(payload, separators=(",", ":")).encode()
                    else:
                        output = raw
                    surface = "http_json"
                elif payload is not None and not isinstance(payload, dict):
                    output = raw
                    surface = "http_headers"
            elif "text/html" in content_type:
                try:
                    output = inject_html(raw.decode(), envelope).encode() if envelope else raw
                    surface = "http_html"
                except UnicodeDecodeError:
                    pass
            if surface is None:
                prepared = None

        if prepared and prepared["envelope"] and output is not None and surface:
            headers = [
                (key, value)
                for key, value in headers
                if key.lower() not in {"content-length", "cache-control", "agent-feedback"}
            ]
            headers.extend([("Content-Length", str(len(output))), ("Cache-Control", "private, no-store")])
            if surface == "http_headers":
                headers.extend(
                    [
                        ("Agent-Feedback", encoded_envelope(prepared["envelope"])),
                        (
                            "Link",
                            f'<{self.runtime.options.endpoint}/.well-known/agent-feedback-v1.json>; rel="agent-feedback"; type="application/json"',
                        ),
                    ]
                )
        writer = start_response(status, headers, captured.get("exc_info"))
        for chunk in writes:
            writer(chunk)
        if prepared and surface:
            self.runtime.record(
                prepared,
                surface=surface,
                operation=normalize_operation(path),
                status_code=status_code,
                duration_ms=round((time.perf_counter() - started) * 1000),
                context=context,
            )
            return [output or b""]
        return chunks if chunks is not None else body

    def shutdown(self) -> None:
        self.runtime.shutdown()
