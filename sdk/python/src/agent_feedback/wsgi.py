from __future__ import annotations

import json
import time
from typing import Any, Callable, Iterable
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


def _operation(environ: dict[str, Any], runtime: AgentFeedback) -> str:
    candidate = runtime.options.operation(environ) if runtime.options.operation else None
    if not candidate:
        candidate = environ.get("agent_feedback.route_pattern")
    if not candidate:
        request = environ.get("werkzeug.request")
        rule = getattr(request, "url_rule", None)
        candidate = getattr(rule, "rule", None)
    path = f'{environ.get("SCRIPT_NAME", "")}{environ.get("PATH_INFO", "/")}'
    return normalize_operation(str(candidate or path))


def _has_non_identity_content_encoding(headers: list[tuple[str, str]]) -> bool:
    return any(
        token.strip().lower() not in {"", "identity"}
        for key, value in headers
        if key.lower() == "content-encoding"
        for token in value.split(",")
    )


def _is_complete_success(status_code: int, headers: list[tuple[str, str]]) -> bool:
    return (
        200 <= status_code < 300
        and status_code not in {204, 205, 206}
        and not any(key.lower() == "content-range" for key, _ in headers)
    )


class _ReplayIterable:
    """Replay already-read chunks, then continue the original WSGI iterator."""

    def __init__(
        self,
        prefix: list[bytes],
        iterator: Any,
        close: Callable[[], Any] | None,
    ) -> None:
        self._prefix = prefix
        self._iterator = iterator
        self._close = close

    def __iter__(self) -> Iterable[bytes]:
        yield from self._prefix
        yield from self._iterator

    def close(self) -> None:
        if self._close:
            self._close()


class _InterleavedReplayIterable:
    """Replay legacy write() calls and yielded chunks in their original order."""

    def __init__(
        self,
        events: list[tuple[bool, bytes]],
        iterator: Any,
        close: Callable[[], Any] | None,
        writer: Callable[[bytes], Any],
    ) -> None:
        self._events = events
        self._iterator = iterator
        self._close = close
        self._writer = writer

    def __iter__(self) -> Iterable[bytes]:
        for is_write, chunk in self._events:
            if is_write:
                self._writer(chunk)
            else:
                yield chunk
        yield from self._iterator

    def close(self) -> None:
        if self._close:
            self._close()


def _with_request_vary(headers: list[tuple[str, str]]) -> list[tuple[str, str]]:
    for key, value in headers:
        if key.lower() != "vary":
            continue
        if any(token.strip().lower() == "agent-feedback-request" for token in value.split(",")):
            return headers
    return [*headers, ("Vary", "Agent-Feedback-Request")]


def _request_target(environ: dict[str, Any]) -> str:
    raw = environ.get("RAW_URI") or environ.get("REQUEST_URI")
    if raw:
        return str(raw)
    path = quote(
        f'{environ.get("SCRIPT_NAME", "")}{environ.get("PATH_INFO", "/")}',
        safe="/:@-._~!$&'()*+,;=",
    )
    query = str(environ.get("QUERY_STRING", ""))
    return f"{path}?{query}" if query else path


def _with_request_discovery(
    environ: dict[str, Any], status: str, headers: list[tuple[str, str]]
) -> list[tuple[str, str]]:
    status_code = int(status.split(" ", 1)[0])
    content_type = next((v for k, v in headers if k.lower() == "content-type"), "")
    content_length = next((v for k, v in headers if k.lower() == "content-length"), None)
    if (
        environ.get("REQUEST_METHOD") not in {"GET", "HEAD"}
        or not _is_complete_success(status_code, headers)
        or not ("application/json" in content_type or "text/html" in content_type)
        or content_length is None
        or not content_length.isdigit()
        or int(content_length) > MAX_BODY_BYTES
    ):
        return headers
    link = request_discovery_link(_request_target(environ))
    return [*headers, ("Link", link)] if link else headers


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
            def start_response_with_request_vary(
                status: str,
                headers: list[tuple[str, str]],
                exc_info: Any = None,
            ) -> Any:
                if not _has_non_identity_content_encoding(headers):
                    headers = _with_request_vary(headers)
                    headers = _with_request_discovery(environ, status, headers)
                return start_response(status, headers, exc_info)

            return self.app(environ, start_response_with_request_vary)
        started = time.perf_counter()
        captured: dict[str, Any] = {}
        writes: list[bytes] = []
        buffered_events: list[tuple[bool, bytes]] | None = None
        buffered_write_seen = False
        live_writer: Callable[[bytes], Any] | None = None

        def capture_write(chunk: bytes) -> None:
            nonlocal buffered_write_seen
            if live_writer is not None:
                live_writer(chunk)
            elif buffered_events is not None:
                buffered_events.append((True, chunk))
                buffered_write_seen = True
            else:
                writes.append(chunk)

        def capture(status: str, headers: list[tuple[str, str]], exc_info: Any = None) -> Callable[[bytes], None]:
            captured.update(status=status, headers=list(headers), exc_info=exc_info)
            return capture_write

        body = self.app(environ, capture)
        body_iterator = iter(body)
        prefetched: list[bytes] = []
        if not captured:
            # WSGI applications may defer start_response until their iterator
            # is first advanced. Peek exactly one chunk so we can inspect the
            # real status and headers, then replay that chunk unchanged.
            try:
                prefetched.append(next(body_iterator))
            except StopIteration:
                pass
        source = _ReplayIterable(prefetched, body_iterator, getattr(body, "close", None))
        status = str(captured.get("status", "500 Error"))
        headers = list(captured.get("headers", []))
        non_identity_encoding = _has_non_identity_content_encoding(headers)
        status_code = int(status.split(" ", 1)[0])
        content_length = next((v for k, v in headers if k.lower() == "content-length"), None)
        cache_control = ",".join(
            value
            for name, value in headers
            if name.lower() in SHARED_CACHE_HEADER_NAMES
        )
        declared_length = int(content_length) if content_length and content_length.isdigit() else None
        safe_body = not writes and declared_length is not None and declared_length <= MAX_BODY_BYTES
        content_type = next((v for k, v in headers if k.lower() == "content-type"), "")
        head_eligible = (
            not non_identity_encoding
            and _is_complete_success(status_code, headers)
            and environ.get("REQUEST_METHOD") == "HEAD"
            and self.runtime.options.cache_mode == "request"
            and request_opt_in
            and ("application/json" in content_type or "text/html" in content_type)
        )
        eligible = (
            not non_identity_encoding
            and _is_complete_success(status_code, headers)
            and environ.get("REQUEST_METHOD") != "HEAD"
            and safe_body
            and self.runtime.should_instrument_http(
                request_opt_in=request_opt_in, cache_control=cache_control
            )
        )
        chunks: list[bytes] | None = None
        passthrough: Iterable[bytes] = source
        replay_events: list[tuple[bool, bytes]] | None = None
        replay_iterator: Any = None
        if eligible:
            chunks = []
            buffered_events = []
            source_iterator = iter(source)
            total = 0
            for chunk in source_iterator:
                chunks.append(chunk)
                buffered_events.append((False, chunk))
                total += len(chunk)
                if buffered_write_seen or total > MAX_BODY_BYTES:
                    eligible = False
                    replay_events = buffered_events
                    replay_iterator = source_iterator
                    chunks = None
                    break
            if eligible and buffered_write_seen:
                eligible = False
                replay_events = buffered_events
                replay_iterator = source_iterator
                chunks = None
            elif eligible:
                source.close()
            if eligible and total != declared_length:
                eligible = False
            buffered_events = None
        surface: str | None = None
        output: bytes | None = None
        payload: Any = None
        html: str | None = None
        raw = b""
        if eligible:
            raw = b"".join(chunks or [])
            content_type = next((v for k, v in headers if k.lower() == "content-type"), "")
            if "application/json" in content_type:
                try:
                    payload = json.loads(raw)
                except Exception:
                    payload = None
                if isinstance(payload, dict) and "_agentFeedback" not in payload:
                    surface = "http_json"
                elif payload is not None and not isinstance(payload, dict):
                    surface = "http_headers"
            elif "text/html" in content_type:
                try:
                    html = raw.decode()
                    surface = (
                        "http_headers"
                        if has_agent_feedback_marker(html)
                        else "http_html"
                    )
                except UnicodeDecodeError:
                    pass

        prepared = None
        if head_eligible:
            surface = "http_headers"
        if surface:
            # Resolve identity after the wrapped application (and any lazy
            # response iterator) has run so downstream authentication can
            # populate the WSGI environment first.
            context = self.runtime.context(environ)
            customer_ref = context.get("customerRef")
            prepared = self.runtime.prepare(
                customer_ref=customer_ref,
                consent_state=self.runtime.cached_consent(customer_ref),
            )
            envelope = prepared["envelope"]
            output = raw if not head_eligible else None
            if surface == "http_json" and envelope:
                payload["_agentFeedback"] = envelope
                output = json.dumps(payload, separators=(",", ":")).encode()
            elif surface == "http_html" and envelope and html is not None:
                injected_html = inject_html(html, envelope)
                if injected_html == html:
                    surface = "http_headers"
                else:
                    output = injected_html.encode()

        if prepared and prepared["envelope"] and surface:
            removed_headers = {*SHARED_CACHE_HEADER_NAMES, "agent-feedback"}
            if surface != "http_headers":
                removed_headers.update(
                    {
                        "content-length",
                        "etag",
                        "content-md5",
                        "digest",
                        "content-digest",
                        "repr-digest",
                        "content-range",
                        "accept-ranges",
                    }
                )
            headers = [
                (key, value)
                for key, value in headers
                if key.lower() not in removed_headers
            ]
            if surface != "http_headers" and output is not None:
                headers.append(("Content-Length", str(len(output))))
            headers.append(("Cache-Control", "private, no-store"))
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
        if self.runtime.options.cache_mode == "request" and not non_identity_encoding:
            headers = _with_request_vary(headers)
        writer = start_response(status, headers, captured.get("exc_info"))
        for chunk in writes:
            writer(chunk)
        live_writer = writer
        if replay_events is not None:
            return _InterleavedReplayIterable(
                replay_events, replay_iterator, source.close, writer
            )
        if prepared and surface:
            self.runtime.record(
                prepared,
                surface=surface,
                operation=_operation(environ, self.runtime),
                status_code=status_code,
                duration_ms=round((time.perf_counter() - started) * 1000),
                context=context,
            )
            self.runtime.warm_consent(customer_ref)
            return source if head_eligible else [output or b""]
        return chunks if chunks is not None else passthrough

    def shutdown(self) -> bool:
        return self.runtime.shutdown()
