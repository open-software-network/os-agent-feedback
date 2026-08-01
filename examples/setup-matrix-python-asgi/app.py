import os
import base64
import hashlib
import hmac

from agent_feedback import AgentFeedbackASGI
from fastapi import FastAPI
from fastapi.responses import HTMLResponse

product = FastAPI()

def verified_account(headers):
    authorization = next(
        (value.decode() for name, value in headers if name.lower() == b"authorization"),
        "",
    )
    token = authorization.removeprefix("Bearer ")
    try:
        payload, signature = token.split(".", 1)
    except ValueError:
        return None
    expected = hmac.new(
        os.environ.get("SETUP_MATRIX_PRODUCT_AUTH_SECRET", "").encode(),
        payload.encode(),
        hashlib.sha256,
    ).digest()
    try:
        supplied = base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4))
        account_id = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)).decode()
    except Exception:
        return None
    if not hmac.compare_digest(supplied, expected):
        return None
    if not 1 <= len(account_id) <= 160 or not all(
        character.isascii() and (character.isalnum() or character in "_.:-")
        for character in account_id
    ):
        return None
    return account_id

class ProductAuthMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("path") == "/health":
            await self.app(scope, receive, send)
            return
        account_id = verified_account(scope.get("headers", []))
        if account_id is None:
            body = b'{"error":"unauthorized"}'
            await send({"type": "http.response.start", "status": 401, "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ]})
            await send({"type": "http.response.body", "body": body})
            return
        scope.setdefault("state", {})["account_id"] = account_id
        await self.app(scope, receive, send)

@product.get("/search")
async def search():
    return {"stack": "python-asgi", "answer": "asgi-result"}

@product.get("/docs/test", response_class=HTMLResponse)
async def docs():
    return "<!doctype html><html><head><title>ASGI docs</title></head><body>asgi-docs-result</body></html>"

@product.get("/health")
async def health():
    return {"ok": True}

instrumented = AgentFeedbackASGI(
    product,
    api_key=os.environ["AGENT_FEEDBACK_KEY"],
    endpoint=os.environ.get("AGENT_FEEDBACK_URL", "https://app.epode.ai"),
    include=("/search", "/docs/*"),
    customer_ref=lambda scope: scope.get("state", {}).get("account_id"),
)
app = ProductAuthMiddleware(instrumented)
