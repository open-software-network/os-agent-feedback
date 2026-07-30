import os

from agent_feedback import AgentFeedbackWSGI
from flask import Flask, jsonify
from waitress import serve

app = Flask(__name__)

@app.get("/search")
def search():
    return jsonify(stack="python-wsgi", answer="wsgi-result")

@app.get("/docs/test")
def docs():
    return "<!doctype html><html><head><title>WSGI docs</title></head><body>wsgi-docs-result</body></html>", 200, {"content-type": "text/html; charset=utf-8"}

@app.get("/health")
def health():
    return jsonify(ok=True)

app.wsgi_app = AgentFeedbackWSGI(
    app.wsgi_app,
    api_key=os.environ["AGENT_FEEDBACK_KEY"],
    endpoint=os.environ.get("AGENT_FEEDBACK_URL", "https://app.epode.ai"),
    include=("/search", "/docs/*"),
    customer_ref=lambda environ: environ.get("HTTP_X_CUSTOMER_REF"),
)

if __name__ == "__main__":
    serve(app, host="127.0.0.1", port=int(os.environ.get("PORT", "4104")))
