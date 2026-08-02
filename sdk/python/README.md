# Epode for Python

Version 0.4.0 includes the existing agent-feedback middleware and a typed,
dependency-free company-side customer-enrichment client.

## Customer enrichment and personalization

```python
from agent_feedback import (
    CustomerContextInput,
    EnrichmentRequestInput,
    EpodeClient,
    PersonalizationDecisionInput,
    PersonalizationOutcomeInput,
)

epode = EpodeClient()  # reads EPODE_API_KEY on the server

request = epode.request_enrichment(EnrichmentRequestInput(
    interaction_id=interaction_id,
    operation="recommendations",
    surface="http_json",
    status_code=200,
    duration_ms=handler_duration_ms,
    session_ref=product_journey.id,
    runtime_hint=verified_runtime_label,
    user_ref=authenticated_user.id,
    purpose="product_personalization",
    remember=True,
))

context = epode.get_customer_context(CustomerContextInput(
    user_ref=authenticated_user.id,
    purpose="product_personalization",
))
result = personalize(normal_result, context.items) if context.available else normal_result

decision = epode.record_personalization_decision(PersonalizationDecisionInput(
    external_decision_id=decision_id,
    context_retrieval_id=context.retrieval_id,
    signal_ids=tuple(item.signal_id for item in context.items),
))
if decision.recorded:
    epode.track_personalization_outcome(PersonalizationOutcomeInput(
        external_outcome_id=order_id,
        decision_id=decision.decision.id,
        outcome="conversion",
    ))
```

Use `anonymous_ref` for a product-owned pre-login visitor ID, or
`interaction_id` alone for interaction-only context. The client uses a 250 ms
company-side budget, rejects redirects, and fails open: Epode downtime never
changes the normal product result. Mount `EpodeClient.relay` at
`/_epode/v1/enrichment/consent` and `/_epode/v1/enrichment/answers`; it validates
the agent answer before forwarding the short-lived handle, and never exposes the
company key.

`surface` is `http_json` by default and may be `html` or `mcp`. The optional status, duration,
session, and runtime fields describe this same product call. A `session_ref` must be issued by
your product, and `runtime_hint` must be a bounded, non-sensitive server-observed label. Never
copy prompts, tool arguments, user content, or regulated traits into either field.

## Existing feedback middleware

## FastAPI, Starlette, Quart, or Django ASGI

```python
from agent_feedback import AgentFeedbackASGI

app = AgentFeedbackASGI(
    app,
    api_key=os.environ["AGENT_FEEDBACK_KEY"],
    include=("/search", "/docs/*"),
    account_ref=lambda scope: scope.get("account_id"),
    user_ref=lambda scope: scope.get("user_id"),
    anonymous_ref=lambda scope: scope.get("first_party_visitor_id"),
    customer_ref=lambda scope: scope.get("account_id"),
)
```

Resolve identity only from authenticated product middleware or a product-owned first-party anonymous
identifier. Never use agent arguments, names, emails, or caller-controlled raw request values.
`account_ref`, `user_ref`, and `anonymous_ref` travel only in background telemetry and never enter the
agent-visible capability. Co-supplying an anonymous reference after authentication authorizes a
deterministic progressive link; Epode never infers verified identity.

## Flask, Django WSGI, Bottle, or Pyramid

```python
from agent_feedback import AgentFeedbackWSGI

app.wsgi_app = AgentFeedbackWSGI(
    app.wsgi_app,
    api_key=os.environ["AGENT_FEEDBACK_KEY"],
    include=("/search",),
)
```

ASGI JSON and HTML responses are decorated directly. The conservative WSGI adapter uses the response header contract only for finite responses so it never buffers or mutates the application body.

Telemetry is queued off the response path, carries a monotonic process-local sequence, and retries transient
delivery failures with bounded exponential backoff. The default request timeout is 30 seconds and graceful
shutdown drain is bounded to 10 seconds. Configure `telemetry_timeout`, `max_telemetry_attempts`, or
`shutdown_timeout` only when a private Epode deployment requires different bounds. ASGI middleware drains
automatically through the server lifespan protocol; call `shutdown()` during graceful WSGI server shutdown.

HTTP feedback is best-effort for generic agents. `feedback_from_response`, `inspect_product_feedback`, `submit_feedback_consent`, and `submit_product_feedback` provide the deterministic, allow-listed agent-runtime path. Inspection is authoritative and redirect-free; decision and report helpers inspect first so stale Ask-once envelopes cannot cause duplicate prompts or overwrite a remembered decision.

HTTP middleware defaults to `cache_mode="safe"`: responses with an explicit shared-cache policy (`public`, `max-age`, `s-maxage`, `immutable`, or `stale-while-revalidate`) are left completely unchanged. Use `cache_mode="request"` to instrument only requests carrying `Agent-Feedback-Request: 1`; both variants use `Vary` and eligible ordinary 2xx `GET`/`HEAD` responses carry a same-path-and-query discovery `Link`. Use `cache_mode="private"` when every included response is intentionally private. Every instrumented response is changed to `Cache-Control: private, no-store` because its capability is unique.

Pass `feedback_mode="ask_once"` with a stable opaque `customer_ref`. HTTP responses never wait for Epode: the middleware signs a subject-bound capability locally, reads only process-local cached consent, and refreshes that cache in the background after an eligible response. Epode Companion verifies the capability and resolves the authoritative remembered decision before it asks or reports. Unknown customers receive the answer-first `approved|declined` action; Epode remembers the decision and reveals a report contract only after approval. Approved and declined responses include a scoped `manageConsent` action so an explicit user request can reverse the saved choice; declined responses remain quiet otherwise. `ask_always` uses the same two-step flow per report. Agents store no preference, and report bodies contain no consent fields.
