package agentfeedback

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCustomerClientCompletesEnrichmentPersonalizationLoop(t *testing.T) {
	key := "af_live_0123456789abcdef0123456789abcdef_" + strings.Repeat("x", 32)
	var calls []string
	var authorizations []string
	var enrichmentBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls = append(calls, request.URL.Path)
		authorizations = append(authorizations, request.Header.Get("Authorization"))
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/api/v2/enrichment/requests":
			enrichmentBody = body
			_ = json.NewEncoder(response).Encode(map[string]any{
				"requestId": "request-1", "interactionId": body["interactionId"],
				"state": "consent_required", "purpose": body["purpose"], "identityLevel": "verified",
				"stageInstruction": "Answer before asking.",
				"question":         "May Example remember relevant preferences?", "answerInstruction": "Answer first.",
				"expiresAt": "2026-08-02T15:00:00Z", "consent": map[string]any{
					"url": "https://app.epode.ai/api/v2/enrichment/consent/decisions", "method": "POST",
					"authorization": "Bearer aqr1_request-1", "contentType": "application/json",
				},
			})
		case "/api/v2/customer-context":
			level := "ephemeral"
			if body["anonymousRef"] != nil {
				level = "pseudonymous"
			}
			_ = json.NewEncoder(response).Encode(map[string]any{
				"retrievalId": "retrieval-1", "identityLevel": level, "interactionId": body["interactionId"],
				"contextVersion": "context-1", "items": []any{map[string]any{
					"signalId": "signal-1", "key": "budget", "type": "constraint", "value": "under_150_usd",
					"summary": "Customer set a budget under $150.", "provenance": "agent_reports_user_statement",
					"allowedUses": []string{"product_personalization"}, "remembered": true,
				}},
			})
		case "/api/v2/personalization/decisions":
			_ = json.NewEncoder(response).Encode(map[string]any{"decision": map[string]any{
				"id": "decision-1", "externalDecisionId": body["externalDecisionId"], "purpose": "product_personalization",
				"signalIds": body["signalIds"], "createdAt": "2026-08-02T15:01:00Z",
			}})
		case "/api/v2/personalization/outcomes":
			_ = json.NewEncoder(response).Encode(map[string]any{"outcome": map[string]any{
				"id": "outcome-1", "externalOutcomeId": body["externalOutcomeId"], "decisionId": body["decisionId"],
				"outcome": body["outcome"], "occurredAt": "2026-08-02T15:02:00Z", "createdAt": "2026-08-02T15:02:01Z",
			}})
		case "/api/v2/enrichment/answers":
			_ = json.NewEncoder(response).Encode(map[string]any{"accepted": true})
		case "/api/v2/enrichment/consent/decisions":
			_ = json.NewEncoder(response).Encode(map[string]any{
				"requestId": "request-1", "state": "answer_ready", "changed": true,
				"submit": map[string]any{
					"url": "https://app.epode.ai/api/v2/enrichment/answers", "method": "POST",
					"authorization": "Bearer aqr1_answer-1", "contentType": "application/json",
				},
			})
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	client, err := NewCustomerClient(CustomerClientOptions{APIKey: key, Endpoint: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	statusCode := 200
	durationMS := int64(23)
	request := client.RequestEnrichment(context.Background(), EnrichmentRequestInput{
		CustomerIdentity: CustomerIdentity{UserRef: "user_42"}, InteractionID: "interaction-1",
		Operation: "recommendations", Surface: SurfaceHTTPJSON, StatusCode: &statusCode,
		DurationMS: &durationMS, SessionRef: "journey_42", RuntimeHint: "go-api/1.0",
		Purpose: ProductPersonalization, Remember: true,
	})
	if request == nil {
		t.Fatal("enrichment request failed open unexpectedly")
	}
	if enrichmentBody["surface"] != "http_json" || enrichmentBody["statusCode"] != float64(200) || enrichmentBody["durationMs"] != float64(23) || enrichmentBody["sessionRef"] != "journey_42" || enrichmentBody["runtimeHint"] != "go-api/1.0" {
		t.Fatalf("same-call enrichment metadata was not preserved: %#v", enrichmentBody)
	}
	visible := SameOriginEnrichmentRequest(*request)
	if visible.Consent == nil || visible.Consent.URL != "/_epode/v1/enrichment/consent" {
		t.Fatalf("unsafe relay URL: %s", visible.Consent.URL)
	}
	encoded, _ := json.Marshal(visible)
	if strings.Contains(string(encoded), key) {
		t.Fatal("company key leaked to agent-visible request")
	}

	contextResult := client.GetCustomerContext(context.Background(), CustomerContextInput{
		CustomerIdentity: CustomerIdentity{AnonymousRef: "visitor_42"}, Purpose: ProductPersonalization,
	})
	if !contextResult.Available || contextResult.IdentityLevel != "pseudonymous" || len(contextResult.Items) != 1 {
		t.Fatalf("unexpected context: %#v", contextResult)
	}
	ephemeral := client.GetCustomerContext(context.Background(), CustomerContextInput{InteractionID: "interaction-1", Purpose: ProductPersonalization})
	if !ephemeral.Available || ephemeral.IdentityLevel != "ephemeral" {
		t.Fatalf("unexpected ephemeral context: %#v", ephemeral)
	}
	decision := client.RecordPersonalizationDecision(context.Background(), PersonalizationDecisionInput{
		ExternalDecisionID: "recommendation_42", ContextRetrievalID: "retrieval-1", SignalIDs: []string{"signal-1"},
	})
	if !decision.Recorded || decision.Decision.ID != "decision-1" {
		t.Fatalf("decision not recorded: %#v", decision)
	}
	outcome := client.TrackPersonalizationOutcome(context.Background(), PersonalizationOutcomeInput{
		ExternalOutcomeID: "order_42", DecisionID: decision.Decision.ID, Outcome: "conversion",
	})
	if !outcome.Recorded {
		t.Fatalf("outcome not recorded: %#v", outcome)
	}
	beforeInvalid := len(calls)
	if client.RequestEnrichment(context.Background(), EnrichmentRequestInput{
		InteractionID: "interaction-2", Operation: "search", RuntimeHint: "political affiliation",
	}) != nil || len(calls) != beforeInvalid {
		t.Fatal("sensitive runtime metadata must fail open before network delivery")
	}
	answer := client.SubmitAnswer(context.Background(), "aqr1_answer-1", CustomerAnswerInput{Status: "answered", Items: []CustomerAnswerItem{{
		Key: "shopping.budget_band", Type: "customer_goal", Value: "50_150", Provenance: "agent_reports_user_statement", Remember: true,
	}}})
	if answer.Status != http.StatusOK {
		t.Fatalf("answer relay failed: %#v", answer)
	}
	withoutSummary, err := json.Marshal(CustomerAnswerInput{Status: "answered", Items: []CustomerAnswerItem{{Key: "shopping.priority", Type: "preference", Value: "quality", Provenance: "agent_reports_current_task", Remember: false}}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(withoutSummary), `"summary"`) {
		t.Fatal("optional summary must be omitted")
	}
	if authorizations[len(authorizations)-1] != "Bearer aqr1_answer-1" {
		t.Fatal("relay exposed or substituted company authorization")
	}
	for _, authorization := range authorizations[:len(authorizations)-1] {
		if authorization != "Bearer "+key {
			t.Fatalf("company call missing key: %q", authorization)
		}
	}
	if len(calls) != 6 {
		t.Fatalf("unexpected calls: %#v", calls)
	}
	consent := client.SubmitConsent(context.Background(), "aqr1_request-1", "approved")
	if consent.Status != http.StatusOK {
		t.Fatalf("consent relay failed: %#v", consent)
	}
	consentBody := consent.Body.(map[string]any)
	if consentBody["submit"].(map[string]any)["url"] != "/_epode/v1/enrichment/answers" {
		t.Fatalf("relay exposed upstream submit URL: %#v", consent.Body)
	}
	if authorizations[len(authorizations)-1] != "Bearer aqr1_request-1" {
		t.Fatal("consent relay substituted the company key")
	}
}

func TestCustomerRelayRejectsSensitiveUnknownAndRedirectedAnswers(t *testing.T) {
	key := "af_live_0123456789abcdef0123456789abcdef_" + strings.Repeat("x", 32)
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls++
		http.Redirect(response, request, "https://other.example", http.StatusFound)
	}))
	defer server.Close()
	client, err := NewCustomerClient(CustomerClientOptions{APIKey: key, Endpoint: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	invalid := client.Relay(context.Background(), RelayRequest{
		Path: "/_epode/v1/enrichment/answers", Authorization: "Bearer aqr1_safe",
		Body: map[string]any{"status": "answered", "items": []any{map[string]any{
			"key": "contact", "type": "preference", "value": "person@example.com", "summary": "Customer email",
			"provenance": "agent_reports_user_statement", "remember": true,
		}}},
	})
	if invalid.Status != http.StatusBadRequest || calls != 0 {
		t.Fatalf("sensitive answer escaped validator: %#v", invalid)
	}
	redirect := client.SubmitConsent(context.Background(), "aqr1_request-1", "approved")
	if redirect.Status != http.StatusBadGateway || calls != 1 {
		t.Fatalf("redirect was not rejected: %#v", redirect)
	}
}

func TestCustomerOperationsFailOpenWithinTimeout(t *testing.T) {
	key := "af_live_0123456789abcdef0123456789abcdef_" + strings.Repeat("x", 32)
	client, err := NewCustomerClient(CustomerClientOptions{
		APIKey: key, Endpoint: "https://epode.test", Timeout: 10 * time.Millisecond, RelayTimeout: 10 * time.Millisecond,
		HTTPClient: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			<-request.Context().Done()
			return nil, request.Context().Err()
		})},
	})
	if err != nil {
		t.Fatal(err)
	}
	if client.RequestEnrichment(context.Background(), EnrichmentRequestInput{InteractionID: "interaction-1", Operation: "search"}) != nil {
		t.Fatal("enrichment did not fail open")
	}
	if client.GetCustomerContext(context.Background(), CustomerContextInput{InteractionID: "interaction-1"}).Available {
		t.Fatal("context did not fail open")
	}
	if client.RecordPersonalizationDecision(context.Background(), PersonalizationDecisionInput{ExternalDecisionID: "decision-1", ContextRetrievalID: "retrieval-1"}).Recorded {
		t.Fatal("decision did not fail open")
	}
	if client.TrackPersonalizationOutcome(context.Background(), PersonalizationOutcomeInput{ExternalOutcomeID: "outcome-1", DecisionID: "decision-1", Outcome: "conversion"}).Recorded {
		t.Fatal("outcome did not fail open")
	}
	if client.SubmitConsent(context.Background(), "aqr1_request-1", "approved").Status != http.StatusServiceUnavailable {
		t.Fatal("relay outage was not retryable")
	}
}

func TestCustomerRelayMatchesBackendRegulatedTaxonomy(t *testing.T) {
	key := "af_live_0123456789abcdef0123456789abcdef_" + strings.Repeat("x", 32)
	calls := 0
	client, err := NewCustomerClient(CustomerClientOptions{
		APIKey: key,
		HTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			calls++
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"accepted":true}`)), Header: make(http.Header)}, nil
		})},
	})
	if err != nil {
		t.Fatal(err)
	}
	vectors := [][2]string{
		{"medical_condition", "asthma"},
		{"shopping.preference", "political affiliation"},
		{"email", "person@example.com"},
		{"precise_location", "home"},
		{"date_of_birth", "1990-01-01"},
		{"demographics.gender", "woman"},
		{"household_income", "over 100000"},
		{"creditworthiness", "excellent"},
		{"shipping.zip", "10001"},
		{"citizenship", "citizen"},
		{"immigration_status", "temporary visa"},
		{"veteran_status", "veteran"},
		{"union_membership", "union member"},
		{"legal_history", "prior arrest"},
		{"genetic_profile", "dna marker"},
		{"audience", "teenager"},
		{"shopping.segment", "women"},
		{"account.status", "US citizen"},
		{"risk.label", "felony conviction"},
		{"shopping.preference", "gay"},
		{"shopping.preference", "Christian"},
		{"shopping.preference", "Muslim"},
		{"shopping.preference", "HIV positive"},
		{"shopping.preference", "has cancer"},
		{"shopping.preference", "Democrat"},
		{"shopping.preference", "handle@localhost"},
		{"shopping.preference", "af_live_deadbeef"},
	}
	for _, vector := range vectors {
		result := client.Relay(context.Background(), RelayRequest{
			Path: "/_epode/v1/enrichment/answers", Authorization: "Bearer aqr1_targeted_ads",
			Body: map[string]any{"status": "answered", "items": []any{map[string]any{
				"key": vector[0], "type": "preference", "value": vector[1],
				"summary":    "Customer supplied this targeting context.",
				"provenance": "agent_reports_user_statement", "remember": true,
			}}},
		})
		if result.Status != http.StatusBadRequest {
			t.Fatalf("regulated vector escaped relay: %#v => %#v", vector, result)
		}
	}
	if calls != 0 {
		t.Fatalf("regulated answers reached network %d times", calls)
	}
}
