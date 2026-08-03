import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function make(args) {
  return execFileSync("make", ["--no-print-directory", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

test("dev-env creates missing files and preserves existing contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "epode-dev-env-"));
  const backendEnv = join(directory, "backend.env");
  const webEnv = join(directory, "web.env.local");
  const variables = [`DEV_BACKEND_ENV_FILE=${backendEnv}`, `DEV_WEB_ENV_FILE=${webEnv}`];

  try {
    const created = make(["dev-env", ...variables]);
    assert.match(created, /Created .*backend\.env/);
    assert.match(created, /Created .*web\.env\.local/);
    assert.equal(
      await readFile(backendEnv, "utf8"),
      await readFile(join(repoRoot, "backend/.env.example"), "utf8"),
    );
    assert.equal(
      await readFile(webEnv, "utf8"),
      await readFile(join(repoRoot, "web/.env.example"), "utf8"),
    );

    const customBackend = [
      "DATABASE_URL=postgres://custom.invalid/custom",
      "DEV_AUTH_ENABLED=true",
      "DEV_AUTH_SIGNING_KEY=fake-test-value",
      "UNRELATED=value",
      "",
    ].join("\n");
    const customWeb = "API_URL=http://127.0.0.1:9999\nDEV_AUTH_ENABLED=true\n";
    await writeFile(backendEnv, customBackend);
    await writeFile(webEnv, customWeb);

    const preserved = make(["dev-env", ...variables]);
    assert.match(preserved, /Preserved .*backend\.env/);
    assert.match(preserved, /Preserved .*web\.env\.local/);
    assert.equal(await readFile(backendEnv, "utf8"), customBackend);
    assert.equal(await readFile(webEnv, "utf8"), customWeb);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dev-bootstrap prepares prerequisites but leaves app processes separate", () => {
  const output = make(["-n", "dev-bootstrap"]);

  assert.match(output, /pnpm install --frozen-lockfile/);
  assert.match(output, /rustup component add clippy rustfmt/);
  assert.match(output, /backend\/\.env\.example/);
  assert.match(output, /docker-compose -f backend\/docker-compose\.yml up -d --wait postgres/);
  assert.doesNotMatch(output, /cargo run/);
  assert.doesNotMatch(output, /@epode\/web dev/);
  assert.doesNotMatch(output, /seed_dashboard_demo|seed:dashboard-demo/);
  assert.doesNotMatch(output, /sqlx migrate/);
});

test("dev-backend selects the API binary explicitly", () => {
  const output = make(["-n", "dev-backend"]);
  assert.match(output, /cargo run --locked --bin agent-feedback/);
});

test("Podman mode rediscovers its socket for bootstrap and backend startup", () => {
  const bootstrap = make(["-n", "dev-bootstrap", "DEV_CONTAINER_RUNTIME=podman"]);
  const backend = make(["-n", "dev-backend", "DEV_CONTAINER_RUNTIME=podman"]);

  for (const output of [bootstrap, backend]) {
    assert.match(output, /podman info --format/);
    assert.match(output, /DOCKER_HOST=.*podman info.*docker-compose/);
  }
  assert.match(bootstrap, /make dev-backend DEV_CONTAINER_RUNTIME=podman/);
});

test("skill and README expose the canonical workflow", async () => {
  const [readme, skill] = await Promise.all([
    readFile(join(repoRoot, "README.md"), "utf8"),
    readFile(join(repoRoot, ".agents/skills/bootstrapping-project/SKILL.md"), "utf8"),
  ]);

  assert.match(skill, /^name: bootstrapping-project$/m);
  for (const source of [readme, skill]) {
    assert.match(source, /make dev-bootstrap/);
    assert.match(source, /make dev-backend/);
    assert.match(source, /make dev-web/);
  }
  assert.match(readme, /make dev-backend DEV_CONTAINER_RUNTIME=podman/);
  assert.match(skill, /make dev-backend DEV_CONTAINER_RUNTIME=podman/);
  assert.doesNotMatch(skill, /scripts\/bootstrap|configure_env/);
});
