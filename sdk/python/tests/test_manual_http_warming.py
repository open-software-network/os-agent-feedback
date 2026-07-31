from __future__ import annotations

import importlib.util
import os
import threading
import time
import unittest
from pathlib import Path
from unittest import mock


SERVER_PATH = Path(__file__).resolve().parents[3] / "examples/setup-matrix-manual-http/server.py"
KEY = "af_live_0123456789abcdef0123456789abcdef_conformance_secret_0123456789abcdef"


def load_server():
    spec = importlib.util.spec_from_file_location("manual_http_warming_fixture", SERVER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load the manual HTTP example")
    module = importlib.util.module_from_spec(spec)
    with mock.patch.dict(os.environ, {
        "AGENT_FEEDBACK_KEY": KEY,
        "AGENT_FEEDBACK_MODE": "ask_once",
    }):
        spec.loader.exec_module(module)
    return module


class ManualHttpConsentWarmingTests(unittest.TestCase):
    def test_manual_warming_is_bounded_and_recovers_from_scheduling_failure(self) -> None:
        server = load_server()

        class UnstartableThread:
            def start(self) -> None:
                raise RuntimeError("thread scheduling unavailable")

        with mock.patch.object(
            server.threading,
            "Thread",
            side_effect=lambda **_kwargs: UnstartableThread(),
        ):
            for index in range(server.MAX_CONCURRENT_CONSENT_WARMS):
                server.warm_consent(f"failed-{index}")

        self.assertEqual(server.CONSENT_LOOKUPS, set())

        release = threading.Event()
        started: set[str] = set()
        started_lock = threading.Lock()

        def lookup(subject: str) -> str:
            with started_lock:
                started.add(subject)
            release.wait(1)
            return "unknown"

        server.lookup_consent = lookup
        for index in range(server.MAX_CONCURRENT_CONSENT_WARMS * 4):
            server.warm_consent(f"customer-{index}")

        self.assertTrue(self.wait_until(
            lambda: len(started) == server.MAX_CONCURRENT_CONSENT_WARMS
        ))
        self.assertEqual(len(server.CONSENT_LOOKUPS), server.MAX_CONCURRENT_CONSENT_WARMS)
        time.sleep(0.02)
        self.assertEqual(len(started), server.MAX_CONCURRENT_CONSENT_WARMS)

        release.set()
        self.assertTrue(self.wait_until(lambda: not server.CONSENT_LOOKUPS))
        server.warm_consent("failed-0")
        self.assertTrue(self.wait_until(
            lambda: len(started) == server.MAX_CONCURRENT_CONSENT_WARMS + 1
        ))
        self.assertTrue(self.wait_until(lambda: not server.CONSENT_LOOKUPS))

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
