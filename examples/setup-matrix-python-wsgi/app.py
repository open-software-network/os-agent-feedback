import os
import base64
import hashlib
import hmac

from agent_feedback import AgentFeedbackWSGI
from flask import Flask, jsonify
from waitress import serve

app = Flask(__name__)

def verified_account(authorization):
    token = authorization.removeprefix("Bearer ")
    try:
        payload, signature = token.split(".", 1)
        supplied = base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4))
        account_id = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)).decode()
    except Exception:
        return None
    expected = hmac.new(
        os.environ.get("SETUP_MATRIX_PRODUCT_AUTH_SECRET", "").encode(),
        payload.encode(),
        hashlib.sha256,
    ).digest()
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

    def __call__(self, environ, start_response):
        if environ.get("PATH_INFO") == "/health":
            return self.app(environ, start_response)
        account_id = verified_account(environ.get("HTTP_AUTHORIZATION", ""))
        if account_id is None:
            body = b'{"error":"unauthorized"}'
            start_response("401 Unauthorized", [
                ("Content-Type", "application/json"),
                ("Content-Length", str(len(body))),
            ])
            return [body]
        environ["verified.account_id"] = account_id
        environ["verified.user_id"] = f"user.{account_id}"
        environ["verified.anonymous_id"] = f"anon.{account_id}"
        return self.app(environ, start_response)

@app.get("/search")
def search():
    return jsonify(stack="python-wsgi", answer="wsgi-result")

@app.get("/docs/test")
def docs():
    return "<!doctype html><html><head><title>WSGI docs</title></head><body>wsgi-docs-result</body></html>", 200, {"content-type": "text/html; charset=utf-8"}

@app.get("/health")
def health():
    return jsonify(ok=True)

instrumented = AgentFeedbackWSGI(
    app.wsgi_app,
    api_key=os.environ["AGENT_FEEDBACK_KEY"],
    endpoint=os.environ.get("AGENT_FEEDBACK_URL", "https://app.epode.ai"),
    include=("/search", "/docs/*"),
    account_ref=lambda environ: environ.get("verified.account_id"),
    user_ref=lambda environ: environ.get("verified.user_id"),
    anonymous_ref=lambda environ: environ.get("verified.anonymous_id"),
    customer_ref=(
        (lambda environ: environ.get("verified.account_id"))
        if os.getenv("AGENT_FEEDBACK_MODE") == "ask_once"
        else None
    ),
)
app.wsgi_app = ProductAuthMiddleware(instrumented)

if __name__ == "__main__":
    serve(app, host="127.0.0.1", port=int(os.environ.get("PORT", "4104")))
