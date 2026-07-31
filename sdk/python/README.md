# `agent-feedback` for Python

Protocol-first middleware with no runtime dependencies.

## FastAPI, Starlette, Quart, or Django ASGI

```python
from agent_feedback import AgentFeedbackASGI

app = AgentFeedbackASGI(
    app,
    api_key=os.environ["AGENT_FEEDBACK_KEY"],
    include=("/search", "/docs/*"),
    customer_ref=lambda scope: scope.get("account_id"),
)
```

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
delivery failures with bounded exponential backoff. Configure `telemetry_timeout` and
`max_telemetry_attempts` only when a private Epode deployment requires different bounds. Call `shutdown()`
during graceful server shutdown so the last queued batch gets a final delivery attempt.

HTTP feedback is best-effort for generic agents. `feedback_from_response`, `submit_feedback_consent`, and `submit_product_feedback` provide the deterministic, allow-listed agent-runtime path.

HTTP middleware defaults to `cache_mode="safe"`: responses with an explicit shared-cache policy (`public`, `max-age`, `s-maxage`, `immutable`, or `stale-while-revalidate`) are left completely unchanged. Use `cache_mode="request"` to instrument only requests carrying `Agent-Feedback-Request: 1`, or `cache_mode="private"` when every included response is intentionally private. Every instrumented response is changed to `Cache-Control: private, no-store` because its capability is unique.

Pass `feedback_mode="ask_once"` with a stable opaque `customer_ref`. HTTP responses never wait for Epode: the middleware signs a subject-bound capability locally, reads only process-local cached consent, and refreshes that cache in the background after an eligible response. Epode Companion verifies the capability and resolves the authoritative remembered decision before it asks or reports. Unknown customers receive the answer-first `approved|declined` action; Epode remembers the decision and reveals a report contract only after approval. Approved and declined responses include a scoped `manageConsent` action so an explicit user request can reverse the saved choice; declined responses remain quiet otherwise. `ask_always` uses the same two-step flow per report. Agents store no preference, and report bodies contain no consent fields.
