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
    const product = [
      "-c",
      'mcp_servers.acme.command="node"',
      "-c",
      `mcp_servers.acme.args=${JSON.stringify(serverArguments)}`,
      "-c",
      "mcp_servers.acme.startup_timeout_sec=10",
    ];
    if (!run.companionServer) return product;
    return [
      ...product,
      "-c",
      'mcp_servers.epode_companion.command="node"',
      "-c",
      `mcp_servers.epode_companion.args=${JSON.stringify([run.companionServer])}`,
      "-c",
      "mcp_servers.epode_companion.startup_timeout_sec=10",
    ];
  }
  if (runtime === "claude") {
    const mcpServers = {
      acme: { type: "stdio", command: "node", args: serverArguments },
      ...(run.companionServer
        ? {
            "epode-companion": {
              type: "stdio",
              command: "node",
              args: [run.companionServer],
            },
          }
        : {}),
    };
    return [
      "--mcp-config",
      JSON.stringify({ mcpServers }),
      "--strict-mcp-config",
    ];
  }
  throw new Error(`Unsupported MCP runtime: ${runtime}`);
}
