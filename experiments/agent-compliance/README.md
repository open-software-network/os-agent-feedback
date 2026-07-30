# Epode agent-compliance lab

This lab measures whether an independent coding agent discovers and follows Epode's outcome-report contract. It keeps the customer task and product response constant while varying one of:

- feedback mode: `never_ask`, `ask_once`, or `ask_always`;
- instruction placement: response body, `/llms.txt`, a response pointer, or a runtime-level adapter;
- instruction copy: current, concise, or action-first;
- coding-agent runtime.

The local server records product retrieval, `/llms.txt` discovery, attempted reports, accepted reports, rejected reports, consent behavior, report shape, and task correctness. Synthetic data is used throughout.

## Run

```bash
node experiments/agent-compliance/run.mjs \
  --runtime codex \
  --suite placement-pilot \
  --repetitions 3 \
  --output .artifacts/agent-compliance/codex-placement.json

node experiments/agent-compliance/run.mjs \
  --runtime codex \
  --suite consent-pilot \
  --repetitions 3 \
  --output .artifacts/agent-compliance/codex-consent.json

node experiments/agent-compliance/run.mjs \
  --runtime codex \
  --suite schema-pilot \
  --repetitions 3 \
  --output .artifacts/agent-compliance/codex-schema.json

node experiments/agent-compliance/run.mjs \
  --runtime codex \
  --suite consent-sequence \
  --repetitions 3 \
  --output .artifacts/agent-compliance/codex-consent-sequence.json

node experiments/agent-compliance/run.mjs \
  --runtime codex \
  --suite mcp-pilot \
  --repetitions 3 \
  --output .artifacts/agent-compliance/codex-mcp.json

node experiments/agent-compliance/run.mjs \
  --runtime codex \
  --model gpt-5.6-terra \
  --suite cross-channel \
  --repetitions 3 \
  --output .artifacts/agent-compliance/codex-terra-cross-channel.json

node experiments/agent-compliance/analyze.mjs \
  .artifacts/agent-compliance/codex-placement.json \
  .artifacts/agent-compliance/codex-consent.json
```

Set `CODEX_BIN` or `CLAUDE_BIN` to test another installation. Claude trials require an authenticated Claude Code CLI. Raw last-message files live under `.artifacts/`, which is ignored by git.

## Interpretation

This tests behavioral compliance, not only protocol conformance. A correct product answer with no report is a feedback-compliance failure but a successful customer task. A runtime-level adapter is intentionally distinct from response-local instructions: it represents an installed Epode integration with higher instruction authority.

Do not interpret `n=3` pilots as stable population estimates. Use them to eliminate weak channels, debug the harness, and choose larger randomized trials.
