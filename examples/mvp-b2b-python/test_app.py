from __future__ import annotations

import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault(
    "EPODE_API_KEY",
    "af_live_0123456789abcdef0123456789abcdef_" + "x" * 32,
)

import app


class Server:
    def __init__(self, handler):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


class ManualClientSecurityTests(unittest.TestCase):
    def tearDown(self):
        app.EPODE_API_URL = "https://app.epode.ai"

    def test_redirect_is_rejected_without_forwarding_company_key(self):
        attacker_authorizations = []

        class Attacker(BaseHTTPRequestHandler):
            def do_POST(self):
                attacker_authorizations.append(self.headers.get("Authorization"))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"accepted":true}')

            def log_message(self, *_args):
                return None

        attacker = Server(Attacker)

        class Redirect(BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(302)
                self.send_header("Location", f"{attacker.url}/stolen")
                self.end_headers()

            def log_message(self, *_args):
                return None

        origin = Server(Redirect)
        try:
            app.EPODE_API_URL = origin.url
            status, response = app.post(
                "/api/v2/customer-context",
                {"interactionId": "interaction-1", "purpose": "product_personalization"},
                f"Bearer {os.environ['EPODE_API_KEY']}",
            )
            self.assertEqual(status, 502)
            self.assertEqual(response["error"], "epode_redirect_rejected")
            self.assertEqual(attacker_authorizations, [])
        finally:
            origin.close()
            attacker.close()

    def test_response_body_is_bounded(self):
        oversized = b"x" * (app.MAX_EPODE_RESPONSE_BYTES + 1)

        class Oversized(BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(oversized)))
                self.end_headers()
                self.wfile.write(oversized)

            def log_message(self, *_args):
                return None

        origin = Server(Oversized)
        try:
            app.EPODE_API_URL = origin.url
            status, response = app.post("/api/v2/customer-context", {}, "Bearer product-key")
            self.assertEqual(status, 502)
            self.assertEqual(response["error"], "epode_response_too_large")
        finally:
            origin.close()

    def test_relay_rewrites_post_consent_actions_to_same_origin(self):
        value = app.same_origin_relay_body(
            {
                "requestId": "request-1",
                "consent": None,
                "submit": {
                    "url": "https://app.epode.ai/api/v2/enrichment/answers",
                    "method": "POST",
                    "authorization": "Bearer aqr1_answer-1",
                },
            }
        )
        self.assertIsNone(value["consent"])
        self.assertEqual(value["submit"]["url"], "/_epode/v1/enrichment/answers")

    def test_relay_matches_backend_regulated_taxonomy(self):
        vectors = [
            ("medical_condition", "asthma"),
            ("shopping.preference", "political affiliation"),
            ("email", "person@example.com"),
            ("precise_location", "home"),
            ("date_of_birth", "1990-01-01"),
            ("demographics.gender", "woman"),
            ("household_income", "over 100000"),
            ("creditworthiness", "excellent"),
            ("shipping.zip", "10001"),
            ("citizenship", "citizen"),
            ("immigration_status", "temporary visa"),
            ("veteran_status", "veteran"),
            ("union_membership", "union member"),
            ("legal_history", "prior arrest"),
            ("genetic_profile", "dna marker"),
            ("audience", "teenager"),
            ("shopping.segment", "women"),
            ("account.status", "US citizen"),
            ("risk.label", "felony conviction"),
            ("shopping.preference", "gay"),
            ("shopping.preference", "Christian"),
            ("shopping.preference", "Muslim"),
            ("shopping.preference", "HIV positive"),
            ("shopping.preference", "has cancer"),
            ("shopping.preference", "Democrat"),
            ("shopping.preference", "handle@localhost"),
            ("shopping.preference", "af_live_deadbeef"),
        ]
        for key, value in vectors:
            with self.subTest(key=key, value=value):
                self.assertFalse(
                    app.valid_answer(
                        {
                            "status": "answered",
                            "items": [
                                {
                                    "key": key,
                                    "type": "preference",
                                    "value": value,
                                    "summary": "Customer supplied this targeting context.",
                                    "provenance": "agent_reports_user_statement",
                                    "remember": True,
                                }
                            ],
                        }
                    )
                )


if __name__ == "__main__":
    unittest.main()
