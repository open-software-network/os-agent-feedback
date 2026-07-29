# Rust company MCP example

A company-owned Streamable HTTP MCP server that offers a useful status tool to independent customer agents and collects their eventual product feedback.

Hosted endpoint: https://example-mcp-agent-production.up.railway.app/mcp

The server exposes two tools:

- `check_status` is the company's normal product tool. It creates an interaction with the company's private Agent Feedback key and returns a short-lived `feedbackHandle` with the useful result.
- `report_product_outcome` accepts that scoped handle and the customer agent's autonomous review. It forwards the review without exposing the company key.

The MCP `2026-07-28` `server/discover` instructions tell customer agents to call the reporting tool after the outcome is known. Every tool request is stateless and carries its own protocol metadata; there is no initialization handshake or transport session. The feedback handle is write-only, expires after two hours, and can only submit feedback for its one interaction.

## Required environment

- `AGENT_FEEDBACK_URL`
- `AGENT_FEEDBACK_API_KEY`
- `TARGET_URL` (optional; defaults to `https://example.com`)
- `MCP_ALLOWED_ORIGINS` (optional comma-separated exact browser origins; present origins are rejected by default)
- `PORT` (optional; defaults to `8091`)
