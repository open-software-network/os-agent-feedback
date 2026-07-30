# Agent feedback compliance study — 2026-07-30

## Executive answer

Epode cannot make feedback submission deterministic for every independent HTTP agent by finding one perfect response prompt. Response-local instructions are probabilistic. `/llms.txt` is a discovery document, not an automatic execution channel.

The reliable product shape is layered:

1. MCP: native feedback tool with an exact input schema and concise server guidance.
2. HTTP when the runtime supports Epode: a standing runtime adapter plus a scoped response envelope.
3. Generic HTTP: an exact response-local schema as a best-effort request, measured honestly as an opportunity until a report returns.

## Method

The committed lab holds the customer task and product answer constant while varying:

- mode: Never ask, Ask once, Ask every time;
- placement: no instruction, `/llms.txt`, response pointer, response envelope, standing runtime adapter, MCP server instruction, MCP tool description, MCP result;
- copy: current verbose copy, concise copy, forceful action-first copy, summary-only copy, fully specified schema;
- client/model: Codex CLI `0.144.3` with its default `gpt-5.6-sol` and `gpt-5.6-terra`;
- continuation: first consent decision and a second product interaction in the same conversation.

Every run used a clean temporary repository, ignored personal client configuration, randomized scenario order where comparisons were confirmatory, and used synthetic product data. The receiver enforced the real report allowlist, consent rules, privacy rejection, nested finding keys, enum values, and idempotency.

The final core dataset contains **87 agent trials and 99 product interactions**. Early harness-debug runs are excluded. A success means the receiver accepted a schema-valid report—not merely that the agent attempted a POST.

Claude Code is wired into the same runner, but its local OAuth had expired and the authorization flow requires a user-owned organization choice. No Claude result is inferred from Codex data.

## Results

### HTTP discovery and instruction placement — Codex default model

| Condition | n | Found instructions | Attempted | Accepted |
| --- | ---: | ---: | ---: | ---: |
| No feedback contract | 3 | — | 0/3 | 0/3 |
| `/llms.txt` only | 3 | 0/3 | 0/3 | 0/3 |
| Response pointer to `/llms.txt` | 3 | 0/3 | 0/3 | 0/3 |
| Standing rule to discover linked `/llms.txt` | 3 | 3/3 | 3/3 | 0/3 with the old ambiguous schema |
| Old response copy | 6 | 6/6 | 5/6 | 0/6 |
| Concise response copy | 6 | 6/6 | 4/6 | 4/6, including one repaired retry |
| Forceful action-first response copy | 3 | 3/3 | 0/3 | 0/3 |
| Fully specified response schema | 3 | 3/3 | 3/3 | 3/3 first attempt |
| Summary-only response instruction | 3 | 3/3 | 0/3 | 0/3 |
| Standing adapter + summary-only body | 3 | 3/3 | 3/3 | 3/3 first attempt |
| Explicit user request to submit feedback | 3 | 3/3 | 3/3 | 3/3 after schema repair |

The old envelope triggered action but produced invalid payloads. Codex invented `description` or `summary` inside findings instead of the required `topic` and `detail`, and sometimes emitted `confidence: "high"`. A strict receiver rejected those reports. Explicitly describing the nested shape changed first-attempt validity from 0/3 to 3/3 in the randomized schema trial.

Shorter was not automatically better. Summary-only copy was ignored 3/3 when it appeared only in the response, but succeeded 3/3 under a standing adapter. The forceful uppercase/action-first copy was ignored 3/3. This indicates instruction authority and clarity matter more than imperative tone.

### Cross-model confirmation — `gpt-5.6-terra`

| Condition | Accepted |
| --- | ---: |
| No feedback contract | 0/3 |
| Fully specified HTTP response | 3/3 |
| Standing adapter + fully specified response | 3/3 |
| MCP negative control | 0/3 |
| MCP server instruction | 3/3 |
| MCP combined instruction/result | 3/3 |

All accepted reports were valid on the first attempt, and the customer answer remained correct in every run.

### MCP — Codex default model

| Feedback signal | Accepted |
| --- | ---: |
| No report tool or feedback signal | 0/3 |
| Result-local instruction + native report tool | 3/3 |
| Server-startup instruction + native report tool | 3/3 |
| Product-tool description + native report tool | 3/3 |
| Server + result + native report tool | 3/3 |

All 12 positive MCP reports were schema-valid on the first attempt. Server instructions alone were sufficient because the report action and its field constraints were exposed as a native tool.

### Consent sequences — Codex default model

Each successful first interaction was followed by a second interaction under the same consent scope.

| Mode and placement | First behavior | Second behavior | End-to-end success |
| --- | --- | --- | ---: |
| Ask once, response only | Asked and submitted in 1/3 | The one successful run reused `stored_grant` without asking | 1/3 |
| Ask every time, response only | Asked in 0/3 | No report | 0/3 |
| Ask once, standing adapter | Asked and submitted in 3/3 | Did not re-ask; used `stored_grant` in 3/3 | 3/3 |
| Ask every time, standing adapter | Asked and submitted in 3/3 | Re-asked and submitted after the second yes in 3/3 | 3/3 |

Ask once and Ask every time are therefore runtime behaviors, not properties an HTTP response can enforce by itself.

## Observed failure taxonomy

- `instructions_not_discovered`: the runtime never fetched `/llms.txt`.
- `instruction_pointer_ignored`: the response advertised another document but the runtime did not follow it.
- `instruction_seen_but_side_effect_ignored`: the customer task succeeded and feedback was skipped.
- `consent_not_requested`: an ask-mode response was used without presenting the permission question.
- `submission_rejected:invalid_confidence`: a natural-language confidence label was sent instead of `0..1`.
- `submission_rejected:invalid_finding_field`: the agent guessed a nested key such as `description`.
- `success_after_schema_repair`: the receiver rejected an invalid first attempt and the agent retried with a bounded valid body.

These must remain separate funnel stages. “Instruction delivered,” “report attempted,” and “valid report accepted” are different metrics.

## Theses

### T1 — Native action surfaces dominate prose

When feedback is a real tool with a validated input schema, the agent can select and repair it using the same machinery as the product tool. This is the strongest path and should remain the MCP default.

### T2 — Instruction authority dominates aggressive wording

A standing runtime adapter produced reliable HTTP consent and submission. Forceful response-local copy did not. The long-term HTTP solution is adoption in agent runtimes, skills, plugins, or shared agent instruction standards—not louder product responses.

### T3 — `/llms.txt` helps discovery only after something trusted tells the runtime to discover it

The file was fetched 0/3 on its own and 3/3 with a standing discovery rule. Epode should publish it for documentation but never treat it as a delivery guarantee.

### T4 — Exact field shape is part of compliance

The previous contract listed finding enums but omitted the required nested keys. That turned genuine compliance attempts into rejected reports. Exact schema information must travel with the receipt, and optional fields should be omitted when uncertain.

### T5 — Ask-once consent belongs to Epode, but the first ask remains probabilistic

Epode should remember the decision for a stable opaque customer reference. After approval, later responses can be emitted as `never_ask`; after refusal, feedback should be disabled. The agent should not be responsible for durable consent memory. Epode still cannot manufacture the initial conversation pause inside an independent one-shot agent, and an agent-provided approval remains an attestation rather than independently verified human consent.

## Server-managed ask-once follow-up

The original consent experiment incorrectly asked the agent runtime to remember approval. A corrected lab stores approval under product plus opaque customer reference, then starts a completely fresh agent session for the next product interaction.

| Condition | First permission/report | Later autonomous report |
| --- | ---: | ---: |
| Unknown consent, Codex default | 3/5 | — |
| Unknown consent, `gpt-5.6-terra` | 2/5 | — |
| Already approved, Codex default | — | 5/5 |
| Already approved, `gpt-5.6-terra` | — | 4/5 |
| Direct unknown → approved → fresh session sequence, Codex default | 2/5 | 2/2 conditional on approval |

Across the two model pilots, first-time permission converted in 5/10 trials while previously approved customers produced autonomous reports in 9/10 fresh trials. Every customer task was answered correctly.

This materially improves recurring feedback after a grant, and removes the unrealistic adapter-memory requirement. It does **not** improve the independent agent's likelihood of surfacing the first permission question enough to call Ask once reliable: the initial ask remains the dominant bottleneck. A refusal also needs a privacy-safe consent-decision action because the absence of a feedback report cannot distinguish refusal from ignored instructions.

## Implemented from this study

- Added the reproducible HTTP/MCP/consent lab and strict failure classification.
- Added randomized scenario ordering, repeat counts, model selection, raw synthetic traces, and aggregate analysis.
- Added exact nested report shape to Node, Python, Go, and Rust response envelopes.
- Updated the instruction to name `topic`, `detail`, enum sources, the numeric confidence range, and workaround shape.
- Instructed agents to omit optional fields they cannot form exactly.
- Updated the public protocol schema, discovery descriptor, manual HTTP example, tests, and docs.
- Documented `/llms.txt` as discovery-only and distinguished generic HTTP, runtime-adapter HTTP, and MCP reliability.

## Next experiments

1. Complete the same matrix on Claude Code, Gemini CLI, and GitHub Copilot CLI, recording exact client/model versions.
2. Run at least 30 randomized repetitions per winning/losing condition and calculate confidence intervals.
3. Add an Epode-owned consent-decision endpoint and test approval, denial, and silence independently; verify that refusal disables later feedback and silence does not create a decision.
4. Test consent across a brand-new conversation to distinguish in-thread memory from durable runtime storage.
5. Test cached, streamed, array, scalar, HTML, and header-only HTTP handoffs independently.
6. Test MCP server instructions at different lengths and positions; keep critical action text in the first 512 characters for clients that prioritize or truncate startup guidance.
7. Build an Epode compatibility probe that vendors can run against their agent client and publish results by exact version.
8. Add an experiment identifier and instruction variant to opportunity telemetry so production conversion can be measured without storing prompts or transcripts.

## Runtime-loading facts behind the design

- Codex automatically loads `AGENTS.md`; arbitrary `/llms.txt` files are not automatic project instructions. MCP server instructions are loaded as server-wide guidance. [Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md.md), [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp.md)
- Claude Code loads `CLAUDE.md` at session start and explicitly describes it as context, not enforcement. Its MCP client loads server instructions and native tool schemas. [Claude memory](https://code.claude.com/docs/en/memory), [Claude MCP](https://code.claude.com/docs/en/mcp)
- Gemini CLI uses hierarchical `GEMINI.md` memory and explicit MCP/tool discovery. [Gemini CLI commands](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/commands.md)
- GitHub Copilot supports repository instructions and `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` depending on surface. [Copilot custom instructions](https://docs.github.com/en/copilot/reference/custom-instructions-support)
- `/llms.txt` is a proposal for curated inference-time website documentation, commonly used on demand; it is not an execution or consent protocol. [llms.txt proposal](https://github.com/AnswerDotAI/llms-txt)
