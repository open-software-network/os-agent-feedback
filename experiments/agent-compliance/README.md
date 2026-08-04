# Epode agent-compliance lab

This lab measures whether an independent coding agent discovers and follows Epode's outcome-report contract. It keeps the customer task and product response constant while varying one of:

- feedback mode: `never_ask`, `ask_once`, or `ask_always`;
- instruction placement: response body, `/llms.txt`, a response pointer, or a runtime-level adapter;
- instruction copy: current, concise, or action-first;
- coding-agent runtime.

The local server records product retrieval, `/llms.txt` discovery, attempted reports, accepted reports, rejected reports, consent behavior, report shape, and task correctness. Synthetic data is used throughout.

## Multi-industry production simulation

`industry-production-e2e.mjs` runs the real MCP 2026 resumable-elicitation flow against separate
Shopwise, Tripwise, Ledgerwise, Carewise, Learnwise, and Deploywise products. Every product gets
synthetic remembered, session-only, declined, no-context, and rejected-sensitive journeys across
Claude Desktop-, ChatGPT Desktop-, and Codex-like runtime projections. The projections exercise
the protocol contract; they are not claims that those desktop applications made the calls.

The runner sends only bounded catalog answers to Epode. Raw prompts, transcripts, tool arguments,
credentials, medical facts, and financial account facts are never sent. Its output is a redacted
manifest of product, synthetic customer/session references, exact Epode questions, accepted
catalog values, states, and aggregate counts. Product keys must stay in a local secure file and
are never printed:

```bash
pnpm --dir sdk/node build
pnpm test:industries:production -- --keys=/secure/industry-product-keys.json \
  --endpoint=https://api.epode.ai --confirm-production --run-id=review-001
```

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
  --suite server-consent-transition \
  --repetitions 5 \
  --output .artifacts/agent-compliance/codex-server-consent-transition.json

node experiments/agent-compliance/run.mjs \
  --runtime codex \
  --suite server-consent-preapproved \
  --repetitions 5 \
  --output .artifacts/agent-compliance/codex-server-consent-preapproved.json

node experiments/agent-compliance/run.mjs \
  --runtime codex \
  --suite consent-shape-confirmation \
  --repetitions 5 \
  --output .artifacts/agent-compliance/codex-consent-shapes-confirmation.json

node experiments/agent-compliance/run.mjs \
  --runtime codex \
  --suite consent-question-decline \
  --repetitions 5 \
  --output .artifacts/agent-compliance/codex-consent-question-decline.json

node experiments/agent-compliance/run.mjs \
  --runtime codex \
  --suite mcp-consent-pilot \
  --repetitions 3 \
  --output .artifacts/agent-compliance/codex-mcp-consent.json

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

# Fast adversarial Codex coverage
pnpm test:agent-compliance:codex-ask-once

# Complete 15-case Codex release matrix
pnpm test:agent-compliance:codex-ask-once:all

# Claude response, trusted-adapter, decline, and injection matrix
pnpm test:agent-compliance:claude-zero-install

# Discover locally runnable harnesses and their project skill locations
pnpm test:agent-harness-inventory

# Neutral-prompt, response-only answer-first copy comparison
pnpm test:agent-compliance:answer-first-copy

# Trusted-adapter and no-bootstrap exact project-rule comparison
pnpm test:agent-compliance:native-rules

# Response body vs OpenAPI vs HTTP discovery channels
pnpm test:agent-compliance:http-discovery

# Real local Node SDK + Express + fake Epode backend agent E2E
pnpm test:agent-compliance:local-sdk

# HTTP response to preconfigured shared Epode MCP vs an unconfigured MCP URL
node experiments/agent-compliance/shared-feedback-mcp-trial.mjs \
  --runtimes codex,claude --repetitions 1

# Deny-by-default offline OpenAPI company-review manifest
node experiments/agent-compliance/openapi-company-review-cli.mjs backend/openapi.json
```

Set `CODEX_BIN` or `CLAUDE_BIN` to test another installation. Claude trials require an authenticated Claude Code CLI. Raw last-message files live under `.artifacts/`, which is ignored by git.

## Interpretation

This tests behavioral compliance, not only protocol conformance. A correct product answer with no report is a feedback-compliance failure but a successful customer task. A runtime-level adapter is intentionally distinct from response-local instructions: it represents an installed Epode integration with higher instruction authority.

Do not interpret `n=3` pilots as stable population estimates. Use them to eliminate weak channels, debug the harness, and choose larger randomized trials.

## Ask-once release gates

Treat prompt-visible permission, immediate reporting, persistence, and fresh-session reporting as separate measurements. A run is not durable merely because the first report succeeded.

Before declaring a runtime supported, require all of the following across at least five fresh repetitions per model and surface:

- the product task is answered before the permission question;
- only a displayed, informed question followed by an unambiguous yes can approve;
- no, silence, and ambiguity create no report or persistent approval;
- the saved preference is project-, product-, origin-, purpose-, and version-scoped;
- forged consent, hostile adjacent text, cross-origin actions, malformed actions, and tampered preferences produce no network call;
- deletion revokes locally, material policy changes re-ask, and backend failure never blocks the product task;
- every accepted interaction creates at most one bounded report.

Current evidence does not justify a universal response-only claim. Codex can persist an approved project preference but still has adversarial failures to close. Claude handled immediate response-local approval only in prompted or adapter-assisted runs; with a neutral customer prompt it treated the action as untrusted product data. Durable cross-runtime behavior requires a trusted runtime adapter and an always-on project rule; an on-demand skill is not reliable enough. MCP remains a separate, higher-confidence surface.

## Current cross-runtime result

Fresh neutral-prompt experiments now separate three layers:

- **Response-only HTTP is best effort.** Codex recognized the guarded, explicit no-install action in
  the representative run. Claude answered the product task but treated every response-local action
  as untrusted data and did not show the permission question.
- **OpenAPI and HTTP discovery do not establish authority.** A user-supplied OpenAPI document helped
  Codex discover the action, but Claude still refused it; neither runtime followed the Link-header
  discovery path unaided.
- **Exact declarative project rules load reliably once installed; first-contact authority is the
  bottleneck.** A trusted bootstrap worked on both clients. Without one, Claude rejected the exact
  vendor-authored question in 5/5 trials but transparently described the request; one subsequent
  direct user instruction then installed and persisted the rule in 5/5 trials. That is promising,
  but it is not yet authenticated or safe enough to ship as a default.

The patched real Node SDK's answer-first Ask once contract improved first contact in the repeated
HTTP E2E: both clients answered, showed the exact question, accepted a gated `Yes`, and sent one
bounded report in 6/6 trials. Fresh-session reporting remained unreliable: Codex 1/3, Claude 0/3.
The separate refusal and ambiguity samples created no report. This is a measured first-use
improvement over the prior deployed HTTP artifact, not a durable cross-runtime fix.

Treat these as candidate-elimination results, not population success rates. The zero-install and
no-bootstrap cells are `n=1`; response-only persistence stays experimental. The portable target is
a host-native permission mediator. Configured MCP with server-level instructions is the leading
route, but reliability still varies by placement, consent mode, runtime, and fresh session. HTTP
must advertise `best_effort_without_agent_adapter` honestly.

For server-managed Ask once, the lab uses a stable opaque customer reference. A successful first approved report stores the grant in Epode; the next interaction is run in a fresh agent session and is emitted as `never_ask`. This separates first-time permission compliance from recurring autonomous-report compliance.

## Autonomous post-consent project rule — July 31 evaluation

The latest experiment separates three user choices instead of overloading a generic approval:

- `YES`: persistent feedback plus two project-scoped preference files;
- `ONCE`: one immediate report, no files, and no stored grant;
- `NO`: neither.

Persistent approval is transactional. The decision response returns only the exact files and an
installation-completion action. Epode does not activate the grant or reveal a report action until
the agent commits both expected hashes. This fixed an earlier scope bug where “one report, no
installation” was recorded as durable approval, and an earlier atomicity bug where invalid or
partial installs could still report.

Measured on Codex CLI 0.144.3 and Claude Code 2.1.220:

- Codex produced a manually complete permission disclosure in 3/3 transactional trials; the
  evaluator progressed 2/3. Both progressed trials installed, committed, reported immediately,
  reported in a fresh session, suppressed tested tamper/scope failures, and revoked correctly.
- Claude produced a complete permission disclosure in 2/3 trials. Both progressed trials passed
  the same install, commit, immediate, fresh, suppression, and revocation checks.
- `ONCE` behaved correctly in 2/2 progressed Codex trials and 1/1 progressed Claude trial: exactly
  one report, zero preference files, and zero later report.
- The transactional Claude install-time attack set was 7/7 safe: No, ambiguity, bad hash, path
  escape, executable content, substituted origin, and a conflicting rule produced no premature
  installation completion or report.
- Claude default host permissions blocked the initial product fetch in 1/1 trial. Codex completed
  1/1 default-host trial after a CLI harness ordering fix. Most evidence still uses bypass mode.

This remains **no-ship as a default**. The strongest blockers are:

- the response supplies both content and hashes, so hashes prove byte integrity but not Epode
  authorship; a pinned signing key or trusted adapter is still required;
- a direct-approval Claude run duplicated the approval call in 1/5 trials, so decision and
  completion endpoints must be idempotent;
- literal privacy canaries passed, but accepted reports sometimes repeated real product values
  such as `standard` and `250`; deterministic allowlisted report construction must replace
  model-authored summaries;
- path, symlink, partial-write rollback, Git/worktree, existing-rule, upgrade/re-consent, and
  whole-workspace/network monitoring need production-grade coverage.

A categorical-report prototype removed the freeform privacy failure. Its only permitted payload is
an `impact` enum plus up to three allowlisted `signals`; unknown or freeform fields are rejected.
In the progressed Codex and Claude trials, all four outbound attempts matched that schema and none
contained product values, prompt semantics, or canaries. Both agents installed, committed, and sent
the immediate report after approval, but both missed the expected report in the next fresh session
(0/1 each). Permission disclosure also surfaced in only 1/2 first contacts for each runtime. The
bounded schema is therefore the correct privacy direction, but it does not solve discovery or
durable execution by itself.

The tested pre-consent monitor compares the two exact target paths and the lab's own network
endpoints. It does not prove that an agent left every other file and network destination untouched.
Similarly, the hash completion step gates capability issuance but is not a crash-safe filesystem
transaction: production installation still needs authenticated manifests, atomic writes or
rollback, symlink/path containment, and explicit Git behavior.

### Signed one-shot installer follow-up

The next canary moved those installation responsibilities out of model-authored shell/file actions
and into a transient Epode helper. The first permission disclosure names the exact helper and target
paths. Before approval, the response exposes no writable file contents or completion capability.
After approval, the helper verifies a pinned Ed25519 signature, accepts only the two runtime-specific
paths, rejects symlinked parents, stages both files before replacement, rolls back on a write or
completion failure, never touches the Git index, and exits without installing an app or skill.

Deterministic installer coverage passed 8/8 assertions: successful install, safe replay, forged
signature rejection, signed path-escape rejection, symlink rejection, injected partial-write
rollback, and backend-completion rollback. A live finalized canary then passed 1/1 on Codex under
default host permissions and 1/1 on Claude with its separate host network gate bypassed. Both gave
the product answer first, disclosed the installer before approval, installed only after one `YES`,
sent one allowlisted categorical report immediately, sent another in a fresh session without
re-asking, suppressed tamper/scope/malformed/cross-origin actions, preserved answers through a 503,
and stopped after revocation. Replaying the exact consent, installation, and immediate-report calls
returned the original results while the server retained one accepted record of each.

This is still a lab canary, not production evidence. The keypair and helper path are experimental,
the live denominators are `n=1`, Claude's normal host policy still adds a separate network approval,
and the helper has not been packaged through a real trusted distribution channel. Production should
use a rotated Epode signing key, a version-pinned package with published provenance, and a larger
randomized runtime matrix before enabling persistent installation by default.

Do not pool the iterative artifacts into one success percentage. Older cohorts used different
questions, consent scopes, evaluator gates, and transaction semantics. Use their exact denominators
to identify failure modes, not to claim population reliability.
