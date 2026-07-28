from __future__ import annotations

import base64
import json
import re
import urllib.request
from typing import Any, Mapping
from urllib.parse import urlparse

from .core import DEFAULT_ENDPOINT


def _valid(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and value.get("v") == 1
        and isinstance(value.get("submit"), dict)
        and value["submit"].get("method") == "POST"
        and str(value["submit"].get("authorization", "")).startswith("Bearer afr2_")
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


def submit_product_outcome(
    feedback: Mapping[str, Any],
    outcome: str,
    note: str,
    *,
    allowed_submit_origins: tuple[str, ...] = (DEFAULT_ENDPOINT,),
    sender: Any = None,
) -> dict[str, Any]:
    if not _valid(feedback):
        raise ValueError("Invalid Agent Feedback submission contract")
    if outcome not in {"success", "partial", "failure"}:
        raise ValueError("outcome must be success, partial, or failure")
    note = note.strip()
    if not 8 <= len(note) <= 500:
        raise ValueError("note must contain 8 to 500 characters")
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
    data = json.dumps({"outcome": outcome, "note": note}, separators=(",", ":")).encode()
    if sender:
        return sender(url, headers, data)
    request = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read())
