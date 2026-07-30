import os
from datetime import datetime, timezone

from agent_feedback import AgentFeedbackASGI
from fastapi import FastAPI, Request

product = FastAPI(title="Agent Feedback Python example")


@product.get("/")
async def about():
    return {
        "example": "company-product-python-asgi",
        "productEndpoint": "/api/status",
        "frameworks": ["FastAPI", "Starlette", "Django ASGI", "Quart"],
        "reliability": {
            "genericAgent": "best_effort",
            "feedbackAwareAgent": "deterministic",
        },
    }


@product.get("/health")
async def health():
    return {"status": "ok"}


@product.get("/api/status")
async def status():
    return {
        "service": "checkout",
        "available": True,
        "region": "us-east",
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "source": "example-company-python-status",
    }


def header(scope, name: bytes):
    return next(
        (value.decode() for key, value in scope.get("headers", []) if key.lower() == name),
        None,
    )


app = AgentFeedbackASGI(
    product,
    api_key=os.environ["AGENT_FEEDBACK_KEY"],
    endpoint=os.getenv("AGENT_FEEDBACK_URL", "https://app.epode.ai"),
    include=("/api/status",),
    customer_ref=lambda scope: header(scope, b"x-customer-ref"),
    runtime_hint=lambda scope: header(scope, b"user-agent"),
)
