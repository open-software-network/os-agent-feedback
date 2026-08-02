"""Typed company-side customer-enrichment client.

The product API key is used only for server-to-server calls. Agent-facing
capabilities are relayed through bounded same-origin endpoints.
"""

from __future__ import annotations

import json
import logging
import os
import re
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Any, Callable, Literal, Mapping

DEFAULT_ENDPOINT = "https://app.epode.ai"
USER_AGENT = "@epode/python/0.4.0"
Purpose = Literal["product_personalization", "targeted_advertising"]
EnrichmentSurface = Literal["http_json", "html", "mcp"]
IdentityLevel = Literal["verified", "pseudonymous", "ephemeral"]
SignalType = Literal["intent", "preference", "constraint", "interest"]
SignalProvenance = Literal[
    "agent_reports_user_statement", "agent_reports_current_task", "agent_inference"
]
AnswerStatus = Literal["answered", "declined", "no_relevant_context"]
OutcomeKind = Literal["conversion", "completion", "engagement", "dismissal", "abandonment"]
Transport = Callable[[str, Mapping[str, str], bytes, float], tuple[int, bytes]]

_PURPOSES = {"product_personalization", "targeted_advertising"}
_SIGNAL_TYPES = {"intent", "preference", "constraint", "interest"}
_PROVENANCE = {
    "agent_reports_user_statement",
    "agent_reports_current_task",
    "agent_inference",
}
_OUTCOMES = {"conversion", "completion", "engagement", "dismissal", "abandonment"}
_OPAQUE = re.compile(r"^[A-Za-z0-9_.:-]+$")
_HANDLE = re.compile(r"^Bearer (aqr1_[A-Za-z0-9._-]+)$")
_KEY = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,63}$")
_FORBIDDEN_KEY_COMPONENTS = frozenset(
    "name email phone address street zip postal age dob birthdate birthday sex gender health "
    "medical race ethnicity nationality citizenship immigration religion political sexual "
    "biometric genetic dna minor child teen income salary credit veteran military union criminal "
    "arrest legal credential password".split()
)
_FORBIDDEN_KEY_PHRASES = (
    "precise_location",
    "financial_account",
    "social_security",
    "date_of_birth",
    "dateofbirth",
    "net_worth",
    "creditworthiness",
    "marital_status",
)
_SENSITIVE_FRAGMENTS = (
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
_SENSITIVE_WORDS = frozenset(
    "male female man woman men women nonbinary transgender citizen visa felony conviction dna gay "
    "lesbian bisexual queer christian muslim jewish hindu buddhist sikh atheist catholic mormon "
    "hiv aids cancer diabetes asthma democrat republican".split()
)
_SECRET_PATTERNS = (
    "af_live_", "af_read_", "github_pat_", "ghp_", "aws_secret", "sk-ant-", "-----begin ",
    "xoxb-", "xoxp-", "sk-proj-", "api key", "password", "prompt was", "user asked",
    "transcript:", "prompt:", "raw input:", "raw output:", "secret", "passwd", "api_key",
    "access_token", "access token", "refresh_token", "refresh token",
)


@dataclass(frozen=True, slots=True)
class EnrichmentRequestInput:
    interaction_id: str
    operation: str
    surface: EnrichmentSurface = "http_json"
    status_code: int | None = None
    duration_ms: int | None = None
    # Product-issued journey only; never derive from prompts or agent/tool arguments.
    session_ref: str | None = None
    # Bounded, non-sensitive product-observed runtime label.
    runtime_hint: str | None = None
    purpose: Purpose = "product_personalization"
    remember: bool = False
    account_ref: str | None = None
    user_ref: str | None = None
    anonymous_ref: str | None = None
    customer_ref: str | None = None


@dataclass(frozen=True, slots=True)
class AgentAction:
    url: str
    method: str
    authorization: str
    content_type: str
    body_schema: Mapping[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class EnrichmentRequest:
    request_id: str
    interaction_id: str
    state: str
    purpose: Purpose
    identity_level: IdentityLevel
    stage_instruction: str
    question: str | None
    answer_instruction: str | None
    expires_at: str
    consent: AgentAction | None
    submit: AgentAction | None = None


@dataclass(frozen=True, slots=True)
class CustomerAnswerItem:
    key: str
    type: SignalType
    value: str
    provenance: SignalProvenance
    remember: bool
    summary: str | None = None
    confidence: float | None = None
    expires_at: str | None = None


@dataclass(frozen=True, slots=True)
class CustomerAnswerInput:
    status: AnswerStatus
    items: tuple[CustomerAnswerItem, ...] = ()


@dataclass(frozen=True, slots=True)
class CustomerContextInput:
    purpose: Purpose = "product_personalization"
    account_ref: str | None = None
    user_ref: str | None = None
    anonymous_ref: str | None = None
    customer_ref: str | None = None
    interaction_id: str | None = None


@dataclass(frozen=True, slots=True)
class CustomerContextItem:
    signal_id: str
    key: str
    type: SignalType
    value: Any
    summary: str
    provenance: SignalProvenance
    allowed_uses: tuple[Purpose, ...]
    remembered: bool
    confidence: float | None = None
    expires_at: str | None = None


@dataclass(frozen=True, slots=True)
class CustomerContext:
    available: bool
    identity_level: IdentityLevel = "ephemeral"
    items: tuple[CustomerContextItem, ...] = ()
    retrieval_id: str | None = None
    customer_id: str | None = None
    interaction_id: str | None = None
    context_version: str | None = None


@dataclass(frozen=True, slots=True)
class PersonalizationDecisionInput:
    external_decision_id: str
    context_retrieval_id: str
    signal_ids: tuple[str, ...]
    variant: str | None = None


@dataclass(frozen=True, slots=True)
class PersonalizationDecision:
    id: str
    external_decision_id: str
    purpose: Purpose
    signal_ids: tuple[str, ...]
    created_at: str
    variant: str | None = None


@dataclass(frozen=True, slots=True)
class PersonalizationDecisionResult:
    recorded: bool
    decision: PersonalizationDecision | None = None


@dataclass(frozen=True, slots=True)
class PersonalizationOutcomeInput:
    external_outcome_id: str
    decision_id: str
    outcome: OutcomeKind
    occurred_at: str | None = None


@dataclass(frozen=True, slots=True)
class PersonalizationOutcome:
    id: str
    external_outcome_id: str
    decision_id: str
    outcome: OutcomeKind
    occurred_at: str
    created_at: str


@dataclass(frozen=True, slots=True)
class PersonalizationOutcomeResult:
    recorded: bool
    outcome: PersonalizationOutcome | None = None


@dataclass(frozen=True, slots=True)
class RelayRequest:
    path: str
    authorization: str | None
    body: Any


@dataclass(frozen=True, slots=True)
class RelayResponse:
    status: int
    body: Any


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


class EpodeClient:
    """Fail-open server-side client for Epode customer enrichment."""

    def __init__(
        self,
        api_key: str | None = None,
        *,
        endpoint: str | None = None,
        timeout: float = 0.25,
        relay_timeout: float = 5.0,
        transport: Transport | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        resolved_key = api_key or os.getenv("EPODE_API_KEY")
        if not resolved_key:
            raise ValueError("EPODE_API_KEY is required")
        if not resolved_key.startswith("af_live_"):
            raise ValueError("EPODE_API_KEY must be a server-side product key")
        if timeout <= 0 or relay_timeout <= 0:
            raise ValueError("timeouts must be positive and bounded")
        self.endpoint = (endpoint or os.getenv("EPODE_API_URL") or DEFAULT_ENDPOINT).rstrip("/")
        self._api_key = resolved_key
        self._timeout = timeout
        self._relay_timeout = relay_timeout
        self._transport = transport
        self._logger = logger or logging.getLogger("epode.customer")
        self._opener = urllib.request.build_opener(_NoRedirect())

    def request_enrichment(self, value: EnrichmentRequestInput) -> EnrichmentRequest | None:
        try:
            body = _identity_body(value)
            body.update(
                interactionId=_opaque(value.interaction_id, "interaction_id"),
                operation=_bounded(value.operation, "operation", 160),
                surface=_surface(value.surface),
                purpose=_purpose(value.purpose),
                remember=bool(value.remember),
            )
            if value.status_code is not None:
                body["statusCode"] = _status_code(value.status_code)
            if value.duration_ms is not None:
                body["durationMs"] = _duration_ms(value.duration_ms)
            if value.session_ref:
                body["sessionRef"] = _opaque(value.session_ref, "session_ref")
            if value.runtime_hint:
                body["runtimeHint"] = _runtime_hint(value.runtime_hint)
            return _parse_enrichment(self._company_post("/api/v2/enrichment/requests", body))
        except Exception as error:
            self._logger.warning(
                "[epode] Customer enrichment is temporarily unavailable; the product response "
                "was not affected. %s",
                error,
            )
            return None

    def get_customer_context(self, value: CustomerContextInput) -> CustomerContext:
        try:
            body = _identity_body(value)
            if value.interaction_id:
                body["interactionId"] = _opaque(value.interaction_id, "interaction_id")
            body["purpose"] = _purpose(value.purpose)
            payload = self._company_post("/api/v2/customer-context", body)
            items = tuple(_parse_context_item(item) for item in payload.get("items", []))
            return CustomerContext(
                available=True,
                retrieval_id=_required_string(payload, "retrievalId"),
                identity_level=_identity_level(payload.get("identityLevel")),
                customer_id=_optional_string(payload.get("customerId")),
                interaction_id=_optional_string(payload.get("interactionId")),
                context_version=_required_string(payload, "contextVersion"),
                items=items,
            )
        except Exception as error:
            self._logger.warning(
                "[epode] Customer context is temporarily unavailable; use the normal product "
                "experience. %s",
                error,
            )
            return CustomerContext(available=False)

    def record_personalization_decision(
        self, value: PersonalizationDecisionInput
    ) -> PersonalizationDecisionResult:
        try:
            body: dict[str, Any] = {
                "externalDecisionId": _opaque(value.external_decision_id, "external_decision_id"),
                "contextRetrievalId": _opaque(
                    value.context_retrieval_id, "context_retrieval_id"
                ),
                "signalIds": [_opaque(item, "signal_id") for item in value.signal_ids],
            }
            if value.variant is not None:
                body["variant"] = _bounded(value.variant, "variant", 160)
            payload = self._company_post("/api/v2/personalization/decisions", body)
            return PersonalizationDecisionResult(
                recorded=True, decision=_parse_decision(payload.get("decision"))
            )
        except Exception as error:
            self._logger.warning(
                "[epode] Personalization decision was not recorded; the product experience may "
                "continue. %s",
                error,
            )
            return PersonalizationDecisionResult(recorded=False)

    def track_personalization_outcome(
        self, value: PersonalizationOutcomeInput
    ) -> PersonalizationOutcomeResult:
        try:
            if value.outcome not in _OUTCOMES:
                raise ValueError("invalid personalization outcome")
            body: dict[str, Any] = {
                "externalOutcomeId": _opaque(value.external_outcome_id, "external_outcome_id"),
                "decisionId": _opaque(value.decision_id, "decision_id"),
                "outcome": value.outcome,
            }
            if value.occurred_at is not None:
                body["occurredAt"] = _date(value.occurred_at)
            payload = self._company_post("/api/v2/personalization/outcomes", body)
            return PersonalizationOutcomeResult(
                recorded=True, outcome=_parse_outcome(payload.get("outcome"))
            )
        except Exception as error:
            self._logger.warning(
                "[epode] Personalization outcome was not recorded; the product response was not "
                "affected. %s",
                error,
            )
            return PersonalizationOutcomeResult(recorded=False)

    def relay(self, value: RelayRequest) -> RelayResponse:
        target = {
            "/_epode/v1/enrichment/consent": "/api/v2/enrichment/consent/decisions",
            "/_epode/v1/enrichment/answers": "/api/v2/enrichment/answers",
        }.get(value.path)
        if not target:
            return RelayResponse(404, {"error": "not_found"})
        handle_match = _HANDLE.fullmatch(value.authorization or "")
        if not handle_match:
            return RelayResponse(401, {"error": "invalid_customer_context_handle"})
        valid = _valid_consent(value.body) if target.endswith("/decisions") else _valid_answer(value.body)
        if not valid:
            return RelayResponse(400, {"error": "invalid_customer_context_body"})
        try:
            status, body = self._post(
                target,
                value.body,
                f"Bearer {handle_match.group(1)}",
                self._relay_timeout,
            )
            if 300 <= status < 400:
                return RelayResponse(502, {"error": "epode_redirect_rejected"})
            return RelayResponse(status, _same_origin_relay_body(body))
        except Exception:
            return RelayResponse(
                503,
                {"error": "customer_context_temporarily_unavailable", "retryable": True},
            )

    def submit_consent(
        self, request_handle: str, decision: Literal["approved", "declined"]
    ) -> RelayResponse:
        return self.relay(
            RelayRequest(
                path="/_epode/v1/enrichment/consent",
                authorization=f"Bearer {request_handle}",
                body={"decision": decision},
            )
        )

    def submit_answer(self, request_handle: str, answer: CustomerAnswerInput) -> RelayResponse:
        return self.relay(
            RelayRequest(
                path="/_epode/v1/enrichment/answers",
                authorization=f"Bearer {request_handle}",
                body=_answer_body(answer),
            )
        )

    def _company_post(self, path: str, body: Mapping[str, Any]) -> dict[str, Any]:
        status, parsed = self._post(
            path, body, f"Bearer {self._api_key}", self._timeout
        )
        if 300 <= status < 400:
            raise RuntimeError("redirect rejected")
        if not 200 <= status < 300 or not isinstance(parsed, dict):
            raise RuntimeError(f"HTTP {status}")
        return parsed

    def _post(
        self, path: str, body: Any, authorization: str, timeout: float
    ) -> tuple[int, Any]:
        url = f"{self.endpoint}{path}"
        headers = {
            "authorization": authorization,
            "content-type": "application/json",
            "user-agent": USER_AGENT,
        }
        encoded = json.dumps(body, separators=(",", ":")).encode()
        if self._transport:
            status, response_body = self._transport(url, headers, encoded, timeout)
        else:
            request = urllib.request.Request(url, data=encoded, headers=headers, method="POST")
            try:
                with self._opener.open(request, timeout=timeout) as response:
                    status, response_body = response.status, response.read()
            except urllib.error.HTTPError as error:
                status, response_body = error.code, error.read()
        if not response_body:
            return status, {}
        try:
            return status, json.loads(response_body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return status, {"error": "Epode returned a non-JSON response"}


def same_origin_enrichment_request(value: EnrichmentRequest) -> EnrichmentRequest:
    return EnrichmentRequest(
        request_id=value.request_id,
        interaction_id=value.interaction_id,
        state=value.state,
        purpose=value.purpose,
        identity_level=value.identity_level,
        stage_instruction=value.stage_instruction,
        question=value.question,
        answer_instruction=value.answer_instruction,
        expires_at=value.expires_at,
        consent=(
            _same_origin_action(value.consent, "/_epode/v1/enrichment/consent")
            if value.consent
            else None
        ),
        submit=(
            _same_origin_action(value.submit, "/_epode/v1/enrichment/answers")
            if value.submit
            else None
        ),
    )


CUSTOMER_CONTEXT_RELAY_PATHS = (
    "/_epode/v1/enrichment/consent",
    "/_epode/v1/enrichment/answers",
)


def _identity_body(value: Any) -> dict[str, str]:
    result: dict[str, str] = {}
    for attribute, key in (
        ("account_ref", "accountRef"),
        ("user_ref", "userRef"),
        ("anonymous_ref", "anonymousRef"),
        ("customer_ref", "customerRef"),
    ):
        current = getattr(value, attribute, None)
        if current:
            result[key] = _opaque(current, attribute)
    return result


def _purpose(value: str) -> Purpose:
    if value not in _PURPOSES:
        raise ValueError("purpose must be product_personalization or targeted_advertising")
    return value  # type: ignore[return-value]


def _surface(value: str) -> EnrichmentSurface:
    if value not in {"http_json", "html", "mcp"}:
        raise ValueError("surface must be http_json, html, or mcp")
    return value  # type: ignore[return-value]


def _status_code(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 100 <= value <= 599:
        raise ValueError("status_code must be an HTTP status from 100 through 599")
    return value


def _duration_ms(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 86_400_000:
        raise ValueError("duration_ms must be an integer from 0 through 86400000")
    return value


def _runtime_hint(value: str) -> str:
    hint = _bounded(value, "runtime_hint", 200)
    if _sensitive_text(hint):
        raise ValueError("runtime_hint must be a non-sensitive product-owned label")
    return hint


def _opaque(value: str, name: str) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 160 or not _OPAQUE.fullmatch(value):
        raise ValueError(f"{name} must be a bounded opaque company reference")
    return value


def _bounded(value: str, name: str, maximum: int) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= maximum or _control(value):
        raise ValueError(f"{name} is invalid")
    return value


def _date(value: str) -> str:
    return _bounded(value, "occurred_at", 64)


def _control(value: str) -> bool:
    return any(ord(character) <= 31 or ord(character) == 127 for character in value)


def _sensitive_key(value: str) -> bool:
    components = re.split(r"[._-]", value)
    return any(item in _FORBIDDEN_KEY_COMPONENTS for item in components) or any(
        item in value for item in _FORBIDDEN_KEY_PHRASES
    )


def _sensitive_text(value: str) -> bool:
    lower = value.lower()
    if "@" in value or any(pattern in lower for pattern in _SECRET_PATTERNS) or _control(value):
        return True
    if re.search(r"(?:AKIA|ASIA)[A-Z0-9]{12}", value):
        return True
    if re.search(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]{20,}", value):
        return True
    if re.search(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
        return True
    normalized = "".join(character if character.isalnum() else " " for character in lower)
    words = set(normalized.split())
    return any(fragment in lower for fragment in _SENSITIVE_FRAGMENTS) or bool(
        words & _SENSITIVE_WORDS
    )


def _plain(value: Any) -> bool:
    return type(value) is dict


def _exact(value: Mapping[str, Any], allowed: set[str]) -> bool:
    return set(value).issubset(allowed)


def _valid_consent(value: Any) -> bool:
    return _plain(value) and set(value) == {"decision"} and value["decision"] in {
        "approved",
        "declined",
    }


def _valid_answer_item(value: Any) -> bool:
    if not _plain(value) or not _exact(
        value,
        {"key", "type", "value", "summary", "provenance", "confidence", "remember", "expiresAt"},
    ):
        return False
    confidence = value.get("confidence")
    expires_at = value.get("expiresAt")
    summary = value.get("summary")
    return (
        isinstance(value.get("key"), str)
        and bool(_KEY.fullmatch(value["key"]))
        and not _sensitive_key(value["key"])
        and value.get("type") in _SIGNAL_TYPES
        and isinstance(value.get("value"), str)
        and 1 <= len(value["value"]) <= 160
        and not _sensitive_text(value["value"])
        and (
            summary is None
            or (
                isinstance(summary, str)
                and 3 <= len(summary) <= 350
                and not _sensitive_text(summary)
            )
        )
        and value.get("provenance") in _PROVENANCE
        and type(value.get("remember")) is bool
        and (confidence is None or (type(confidence) in {int, float} and 0 <= confidence <= 1))
        and (expires_at is None or (isinstance(expires_at, str) and _valid_date(expires_at)))
    )


def _valid_answer(value: Any) -> bool:
    if not _plain(value) or not set(value).issubset({"status", "items"}) or "status" not in value:
        return False
    if value["status"] not in {"answered", "declined", "no_relevant_context"}:
        return False
    items = value.get("items", [])
    if not isinstance(items, list) or len(items) > 8 or not all(_valid_answer_item(item) for item in items):
        return False
    return bool(items) if value["status"] == "answered" else not items


def _valid_date(value: str) -> bool:
    if not 1 <= len(value) <= 64:
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def _same_origin_relay_body(value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    result = dict(value)
    for key, path in (
        ("consent", "/_epode/v1/enrichment/consent"),
        ("submit", "/_epode/v1/enrichment/answers"),
    ):
        if key in result and isinstance(result[key], dict):
            result[key] = {**result[key], "url": path}
    return result


def _answer_body(value: CustomerAnswerInput) -> dict[str, Any]:
    items = []
    for item in value.items:
        raw = asdict(item)
        encoded = {
            "key": raw["key"],
            "type": raw["type"],
            "value": raw["value"],
            "provenance": raw["provenance"],
            "remember": raw["remember"],
        }
        if raw["summary"] is not None:
            encoded["summary"] = raw["summary"]
        if raw["confidence"] is not None:
            encoded["confidence"] = raw["confidence"]
        if raw["expires_at"] is not None:
            encoded["expiresAt"] = raw["expires_at"]
        items.append(encoded)
    return {"status": value.status, "items": items}


def _parse_action(value: Any) -> AgentAction:
    if not isinstance(value, dict):
        raise ValueError("invalid enrichment action")
    return AgentAction(
        url=_required_string(value, "url"),
        method=_required_string(value, "method"),
        authorization=_required_string(value, "authorization"),
        content_type=_required_string(value, "contentType"),
        body_schema=value.get("bodySchema") if isinstance(value.get("bodySchema"), dict) else None,
    )


def _parse_enrichment(value: Mapping[str, Any]) -> EnrichmentRequest:
    return EnrichmentRequest(
        request_id=_required_string(value, "requestId"),
        interaction_id=_required_string(value, "interactionId"),
        state=_required_string(value, "state"),
        purpose=_purpose(_required_string(value, "purpose")),
        identity_level=_identity_level(value.get("identityLevel")),
        stage_instruction=_required_string(value, "stageInstruction"),
        question=_optional_string(value.get("question")),
        answer_instruction=_optional_string(value.get("answerInstruction")),
        expires_at=_required_string(value, "expiresAt"),
        consent=_parse_action(value.get("consent")) if value.get("consent") is not None else None,
        submit=_parse_action(value.get("submit")) if value.get("submit") is not None else None,
    )


def _parse_context_item(value: Any) -> CustomerContextItem:
    if not isinstance(value, dict):
        raise ValueError("invalid customer context item")
    if "value" not in value:
        raise ValueError("invalid customer context value")
    uses = value.get("allowedUses")
    if not isinstance(uses, list):
        raise ValueError("invalid allowed uses")
    return CustomerContextItem(
        signal_id=_required_string(value, "signalId"),
        key=_required_string(value, "key"),
        type=_signal_type(value.get("type")),
        value=value["value"],
        summary=_required_string(value, "summary"),
        provenance=_provenance(value.get("provenance")),
        confidence=value.get("confidence") if isinstance(value.get("confidence"), (int, float)) else None,
        expires_at=_optional_string(value.get("expiresAt")),
        allowed_uses=tuple(_purpose(item) for item in uses),
        remembered=value.get("remembered") is True,
    )


def _same_origin_action(value: AgentAction, path: str) -> AgentAction:
    return AgentAction(
        url=path,
        method="POST",
        authorization=value.authorization,
        content_type="application/json",
        body_schema=value.body_schema,
    )


def _parse_decision(value: Any) -> PersonalizationDecision:
    if not isinstance(value, dict) or not isinstance(value.get("signalIds"), list):
        raise ValueError("invalid decision response")
    return PersonalizationDecision(
        id=_required_string(value, "id"),
        external_decision_id=_required_string(value, "externalDecisionId"),
        purpose=_purpose(_required_string(value, "purpose")),
        signal_ids=tuple(_required_list_string(value, "signalIds")),
        variant=_optional_string(value.get("variant")),
        created_at=_required_string(value, "createdAt"),
    )


def _parse_outcome(value: Any) -> PersonalizationOutcome:
    if not isinstance(value, dict):
        raise ValueError("invalid outcome response")
    kind = _required_string(value, "outcome")
    if kind not in _OUTCOMES:
        raise ValueError("invalid outcome response")
    return PersonalizationOutcome(
        id=_required_string(value, "id"),
        external_outcome_id=_required_string(value, "externalOutcomeId"),
        decision_id=_required_string(value, "decisionId"),
        outcome=kind,  # type: ignore[arg-type]
        occurred_at=_required_string(value, "occurredAt"),
        created_at=_required_string(value, "createdAt"),
    )


def _required_string(value: Mapping[str, Any], key: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result:
        raise ValueError(f"invalid {key}")
    return result


def _required_list_string(value: Mapping[str, Any], key: str) -> list[str]:
    result = value.get(key)
    if not isinstance(result, list) or not all(isinstance(item, str) for item in result):
        raise ValueError(f"invalid {key}")
    return result


def _optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _identity_level(value: Any) -> IdentityLevel:
    if value not in {"verified", "pseudonymous", "ephemeral"}:
        raise ValueError("invalid identityLevel")
    return value  # type: ignore[return-value]


def _signal_type(value: Any) -> SignalType:
    if value not in _SIGNAL_TYPES:
        raise ValueError("invalid signal type")
    return value  # type: ignore[return-value]


def _provenance(value: Any) -> SignalProvenance:
    if value not in _PROVENANCE:
        raise ValueError("invalid provenance")
    return value  # type: ignore[return-value]
