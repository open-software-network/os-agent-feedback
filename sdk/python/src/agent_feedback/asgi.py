from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Awaitable, Callable
from urllib.parse import quote

from .core import (
    AgentFeedback,
    AgentFeedbackOptions,
    SHARED_CACHE_HEADER_NAMES,
    encoded_envelope,
    has_agent_feedback_marker,
    inject_html,
    normalize_operation,
    request_discovery_link,
)

MAX_BODY_BYTES = 1024 * 1024


def _operation(scope: dict[str, Any], runtime: AgentFeedback) -> str:
    candidate = runtime.options.operation(scope) if runtime.options.operation else None
    if not candidate:
        candidate = scope.get("route_path")
    if not candidate:
        route = scope.get("route")
        candidate = getattr(route, "path_format", None) or getattr(route, "path", None)
    return normalize_operation(str(candidate or scope.get("path", "/")))


def _has_non_identity_content_encoding(headers: list[tuple[bytes, bytes]]) -> bool:
    return any(
        token.strip().lower() not in {b"", b"identity"}
        for name, value in headers
        if name.lower() == b"content-encoding"
        for token in value.split(b",")
    )


def _is_complete_success(status: int, headers: list[tuple[bytes, bytes]]) -> bool:
    return (
        200 <= status < 300
        and status not in {204, 205, 206}
        and not any(name.lower() == b"content-range" for name, _ in headers)
    )


def _with_request_vary(headers: list[tuple[bytes, bytes]]) -> list[tuple[bytes, bytes]]:
    for name, value in headers:
        if name.lower() != b"vary":
            continue
        if any(token.strip().lower() == b"agent-feedback-request" for token in value.split(b",")):
            return headers
    return [*headers, (b"vary", b"Agent-Feedback-Request")]


def _request_target(scope: dict[str, Any]) -> str:
    raw_path = scope.get("raw_path")
    if isinstance(raw_path, bytes):
        path = raw_path.decode("ascii", "strict")
    else:
        path = quote(str(scope.get("path", "/")), safe="/:@-._~!$&'()*+,;=")
    query = scope.get("query_string", b"")
    if isinstance(query, bytes) and query:
        return f"{path}?{query.decode('ascii', 'strict')}"
    return path


def _with_request_discovery(
    scope: dict[str, Any], status: int, headers: list[tuple[bytes, bytes]]
) -> list[tuple[bytes, bytes]]:
    if scope.get("method") not in {"GET", "HEAD"} or not _is_complete_success(
        status, headers
    ):
        return headers
    content_type = next(
        (value.decode("latin1") for name, value in headers if name.lower() == b"content-type"),
        "",
    )
    content_length = next(
        (value for name, value in headers if name.lower() == b"content-length"), None
    )
    if (
        not ("application/json" in content_type or "text/html" in content_type)
        or content_length is None
        or not content_length.isdigit()
        or int(content_length) > MAX_BODY_BYTES
    ):
        return headers
    try:
        link = request_discovery_link(_request_target(scope))
    except (UnicodeDecodeError, ValueError):
        link = None
    return [*headers, (b"link", link.encode())] if link else headers


class AgentFeedbackASGI:
    """Dependency-free ASGI middleware for FastAPI, Starlette, Quart, and Django ASGI."""

    def __init__(self, app: Callable[..., Awaitable[None]], **options: Any):
        self.app = app
        self.runtime = AgentFeedback(AgentFeedbackOptions(**options))

    async def __call__(self, scope: dict[str, Any], receive: Callable[..., Any], send: Callable[..., Any]) -> None:
        if scope.get("type") == "lifespan":
            drained = False

            async def send_with_shutdown_drain(message: dict[str, Any]) -> None:
                nonlocal drained
                if message.get("type") == "lifespan.shutdown.complete" and not drained:
                    drained = True
                    await asyncio.to_thread(self.shutdown)
                await send(message)

            await self.app(scope, receive, send_with_shutdown_drain)
            return
        if scope.get("type") != "http" or not self.runtime.matches(scope.get("path", "/")):
            await self.app(scope, receive, send)
            return
        request_opt_in = any(
            name.lower() == b"agent-feedback-request" and value.strip() == b"1"
            for name, value in scope.get("headers", [])
        )
        if self.runtime.options.cache_mode == "request":
            original_send = send

            async def send_with_request_vary(message: dict[str, Any]) -> None:
                if message.get("type") == "http.response.start":
                    original_headers = list(message.get("headers", []))
                    if _has_non_identity_content_encoding(original_headers):
                        headers = original_headers
                    else:
                        headers = _with_request_vary(original_headers)
                        if not request_opt_in:
                            headers = _with_request_discovery(
                                scope, int(message.get("status", 200)), headers
                            )
                    message = {
                        **message,
                        "headers": headers,
                    }
                await original_send(message)

            send = send_with_request_vary
        if self.runtime.options.cache_mode == "request" and not request_opt_in:
            await self.app(scope, receive, send)
            return
        started = time.perf_counter()
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
            if _has_non_identity_content_encoding(headers) or not _is_complete_success(
                status, headers
            ):
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
                if name.decode("latin1").lower() in SHARED_CACHE_HEADER_NAMES
            )
            if not self.runtime.should_instrument_http(
                request_opt_in=request_opt_in, cache_control=cache_control
            ):
                await send(start_message)
                await send(message)
                return
            if method == "HEAD":
                if (
                    self.runtime.options.cache_mode != "request"
                    or not request_opt_in
                    or not ("application/json" in content_type or "text/html" in content_type)
                ):
                    await send(start_message)
                    await send(message)
                    return
                # Resolve identity only after every eligibility check, and
                # after the wrapped authentication middleware populated the
                # original ASGI scope.
                context = self.runtime.context(scope)
                customer_ref = context.get("customerRef")
                prepared = self.runtime.prepare(
                    customer_ref=customer_ref,
                    consent_state=self.runtime.cached_consent(customer_ref),
                )
                envelope = prepared["envelope"]
                if not envelope:
                    await send(start_message)
                    await send(message)
                    return
                headers = [
                    (name, value)
                    for name, value in headers
                    if name.decode("latin1").lower()
                    not in {*SHARED_CACHE_HEADER_NAMES, "agent-feedback"}
                ]
                headers.extend(
                    [
                        (b"cache-control", b"private, no-store"),
                        (b"agent-feedback", encoded_envelope(envelope).encode()),
                        (
                            b"link",
                            f'<{self.runtime.options.endpoint}/.well-known/agent-feedback-v1.json>; rel="agent-feedback"; type="application/json"'.encode(),
                        ),
                    ]
                )
                start_message["headers"] = headers
                await send(start_message)
                await send(message)
                self.runtime.record(
                    prepared,
                    surface="http_headers",
                    operation=_operation(scope, self.runtime),
                    status_code=status,
                    duration_ms=round((time.perf_counter() - started) * 1000),
                    context=context,
                )
                self.runtime.warm_consent(customer_ref)
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
                    surface = (
                        "http_headers"
                        if has_agent_feedback_marker(html)
                        else "http_html"
                    )
                except UnicodeDecodeError:
                    surface = None

            if surface is None:
                await send(start_message)
                await send(message)
                return

            context = self.runtime.context(scope)
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
                injected_html = inject_html(html, envelope)
                if injected_html == html:
                    surface = "http_headers"
                else:
                    output = injected_html.encode()

            if envelope:
                removed_headers = {
                    *(name.encode() for name in SHARED_CACHE_HEADER_NAMES),
                    b"agent-feedback",
                }
                if surface != "http_headers":
                    removed_headers.update(
                        {
                            b"content-length",
                            b"etag",
                            b"content-md5",
                            b"digest",
                            b"content-digest",
                            b"repr-digest",
                            b"content-range",
                            b"accept-ranges",
                        }
                    )
                headers = [
                    (name, value)
                    for name, value in headers
                    if name.lower() not in removed_headers
                ]
                if surface != "http_headers":
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
                operation=_operation(scope, self.runtime),
                status_code=status,
                duration_ms=round((time.perf_counter() - started) * 1000),
                context=context,
            )
            self.runtime.warm_consent(customer_ref)

        await self.app(scope, receive, wrapped_send)

    def shutdown(self) -> bool:
        return self.runtime.shutdown()
