from __future__ import annotations

import base64
import json
import re
import urllib.request
from typing import Any, Mapping
from urllib.parse import urlparse

from .core import DEFAULT_ENDPOINT


def _valid(value: Any) -> bool:
    if not (
        isinstance(value, dict)
        and value.get("v") == 1
        and value.get("requested") is True
        and isinstance(value.get("submit"), dict)
        and value["submit"].get("method") == "POST"
        and value["submit"].get("contentType") == "application/json"
        and str(value["submit"].get("authorization", "")).startswith("Bearer afr2_")
    ):
        return False
    mode = value.get("mode")
    scope = value.get("consentScope")
    if mode == "never_ask":
        return (
            value.get("consentRequired") is False
            and value.get("consentPolicy") == "none"
            and value.get("when") == "after_experience_known_before_final_response"
            and scope is None
        )
    if mode == "ask_once":
        return (
            value.get("consentRequired") is True
            and value.get("consentPolicy") == "once"
            and isinstance(scope, str)
            and re.fullmatch(r"afcs1_[0-9a-f]{32}", scope) is not None
            and value.get("when") == "after_experience_known_and_consent_resolved"
        )
    if mode == "ask_always":
        return (
            value.get("consentRequired") is True
            and value.get("consentPolicy") == "always"
            and scope is None
            and value.get("when") == "after_experience_known_and_explicit_user_approval"
        )
    return False


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


def feedback_consent_action(
    feedback: Mapping[str, Any], stored_decision: str | None = None
) -> str:
    """Resolve agent-local consent without sending the decision to Epode."""
    if not _valid(feedback):
        return "skip"
    if feedback.get("consentRequired") is not True:
        return "submit"
    if feedback.get("mode") == "ask_always":
        return "ask"
    if feedback.get("mode") == "ask_once":
        if stored_decision == "approved":
            return "submit"
        if stored_decision == "refused":
            return "skip"
    return "ask"


def submit_product_feedback(
    feedback: Mapping[str, Any],
    report: Mapping[str, Any],
    *,
    allowed_submit_origins: tuple[str, ...] = (DEFAULT_ENDPOINT,),
    user_approved: bool = False,
    approval_source: str | None = None,
    sender: Any = None,
) -> dict[str, Any]:
    if not _valid(feedback):
        raise ValueError("Invalid Agent Feedback submission contract")
    if feedback.get("consentRequired") is True and not user_approved:
        raise ValueError("Explicit user approval is required before submitting this report")
    if feedback.get("mode") == "ask_once" and approval_source not in {"granted_now", "stored_grant"}:
        raise ValueError("Ask-once submission requires granted_now or stored_grant approval")
    if feedback.get("mode") == "ask_always" and approval_source != "granted_now":
        raise ValueError("Ask-every-time submission requires fresh approval")
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
        "user-agent": "agent-feedback-python-agent/0.1.0",
    }
    data = json.dumps(dict(report), separators=(",", ":")).encode()
    if sender:
        return sender(url, headers, data)
    request = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read())
