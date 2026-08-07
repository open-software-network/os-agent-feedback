import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { resolveRoute, startRouter } from "../tunnel/router.mjs";

const execFileAsync = promisify(execFile);
const TUNNEL_SH = path.resolve(import.meta.dirname, "../tunnel/tunnel.sh");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-lab-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function createEchoUpstream() {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
  });
}

function httpRequest({ port, host, url = "/", method = "GET", body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: url, method, headers: { host, ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function freePort() {
  const probe = net.createServer();
  const port = await listen(probe);
  await closeServer(probe);
  return port;
}

async function poll(fn, { attempts = 40, delayMs = 50 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

test("resolveRoute matches exact hosts and first labels, skips the apex", () => {
  const routes = new Map([["commerce", 4311]]);
  assert.deepEqual(resolveRoute("commerce.lab.test", routes, "lab.test"), {
    name: "commerce",
    port: 4311,
  });
  assert.deepEqual(resolveRoute("Commerce.LAB.test:443", routes, "lab.test"), {
    name: "commerce",
    port: 4311,
  });
  assert.equal(resolveRoute("lab.test", routes, "lab.test"), null);
  assert.equal(resolveRoute("other.lab.test", routes, "lab.test"), null);
  assert.equal(resolveRoute(undefined, routes, "lab.test"), null);
});

test("routes requests by host label and sets forwarded headers", async (t) => {
  const dir = tempDir(t);
  const routesFile = path.join(dir, "routes.json");
  const upstreamA = createEchoUpstream();
  const upstreamB = createEchoUpstream();
  const portA = await listen(upstreamA);
  const portB = await listen(upstreamB);
  fs.writeFileSync(routesFile, JSON.stringify({ alpha: portA, beta: portB }));
  const { server: router, port: routerPort } = await startRouter({
    port: 0,
    routesFile,
    baseDomain: "lab.test",
  });
  t.after(async () => {
    await closeServer(router);
    await closeServer(upstreamA);
    await closeServer(upstreamB);
  });

  const resA = await httpRequest({
    port: routerPort,
    host: "alpha.lab.test",
    url: "/mcp?x=1",
    method: "POST",
    body: "hello",
  });
  assert.equal(resA.status, 200);
  const echoedA = JSON.parse(resA.body);
  assert.equal(echoedA.method, "POST");
  assert.equal(echoedA.url, "/mcp?x=1");
  assert.equal(echoedA.body, "hello");
  assert.equal(echoedA.headers.host, `127.0.0.1:${portA}`);
  assert.equal(echoedA.headers["x-forwarded-host"], "alpha.lab.test");
  assert.equal(echoedA.headers["x-forwarded-proto"], "https");

  const resB = await httpRequest({ port: routerPort, host: "beta.lab.test" });
  assert.equal(JSON.parse(resB.body).headers.host, `127.0.0.1:${portB}`);
});

test("returns 404 with known routes for unknown hosts", async (t) => {
  const dir = tempDir(t);
  const routesFile = path.join(dir, "routes.json");
  fs.writeFileSync(routesFile, JSON.stringify({ alpha: 4311 }));
  const { server: router, port: routerPort } = await startRouter({ port: 0, routesFile });
  t.after(() => closeServer(router));

  const res = await httpRequest({ port: routerPort, host: "nope.lab.test" });
  assert.equal(res.status, 404);
  const body = JSON.parse(res.body);
  assert.equal(body.error, "unknown_route");
  assert.deepEqual(body.knownRoutes, ["alpha"]);
});

test("returns 502 when the upstream is unreachable", async (t) => {
  const dir = tempDir(t);
  const routesFile = path.join(dir, "routes.json");
  const deadPort = await freePort();
  fs.writeFileSync(routesFile, JSON.stringify({ down: deadPort }));
  const { server: router, port: routerPort } = await startRouter({ port: 0, routesFile });
  t.after(() => closeServer(router));

  const res = await httpRequest({ port: routerPort, host: "down.lab.test" });
  assert.equal(res.status, 502);
  const body = JSON.parse(res.body);
  assert.equal(body.error, "upstream_unreachable");
  assert.equal(body.route, "down");
});

test("picks up routes file changes without a restart", async (t) => {
  const dir = tempDir(t);
  const routesFile = path.join(dir, "routes.json");
  const upstream = createEchoUpstream();
  const upstreamPort = await listen(upstream);
  fs.writeFileSync(routesFile, JSON.stringify({}));
  const { server: router, port: routerPort } = await startRouter({ port: 0, routesFile });
  t.after(async () => {
    await closeServer(router);
    await closeServer(upstream);
  });

  const before = await httpRequest({ port: routerPort, host: "gamma.lab.test" });
  assert.equal(before.status, 404);

  fs.writeFileSync(routesFile, JSON.stringify({ gamma: upstreamPort }));
  // Guarantee an mtime bump so the cache notices even on same-millisecond writes.
  const bumped = new Date(Date.now() + 5000);
  fs.utimesSync(routesFile, bumped, bumped);

  const res = await poll(async () => {
    const attempt = await httpRequest({ port: routerPort, host: "gamma.lab.test" });
    assert.equal(attempt.status, 200);
    return attempt;
  });
  assert.equal(JSON.parse(res.body).headers["x-forwarded-host"], "gamma.lab.test");
});

test("serves a route index on the apex and localhost", async (t) => {
  const dir = tempDir(t);
  const routesFile = path.join(dir, "routes.json");
  fs.writeFileSync(routesFile, JSON.stringify({ commerce: 4311 }));
  const { server: router, port: routerPort } = await startRouter({
    port: 0,
    routesFile,
    baseDomain: "lab.test",
  });
  t.after(() => closeServer(router));

  const apex = await httpRequest({ port: routerPort, host: "lab.test" });
  assert.equal(apex.status, 200);
  assert.match(apex.body, /commerce/);
  assert.match(apex.body, /https:\/\/commerce\.lab\.test/);

  const local = await httpRequest({ port: routerPort, host: `localhost:${routerPort}` });
  assert.equal(local.status, 200);
  assert.match(local.body, /commerce/);
});

function createWsEchoUpstream() {
  const server = http.createServer((_req, res) => {
    res.writeHead(426);
    res.end("upgrade required");
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.destroySockets = () => {
    for (const socket of sockets) socket.destroy();
  };
  server.on("upgrade", (req, socket) => {
    const accept = crypto
      .createHash("sha1")
      .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on("data", (chunk) => {
      const length = chunk[1] & 0x7f;
      const mask = chunk.subarray(2, 6);
      const payload = Buffer.from(chunk.subarray(6, 6 + length));
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
      socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    });
  });
  return server;
}

async function wsRoundTrip(port, host, message) {
  const socket = net.connect(port, "127.0.0.1");
  const readUntil = (predicate) =>
    new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (predicate(buffer)) {
          socket.off("data", onData);
          socket.off("error", onError);
          resolve(buffer);
        }
      };
      const onError = (error) => {
        socket.off("data", onData);
        reject(error);
      };
      socket.on("data", onData);
      socket.on("error", onError);
    });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const key = crypto.randomBytes(16).toString("base64");
  socket.write(
    `GET /ws HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );

  const handshake = await readUntil((buffer) => buffer.includes("\r\n\r\n"));
  const headerText = handshake.toString();
  assert.match(headerText, /101 Switching Protocols/);

  const payload = Buffer.from(message);
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] ^= mask[index % 4];
  }
  const frameRead = readUntil((buffer) => buffer.length >= 2 + payload.length);
  socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | masked.length]), mask, masked]));

  const frame = await frameRead;
  socket.destroy();
  assert.equal(frame[0], 0x81);
  assert.equal(frame[1], payload.length);
  return frame.subarray(2, 2 + payload.length).toString();
}

test("proxies websocket upgrades to the routed upstream", async (t) => {
  const dir = tempDir(t);
  const routesFile = path.join(dir, "routes.json");
  const wsUpstream = createWsEchoUpstream();
  const wsPort = await listen(wsUpstream);
  fs.writeFileSync(routesFile, JSON.stringify({ live: wsPort }));
  const { server: router, port: routerPort } = await startRouter({ port: 0, routesFile });
  t.after(async () => {
    wsUpstream.destroySockets();
    await closeServer(router);
    await closeServer(wsUpstream);
  });

  assert.equal(await wsRoundTrip(routerPort, "live.lab.test", "ping"), "ping");
});

test("tunnel.sh route add/rm manage the routes file", async (t) => {
  const dir = tempDir(t);
  const routesFile = path.join(dir, "routes.json");
  const defaultsFile = path.join(dir, "defaults.json");
  fs.writeFileSync(defaultsFile, JSON.stringify({ seed: 4000 }));
  const env = {
    ...process.env,
    TUNNEL_ROUTES_FILE: routesFile,
    TUNNEL_DEFAULTS_FILE: defaultsFile,
    TUNNEL_CONFIG_FILE: path.join(dir, "config.yml"),
  };

  const add = await execFileAsync("bash", [TUNNEL_SH, "route", "add", "demo", "4311"], { env });
  assert.match(add.stdout, /demo -> 127\.0\.0\.1:4311/);
  assert.deepEqual(JSON.parse(fs.readFileSync(routesFile, "utf8")), { seed: 4000, demo: 4311 });

  await assert.rejects(
    execFileAsync("bash", [TUNNEL_SH, "route", "add", "BAD NAME", "4311"], { env }),
  );
  await assert.rejects(
    execFileAsync("bash", [TUNNEL_SH, "route", "add", "demo", "99999"], { env }),
  );

  const list = await execFileAsync("bash", [TUNNEL_SH, "route", "ls"], { env });
  assert.match(list.stdout, /demo\s+127\.0\.0\.1:4311/);

  await execFileAsync("bash", [TUNNEL_SH, "route", "rm", "demo"], { env });
  assert.deepEqual(JSON.parse(fs.readFileSync(routesFile, "utf8")), { seed: 4000 });
  await assert.rejects(execFileAsync("bash", [TUNNEL_SH, "route", "rm", "demo"], { env }));
});
