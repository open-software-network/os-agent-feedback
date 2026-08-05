from __future__ import annotations

import json
import unittest
from dataclasses import asdict

from agent_feedback import (
    CustomerAnswerInput,
    CustomerAnswerItem,
    CustomerContextInput,
    EnrichmentRequestInput,
    EpodeClient,
    PersonalizationDecisionInput,
    PersonalizationOutcomeInput,
    RelayRequest,
    same_origin_enrichment_request,
)

KEY = "af_live_0123456789abcdef0123456789abcdef_" + "x" * 32


class Backend:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, str], dict, float]] = []
        self.fail = False
        self.redirect = False

    def __call__(self, url: str, headers: dict[str, str], body: bytes, timeout: float):
        payload = json.loads(body)
        self.calls.append((url, dict(headers), payload, timeout))
        if self.fail:
            raise TimeoutError("offline")
        if self.redirect:
            return 302, b'{}'
        path = url.removeprefix("https://epode.test")
        if path == "/api/v2/enrichment/requests":
            return self.response(
                {
                    "requestId": "request-1",
                    "interactionId": payload["interactionId"],
                    "state": "consent_required",
                    "purpose": payload["purpose"],
                    "identityLevel": "verified" if payload.get("userRef") else "ephemeral",
                    "stageInstruction": "Answer the task before asking.",
                    "question": "May Example remember relevant preferences?",
                    "answerInstruction": "Answer the task before asking.",
                    "expiresAt": "2026-08-02T15:00:00Z",
                    "consent": {
                        "url": "https://app.epode.ai/api/v2/enrichment/consent/decisions",
                        "method": "POST",
                        "authorization": "Bearer aqr1_request-1",
                        "contentType": "application/json",
                    },
                }
            )
        if path == "/api/v2/customer-context":
            return self.response(
                {
                    "retrievalId": "retrieval-1",
                    "identityLevel": "pseudonymous" if payload.get("anonymousRef") else "ephemeral",
                    "interactionId": payload.get("interactionId"),
                    "contextVersion": "context-1",
                    "items": [
                        {
                            "signalId": "signal-1",
                            "key": "budget",
                            "type": "constraint",
                            "value": {"currency": "USD", "maximum": 150},
                            "summary": "Customer set a budget under $150.",
                            "provenance": "agent_reports_user_statement",
                            "confidence": 1,
                            "allowedUses": ["product_personalization"],
                            "remembered": True,
                        }
                    ],
                }
            )
        if path == "/api/v2/personalization/decisions":
            return self.response(
                {
                    "decision": {
                        "id": "decision-1",
                        "externalDecisionId": payload["externalDecisionId"],
                        "purpose": "product_personalization",
                        "signalIds": payload["signalIds"],
                        "variant": payload.get("variant"),
                        "createdAt": "2026-08-02T15:01:00Z",
                    }
                }
            )
        if path == "/api/v2/personalization/outcomes":
            return self.response(
                {
                    "outcome": {
                        "id": "outcome-1",
                        **payload,
                        "occurredAt": payload.get("occurredAt", "2026-08-02T15:02:00Z"),
                        "createdAt": "2026-08-02T15:02:01Z",
                    }
                }
            )
        if path.endswith("/consent/decisions"):
            return self.response(
                {
                    "requestId": "request-1",
                    "state": "answer_ready",
                    "changed": True,
                    "submit": {
                        "url": "https://app.epode.ai/api/v2/enrichment/answers",
                        "method": "POST",
                        "authorization": "Bearer aqr1_answer-1",
                        "contentType": "application/json",
                    },
                }
            )
        if path.endswith("/enrichment/answers"):
            return self.response({"accepted": True, "signals": payload["items"]})
        return 404, b'{"error":"not_found"}'

    @staticmethod
    def response(value: dict):
        return 200, json.dumps(value).encode()


class CustomerClientTests(unittest.TestCase):
    def test_complete_company_side_loop_and_identity_modes(self) -> None:
        backend = Backend()
        client = EpodeClient(KEY, endpoint="https://epode.test", transport=backend)
        request = client.request_enrichment(
            EnrichmentRequestInput(
                interaction_id="00000000-0000-4000-8000-000000000001",
                operation="recommendations",
                surface="http_json",
                status_code=200,
                duration_ms=17,
                session_ref="journey_42",
                runtime_hint="python-api/1.0",
                user_ref="user_42",
                remember=True,
            )
        )
        self.assertIsNotNone(request)
        assert request is not None
        visible = same_origin_enrichment_request(request)
        self.assertEqual(visible.consent.url, "/_epode/v1/enrichment/consent")
        self.assertNotIn(KEY, json.dumps(asdict(visible)))
        self.assertEqual(
            backend.calls[0][2],
            {
                "userRef": "user_42",
                "interactionId": "00000000-0000-4000-8000-000000000001",
                "operation": "recommendations",
                "surface": "http_json",
                "purpose": "product_personalization",
                "remember": True,
                "statusCode": 200,
                "durationMs": 17,
                "sessionRef": "journey_42",
                "runtimeHint": "python-api/1.0",
            },
        )

        context = client.get_customer_context(
            CustomerContextInput(anonymous_ref="visitor_42")
        )
        self.assertTrue(context.available)
        self.assertEqual(context.identity_level, "pseudonymous")
        self.assertEqual(context.items[0].allowed_uses, ("product_personalization",))
        self.assertEqual(context.items[0].value["maximum"], 150)
        ephemeral = client.get_customer_context(
            CustomerContextInput(interaction_id="00000000-0000-4000-8000-000000000001")
        )
        self.assertTrue(ephemeral.available)
        self.assertEqual(ephemeral.identity_level, "ephemeral")

        decision = client.record_personalization_decision(
            PersonalizationDecisionInput("recommendation_42", "retrieval-1", ("signal-1",))
        )
        self.assertTrue(decision.recorded)
        assert decision.decision is not None
        outcome = client.track_personalization_outcome(
            PersonalizationOutcomeInput("order_42", "decision-1", "conversion")
        )
        self.assertTrue(outcome.recorded)
        self.assertEqual(
            [call[0].removeprefix("https://epode.test") for call in backend.calls[-4:]],
            [
                "/api/v2/customer-context",
                "/api/v2/customer-context",
                "/api/v2/personalization/decisions",
                "/api/v2/personalization/outcomes",
            ],
        )
        self.assertTrue(all(call[3] == 0.25 for call in backend.calls))
        self.assertTrue(all(call[1]["authorization"] == f"Bearer {KEY}" for call in backend.calls))

    def test_relay_is_allowlisted_bounded_and_never_forwards_company_key(self) -> None:
        backend = Backend()
        client = EpodeClient(KEY, endpoint="https://epode.test", transport=backend)
        answer = CustomerAnswerInput(
            "answered",
            (
                CustomerAnswerItem(
                    key="shopping.budget_band",
                    type="customer_goal",
                    value="50_150",
                    provenance="agent_reports_user_statement",
                    confidence=1,
                    remember=True,
                ),
            ),
        )
        result = client.submit_answer("aqr1_answer-1", answer)
        self.assertEqual(result.status, 200)
        self.assertEqual(backend.calls[0][1]["authorization"], "Bearer aqr1_answer-1")
        self.assertNotIn(KEY, json.dumps(backend.calls[0]))
        self.assertNotIn("summary", backend.calls[0][2]["items"][0])
        consent = client.submit_consent("aqr1_request-1", "approved")
        self.assertEqual(consent.status, 200)
        self.assertEqual(consent.body["submit"]["url"], "/_epode/v1/enrichment/answers")

        invalid = client.relay(
            RelayRequest(
                "/_epode/v1/enrichment/answers",
                "Bearer aqr1_answer-1",
                {
                    "status": "answered",
                    "items": [
                        {
                            "key": "contact",
                            "type": "preference",
                            "value": "person@example.com",
                            "summary": "Customer email address",
                            "provenance": "agent_reports_user_statement",
                            "remember": True,
                        }
                    ],
                },
            )
        )
        self.assertEqual(invalid.status, 400)
        self.assertEqual(len(backend.calls), 2)
        unknown = client.relay(RelayRequest("/_epode/unknown", "Bearer aqr1_x", {}))
        self.assertEqual(unknown.status, 404)

    def test_relay_matches_backend_regulated_taxonomy_for_ads_and_personalization(self) -> None:
        backend = Backend()
        client = EpodeClient(KEY, endpoint="https://epode.test", transport=backend)
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
                result = client.relay(
                    RelayRequest(
                        "/_epode/v1/enrichment/answers",
                        "Bearer aqr1_targeted_ads",
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
                        },
                    )
                )
                self.assertEqual(result.status, 400)
        self.assertEqual(backend.calls, [])

    def test_enrichment_metadata_rejects_untrusted_or_sensitive_values_locally(self) -> None:
        backend = Backend()
        client = EpodeClient(KEY, endpoint="https://epode.test", transport=backend)
        for request in (
            EnrichmentRequestInput("interaction-1", "search", surface="browser"),
            EnrichmentRequestInput("interaction-1", "search", status_code=700),
            EnrichmentRequestInput("interaction-1", "search", duration_ms=-1),
            EnrichmentRequestInput(
                "interaction-1", "search", session_ref="prompt supplied journey"
            ),
            EnrichmentRequestInput(
                "interaction-1", "search", runtime_hint="political affiliation"
            ),
        ):
            with self.subTest(request=request):
                self.assertIsNone(client.request_enrichment(request))
        self.assertEqual(backend.calls, [])

    def test_context_decision_outcome_and_enrichment_fail_open(self) -> None:
        backend = Backend()
        backend.fail = True
        client = EpodeClient(KEY, endpoint="https://epode.test", transport=backend)
        self.assertIsNone(
            client.request_enrichment(EnrichmentRequestInput("interaction-1", "search"))
        )
        self.assertFalse(client.get_customer_context(CustomerContextInput()).available)
        self.assertFalse(
            client.record_personalization_decision(
                PersonalizationDecisionInput("decision-1", "retrieval-1", ())
            ).recorded
        )
        self.assertFalse(
            client.track_personalization_outcome(
                PersonalizationOutcomeInput("outcome-1", "decision-1", "conversion")
            ).recorded
        )
        self.assertEqual(client.submit_consent("aqr1_request-1", "approved").status, 503)

        backend.fail = False
        backend.redirect = True
        self.assertIsNone(
            client.request_enrichment(EnrichmentRequestInput("interaction-1", "search"))
        )
        self.assertEqual(client.submit_consent("aqr1_request-1", "approved").status, 502)


if __name__ == "__main__":
    unittest.main()
