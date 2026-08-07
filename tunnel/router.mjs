#!/usr/bin/env node
// Host-header reverse proxy for the public tunnel lab.
//
// One cloudflared tunnel fronts `*.<base-domain>`; this router listens on one
// local port and dispatches each request to the example server registered for
// the first host label in the routes file. Routes reload on file change, so
// `tunnel.sh route add` takes effect without a restart.

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_ROUTER_PORT = 8400;

function readRoutesFile(routesFile) {
  const raw = fs.readFileSync(routesFile, "utf8");
  const parsed = JSON.parse(raw);
  const routes = new Map();
  for (const [name, port] of Object.entries(parsed)) {
    if (typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535) {
      routes.set(name.toLowerCase(), port);
    }
  }
  return routes;
}

export function createRoutesCache(routesFile, logger = () => {}) {
  let cached = { mtimeMs: -1, routes: new Map() };
  return function getRoutes() {
    let stat;
    try {
      stat = fs.statSync(routesFile);
    } catch {
      if (cached.mtimeMs !== 0)
        logger(`routes file ${routesFile} missing; serving empty route set`);
      cached = { mtimeMs: 0, routes: new Map() };
      return cached.routes;
    }
    if (stat.mtimeMs === cached.mtimeMs) return cached.routes;
    try {
      cached = { mtimeMs: stat.mtimeMs, routes: readRoutesFile(routesFile) };
    } catch (error) {
      logger(`routes file ${routesFile} unreadable (${error.message}); keeping previous routes`);
    }
    return cached.routes;
  };
}

export function resolveRoute(hostHeader, routes, baseDomain) {
  if (!hostHeader) return null;
  const host = hostHeader.split(":")[0].toLowerCase();
  if (routes.has(host)) return { name: host, port: routes.get(host) };
  if (baseDomain && host === baseDomain) return null;
  const firstLabel = host.split(".")[0];
  if (routes.has(firstLabel)) return { name: firstLabel, port: routes.get(firstLabel) };
  return null;
}

function isIndexHost(hostHeader, baseDomain) {
  if (!hostHeader) return false;
  const host = hostHeader.split(":")[0].toLowerCase();
  return host === baseDomain || host === "localhost" || host === "127.0.0.1";
}

function renderIndex(routes, baseDomain) {
  const scheme = "https";
  const rows = [...routes.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, port]) => {
      const url = baseDomain ? `${scheme}://${name}.${baseDomain}` : `port ${port}`;
      const link = baseDomain ? `<a href="${url}">${url}</a>` : url;
      return `<li><strong>${name}</strong> &rarr; 127.0.0.1:${port} &mdash; ${link}</li>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>epode tunnel lab</title></head>
<body style="font-family: ui-monospace, monospace; margin: 2rem;">
  <h1>epode tunnel lab</h1>
  <p>Host-header routes served by this router:</p>
  <ul>
${rows || "    <li>No routes yet. Add one with <code>make tunnel-route NAME=demo PORT=4311</code>.</li>"}
  </ul>
</body>
</html>`;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(`${payload}\n`);
}

function forwardedHeaders(req, targetPort) {
  const headers = { ...req.headers };
  headers.host = `127.0.0.1:${targetPort}`;
  headers["x-forwarded-host"] = req.headers.host ?? "";
  headers["x-forwarded-proto"] = req.headers["x-forwarded-proto"] ?? "https";
  const priorFor = req.headers["x-forwarded-for"];
  headers["x-forwarded-for"] = priorFor
    ? `${priorFor}, ${req.socket.remoteAddress}`
    : req.socket.remoteAddress;
  return headers;
}

export function createRouter({ routesFile, baseDomain = "", logger = () => {} }) {
  const getRoutes = createRoutesCache(routesFile, logger);

  const server = http.createServer((req, res) => {
    const routes = getRoutes();
    if (
      isIndexHost(req.headers.host, baseDomain) &&
      (req.url === "/" || req.url === "/index.html")
    ) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderIndex(routes, baseDomain));
      return;
    }
    const route = resolveRoute(req.headers.host, routes, baseDomain);
    if (!route) {
      sendJson(res, 404, {
        error: "unknown_route",
        host: req.headers.host ?? null,
        knownRoutes: [...routes.keys()].sort(),
      });
      return;
    }
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: route.port,
        method: req.method,
        path: req.url,
        headers: forwardedHeaders(req, route.port),
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", (error) => {
      if (!res.headersSent) {
        sendJson(res, 502, {
          error: "upstream_unreachable",
          route: route.name,
          target: `127.0.0.1:${route.port}`,
          detail: error.code ?? error.message,
        });
      } else {
        res.destroy();
      }
    });
    req.pipe(upstream);
  });

  server.on("upgrade", (req, socket, head) => {
    const route = resolveRoute(req.headers.host, getRoutes(), baseDomain);
    if (!route) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const upstream = net.connect(route.port, "127.0.0.1", () => {
      const headers = forwardedHeaders(req, route.port);
      let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (const [key, value] of Object.entries(headers)) {
        raw += `${key}: ${value}\r\n`;
      }
      raw += "\r\n";
      upstream.write(raw);
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(socket).pipe(upstream);
    });
    upstream.on("error", () => {
      socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      socket.destroy();
    });
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  });

  return server;
}

export async function startRouter({
  port = DEFAULT_ROUTER_PORT,
  routesFile,
  baseDomain = "",
  logger = () => {},
} = {}) {
  if (!routesFile) throw new Error("startRouter requires routesFile");
  const server = createRouter({ routesFile, baseDomain, logger });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  return { server, port: address.port };
}

function parseCliArgs(argv) {
  const args = { port: DEFAULT_ROUTER_PORT, routesFile: "", baseDomain: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port") args.port = Number(argv[++index]);
    else if (arg === "--routes") args.routesFile = argv[++index];
    else if (arg === "--base-domain") args.baseDomain = argv[++index];
  }
  return args;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args.routesFile) {
    console.error(
      "usage: router.mjs --routes <routes.json> [--port 8400] [--base-domain lab.example.com]",
    );
    process.exit(1);
  }
  const logger = (message) => console.error(`[tunnel-router] ${message}`);
  const { port } = await startRouter({
    port: args.port,
    routesFile: args.routesFile,
    baseDomain: args.baseDomain,
    logger,
  });
  console.log(
    `[tunnel-router] listening on http://127.0.0.1:${port}` +
      (args.baseDomain ? ` for *.${args.baseDomain}` : ""),
  );
}
