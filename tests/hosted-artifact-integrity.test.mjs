import test from "node:test";

import { syncExampleSdkIntegrity } from "./sync-example-sdk-integrity.mjs";

test("hosted Node examples lock the exact committed SDK artifact", async () => {
  await syncExampleSdkIntegrity();
});
