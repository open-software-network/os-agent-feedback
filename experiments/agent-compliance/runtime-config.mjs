export function mcpClientArguments(runtime, run, mcpServer) {
  if (run?.surface !== "mcp") return [];
  const serverArguments = [
    mcpServer,
    "--run-id",
    run.id,
    "--base-url",
    run.baseUrl,
    "--placement",
    run.placement,
    "--copy",
    run.copy,
  ];
  if (runtime === "codex") {
    return [
      "-c",
      'mcp_servers.acme.command="node"',
      "-c",
      `mcp_servers.acme.args=${JSON.stringify(serverArguments)}`,
      "-c",
      "mcp_servers.acme.startup_timeout_sec=10",
    ];
  }
  if (runtime === "claude") {
    return [
      "--mcp-config",
      JSON.stringify({
        mcpServers: { acme: { type: "stdio", command: "node", args: serverArguments } },
      }),
      "--strict-mcp-config",
    ];
  }
  throw new Error(`Unsupported MCP runtime: ${runtime}`);
}
