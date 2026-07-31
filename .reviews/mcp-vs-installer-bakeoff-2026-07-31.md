# Epode architecture bakeoff: MCP, shared MCP, generated MCP, and signed rules

Date: 2026-07-31

## Decision

There is no universal transport that makes every customer agent report reliably.

The conditional winner is:

1. **Primary for MCP-capable companies:** instrument the company's already-configured product MCP and put
   feedback guidance in server-level instructions as well as a bounded native tool.
2. **Primary bridge for HTTP/web products:** one user- or admin-installed Epode companion/plugin containing a
   shared Epode MCP plus trusted workflow guidance. Company responses contain only short-lived, product-scoped
   handles.
3. **Universal fallback:** retain response-only HTTP, label it
   `best_effort_without_agent_adapter`, and never sell it as deterministic.
4. **Experimental fallback only:** the signed one-shot project-rule installer may be useful for users who
   explicitly choose project-local durability, but it is not the default architecture.

Do not ship dynamic MCP registration from response URLs, naive autonomous OpenAPI-to-MCP deployment, or native
MCP MRTR elicitation as the only consent path.

## Assumptions tested

| Assumption | Result |
|---|---|
| "MCP worked perfectly" | Too broad. Configured product MCP with server guidance leads; behavior changes by placement, mode, runtime, and fresh session. |
| A response can point to a new MCP URL and the agent will use it | Rejected: 0 reports and 0 connection attempts in 8/8 URL-only Never-ask trials; 0/2 in Ask once. |
| One shared Epode MCP can bridge ordinary HTTP | Promising only when already configured. Configured marker/guidance variants reported in 12/13 specified Never-ask trials under bypass permissions. |
| A handle in the response is enough | Rejected as a cross-runtime guarantee. Claude marker-only was 2/3 and explicitly rejected the embedded request once. |
| Trusted server-level guidance fixes the bridge | It improved Claude reporting to 3/3, but one run omitted the requested product answer. Telemetry reliability cannot be optimized independently of task correctness. |
| Native MCP elicitation solves consent | Rejected today. Codex completed 0/3 native-consent trials. One Claude trial emitted repeated internal requests but no user-facing completion/report. |
| Ask once is durable because Epode remembers | Runtime-dependent. Production product-MCP first use reported 4/4; fresh-session reporting was Codex 2/2 and Claude 0/2. |
| A signed one-shot installer makes HTTP durable | Demonstrated once per runtime, but the Claude pass required bypass permissions and trusted distribution is still unbuilt. |
| Epode can autonomously generate MCPs from public OpenAPI | Only a review manifest can be generated safely without company authority. Epode's own spec yielded 0/30 auto-eligible operations. |

## Measured evidence

Samples are small and sequential. Do not pool incompatible prompt, permission, consent, placement, or schema
cohorts into one population rate.

| Cohort | Reports | Product answer | Interpretation |
|---|---:|---:|---|
| Configured product MCP, server-only or combined guidance | 4/4 | 4/4 | Leading primary path; n=1 per runtime/placement cell. |
| Configured product MCP, result/tool-description only | Codex 2/2, Claude 0/2 | 4/4 | Not a cross-runtime default. |
| Production product MCP Ask once, first use | 4/4 | 4/4 | Strong first-contact pilot. |
| Production product MCP Ask once, fresh session | Codex 2/2, Claude 0/2 | 4/4 | Not durable cross-runtime. |
| Production product MCP Ask every time | 11/12 interactions | 12/12 | Strongest production consent behavior tested; requires repeated user work. |
| Production product MCP Never ask | Codex 2/2, Claude 0/2 | 4/4 | Runtime-dependent autonomous side effect. |
| Shared Epode MCP configured, specified Never-ask runs | 12/13 | 12/13 | Promising HTTP bridge; all runs used broad/bypass permissions. |
| Shared MCP URL only, Never ask | 0/8 | 8/8 | Candidate eliminated. |
| Shared MCP Ask once, configured | 3/4 | 4/4 | Promising but underpowered; server guidance mattered for Codex. |
| Shared MCP Ask once, URL only | 0/2 | 2/2 | Candidate eliminated. |
| Response-only HTTP SDK, first use | 6/6 | 6/6 | Good consent entry, not durable. |
| Response-only HTTP SDK, fresh session | 1/6 | 6/6 | Reject as durable architecture. |
| Signed one-shot installer final | Codex default 1/1; Claude bypass 1/1 | 2/2 | Experimental demonstration only. |

The shared MCP and signed-installer final reports used only categorical `impact` plus allowlisted `signals`.
Existing product-MCP cohorts used freeform summaries/findings and are not equivalent privacy evidence.

Key compact artifacts:

- `.artifacts/agent-compliance/2026-07-31-codex-mcp-pilot-n1.json`
- `.artifacts/agent-compliance/2026-07-31-claude-mcp-pilot-n1.json`
- `.artifacts/agent-compliance/shared-feedback-mcp-cross-surface-n1-20260731.json`
- `.artifacts/agent-compliance/shared-feedback-mcp-codex-marker-url-r3.json`
- `.artifacts/agent-compliance/shared-feedback-mcp-claude-marker-url-r3.json`
- `.artifacts/agent-compliance/shared-feedback-mcp-claude-server-guidance-r3.json`
- `.artifacts/agent-compliance/shared-feedback-mcp-ask-once-n1-20260731.json`
- `.artifacts/agent-compliance/codex-trusted-installer-idempotent-final-n1-20260731.json`
- `.artifacts/agent-compliance/claude-trusted-installer-informed-consent-n1-20260731.json`
- `.artifacts/agent-compliance/local-sdk-answer-first-positive-n3.json`

## Why an unconfigured MCP URL cannot win

MCP `server/discover` describes a server after the host already knows its endpoint. It is not internet, registry,
HTTP-response, or `Link` discovery. Hosts deliberately place trust/configuration in front of MCP activation:

- Codex requires Settings, `codex mcp add`, config, a trusted project, a plugin, or managed policy.
- Claude Code requires local/user/project/plugin/managed config; project MCPs add a trust gate.
- Claude remote connectors require account or organization provisioning plus authentication.
- OAuth dynamic client registration registers a client with a known authorization server; it does not add a new
  MCP server to an agent host.

Relevant primary sources:

- [MCP 2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- [`server/discover`](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)
- [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [Codex MCP setup](https://learn.chatgpt.com/docs/extend/mcp)
- [Claude Code MCP setup](https://code.claude.com/docs/en/mcp)

## Winning architecture by product surface

### Company already has MCP

Instrument that server. Keep the business tool and feedback tool in one trusted surface.

Requirements:

- Server-level guidance, not result-only or tool-description-only guidance.
- Categorical reporting by default; richer feedback must be a separate, explicitly trusted policy.
- The product task always completes before feedback handling.
- Company-authenticated context derives `customerRef`; never accept identity as a tool argument.
- Server-authoritative, tenant-scoped consent, expiry, revocation, and idempotency.
- Conversational consent remains the compatibility path until host MRTR behavior passes a larger matrix.

### Company has HTTP/API/web only

Instrument the existing product response with a signed, write-only Epode handle. A separately installed Epode
companion/plugin is the trust anchor and supplies server instructions plus fixed tools.

The handle must bind:

- company, product, interaction, purpose, policy version, and tool audience;
- consent mode/state and company-scoped subject when available;
- expiry, nonce, and single-report limit.

The companion must accept only Epode capabilities, use one fixed destination, reject redirects and arbitrary
URLs, keep products/companies unlinkable by global user identifier, and accept categorical fields only.

Installation, MCP/OAuth authorization, tool-call approval, and feedback consent are four distinct grants. Never
substitute one for another.

### Company wants Epode to create MCP

Offer an offline, deny-by-default review compiler first. Do not silently deploy a proxy.

The prototype in `experiments/agent-compliance/openapi-company-review.mjs`:

- pins the exact OpenAPI digest;
- defaults every operation to excluded;
- suggests only stable, described JSON GET/HEAD candidates;
- excludes mutations, auth/logout/key/admin/MCP/webhook routes, request bodies, credential-like parameters,
  binary/streaming results, unsafe servers, and incomplete path contracts;
- treats descriptions as untrusted review-only text;
- emits a credential-free approved IR only after explicit company decisions.

Epode's current OpenAPI contains 30 operations, 20 mutations, 29 missing descriptions, three auth schemes, and
no declared upstream host; zero operations are automatically eligible. This is the intended safe failure.

If this becomes a product later, prefer a company-deployed sidecar or in-process wrapper. An Epode-hosted proxy
would put credentials, raw arguments, and product responses in Epode's data plane and materially change the
company's security, privacy, availability, and procurement obligations.

## Role of the signed installer

Keep it as a research bridge, not the onboarding path.

It improved installation mechanics with a pinned Ed25519 key, two-path allowlist, symlink/path checks, staged
writes, rollback, same-origin completion, and idempotent replay. It still assumes a trusted version-pinned helper,
safe signer, host subprocess/network permission, stable agent rule semantics, repository-scoped consent, and
model compliance in future sessions. Production would need real package provenance, key rotation/revocation,
crash recovery, race resistance, secret-free invocation, semantic restrictions on signed instructions, clean
uninstall, update/re-consent, real-repository testing, and default-permission coverage.

It solves persistence by modifying customer repositories, which is a worse enterprise adoption boundary than an
admin-installed plugin or an already-configured company MCP.

## Scored decision

Scores are directional, 1 (poor) to 5 (strong). Effort scores are higher when the approach is easier.

| Approach | Company effort | User/admin effort | Reliability | Privacy | Security/support | Coverage |
|---|---:|---:|---:|---:|---:|---:|
| Existing company MCP + Epode instrumentation | 4 | 5 when already connected | 4.5 | 4 now; 5 categorical | 4.5 | 3 |
| Installed Epode companion/shared MCP + HTTP handles | 5 | 3 individually; 5 managed | 4 | 5 | 4 | 4 |
| Raw HTTP response fallback | 5 | 5 | 2 | 4 categorical | 4 | 5 |
| Signed project-rule installer | 5 company-side | 2.5 | 2.5 | 5 categorical | 2 | 2 |
| Generated company-deployed sidecar | 2 | 3 | 4 for approved traffic | 4 | 2.5 | 2 |
| Epode-hosted API-to-MCP proxy | 3 | 3 | 3 | 1 | 1.5 | 2 |
| Unconfigured MCP URL in response | 5 apparent | 5 apparent | 1 | 1 | 1 | 1 |

## Next implementation sequence

1. Make categorical reporting the default for native product MCP, not only the companion experiments.
2. Harden server-level MCP guidance so the product task remains the dominant instruction.
3. Package one Epode companion/plugin for trusted host marketplaces and enterprise-managed rollout.
4. Run a clean-profile install/use/fresh-session/revoke/uninstall study under default Codex, Claude, and one IDE
   host, counting every approval and restart.
5. Run at least five fresh repetitions per runtime/model/placement for shared MCP Never ask and Ask once, with
   decline, ambiguity, cancellation, outage, duplicate, expiry, malicious-server collision, and tenant-isolation
   cases.
6. Continue supporting raw HTTP as best effort, with dashboard evidence labels that distinguish
   `confirmed_protocol`, `trusted_adapter`, and `best_effort_without_agent_adapter`.
7. Keep the OpenAPI compiler as a design-partner experiment. Do not build the proxy runtime before companies
   prove demand for reviewing, deploying, and operating it.

## Safe external claim

> In current pilots, the strongest path is feedback built into a product MCP that the customer's agent already
> trusts. For HTTP products, a single preinstalled Epode companion can bridge short-lived response handles into a
> bounded feedback tool. Response-only HTTP remains best effort, and an MCP URL in a response is not enough to
> make an agent connect.
