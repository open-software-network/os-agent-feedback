import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration39 = new URL(
  "../backend/migrations/0039_customer_request_observations.sql",
  import.meta.url,
);

test("migration 39 keeps its production-applied SQLx checksum", async () => {
  const source = await readFile(migration39);
  const checksum = createHash("sha384").update(source).digest("hex");

  assert.equal(
    checksum,
    "c947cc2a273dcaa0939f3e9d3f11de1e7e5a167e8fb8c8805b33516651c4b32bb7f69bf1fa115729015884d866e76d6f",
    "changing the production-applied migration prevents deployed databases from starting",
  );
});
