import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const tsc = fileURLToPath(new URL("../node_modules/.bin/tsc", import.meta.url));

test("strict callbacks and a real MCP v2 server satisfy the public instrumentation types", () => {
  execFileSync(
    tsc,
    [
      "--noEmit",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--skipLibCheck",
      "test/mcp-types.fixture.ts",
    ],
    { cwd: packageDirectory, stdio: "pipe" },
  );
});
