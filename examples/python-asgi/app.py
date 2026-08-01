import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from agent_feedback import AgentFeedbackASGI
from fastapi import FastAPI, Request

feedback_app = None


@asynccontextmanager
async def lifespan(_product):
    yield
    if feedback_app is not None:
        feedback_app.shutdown()


product = FastAPI(title="Agent Feedback Python example", lifespan=lifespan)


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


feedback_app = AgentFeedbackASGI(
    product,
    api_key=os.environ["AGENT_FEEDBACK_KEY"],
    endpoint=os.getenv("AGENT_FEEDBACK_URL", "https://app.epode.ai"),
    include=("/api/status",),
    # This public example is anonymous. A real product should set customer_ref
    # only from identity established by its outer authentication middleware.
    runtime_hint=lambda scope: header(scope, b"user-agent"),
)
app = feedback_app
