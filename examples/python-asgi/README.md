# Python ASGI example

One dependency-free `AgentFeedbackASGI` wrapper supports FastAPI, Starlette, Django ASGI, Quart, and other ASGI products. The route handler remains unchanged.

```python
app = AgentFeedbackASGI(
    app,
    api_key=os.environ["AGENT_FEEDBACK_KEY"],
    include=("/api/status",),
)
```

Use `AgentFeedbackWSGI` for Flask, Django WSGI, Bottle, or Pyramid.

This public example is anonymous and deliberately omits `customer_ref`. A real application should derive it only
from verified identity populated by outer authentication middleware. The FastAPI lifespan hook flushes queued
telemetry on graceful shutdown. `AGENT_FEEDBACK_MODE=off` leaves responses completely untouched.
