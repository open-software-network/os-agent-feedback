export const MCP_REPORT_RETRY_DELAY_MS = 250;

export async function submitMcpReportWithOneRetry({
  id,
  reportArguments,
  call,
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
}) {
  const attempts = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const payload = await call({
      requestId: id + attempt,
      reportArguments,
    });
    attempts.push(payload);
    const result = payload.result.structuredContent;
    if (result.accepted || !result.retryable) break;
    if (attempt === 0) await wait(MCP_REPORT_RETRY_DELAY_MS);
  }
  return { payload: attempts.at(-1), attempts };
}
