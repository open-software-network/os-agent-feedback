import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";

import { assertPortAvailable } from "./setup-matrix-process.mjs";

test("setup matrix refuses to mistake a stale listener for the process it launched", async () => {
  const stale = createServer();
  await new Promise((resolve, reject) => {
    stale.once("error", reject);
    stale.listen(0, "127.0.0.1", resolve);
  });
  const address = stale.address();
  assert.ok(address && typeof address === "object");
  await assert.rejects(
    assertPortAvailable(address.port, "Epode Rust backend"),
    /already in use; stop the stale process/i,
  );
  await new Promise((resolve, reject) =>
    stale.close((error) => (error ? reject(error) : resolve())),
  );
  await assert.doesNotReject(assertPortAvailable(address.port, "Epode Rust backend"));
});
