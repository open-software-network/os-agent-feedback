from __future__ import annotations

import base64
import json
import re
import urllib.request
from typing import Any, Mapping
from urllib.parse import urlparse

from .core import DEFAULT_ENDPOINT


def _valid_manage_consent(value: Any, current: str) -> bool:
    body_schema = value.get("bodySchema") if isinstance(value, dict) else None
    return (
        isinstance(value, dict)
        and value.get("current") == current
        and value.get("method") == "POST"
        and value.get("contentType") == "application/json"
        and str(value.get("authorization", "")).startswith("Bearer afr2_")
        and isinstance(value.get("url"), str)
        and bool(value.get("url"))
        and isinstance(body_schema, dict)
        and set(body_schema) == {"decision"}
        and body_schema.get("decision") == ["approved", "declined"]
    )


def _valid(value: Any) -> bool:
    if not (isinstance(value, dict) and value.get("v") == 1):
        return False
    if value.get("state") == "feedback_disabled":
        return (
            value.get("requested") is False
            and value.get("mode") == "ask_once"
            and value.get("configuredMode") == "ask_once"
            and value.get("consentRequired") is False
            and value.get("consentPolicy") == "once"
            and value.get("consentManagedBy") == "epode"
            and value.get("when") == "only_after_explicit_user_request"
            and _valid_manage_consent(value.get("manageConsent"), "declined")
            and value.get("requiredAction") is None
            and value.get("submit") is None
        )
    if value.get("requested") is not True:
        return False
    if value.get("state") == "feedback_ready":
        submit = value.get("submit")
        valid = (
            value.get("mode") == "never_ask"
            and
            value.get("consentRequired") is False
            and value.get("consentPolicy") == "none"
            and value.get("when") == "after_experience_known_before_final_response"
            and isinstance(submit, dict)
            and submit.get("method") == "POST"
            and submit.get("contentType") == "application/json"
            and str(submit.get("authorization", "")).startswith("Bearer afr2_")
            and isinstance(submit.get("url"), str)
            and bool(submit.get("url"))
            and "requiredAction" not in value
        )
        if not valid:
            return False
        if value.get("configuredMode") == "ask_once":
            return _valid_manage_consent(value.get("manageConsent"), "approved")
        return value.get("manageConsent") is None
    mode = value.get("mode")
    mode_contract = (
        mode == "ask_once"
        and value.get("configuredMode") == "ask_once"
        and value.get("consentPolicy") == "once"
        and value.get("when") == "after_experience_known_and_consent_resolved"
    ) or (
        mode == "ask_always"
        and value.get("configuredMode") in {"ask_always", "ask_once"}
        and value.get("consentPolicy") == "always"
        and value.get("when") == "after_experience_known_and_explicit_user_approval"
    )
    required_action = value.get("requiredAction")
    action = required_action.get("submitDecision") if isinstance(required_action, dict) else None
    body_schema = action.get("bodySchema") if isinstance(action, dict) else None
    return (
        value.get("state") == "consent_required"
        and mode_contract
        and value.get("consentRequired") is True
        and value.get("consentManagedBy") == "epode"
        and isinstance(required_action, dict)
        and required_action.get("type") == "ask_user"
        and isinstance(required_action.get("question"), str)
        and bool(required_action.get("question"))
        and isinstance(action, dict)
        and action.get("method") == "POST"
        and action.get("contentType") == "application/json"
        and str(action.get("authorization", "")).startswith("Bearer afr2_")
        and isinstance(action.get("url"), str)
        and isinstance(body_schema, dict)
        and set(body_schema) == {"decision"}
        and body_schema.get("decision") == ["approved", "declined"]
        and value.get("submit") is None
    )


def feedback_from_response(headers: Mapping[str, str], body: Any) -> dict[str, Any] | None:
    if isinstance(body, dict) and _valid(body.get("_agentFeedback")):
        return body["_agentFeedback"]
    if isinstance(body, (str, bytes)):
        text = body.decode() if isinstance(body, bytes) else body
        match = re.search(
            r'<script[^>]+id=["\']agent-feedback["\'][^>]*>([\s\S]*?)</script>',
            text,
            flags=re.I,
        )
        if match:
            try:
                value = json.loads(match.group(1))
                if _valid(value):
                    return value
            except json.JSONDecodeError:
                pass
    encoded = next((v for k, v in headers.items() if k.lower() == "agent-feedback"), None)
    if encoded:
        try:
            value = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
            if _valid(value):
                return value
        except Exception:
            pass
    return None


def feedback_consent_action(feedback: Mapping[str, Any]) -> str:
    """Resolve Epode's server-managed response state."""
    if not _valid(feedback):
        return "skip"
    if feedback.get("state") == "feedback_ready":
        return "submit"
    if feedback.get("state") == "consent_required":
        return "ask"
    return "skip"


def submit_feedback_consent(
    feedback: Mapping[str, Any],
    decision: str,
    *,
    allowed_submit_origins: tuple[str, ...] = (DEFAULT_ENDPOINT,),
    sender: Any = None,
) -> dict[str, Any]:
    if not _valid(feedback) or feedback.get("state") != "consent_required":
        raise ValueError("Invalid Agent Feedback consent contract")
    if decision not in {"approved", "declined"}:
        raise ValueError("decision must be approved or declined")
    action = feedback["requiredAction"]["submitDecision"]
    url = str(action["url"])
    parsed = urlparse(url)
    allowed = {(urlparse(value).scheme, urlparse(value).netloc) for value in allowed_submit_origins}
    if parsed.scheme != "https" or (parsed.scheme, parsed.netloc) not in allowed:
        raise ValueError(f"Refusing to submit a consent decision to untrusted origin {parsed.scheme}://{parsed.netloc}")
    headers = {
        "authorization": str(action["authorization"]),
        "content-type": "application/json",
        "user-agent": "agent-feedback-python-agent/0.2.1",
    }
    data = json.dumps({"decision": decision}, separators=(",", ":")).encode()
    if sender:
        return sender(url, headers, data)
    request = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read())


def submit_product_feedback(
    feedback: Mapping[str, Any],
    report: Mapping[str, Any],
    *,
    allowed_submit_origins: tuple[str, ...] = (DEFAULT_ENDPOINT,),
    sender: Any = None,
) -> dict[str, Any]:
    if not _valid(feedback) or feedback.get("state") != "feedback_ready":
        raise ValueError("Invalid Agent Feedback submission contract")
    summary = str(report.get("summary", "")).strip()
    if not 8 <= len(summary) <= 700:
        raise ValueError("summary must contain 8 to 700 characters")
    impact = report.get("impact")
    if impact is not None and impact not in {"helped", "helped_with_friction", "neutral", "hindered", "blocked", "unknown"}:
        raise ValueError("invalid impact")
    confidence = report.get("confidence")
    if confidence is not None and (not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1):
        raise ValueError("confidence must be between 0 and 1")
    findings = report.get("findings", [])
    if not isinstance(findings, list) or len(findings) > 8:
        raise ValueError("findings must be an array with at most 8 items")
    for finding in findings:
        if not isinstance(finding, dict) or finding.get("kind") not in {"strength", "friction", "defect", "gap", "suggestion", "uncertainty", "other"}:
            raise ValueError("invalid finding kind")
        if re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", str(finding.get("topic", ""))) is None:
            raise ValueError("finding topic must be a normalized slug")
        if finding.get("severity") is not None and finding.get("severity") not in {"minor", "major", "blocking"}:
            raise ValueError("invalid finding severity")
        if not 3 <= len(str(finding.get("detail", "")).strip()) <= 350:
            raise ValueError("finding detail must contain 3 to 350 characters")
    workaround = report.get("workaround")
    if workaround is not None and (not isinstance(workaround, dict) or not isinstance(workaround.get("used"), bool)):
        raise ValueError("workaround must contain used")
    if isinstance(workaround, dict) and workaround.get("used") and not str(workaround.get("detail", "")).strip():
        raise ValueError("workaround detail is required when a workaround was used")
    url = str(feedback["submit"]["url"])
    parsed = urlparse(url)
    allowed = {(urlparse(value).scheme, urlparse(value).netloc) for value in allowed_submit_origins}
    if parsed.scheme != "https" or (parsed.scheme, parsed.netloc) not in allowed:
        raise ValueError(f"Refusing to submit feedback to untrusted origin {parsed.scheme}://{parsed.netloc}")
    headers = {
        "authorization": str(feedback["submit"]["authorization"]),
        "content-type": "application/json",
        "user-agent": "agent-feedback-python-agent/0.2.1",
    }
    body = {
        "summary": summary,
        **({"impact": impact} if impact is not None else {}),
        **({"confidence": confidence} if confidence is not None else {}),
        **({"findings": findings} if findings else {}),
        **({"workaround": workaround} if workaround is not None else {}),
    }
    data = json.dumps(body, separators=(",", ":")).encode()
    if sender:
        return sender(url, headers, data)
    request = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read())
