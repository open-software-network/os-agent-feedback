from __future__ import annotations

import json
import time
from typing import Any, Awaitable, Callable

from .core import AgentFeedback, AgentFeedbackOptions, encoded_envelope, inject_html, normalize_operation

MAX_BODY_BYTES = 1024 * 1024


class AgentFeedbackASGI:
    """Dependency-free ASGI middleware for FastAPI, Starlette, Quart, and Django ASGI."""

    def __init__(self, app: Callable[..., Awaitable[None]], **options: Any):
        self.app = app
        self.runtime = AgentFeedback(AgentFeedbackOptions(**options))

    async def __call__(self, scope: dict[str, Any], receive: Callable[..., Any], send: Callable[..., Any]) -> None:
        if scope.get("type") != "http" or not self.runtime.matches(scope.get("path", "/")):
            await self.app(scope, receive, send)
            return
        request_opt_in = any(
            name.lower() == b"agent-feedback-request" and value.strip() == b"1"
            for name, value in scope.get("headers", [])
        )
        if self.runtime.options.cache_mode == "request" and not request_opt_in:
            await self.app(scope, receive, send)
            return
        started = time.perf_counter()
        context = self.runtime.context(scope)
        start_message: dict[str, Any] | None = None
        streamed = False

        async def wrapped_send(message: dict[str, Any]) -> None:
            nonlocal start_message, streamed
            if message["type"] == "http.response.start":
                start_message = dict(message)
                return
            if message["type"] != "http.response.body" or start_message is None:
                await send(message)
                return
            if message.get("more_body"):
                streamed = True
                await send(start_message)
                start_message = None
                await send(message)
                return
            if streamed:
                await send(message)
                return

            status = int(start_message.get("status", 200))
            headers = list(start_message.get("headers", []))
            method = str(scope.get("method", "GET"))
            if status < 200 or status >= 300 or method == "HEAD":
                await send(start_message)
                await send(message)
                return
            content_type = next(
                (value.decode("latin1") for name, value in headers if name.lower() == b"content-type"),
                "",
            )
            cache_control = ",".join(
                value.decode("latin1")
                for name, value in headers
                if name.lower() == b"cache-control"
            )
            if not self.runtime.should_instrument_http(
                request_opt_in=request_opt_in, cache_control=cache_control
            ):
                await send(start_message)
                await send(message)
                return
            body = bytes(message.get("body", b""))
            if len(body) > MAX_BODY_BYTES:
                await send(start_message)
                await send(message)
                return
            surface: str | None = None
            payload: Any = None
            html: str | None = None

            if "application/json" in content_type:
                try:
                    payload = json.loads(body)
                except Exception:
                    payload = None
                if isinstance(payload, dict) and "_agentFeedback" not in payload:
                    surface = "http_json"
                elif payload is not None and not isinstance(payload, dict):
                    surface = "http_headers"
            elif "text/html" in content_type:
                try:
                    html = body.decode()
                    surface = "http_html"
                except UnicodeDecodeError:
                    surface = None

            if surface is None:
                await send(start_message)
                await send(message)
                return

            customer_ref = context.get("customerRef")
            prepared = self.runtime.prepare(
                customer_ref=customer_ref,
                consent_state=self.runtime.cached_consent(customer_ref),
            )
            envelope = prepared["envelope"]
            output = body
            if surface == "http_json" and envelope:
                payload["_agentFeedback"] = envelope
                output = json.dumps(payload, separators=(",", ":")).encode()
            elif surface == "http_html" and envelope and html is not None:
                output = inject_html(html, envelope).encode()

            if envelope:
                headers = [
                    (name, value)
                    for name, value in headers
                    if name.lower() not in {b"content-length", b"cache-control", b"agent-feedback"}
                ]
                headers.append((b"content-length", str(len(output)).encode()))
                headers.append((b"cache-control", b"private, no-store"))
            if surface == "http_headers" and envelope:
                headers.append((b"agent-feedback", encoded_envelope(prepared["envelope"]).encode()))
                headers.append(
                    (
                        b"link",
                        f'<{self.runtime.options.endpoint}/.well-known/agent-feedback-v1.json>; rel="agent-feedback"; type="application/json"'.encode(),
                    )
                )
            start_message["headers"] = headers
            await send(start_message)
            await send({**message, "body": output})
            self.runtime.record(
                prepared,
                surface=surface,
                operation=normalize_operation(scope.get("route_path") or scope.get("path", "/")),
                status_code=status,
                duration_ms=round((time.perf_counter() - started) * 1000),
                context=context,
            )
            self.runtime.warm_consent(customer_ref)

        await self.app(scope, receive, wrapped_send)

    def shutdown(self) -> None:
        self.runtime.shutdown()
