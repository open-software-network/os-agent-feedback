from __future__ import annotations

import json
import threading
import time
import unittest
from io import BytesIO
from unittest import mock

from agent_feedback import AgentFeedback, AgentFeedbackASGI, AgentFeedbackOptions, AgentFeedbackWSGI
from agent_feedback.core import MAX_CONCURRENT_CONSENT_WARMS


KEY = "af_live_0123456789abcdef0123456789abcdef_conformance_secret_0123456789abcdef"


class ConsentWarmingTests(unittest.IsolatedAsyncioTestCase):
    def runtime(self) -> AgentFeedback:
        return AgentFeedback(AgentFeedbackOptions(
            api_key=KEY,
            endpoint="https://feedback.test",
            feedback_mode="ask_once",
            sender=lambda *_: None,
        ))

    def test_thread_scheduling_failure_rolls_back_subject_and_slots(self) -> None:
        runtime = self.runtime()

        class UnstartableThread:
            def start(self) -> None:
                raise RuntimeError("thread scheduling unavailable")

        with mock.patch(
            "agent_feedback.core.threading.Thread",
            side_effect=lambda **_kwargs: UnstartableThread(),
        ):
            for index in range(MAX_CONCURRENT_CONSENT_WARMS):
                runtime.warm_consent(f"failed-{index}")
            runtime.warm_consent("failed-0")

        self.assertEqual(runtime._consent_lookups, set())

        started = threading.Event()
        release = threading.Event()

        def lookup(_subject: str) -> str:
            started.set()
            release.wait(1)
            return "unknown"

        runtime._lookup_consent_subject = lookup
        runtime.warm_consent("failed-0")
        self.assertTrue(started.wait(0.2), "failed scheduling leaked its subject or permit")
        release.set()
        self.assertTrue(self.wait_until(lambda: not runtime._consent_lookups))
        runtime.shutdown()

    def test_high_cardinality_warming_never_exceeds_eight_lookups(self) -> None:
        runtime = self.runtime()
        release = threading.Event()
        started: set[str] = set()
        started_lock = threading.Lock()

        def lookup(subject: str) -> str:
            with started_lock:
                started.add(subject)
            release.wait(1)
            return "unknown"

        runtime._lookup_consent_subject = lookup
        for index in range(MAX_CONCURRENT_CONSENT_WARMS * 4):
            runtime.warm_consent(f"customer-{index}")

        self.assertTrue(
            self.wait_until(lambda: len(started) == MAX_CONCURRENT_CONSENT_WARMS),
            f"expected {MAX_CONCURRENT_CONSENT_WARMS} admitted lookups, got {len(started)}",
        )
        self.assertEqual(len(runtime._consent_lookups), MAX_CONCURRENT_CONSENT_WARMS)
        time.sleep(0.02)
        self.assertEqual(len(started), MAX_CONCURRENT_CONSENT_WARMS)

        release.set()
        self.assertTrue(self.wait_until(lambda: not runtime._consent_lookups))
        runtime.warm_consent("customer-skipped-while-full")
        self.assertTrue(
            self.wait_until(lambda: len(started) == MAX_CONCURRENT_CONSENT_WARMS + 1),
            "a released warming slot was not reusable",
        )
        self.assertTrue(self.wait_until(lambda: not runtime._consent_lookups))
        runtime.shutdown()

    async def test_asgi_response_survives_thread_scheduling_failure(self) -> None:
        body = b'{"answer":"available"}'

        async def app(_scope, _receive, send):
            await send({
                "type": "http.response.start",
                "status": 200,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                ],
            })
            await send({"type": "http.response.body", "body": body})

        middleware = AgentFeedbackASGI(
            app,
            api_key=KEY,
            feedback_mode="ask_once",
            customer_ref=lambda _scope: "customer",
            sender=lambda *_: None,
        )
        sent: list[dict] = []
        real_thread = threading.Thread

        def schedule_thread(*args, **kwargs):
            if kwargs.get("name") == "agent-feedback-consent":
                raise RuntimeError("thread scheduling unavailable")
            return real_thread(*args, **kwargs)

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message):
            sent.append(message)

        with mock.patch(
            "agent_feedback.core.threading.Thread",
            side_effect=schedule_thread,
        ):
            await middleware(
                {"type": "http", "method": "GET", "path": "/", "headers": []},
                receive,
                send,
            )

        self.assertEqual(json.loads(sent[1]["body"])["answer"], "available")
        self.assertEqual(middleware.runtime._consent_lookups, set())
        middleware.shutdown()

    def test_wsgi_response_survives_thread_scheduling_failure(self) -> None:
        body = b'{"answer":"available"}'

        def app(_environ, start_response):
            start_response("200 OK", [
                ("Content-Type", "application/json"),
                ("Content-Length", str(len(body))),
            ])
            return [body]

        middleware = AgentFeedbackWSGI(
            app,
            api_key=KEY,
            feedback_mode="ask_once",
            customer_ref=lambda _environ: "customer",
            sender=lambda *_: None,
        )
        captured: dict = {}
        real_thread = threading.Thread

        def schedule_thread(*args, **kwargs):
            if kwargs.get("name") == "agent-feedback-consent":
                raise RuntimeError("thread scheduling unavailable")
            return real_thread(*args, **kwargs)

        with mock.patch(
            "agent_feedback.core.threading.Thread",
            side_effect=schedule_thread,
        ):
            output = b"".join(middleware(
                {"PATH_INFO": "/", "REQUEST_METHOD": "GET", "wsgi.input": BytesIO()},
                lambda status, headers, _exc=None: captured.update(status=status, headers=headers),
            ))

        self.assertEqual(json.loads(output)["answer"], "available")
        self.assertEqual(captured["status"], "200 OK")
        self.assertEqual(middleware.runtime._consent_lookups, set())
        middleware.shutdown()

    @staticmethod
    def wait_until(predicate, timeout: float = 0.5) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.005)
        return predicate()


if __name__ == "__main__":
    unittest.main()
