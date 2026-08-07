"""Small product-owned MCP journey instrumented with Agent Feedback."""

import os
from collections.abc import Mapping
from uuid import uuid4

from agent_feedback import AgentFeedback, AgentFeedbackOptions
from agent_feedback.mcp import MCPInstrumentation, MCPProductContext
from mcp.server import MCPServer

feedback = AgentFeedback(AgentFeedbackOptions(api_key=os.environ["AGENT_FEEDBACK_API_KEY"]))
authenticated_account = os.environ["DEMO_ACCOUNT_REF"]
journeys: dict[str, str] = {}  # canonical session -> authenticated owning account


def product_context(params, _context, result) -> MCPProductContext:
    arguments = params.arguments or {}
    # In production this comes from deployment authentication/request context,
    # never from model-controlled tool arguments.
    account = authenticated_account
    result_session = result if isinstance(result, Mapping) else (
        getattr(result, "structured_content", None) or {}
    )
    session = result_session.get("session_ref") or arguments.get("session_ref")
    if not isinstance(account, str) or not isinstance(session, str):
        return MCPProductContext(runtime_hint="python-mcp-v2")
    if journeys.get(session) != account:
        return MCPProductContext(runtime_hint="python-mcp-v2")
    return MCPProductContext(
        account_ref=account, session_ref=session, runtime_hint="python-mcp-v2"
    )


instrumentation = MCPInstrumentation(feedback, resolve_context=product_context)
server = MCPServer("agent-feedback-example", extensions=[instrumentation])


@server.tool()
@instrumentation.instrument_tool
def create_summary(text: str) -> dict[str, str]:
    """Create a product journey; never place raw text in telemetry context."""
    session_ref = f"summary:{uuid4()}"
    journeys[session_ref] = authenticated_account
    return {"session_ref": session_ref, "summary": text[:80]}


@server.tool()
@instrumentation.instrument_tool
async def revise_summary(session_ref: str, text: str) -> dict[str, str]:
    """Continue only a journey proven to belong to the authenticated account."""
    if journeys.get(session_ref) != authenticated_account:
        raise ValueError("unknown summary")
    return {"session_ref": session_ref, "summary": text[:80]}


if __name__ == "__main__":
    try:
        server.run()
    finally:
        feedback.shutdown()
