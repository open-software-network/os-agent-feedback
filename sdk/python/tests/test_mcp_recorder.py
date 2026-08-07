from __future__ import annotations

import json
import threading
import time
import unittest
import uuid
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from agent_feedback import AgentFeedback, AgentFeedbackOptions

KEY = "af_live_0123456789abcdef0123456789abcdef_0123456789abcdef0123456789"
CONFORMANCE_DOCUMENT = json.loads(
    (Path(__file__).parents[3] / "protocol/v1/conformance.json").read_text()
)
CONFORMANCE = CONFORMANCE_DOCUMENT["mcpCompletion"]
VECTORS = CONFORMANCE["vectors"]
LINKED_JOURNEY = CONFORMANCE_DOCUMENT["mcpLinkedJourney"]


class MCPRecorderTests(unittest.TestCase):
    def runtime(self, events: list[dict], **options: object) -> AgentFeedback:
        return AgentFeedback(
            AgentFeedbackOptions(
                api_key=KEY,
                flush_interval=60,
                sender=lambda _url, _headers, body: events.extend(json.loads(body)["events"]),
                **options,
            )
        )

    def test_conformance_vectors(self) -> None:
        for vector in VECTORS:
            with self.subTest(vector["name"]):
                events: list[dict] = []
                runtime = self.runtime(events)
                values = vector["input"]
                kwargs = {
                    key: values.get(wire)
                    for key, wire in (
                        ("account_ref", "accountRef"), ("user_ref", "userRef"),
                        ("anonymous_ref", "anonymousRef"), ("customer_ref", "customerRef"),
                        ("session_ref", "sessionRef"), ("runtime_hint", "runtimeHint"),
                    )
                }
                if vector.get("expectedErrorKind"):
                    with self.assertRaisesRegex(ValueError, "invalid MCP"):
                        runtime.record_interaction(values["operation"], values["outcome"], **kwargs)
                    self.assertTrue(runtime.shutdown())
                    self.assertEqual(events, [])
                    continue
                runtime.record_interaction(values["operation"], values["outcome"], **kwargs)
                self.assertTrue(runtime.shutdown())
                event = events[0]
                generated = {name: event.pop(name) for name in ("interactionId", "sequence", "occurredAt")}
                self.assertEqual(event, vector["expectedEvent"])
                self.assertEqual(uuid.UUID(generated["interactionId"]).version, 4)
                self.assertGreater(generated["sequence"], 0)
                self.assertTrue(generated["occurredAt"].endswith("Z"))
                datetime.fromisoformat(generated["occurredAt"].replace("Z", "+00:00"))

    def test_fresh_ids_sequence_and_one_batch_flush(self) -> None:
        events: list[dict] = []
        runtime = self.runtime(events)
        for _ in range(51):
            runtime.record_interaction("summary", "success")
        self.assertTrue(runtime.flush())
        self.assertEqual(len(events), 50)
        self.assertEqual([event["sequence"] for event in events], list(range(1, 51)))
        self.assertEqual(len({event["interactionId"] for event in events}), 50)
        self.assertTrue(runtime.shutdown())
        self.assertEqual(len(events), 51)

    def test_shared_linked_journey_fixture(self) -> None:
        fixture = LINKED_JOURNEY
        events: list[dict] = []
        runtime = self.runtime(events)
        expected: list[tuple[str, str, str | None]] = []
        identity = fixture["identity"]
        for run in fixture["runs"]:
            for completion in run["completions"]:
                runtime.record_interaction(
                    completion["operation"], completion["outcome"],
                    account_ref=identity["accountRef"], user_ref=identity["userRef"],
                    anonymous_ref=identity["anonymousRef"], session_ref=run["sessionRef"],
                    runtime_hint=fixture["runtimeHint"],
                )
                expected.append((completion["operation"], completion["outcome"], run["sessionRef"]))
        for completion in fixture["unlinked"]:
            # The product did not resolve a canonical ref, so candidate proof is not passed.
            runtime.record_interaction(
                completion["operation"], completion["outcome"],
                account_ref=identity["accountRef"], user_ref=identity["userRef"],
                anonymous_ref=identity["anonymousRef"], runtime_hint=fixture["runtimeHint"],
            )
            expected.append((completion["operation"], completion["outcome"], None))
        self.assertTrue(runtime.shutdown())

        self.assertEqual(len(events), len(expected))
        self.assertEqual([event["sequence"] for event in events], list(range(1, len(events) + 1)))
        self.assertEqual(len({event["interactionId"] for event in events}), len(events))
        for event, (operation, outcome, session_ref) in zip(events, expected, strict=True):
            parsed_id = uuid.UUID(event["interactionId"])
            self.assertEqual(parsed_id.version, 4)
            self.assertEqual(parsed_id.variant, uuid.RFC_4122)
            self.assertEqual(event["surface"], "mcp")
            self.assertEqual(event["classification"], "confirmed")
            self.assertEqual(event["confirmationMethod"], "mcp")
            self.assertEqual(event["operation"], operation)
            self.assertEqual(event["statusCode"], 200 if outcome == "success" else 500)
            self.assertEqual(event.get("sessionRef"), session_ref)
            self.assertEqual(event.get("sessionSource"), "mcp" if session_ref else None)
            if session_ref is None:
                self.assertNotIn("sessionRef", event)
                self.assertNotIn("sessionSource", event)
            self.assertEqual(event["accountRef"], identity["accountRef"])
            self.assertEqual(event["userRef"], identity["userRef"])
            self.assertEqual(event["anonymousRef"], identity["anonymousRef"])
            self.assertEqual(event["runtimeHint"], fixture["runtimeHint"])
            self.assertEqual(event["runtimeHintSource"], "mcp")
        self.assertNotIn(fixture["privateContentSentinel"], json.dumps(events))

    def test_disabled_and_shutdown_skip_validation(self) -> None:
        events: list[dict] = []
        runtime = self.runtime(events, feedback_mode="off")
        runtime.record_interaction("unsafe?value", "partial")
        self.assertTrue(runtime.shutdown())
        runtime.record_interaction("unsafe?value", "partial")
        self.assertEqual(events, [])

    def test_invalid_required_fields_remain_synchronous_errors(self) -> None:
        runtime = self.runtime([])
        with self.assertRaisesRegex(ValueError, "invalid MCP operation"):
            runtime.record_interaction("unsafe?value", "success")
        with self.assertRaisesRegex(ValueError, "invalid MCP outcome"):
            runtime.record_interaction("summary", "partial")
        with self.assertRaisesRegex(ValueError, "invalid MCP outcome"):
            runtime.record_interaction("summary", [])  # type: ignore[arg-type]
        self.assertTrue(runtime.shutdown())

    def test_uuid_failure_is_fail_open_and_returns_none(self) -> None:
        runtime = self.runtime([])
        with patch("agent_feedback.core.uuid.uuid4", side_effect=RuntimeError("uuid unavailable")):
            self.assertIsNone(runtime.record_interaction("summary", "success"))
        self.assertTrue(runtime.shutdown())

    def test_worker_start_failure_is_fail_open_and_shutdown_is_bounded(self) -> None:
        runtime = self.runtime([], shutdown_timeout=5.0)
        with patch.object(threading.Thread, "start", side_effect=RuntimeError("thread unavailable")):
            self.assertIsNone(runtime.record_interaction("summary", "success"))
        self.assertIsNone(runtime.telemetry.thread)

        started = time.monotonic()
        self.assertFalse(runtime.shutdown())
        self.assertLess(time.monotonic() - started, 0.5)


if __name__ == "__main__":
    unittest.main()
