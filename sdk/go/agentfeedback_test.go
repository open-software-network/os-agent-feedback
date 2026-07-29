package agentfeedback

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const conformanceKey = "af_live_0123456789abcdef0123456789abcdef_conformance_secret_0123456789abcdef"
const conformanceToken = "afr2_0123456789abcdef0123456789abcdef.eyJ2IjoxLCJpIjoiMDE4ZjFmMmUtN2I0YS03YzEyLTljOGQtMTIzNDU2Nzg5YWJjIiwiaWF0IjoxNzE1MDAwMDAwLCJleHAiOjE3MTUwMDcyMDAsIm4iOiJBUUlEQkFVR0J3Z0pDZ3NNRFE0UEVCRVMifQ.wxJ0YGS21x9eW-Cn33t9V1INhyGNj1_U3qoQns3vdWA"

func TestCapabilityConformance(t *testing.T) {
	token, err := SignCapability(conformanceKey, claims{
		V: 1, I: "018f1f2e-7b4a-7c12-9c8d-123456789abc",
		IAT: 1715000000, EXP: 1715007200, N: "AQIDBAUGBwgJCgsMDQ4PEBES",
	})
	if err != nil || token != conformanceToken {
		t.Fatalf("unexpected token: %s %v", token, err)
	}
}

func TestMiddlewarePreservesShapeAndQueuesOpportunity(t *testing.T) {
	telemetry := make(chan map[string]any, 1)
	runtime, err := New(Options{
		APIKey: conformanceKey, Endpoint: "https://feedback.test",
		Include: []string{"/status"}, FlushInterval: time.Millisecond,
		Sender: func(_ context.Context, _ string, _ http.Header, body []byte) error {
			var value map[string]any
			_ = json.Unmarshal(body, &value)
			telemetry <- value
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Shutdown(context.Background())
	handler := runtime.Middleware(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(map[string]any{"available": true})
	}))
	request := httptest.NewRequest(http.MethodGet, "/status", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	var body map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &body)
	if body["available"] != true {
		t.Fatalf("shape changed: %#v", body)
	}
	feedback := body["_agentFeedback"].(map[string]any)
	if feedback["reliability"] != "best_effort_without_agent_adapter" {
		t.Fatalf("wrong reliability: %#v", feedback)
	}
	select {
	case batch := <-telemetry:
		events := batch["events"].([]any)
		if events[0].(map[string]any)["classification"] != "unclassified" {
			t.Fatal("wrong classification")
		}
	case <-time.After(time.Second):
		t.Fatal("telemetry was not flushed")
	}
}

func TestAgentHelperRejectsUntrustedOrigin(t *testing.T) {
	envelope := &Envelope{
		V: 1, Mode: FeedbackAuto, Requested: true, ConsentPolicy: "none",
		When: "after_outcome_known_before_final_response",
		Submit: SubmitContract{
			URL: "https://evil.test/outcomes", Method: http.MethodPost,
			Authorization: "Bearer afr2_test.payload.signature", ContentType: "application/json",
		}}
	_, err := SubmitProductOutcome(context.Background(), envelope, OutcomeReview{
		Outcome: "success", Note: "The product completed the task.",
	}, []string{"https://feedback.test"}, nil)
	if err == nil {
		t.Fatal("untrusted origin was accepted")
	}
}

func TestAgentHelperRejectsMalformedConsentContracts(t *testing.T) {
	runtime, err := New(Options{APIKey: conformanceKey, FeedbackMode: FeedbackAskAlways})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Shutdown(context.Background())
	prepared, err := runtime.prepare(time.Unix(1_715_000_000, 0))
	if err != nil {
		t.Fatal(err)
	}
	malformed := prepared.Envelope
	malformed.ConsentRequired = false
	if validEnvelope(&malformed) || FeedbackConsentAction(&malformed, "approved") != "skip" {
		t.Fatal("malformed ask-always contract was accepted")
	}
	malformed = prepared.Envelope
	malformed.Mode = FeedbackAskOnce
	malformed.ConsentPolicy = "once"
	malformed.When = "after_outcome_known_and_consent_resolved"
	malformed.ConsentScope = ""
	if validEnvelope(&malformed) {
		t.Fatal("ask-once contract without a scope was accepted")
	}
}

func TestAskModesExposeDistinctConsentPolicies(t *testing.T) {
	runtime, err := New(Options{APIKey: conformanceKey, FeedbackMode: FeedbackAskOnce})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Shutdown(context.Background())
	prepared, err := runtime.prepare(time.Unix(1_715_000_000, 0))
	if err != nil {
		t.Fatal(err)
	}
	envelope := prepared.Envelope
	if !envelope.Requested || !envelope.ConsentRequired {
		t.Fatalf("ask contract is not requested with consent: %#v", envelope)
	}
	if envelope.ConsentPolicy != "once" || envelope.ConsentScope != "afcs1_0123456789abcdef0123456789abcdef" {
		t.Fatalf("wrong ask-once scope: %#v", envelope)
	}
	if envelope.When != "after_outcome_known_and_consent_resolved" {
		t.Fatalf("wrong ask timing: %s", envelope.When)
	}
	if !strings.Contains(envelope.Instruction, "ask the user once") ||
		!strings.Contains(envelope.Instruction, "do not ask again") {
		t.Fatalf("wrong ask instruction: %s", envelope.Instruction)
	}
	if FeedbackConsentAction(&envelope, "") != "ask" ||
		FeedbackConsentAction(&envelope, "approved") != "submit" ||
		FeedbackConsentAction(&envelope, "refused") != "skip" {
		t.Fatal("ask-once decision was not resolved correctly")
	}
	_, err = SubmitProductOutcome(context.Background(), &envelope, OutcomeReview{
		Outcome: "success", Note: "The product completed the task.",
	}, []string{"https://feedback.test"}, nil)
	if err == nil || !strings.Contains(err.Error(), "explicit user approval") {
		t.Fatalf("ask helper did not enforce approval: %v", err)
	}

	always, err := New(Options{APIKey: conformanceKey, FeedbackMode: FeedbackAskAlways})
	if err != nil {
		t.Fatal(err)
	}
	defer always.Shutdown(context.Background())
	alwaysPrepared, err := always.prepare(time.Unix(1_715_000_000, 0))
	if err != nil {
		t.Fatal(err)
	}
	if alwaysPrepared.Envelope.ConsentPolicy != "always" || alwaysPrepared.Envelope.ConsentScope != "" {
		t.Fatalf("wrong ask-always policy: %#v", alwaysPrepared.Envelope)
	}
	if !strings.Contains(alwaysPrepared.Envelope.Instruction, "every future report") {
		t.Fatalf("ask-always does not require fresh permission: %s", alwaysPrepared.Envelope.Instruction)
	}
	if FeedbackConsentAction(&alwaysPrepared.Envelope, "approved") != "ask" {
		t.Fatal("ask-always incorrectly reused stored approval")
	}
}

type flushingRecorder struct {
	*httptest.ResponseRecorder
}

func (recorder flushingRecorder) Flush() {}

func TestMiddlewareLeavesFlushedStreamsUntouched(t *testing.T) {
	runtime, err := New(Options{APIKey: conformanceKey, Include: []string{"/stream"}})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Shutdown(context.Background())
	handler := runtime.Middleware(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "text/event-stream")
		_, _ = response.Write([]byte("first\n"))
		response.(http.Flusher).Flush()
		_, _ = response.Write([]byte("second\n"))
	}))
	base := httptest.NewRecorder()
	handler.ServeHTTP(flushingRecorder{base}, httptest.NewRequest(http.MethodGet, "/stream", nil))
	if base.Body.String() != "first\nsecond\n" {
		t.Fatalf("stream changed: %q", base.Body.String())
	}
	if base.Header().Get("Agent-Feedback") != "" {
		t.Fatal("stream was instrumented")
	}
}
