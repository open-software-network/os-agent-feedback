# Stateful browser MCP ICP

A Browserbase-style MCP server. Epode records every browser tool call in one
application-level session, but asks for feedback only when useful output is
extracted or the session closes. The session-creation call is grouped using the
session ID returned by the tool result.
