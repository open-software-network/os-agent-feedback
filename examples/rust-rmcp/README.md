# Rust rmcp create/follow server

Runnable stdio MCP server using `rmcp` 3.1.0 and the Epode completion adapter.
Identity comes only from trusted deployment configuration. The product-owned
registry validates session ownership; model-authored arguments are never proof.

```sh
DEMO_ACCOUNT_REF=account_42 AGENT_FEEDBACK_KEY=af_live_... cargo run --locked
```

The adapter wraps the macro-generated handler directly and shuts down its shared
telemetry runtime after the stdio service exits.
