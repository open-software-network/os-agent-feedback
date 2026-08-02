"""Dependency-free company-layer Epode example for a B2B SaaS product."""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from datetime import datetime
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener
from wsgiref.simple_server import make_server

EPODE_API_URL = os.getenv("EPODE_API_URL", "https://app.epode.ai").rstrip("/")
EPODE_API_KEY = os.environ["EPODE_API_KEY"]
DECISIONS: dict[str, str] = {}
MAX_EPODE_RESPONSE_BYTES = 1_048_576


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):
        return None


EPODE_OPENER = build_opener(NoRedirect())


def read_epode_response(response):
    declared_length = response.headers.get("Content-Length")
    if declared_length and int(declared_length) > MAX_EPODE_RESPONSE_BYTES:
        raise ValueError("epode_response_too_large")
    payload = response.read(MAX_EPODE_RESPONSE_BYTES + 1)
    if len(payload) > MAX_EPODE_RESPONSE_BYTES:
        raise ValueError("epode_response_too_large")
    try:
        return json.loads(payload or b"{}")
    except json.JSONDecodeError:
        return {"error": "epode_non_json_error"}


def post(path: str, body: dict, authorization: str, timeout: float = 1.0):
    request = Request(
        f"{EPODE_API_URL}{path}",
        data=json.dumps(body).encode(),
        method="POST",
        headers={
            "Authorization": authorization,
            "Content-Type": "application/json",
            "User-Agent": "epode-python-manual-mvp/1.0",
        },
    )
    try:
        with EPODE_OPENER.open(request, timeout=timeout) as response:
            return response.status, read_epode_response(response)
    except HTTPError as error:
        if 300 <= error.code < 400:
            return 502, {"error": "epode_redirect_rejected"}
        try:
            return error.code, read_epode_response(error)
        except ValueError:
            return 502, {"error": "epode_response_too_large"}
    except ValueError:
        return 502, {"error": "epode_response_too_large"}
    except (TimeoutError, URLError):
        return 503, {"error": "epode_temporarily_unavailable", "retryable": True}


def body(environ):
    length = int(environ.get("CONTENT_LENGTH") or 0)
    if length > 32_000:
        return None
    try:
        return json.loads(environ["wsgi.input"].read(length) or b"{}")
    except json.JSONDecodeError:
        return None


def send(start_response, status: int, value: dict, extra_headers=()):
    payload = json.dumps(value).encode()
    start_response(
        f"{status} {'OK' if status < 400 else 'Error'}",
        [
            ("Content-Type", "application/json"),
            ("Content-Length", str(len(payload))),
            *extra_headers,
        ],
    )
    return [payload]


FORBIDDEN_KEY_COMPONENTS = frozenset(
    "name email phone address street zip postal age dob birthdate birthday sex gender health "
    "medical race ethnicity nationality citizenship immigration religion political sexual "
    "biometric genetic dna minor child teen income salary credit veteran military union criminal "
    "arrest legal credential password".split()
)
FORBIDDEN_KEY_PHRASES = (
    "precise_location", "financial_account", "social_security", "date_of_birth", "dateofbirth",
    "net_worth", "creditworthiness", "marital_status",
)
SENSITIVE_FRAGMENTS = (
    "pregnan", "diagnos", "disabil", "medical", "health condition", "race", "ethnic",
    "religio", "politic", "sexual orientation", "gender identity", "biometric",
    "social security", "bank account", "credit card", "precise location", "home address",
    "street address", "zip code", "postal code", "date of birth", "birth date", "birthday",
    "years old", "age is", "biological sex", "sex assigned", "gender", "income", "salary",
    "net worth", "credit score", "creditworthiness", "nationality", "citizenship",
    "immigration status", "refugee", "veteran", "military service", "union member",
    "labor union", "criminal record", "arrest", "legal dispute", "lawsuit", "genetic",
    " dna ", "child", "minor", "teenager",
)
SENSITIVE_WORDS = frozenset(
    "male female man woman men women nonbinary transgender citizen visa felony conviction dna gay "
    "lesbian bisexual queer christian muslim jewish hindu buddhist sikh atheist catholic mormon "
    "hiv aids cancer diabetes asthma democrat republican".split()
)
SECRET_PATTERNS = (
    "af_live_", "af_read_", "github_pat_", "ghp_", "aws_secret", "sk-ant-", "-----begin ",
    "xoxb-", "xoxp-", "sk-proj-", "api key", "password", "prompt was", "user asked",
    "transcript:", "prompt:", "raw input:", "raw output:", "secret", "passwd", "api_key",
    "access_token", "access token", "refresh_token", "refresh token",
)


def sensitive_key(value):
    components = re.split(r"[._-]", value)
    return any(item in FORBIDDEN_KEY_COMPONENTS for item in components) or any(
        item in value for item in FORBIDDEN_KEY_PHRASES
    )


def sensitive_text(value):
    lower = value.lower()
    normalized = "".join(character if character.isalnum() else " " for character in lower)
    return (
        "@" in value
        or any(ord(character) <= 31 or ord(character) == 127 for character in value)
        or any(pattern in lower for pattern in SECRET_PATTERNS)
        or bool(re.search(r"(?:AKIA|ASIA)[A-Z0-9]{12}", value))
        or bool(re.search(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]{20,}", value))
        or bool(re.search(r"[^\s@]+@[^\s@]+\.[^\s@]+", value))
        or any(fragment in lower for fragment in SENSITIVE_FRAGMENTS)
        or bool(set(normalized.split()) & SENSITIVE_WORDS)
    )


def valid_answer_item(item):
    allowed = {
        "key", "type", "value", "summary", "provenance", "confidence", "remember", "expiresAt",
    }
    if not isinstance(item, dict) or not set(item) <= allowed:
        return False
    key = item.get("key")
    value = item.get("value")
    summary = item.get("summary")
    confidence = item.get("confidence")
    expires_at = item.get("expiresAt")
    if not (
        isinstance(key, str)
        and re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,63}", key)
        and not sensitive_key(key)
        and item.get("type") in {"intent", "preference", "constraint", "interest"}
        and isinstance(value, str)
        and 1 <= len(value) <= 160
        and not sensitive_text(value)
        and isinstance(summary, str)
        and 3 <= len(summary) <= 350
        and not sensitive_text(summary)
        and item.get("provenance") in {
            "agent_reports_user_statement", "agent_reports_current_task", "agent_inference",
        }
        and type(item.get("remember")) is bool
        and (confidence is None or (type(confidence) in {int, float} and 0 <= confidence <= 1))
    ):
        return False
    if expires_at is None:
        return True
    try:
        return len(expires_at) <= 64 and bool(datetime.fromisoformat(expires_at.replace("Z", "+00:00")))
    except (AttributeError, ValueError):
        return False


def valid_answer(value):
    if not isinstance(value, dict) or not set(value) <= {"status", "items"} or "status" not in value:
        return False
    if value["status"] not in {"answered", "declined", "no_relevant_context"}:
        return False
    items = value.get("items", [])
    if not isinstance(items, list) or len(items) > 8:
        return False
    if (value["status"] == "answered") != bool(items):
        return False
    return all(valid_answer_item(item) for item in items)


def same_origin_relay_body(value):
    if not isinstance(value, dict):
        return value
    result = dict(value)
    for key, path in (
        ("consent", "/_epode/v1/enrichment/consent"),
        ("submit", "/_epode/v1/enrichment/answers"),
    ):
        if isinstance(result.get(key), dict):
            result[key] = {**result[key], "url": path}
    return result


def relay(environ, start_response, path):
    authorization = environ.get("HTTP_AUTHORIZATION", "")
    value = body(environ)
    consent = path.endswith("/consent")
    valid = (
        isinstance(value, dict)
        and (
            set(value) == {"decision"}
            and value["decision"] in {"approved", "declined"}
            if consent
            else valid_answer(value)
        )
    )
    if not authorization.startswith("Bearer aqr1_"):
        return send(start_response, 401, {"error": "invalid_customer_context_handle"})
    if not valid:
        return send(start_response, 400, {"error": "invalid_customer_context_body"})
    backend_path = (
        "/api/v2/enrichment/consent/decisions"
        if consent
        else "/api/v2/enrichment/answers"
    )
    status, response = post(backend_path, value, authorization)
    response = same_origin_relay_body(response)
    headers = [("Cache-Control", "private, no-store")]
    if status == 503:
        headers.append(("Retry-After", "1"))
    return send(start_response, status, response, headers)


def application(environ, start_response):
    path = environ.get("PATH_INFO", "/")
    if path in {
        "/_epode/v1/enrichment/consent",
        "/_epode/v1/enrichment/answers",
    }:
        return relay(environ, start_response, path)
    if path == "/health":
        return send(start_response, 200, {"ok": True})
    if environ.get("HTTP_AUTHORIZATION") != "Bearer demo-b2b-user-token":
        return send(start_response, 401, {"error": "unauthorized"})

    identity = {"accountRef": "b2b_workspace_42", "userRef": "b2b_user_7"}
    if path == "/api/onboarding" and environ["REQUEST_METHOD"] == "GET":
        started_at = time.monotonic()
        context_status, context = post(
            "/api/v2/customer-context",
            {**identity, "purpose": "product_personalization"},
            f"Bearer {EPODE_API_KEY}",
            0.25,
        )
        items = context.get("items", []) if context_status == 200 else []
        values = {f"{item['key']}:{item['value']}" for item in items}
        modules = ["Create project", "Invite team", "Connect data"]
        if "role:developer" in values:
            modules = ["Create API key", "Install SDK", "Send first event"]
        decision_id = None
        if items:
            status, decision = post(
                "/api/v2/personalization/decisions",
                {
                    "externalDecisionId": f"onboarding_{uuid.uuid4()}",
                    "contextRetrievalId": context["retrievalId"],
                    "signalIds": [item["signalId"] for item in items],
                    "variant": "role-aware-onboarding-v1",
                },
                f"Bearer {EPODE_API_KEY}",
            )
            if status == 200:
                decision_id = decision["decision"]["id"]
                DECISIONS[identity["userRef"]] = decision_id
        result = {"modules": modules, "personalized": decision_id is not None}
        request_status, enrichment = post(
            "/api/v2/enrichment/requests",
            {
                "interactionId": str(uuid.uuid4()),
                "operation": "/api/onboarding",
                "surface": "http_json",
                "statusCode": 200,
                "durationMs": min(int((time.monotonic() - started_at) * 1_000), 86_400_000),
                # Issued by this product's authenticated onboarding workflow.
                "sessionRef": "b2b_onboarding_journey_42",
                "runtimeHint": "b2b-wsgi/1.0",
                "purpose": "product_personalization",
                "remember": True,
                **identity,
            },
            f"Bearer {EPODE_API_KEY}",
            0.25,
        )
        if request_status == 200:
            enrichment = same_origin_relay_body(enrichment)
            result["_epode"] = {"customerContext": enrichment}
        return send(start_response, 200, result, [("Cache-Control", "private, no-store")])

    if path == "/api/activate" and environ["REQUEST_METHOD"] == "POST":
        decision_id = DECISIONS.get(identity["userRef"])
        if decision_id:
            post(
                "/api/v2/personalization/outcomes",
                {
                    "externalOutcomeId": f"activation_{uuid.uuid4()}",
                    "decisionId": decision_id,
                    "outcome": "completion",
                },
                f"Bearer {EPODE_API_KEY}",
            )
        return send(start_response, 200, {"activated": True, "recorded": bool(decision_id)})
    return send(start_response, 404, {"error": "not_found"})


if __name__ == "__main__":
    with make_server("0.0.0.0", int(os.getenv("PORT", "4304")), application) as server:
        server.serve_forever()
