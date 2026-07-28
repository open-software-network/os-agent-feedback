import os

from agent_feedback import AgentFeedbackASGI
from fastapi import FastAPI
from fastapi.responses import HTMLResponse

product = FastAPI()

@product.get("/search")
async def search():
    return {"stack": "python-asgi", "answer": "asgi-result"}

@product.get("/docs/test", response_class=HTMLResponse)
async def docs():
    return "<!doctype html><html><head><title>ASGI docs</title></head><body>asgi-docs-result</body></html>"

@product.get("/health")
async def health():
    return {"ok": True}

app = AgentFeedbackASGI(
    product,
    api_key=os.environ["AGENT_FEEDBACK_KEY"],
    endpoint=os.environ.get("AGENT_FEEDBACK_URL", "https://app.epode.ai"),
    include=("/search", "/docs/*"),
)
