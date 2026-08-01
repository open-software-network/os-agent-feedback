import assert from "node:assert/strict";
import test from "node:test";
import {
  MCP_REPORT_RETRY_DELAY_MS,
  submitMcpReportWithOneRetry,
} from "./setup-matrix-mcp-retry.mjs";

function response(structuredContent) {
  return { result: { structuredContent } };
}

test("MCP report submission retries exactly once with the same report and a fresh RPC id", async () => {
  const reportArguments = {
    feedbackHandle: "afr2_same_handle",
    summary: "The same report must be retried.",
  };
  const calls = [];
  const waits = [];
  const { payload, attempts } = await submitMcpReportWithOneRetry({
    id: 41,
    reportArguments,
    call: async (call) => {
      calls.push(call);
      return response({ accepted: false, retryable: true });
    },
    wait: async (delayMs) => waits.push(delayMs),
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map(({ requestId }) => requestId),
    [41, 42],
  );
  assert.strictEqual(calls[0].reportArguments, reportArguments);
  assert.strictEqual(calls[1].reportArguments, reportArguments);
  assert.deepEqual(waits, [MCP_REPORT_RETRY_DELAY_MS]);
  assert.equal(attempts.length, 2);
  assert.strictEqual(payload, attempts[1]);
});

test("MCP report submission does not retry accepted or terminal responses", async () => {
  for (const structuredContent of [
    { accepted: true, retryable: false },
    { accepted: false, retryable: false },
  ]) {
    let calls = 0;
    let waits = 0;
    const { attempts } = await submitMcpReportWithOneRetry({
      id: 1,
      reportArguments: { feedbackHandle: "afr2_terminal", summary: "Terminal report." },
      call: async () => {
        calls += 1;
        return response(structuredContent);
      },
      wait: async () => {
        waits += 1;
      },
    });
    assert.equal(calls, 1);
    assert.equal(waits, 0);
    assert.equal(attempts.length, 1);
  }
});
