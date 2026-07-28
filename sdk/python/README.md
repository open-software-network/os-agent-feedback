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

HTTP feedback is best-effort for generic agents. `feedback_from_response` and `submit_product_outcome` provide the deterministic, allow-listed agent-runtime path.
