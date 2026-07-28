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
