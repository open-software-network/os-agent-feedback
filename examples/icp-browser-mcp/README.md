# Stateful browser MCP ICP

A Browserbase-style MCP server. Epode records every browser tool call in one
application-level session, but asks for feedback only when useful output is
extracted or the session closes. The server derives the journey only from its
verified OAuth connection context; caller tool arguments never establish identity or continuity.
