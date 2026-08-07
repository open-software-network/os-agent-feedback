"""Official Model Context Protocol SDK v2 instrumentation."""

from __future__ import annotations

import contextvars
import inspect
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import wraps
from typing import Any, Callable

try:
    from mcp.server.extension import Extension
    from mcp_types import CallToolResult, InputRequiredResult
except ImportError as error:  # pragma: no cover - exercised without the extra
    raise ImportError(
        "agent_feedback.mcp requires the optional MCP support; install 'agent-feedback[mcp]'"
    ) from error

from .core import AgentFeedback


@dataclass(frozen=True, slots=True)
class MCPProductContext:
    account_ref: str | None = None
    user_ref: str | None = None
    anonymous_ref: str | None = None
    customer_ref: str | None = None
    session_ref: str | None = None
    runtime_hint: str | None = None


@dataclass(slots=True)
class _Invocation:
    entered: bool = False
    handler_error: BaseException | None = None
    handler_result: Any = None
    returned: bool = False
    started_ns: int = 0
    finished_ns: int = 0
    completed_at: datetime | None = None


_invocation: contextvars.ContextVar[_Invocation | None] = contextvars.ContextVar(
    "agent_feedback_mcp_invocation", default=None
)


class MCPInstrumentation(Extension):
    """Instrument explicitly marked product tools on an official ``MCPServer``."""

    identifier = "ai.epode/agent-feedback"

    def __init__(
        self,
        feedback: AgentFeedback,
        resolve_context: Callable[[Any, Any, Any], MCPProductContext] | None = None,
    ) -> None:
        self.feedback = feedback
        self.resolve_context = resolve_context

    def instrument_tool(self, function: Callable[..., Any]) -> Callable[..., Any]:
        """Mark actual business-handler entry while preserving sync/async shape."""
        if inspect.iscoroutinefunction(function):
            @wraps(function)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                state = _invocation.get()
                if state is not None:
                    state.entered, state.started_ns = True, time.monotonic_ns()
                try:
                    result = await function(*args, **kwargs)
                    if state is not None:
                        state.finished_ns = time.monotonic_ns()
                        state.completed_at = datetime.now(timezone.utc)
                        state.handler_result, state.returned = result, True
                    return result
                except BaseException as error:
                    if state is not None:
                        state.finished_ns = time.monotonic_ns()
                        state.completed_at = datetime.now(timezone.utc)
                        state.handler_error = error
                    raise
            return async_wrapper

        @wraps(function)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            state = _invocation.get()
            if state is not None:
                state.entered, state.started_ns = True, time.monotonic_ns()
            try:
                result = function(*args, **kwargs)
                if state is not None:
                    state.finished_ns = time.monotonic_ns()
                    state.completed_at = datetime.now(timezone.utc)
                    state.handler_result, state.returned = result, True
                return result
            except BaseException as error:
                if state is not None:
                    state.finished_ns = time.monotonic_ns()
                    state.completed_at = datetime.now(timezone.utc)
                    state.handler_error = error
                raise
        return sync_wrapper

    async def intercept_tool_call(self, params: Any, ctx: Any, call_next: Any) -> Any:
        state = _Invocation()
        token = _invocation.set(state)
        try:
            try:
                result = await call_next(ctx)
            except BaseException as error:
                # Framework validation/conversion can fail after the product
                # handler. Only the exact exception raised by that handler is
                # a completed product interaction.
                if state.entered and error is state.handler_error:
                    try:
                        self._record(params, ctx, None, state, "error")
                    except Exception:
                        pass
                raise
            if not state.entered or isinstance(result, InputRequiredResult):
                return result
            if isinstance(result, CallToolResult) and result.is_error:
                # An error generated while validating/converting an ordinary
                # return value is a framework failure, not product completion.
                explicit_error = (
                    state.returned
                    and isinstance(state.handler_result, CallToolResult)
                    and state.handler_result.is_error
                )
                if state.handler_error is None and not explicit_error:
                    return result
                outcome = "error"
            else:
                outcome = "success"
            # MCP v2's adapter may omit structured_content while converting a
            # decorated handler's mapping. Give context resolution the original
            # product result so canonical identifiers returned by the handler
            # remain observable.
            resolution_result = state.handler_result if state.returned else result
            try:
                self._record(params, ctx, resolution_result, state, outcome)
            except Exception:
                pass
            return result
        finally:
            _invocation.reset(token)

    def _record(self, params: Any, ctx: Any, result: Any, state: _Invocation, outcome: str) -> None:
        if not self.feedback.enabled or self.feedback.telemetry.stop.is_set():
            return
        product_context = MCPProductContext()
        if self.resolve_context is not None:
            try:
                candidate = self.resolve_context(params, ctx, result)
                if isinstance(candidate, MCPProductContext):
                    product_context = candidate
            except Exception:
                pass
        values = {name: getattr(product_context, name) for name in product_context.__slots__}
        try:
            self.feedback._record_mcp_interaction(
                params.name, outcome,
                duration_ms=max(0, (state.finished_ns - state.started_ns) // 1_000_000),
                completed_at=state.completed_at,
                **values,
            )
        except Exception:
            # Instrumentation must never alter the framework-visible completion.
            pass

__all__ = ["MCPInstrumentation", "MCPProductContext"]
