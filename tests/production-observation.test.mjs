import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const script = new URL("../scripts/verify-production-observation.sh", import.meta.url).pathname;

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

const observationEnv = {
  ...process.env,
  EPODE_OBSERVATION_ALLOW_HTTP_LOCALHOST: "1",
  EPODE_OBSERVATION_SECONDS: "1",
  EPODE_OBSERVATION_INTERVAL_SECONDS: "1",
  EPODE_OBSERVATION_FAILURE_THRESHOLD: "2",
  EPODE_OBSERVATION_MAX_LATENCY_SECONDS: "2",
};

test("production observation accepts a continuously healthy API and web pair", async () => {
  const api = await listen((request, response) => {
    response.writeHead(request.url === "/api/health" ? 200 : 404).end();
  });
  const web = await listen((request, response) => {
    if (request.url === "/") {
      response.writeHead(307, { location: "/auth/signin" }).end();
      return;
    }
    response.writeHead(request.url === "/auth/signin" ? 200 : 404).end("ok");
  });
  try {
    const { stdout } = await execFileAsync("bash", [script, api.origin, web.origin], {
      env: observationEnv,
      timeout: 5_000,
    });
    assert.match(stdout, /Production observation passed for 1s/);
    assert.match(stdout, /Web root probe returned HTTP 200 .* after 1 redirect/);
  } finally {
    await Promise.all([api.close(), web.close()]);
  }
});

test("production observation trips when the web redirect never becomes healthy", async () => {
  const api = await listen((request, response) => {
    response.writeHead(request.url === "/api/health" ? 200 : 404).end();
  });
  const web = await listen((_request, response) => {
    response.writeHead(307, { location: "/" }).end();
  });
  try {
    await assert.rejects(
      execFileAsync("bash", [script, api.origin, web.origin], {
        env: { ...observationEnv, EPODE_OBSERVATION_SECONDS: "10" },
        timeout: 5_000,
      }),
      (error) => {
        assert.match(
          `${error.stdout}\n${error.stderr}`,
          /circuit breaker tripped after 2 consecutive failed samples/,
        );
        return true;
      },
    );
  } finally {
    await Promise.all([api.close(), web.close()]);
  }
});

test("production observation trips after consecutive availability failures", async () => {
  const api = await listen((_request, response) => response.writeHead(503).end());
  const web = await listen((_request, response) => response.writeHead(200).end("ok"));
  try {
    await assert.rejects(
      execFileAsync("bash", [script, api.origin, web.origin], {
        env: { ...observationEnv, EPODE_OBSERVATION_SECONDS: "10" },
        timeout: 5_000,
      }),
      (error) => {
        assert.match(
          `${error.stdout}\n${error.stderr}`,
          /circuit breaker tripped after 2 consecutive failed samples/,
        );
        return true;
      },
    );
  } finally {
    await Promise.all([api.close(), web.close()]);
  }
});
