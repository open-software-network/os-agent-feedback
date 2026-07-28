from __future__ import annotations

import time
from typing import Any, Callable, Iterable

from .core import AgentFeedback, AgentFeedbackOptions, encoded_envelope, normalize_operation


class AgentFeedbackWSGI:
    """Header-safe WSGI middleware for Flask, Django WSGI, Bottle, and Pyramid."""

    def __init__(self, app: Callable[..., Iterable[bytes]], **options: Any):
        self.app = app
        self.runtime = AgentFeedback(AgentFeedbackOptions(**options))

    def __call__(self, environ: dict[str, Any], start_response: Callable[..., Any]) -> Iterable[bytes]:
        path = environ.get("PATH_INFO", "/")
        if not self.runtime.matches(path):
            return self.app(environ, start_response)
        started = time.perf_counter()
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
        safe_body = isinstance(body, (list, tuple)) and not writes and content_length is not None
        eligible = (
            200 <= status_code < 300
            and environ.get("REQUEST_METHOD") != "HEAD"
            and safe_body
        )
        prepared = self.runtime.prepare() if eligible else None
        if prepared:
            headers = [
                (key, value)
                for key, value in headers
                if key.lower() not in {"cache-control", "agent-feedback"}
            ]
            headers.extend(
                [
                    ("Cache-Control", "private, no-store"),
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
        if prepared:
            self.runtime.record(
                prepared,
                surface="http_headers",
                operation=normalize_operation(path),
                status_code=status_code,
                duration_ms=round((time.perf_counter() - started) * 1000),
                context=self.runtime.context(environ),
            )
        return body

    def shutdown(self) -> None:
        self.runtime.shutdown()
