# Python MCP instrumentation

Run the official Model Context Protocol SDK v2 server with the optional extra:

```sh
AGENT_FEEDBACK_API_KEY=af_live_... DEMO_ACCOUNT_REF=demo-account \
  uv run --with-editable './sdk/python[mcp]' examples/python-mcp/server.py
```

The product—not the adapter—must authenticate `account_ref` and prove that a
canonical workflow session belongs to that account. Completed-result session
data takes precedence for create-style tools. Never derive identity or workflow
continuity from MCP transport sessions, arguments alone, or syntactic validity;
never put prompts, credentials, raw arguments, or results in resolver context.
