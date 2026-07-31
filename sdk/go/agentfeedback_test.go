package agentfeedback

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const conformanceKey = "af_live_0123456789abcdef0123456789abcdef_conformance_secret_0123456789abcdef"
const conformanceToken = "afr2_0123456789abcdef0123456789abcdef.eyJ2IjoxLCJpIjoiMDE4ZjFmMmUtN2I0YS03YzEyLTljOGQtMTIzNDU2Nzg5YWJjIiwiaWF0IjoxNzE1MDAwMDAwLCJleHAiOjE3MTUwMDcyMDAsIm4iOiJBUUlEQkFVR0J3Z0pDZ3NNRFE0UEVCRVMifQ.wxJ0YGS21x9eW-Cn33t9V1INhyGNj1_U3qoQns3vdWA"

func TestAskOnceConsentKeySurvivesRotation(t *testing.T) {
	scope := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	first := "af_live_11111111111111111111111111111111_" + scope + "_" + strings.Repeat("x", 32)
	rotated := "af_live_22222222222222222222222222222222_" + scope + "_" + strings.Repeat("y", 32)
	other := "af_live_33333333333333333333333333333333_" + strings.Repeat("b", 32) + "_" + strings.Repeat("z", 32)
	_, _, firstConsent, firstErr := keyParts(first)
	_, _, rotatedConsent, rotatedErr := keyParts(rotated)
	_, _, otherConsent, otherErr := keyParts(other)
	if firstErr != nil || rotatedErr != nil || otherErr != nil {
		t.Fatalf("unexpected key parse error: %v %v %v", firstErr, rotatedErr, otherErr)
	}
	if string(firstConsent) != string(rotatedConsent) {
		t.Fatal("rotated key changed the Ask-once consent scope")
	}
	if string(firstConsent) == string(otherConsent) {
		t.Fatal("different products shared an Ask-once consent scope")
	}
}

func TestCapabilityConformance(t *testing.T) {
	token, err := SignCapability(conformanceKey, claims{
		V: 1, I: "018f1f2e-7b4a-7c12-9c8d-123456789abc",
		IAT: 1715000000, EXP: 1715007200, N: "AQIDBAUGBwgJCgsMDQ4PEBES",
	})
	if err != nil || token != conformanceToken {
		t.Fatalf("unexpected token: %s %v", token, err)
	}
}

func TestLegacyAutoModeIsRejected(t *testing.T) {
	_, err := New(Options{APIKey: conformanceKey, FeedbackMode: FeedbackMode("auto")})
	if err == nil || !strings.Contains(err.Error(), "never_ask, ask_once, ask_always, or off") {
		t.Fatalf("expected strict mode validation, got %v", err)
	}
}

func TestInvalidCacheModeIsRejected(t *testing.T) {
	_, err := New(Options{APIKey: conformanceKey, CacheMode: HTTPCacheMode("surprise")})
	if err == nil || !strings.Contains(err.Error(), "safe, private, or request") {
		t.Fatalf("expected strict cache mode validation, got %v", err)
	}
}

func TestMiddlewareCacheModesPreservePublicResponsesUnlessExplicit(t *testing.T) {
	tests := []struct {
		name         string
		mode         HTTPCacheMode
		requestOptIn bool
		instrumented bool
	}{
		{name: "safe", mode: CacheSafe},
		{name: "request ordinary", mode: CacheRequest},
		{name: "request opted in", mode: CacheRequest, requestOptIn: true, instrumented: true},
		{name: "private", mode: CachePrivate, instrumented: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			runtime, err := New(Options{
				APIKey: conformanceKey, CacheMode: test.mode, Include: []string{"/status"},
				FlushInterval: time.Hour, Sender: func(context.Context, string, http.Header, []byte) error { return nil },
			})
			if err != nil {
				t.Fatal(err)
			}
			handler := runtime.Middleware(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				response.Header().Set("Content-Type", "application/json")
				response.Header().Set("Cache-Control", "public, s-maxage=600")
				_, _ = response.Write([]byte(`{"answer":"cached"}`))
			}))
			request := httptest.NewRequest(http.MethodGet, "/status", nil)
			if test.requestOptIn {
				request.Header.Set("Agent-Feedback-Request", "1")
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			var body map[string]any
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			_, instrumented := body["_agentFeedback"]
			if instrumented != test.instrumented {
				t.Fatalf("instrumented = %v, want %v", instrumented, test.instrumented)
			}
			wantCache := "public, s-maxage=600"
			if test.instrumented {
				wantCache = "private, no-store"
			}
			if got := response.Header().Get("Cache-Control"); got != wantCache {
				t.Fatalf("Cache-Control = %q, want %q", got, wantCache)
			}
			if err := runtime.Shutdown(context.Background()); err != nil {
				t.Fatal(err)
			}
		})
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
		event := events[0].(map[string]any)
		if event["classification"] != "unclassified" {
			t.Fatal("wrong classification")
		}
		if event["sequence"] != float64(1) {
			t.Fatalf("wrong client sequence: %#v", event["sequence"])
		}
	case <-time.After(time.Second):
		t.Fatal("telemetry was not flushed")
	}
}

func TestAgentHelperRejectsUntrustedOrigin(t *testing.T) {
	envelope := &Envelope{
		V: 1, Mode: FeedbackNeverAsk, State: "feedback_ready", Requested: true, ConsentPolicy: "none",
		When: "after_experience_known_before_final_response",
		Submit: &SubmitContract{
			URL: "https://evil.test/reports", Method: http.MethodPost,
			Authorization: "Bearer afr2_test.payload.signature", ContentType: "application/json",
		}}
	_, err := SubmitProductFeedback(context.Background(), envelope, FeedbackReport{
		Summary: "The product completed the task.", Impact: "helped",
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
	prepared, err := runtime.prepare(time.Unix(1_715_000_000, 0), "acct_go_ask_once")
	if err != nil {
		t.Fatal(err)
	}
	cloneEnvelope := func(source *Envelope) Envelope {
		payload, marshalErr := json.Marshal(source)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		var target Envelope
		if unmarshalErr := json.Unmarshal(payload, &target); unmarshalErr != nil {
			t.Fatal(unmarshalErr)
		}
		return target
	}
	malformed := cloneEnvelope(prepared.Envelope)
	malformed.ConsentRequired = false
	if validEnvelope(&malformed) || FeedbackConsentAction(&malformed) != "skip" {
		t.Fatal("malformed ask-always contract was accepted")
	}
	malformed = cloneEnvelope(prepared.Envelope)
	malformed.RequiredAction = nil
	if validEnvelope(&malformed) {
		t.Fatal("ask-once contract without a scope was accepted")
	}
	malformed = cloneEnvelope(prepared.Envelope)
	malformed.ConsentPolicy = "once"
	if validEnvelope(&malformed) {
		t.Fatal("ask-always contract with the wrong consent policy was accepted")
	}
	malformed = cloneEnvelope(prepared.Envelope)
	malformed.When = "after_experience_known_and_consent_resolved"
	if validEnvelope(&malformed) {
		t.Fatal("ask-always contract with the wrong stage was accepted")
	}
	malformed = cloneEnvelope(prepared.Envelope)
	malformed.RequiredAction.SubmitDecision.Authorization = "Bearer untrusted"
	if validEnvelope(&malformed) {
		t.Fatal("consent contract with an untrusted receipt was accepted")
	}
	malformed = cloneEnvelope(prepared.Envelope)
	malformed.RequiredAction.SubmitDecision.BodySchema["decision"] = []string{"approved", "declined", "unsure"}
	if validEnvelope(&malformed) {
		t.Fatal("consent contract with an expanded decision schema was accepted")
	}
	malformed = cloneEnvelope(prepared.Envelope)
	malformed.RequiredAction.SubmitDecision.BodySchema["foreign"] = []string{"unexpected"}
	if validEnvelope(&malformed) {
		t.Fatal("consent contract with a foreign decision-schema field was accepted")
	}
	readyRuntime, readyErr := New(Options{APIKey: conformanceKey, FeedbackMode: FeedbackNeverAsk})
	if readyErr != nil {
		t.Fatal(readyErr)
	}
	defer readyRuntime.Shutdown(context.Background())
	readyPrepared, readyErr := readyRuntime.prepare(time.Unix(1_715_000_000, 0), "")
	if readyErr != nil {
		t.Fatal(readyErr)
	}
	wrongReadyWhen := cloneEnvelope(readyPrepared.Envelope)
	wrongReadyWhen.When = "after_experience_known_and_consent_resolved"
	if validEnvelope(&wrongReadyWhen) {
		t.Fatal("feedback-ready contract with the wrong stage was accepted")
	}
	mixedReady := cloneEnvelope(readyPrepared.Envelope)
	mixedReady.RequiredAction = cloneEnvelope(prepared.Envelope).RequiredAction
	if validEnvelope(&mixedReady) {
		t.Fatal("feedback-ready contract with a consent action was accepted")
	}
}

func TestAskModesExposeDistinctConsentPolicies(t *testing.T) {
	runtime, err := New(Options{APIKey: conformanceKey, FeedbackMode: FeedbackAskOnce})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Shutdown(context.Background())
	prepared, err := runtime.prepare(time.Unix(1_715_000_000, 0), "acct_go_ask_once")
	if err != nil {
		t.Fatal(err)
	}
	envelope := prepared.Envelope
	if !envelope.Requested || !envelope.ConsentRequired {
		t.Fatalf("ask contract is not requested with consent: %#v", envelope)
	}
	if envelope.State != "consent_required" || envelope.ConsentPolicy != "once" || envelope.ConsentManagedBy != "epode" {
		t.Fatalf("wrong ask-once state: %#v", envelope)
	}
	if envelope.When != "after_experience_known_and_consent_resolved" {
		t.Fatalf("wrong ask timing: %s", envelope.When)
	}
	if !strings.HasPrefix(envelope.Instruction, "First complete the user's product task.") ||
		!strings.Contains(envelope.Instruction, "after the product answer") ||
		!strings.Contains(envelope.Instruction, "silence, uncertainty, or ambiguity, submit nothing") {
		t.Fatalf("wrong ask instruction: %s", envelope.Instruction)
	}
	if !strings.Contains(envelope.RequiredAction.Question, "future uses without asking again") ||
		!strings.Contains(envelope.RequiredAction.Question, "nothing is installed") {
		t.Fatalf("ask-once scope is not disclosed: %s", envelope.RequiredAction.Question)
	}
	perUse, err := runtime.prepare(time.Unix(1_715_000_000, 0))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(perUse.Envelope.RequiredAction.Question, "future uses") ||
		!strings.Contains(perUse.Envelope.RequiredAction.Question, "about this use") {
		t.Fatalf("unscoped ask-once overpromised persistence: %s", perUse.Envelope.RequiredAction.Question)
	}
	if perUse.Envelope.Mode != FeedbackAskAlways || perUse.Envelope.ConfiguredMode != FeedbackAskOnce ||
		perUse.Envelope.ConsentPolicy != "always" {
		t.Fatal("ask-once without customerRef did not fail safely to per-use consent")
	}
	if FeedbackConsentAction(perUse.Envelope) != "ask" {
		t.Fatal("agent helper rejected the safe per-use consent fallback")
	}
	if envelope.Submit != nil || envelope.RequiredAction == nil {
		t.Fatalf("report schema was exposed before approval: %#v", envelope)
	}
	if FeedbackConsentAction(envelope) != "ask" {
		t.Fatal("ask-once question was not surfaced")
	}
	declined, err := runtime.prepare(time.Unix(1_715_000_000, 0), "acct_go_ask_once", "declined")
	if err != nil {
		t.Fatal(err)
	}
	if declined.Envelope.Requested || declined.Envelope.State != "feedback_disabled" ||
		declined.Envelope.When != "only_after_explicit_user_request" ||
		declined.Envelope.ManageConsent == nil || declined.Envelope.ManageConsent.Current != "declined" ||
		!validEnvelope(declined.Envelope) || FeedbackConsentAction(declined.Envelope) != "skip" {
		t.Fatalf("declined Ask-once state is not reversible and quiet: %#v", declined.Envelope)
	}
	approved, err := runtime.prepare(time.Unix(1_715_000_000, 0), "acct_go_ask_once", "approved")
	if err != nil {
		t.Fatal(err)
	}
	if approved.Envelope.State != "feedback_ready" || approved.Envelope.ManageConsent == nil ||
		approved.Envelope.ManageConsent.Current != "approved" || !validEnvelope(approved.Envelope) {
		t.Fatalf("approved Ask-once state cannot be managed: %#v", approved.Envelope)
	}
	_, err = SubmitProductFeedback(context.Background(), envelope, FeedbackReport{
		Summary: "The product completed the task.", Impact: "helped",
	}, []string{"https://feedback.test"}, nil)
	if err == nil || !strings.Contains(err.Error(), "invalid Agent Feedback") {
		t.Fatalf("report helper accepted a consent-only contract: %v", err)
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
	if alwaysPrepared.Envelope.ConsentPolicy != "always" || alwaysPrepared.Envelope.Submit != nil {
		t.Fatalf("wrong ask-always policy: %#v", alwaysPrepared.Envelope)
	}
	if !strings.Contains(alwaysPrepared.Envelope.Instruction, "after the product answer") ||
		strings.Contains(alwaysPrepared.Envelope.RequiredAction.Question, "future uses") {
		t.Fatalf("ask-always is not answer-first and per-use: %#v", alwaysPrepared.Envelope)
	}
	if FeedbackConsentAction(alwaysPrepared.Envelope) != "ask" {
		t.Fatal("ask-always incorrectly reused stored approval")
	}

	ready, err := New(Options{APIKey: conformanceKey, FeedbackMode: FeedbackNeverAsk})
	if err != nil {
		t.Fatal(err)
	}
	defer ready.Shutdown(context.Background())
	readyPrepared, err := ready.prepare(time.Unix(1_715_000_000, 0))
	if err != nil {
		t.Fatal(err)
	}
	body := map[string]any{}
	_ = json.Unmarshal(feedbackSubmissionBody(readyPrepared.Envelope, FeedbackReport{Summary: "The product completed the task."}), &body)
	if _, exists := body["consent"]; exists {
		t.Fatal("report body still contains consent")
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

func TestMiddlewareBypassesBeforeResponseBufferLimit(t *testing.T) {
	body := `{"payload":"` + strings.Repeat("x", 128) + `"}`
	runtime, err := New(Options{
		APIKey: conformanceKey, Include: []string{"/large"}, MaxResponseBodyBytes: 32,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Shutdown(context.Background())
	handler := runtime.Middleware(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		response.Header().Set("Content-Length", strconv.Itoa(len(body)))
		_, _ = response.Write([]byte(body[:16]))
		_, _ = response.Write([]byte(body[16:]))
	}))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/large", nil))
	if response.Body.String() != body {
		t.Fatalf("large customer response changed: got %d bytes, want %d", response.Body.Len(), len(body))
	}
	if response.Header().Get("Content-Length") != strconv.Itoa(len(body)) {
		t.Fatalf("customer content length changed: %q", response.Header().Get("Content-Length"))
	}
	if strings.Contains(response.Body.String(), "_agentFeedback") || response.Header().Get("Agent-Feedback") != "" {
		t.Fatal("response larger than the capture limit was instrumented")
	}
}

func TestTelemetryRetriesTransientHTTPStatus(t *testing.T) {
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		attempt := attempts.Add(1)
		if attempt < 3 {
			response.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		response.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()
	runtime, err := New(Options{
		APIKey: conformanceKey, Endpoint: server.URL, FlushInterval: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	runtime.record(TelemetryEvent{InteractionID: "retry-test", Surface: "http_json"})
	if err := runtime.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if attempts.Load() != 3 {
		t.Fatalf("telemetry attempts = %d, want 3", attempts.Load())
	}
}

func TestTelemetryDoesNotRetryPermanentHTTPStatus(t *testing.T) {
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		attempts.Add(1)
		response.WriteHeader(http.StatusBadRequest)
	}))
	defer server.Close()
	runtime, err := New(Options{
		APIKey: conformanceKey, Endpoint: server.URL, FlushInterval: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	runtime.record(TelemetryEvent{InteractionID: "no-retry-test", Surface: "http_json"})
	if err := runtime.Shutdown(context.Background()); err == nil || !strings.Contains(err.Error(), "HTTP 400") {
		t.Fatalf("permanent telemetry failure was not reported: %v", err)
	}
	if attempts.Load() != 1 {
		t.Fatalf("telemetry attempts = %d, want 1", attempts.Load())
	}
}

func TestTelemetrySenderReceivesBoundedContext(t *testing.T) {
	deadlineSeen := make(chan time.Duration, 1)
	runtime, err := New(Options{
		APIKey: conformanceKey, FlushInterval: time.Hour,
		Sender: func(ctx context.Context, _ string, _ http.Header, _ []byte) error {
			deadline, ok := ctx.Deadline()
			if !ok {
				return errors.New("missing deadline")
			}
			deadlineSeen <- time.Until(deadline)
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	runtime.record(TelemetryEvent{InteractionID: "deadline-test", Surface: "http_json"})
	if err := runtime.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	deadline := <-deadlineSeen
	if deadline <= 0 || deadline > telemetryAttemptTimeout {
		t.Fatalf("unexpected telemetry deadline: %s", deadline)
	}
}
