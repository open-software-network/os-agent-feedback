# Connecting an MCP client with a read key

Reference config for the read-scoped product key (EPD-2), verified against each
client's own documentation as part of [EPD-3](https://app.opensoftware.co/epode/issues/3).

These snippets live here rather than on the issue because the os-platform WAF
rejects comment bodies containing them.

Every client below supports a static `Authorization: Bearer` header on a remote
HTTP MCP server, and every one supports keeping the secret out of the committed
file. The **interpolation syntax differs per client** — that is the constraint
EPD-7's install snippet has to design around.

## Claude Code

`headers` is a documented environment-variable expansion location, alongside
`command`, `args`, `env`, and `url`.

```json
{
  "mcpServers": {
    "agent-feedback": {
      "type": "http",
      "url": "https://app.epode.ai/mcp",
      "headers": { "Authorization": "Bearer ${AGENT_FEEDBACK_READ_KEY}" }
    }
  }
}
```

- Syntax: `${VAR}`, or `${VAR:-default}` to supply a fallback.
- `type` is required. An entry with a `url` but no `type` is a configuration
  error — Claude Code reads it as a stdio server and skips it.
- `streamable-http` is accepted as an alias for `http`, so config copied from
  server docs works unmodified.
- If the variable is unset with no default, the config still loads: the server
  is reported with a missing-variable warning in `claude mcp list` and the
  literal `${VAR}` text is sent.

CLI equivalent:

```sh
claude mcp add --transport http agent-feedback https://app.epode.ai/mcp \
  --header "Authorization: Bearer $AGENT_FEEDBACK_READ_KEY"
```

## Cursor

```json
{
  "mcpServers": {
    "agent-feedback": {
      "url": "https://app.epode.ai/mcp",
      "headers": { "Authorization": "Bearer ${env:AGENT_FEEDBACK_READ_KEY}" }
    }
  }
}
```

Note the `env:` prefix inside the braces — Cursor's syntax, not Claude Code's.

## VS Code

VS Code prompts for the secret once and stores it securely, so nothing lands in
the file at all.

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "epode-read-key",
      "description": "Agent Feedback read key",
      "password": true
    }
  ],
  "servers": {
    "agent-feedback": {
      "type": "http",
      "url": "https://app.epode.ai/mcp",
      "headers": { "Authorization": "Bearer ${input:epode-read-key}" }
    }
  }
}
```

`${env:VAR}` also works. Note the top-level key is `servers`, not `mcpServers`.

VS Code's schema carries an `oauth` block alongside `headers`, so clients
already model a server picking one scheme or the other.

## Server-side obligations

- **Do not publish OAuth metadata epode does not implement.** The MCP
  authorization spec's hard requirements (protected-resource metadata,
  authorization-server metadata) bind only servers that implement OAuth.
  Advertising them would make compliant clients start a handshake that goes
  nowhere.
- **Return 401 for invalid or expired tokens.** The spec's error table expects
  401 (invalid/absent) and 403 (insufficient scope). `mcp_handler` currently
  maps an auth failure to a JSON-RPC result with `isError` over HTTP 200, which
  is neither — and cannot express "expired" as distinct from "invalid", which
  EPD-2 requires.
