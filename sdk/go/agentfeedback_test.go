package agentfeedback

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const conformanceKey = "af_live_0123456789abcdef0123456789abcdef_conformance_secret_0123456789abcdef"
const conformanceToken = "afr2_0123456789abcdef0123456789abcdef.eyJ2IjoxLCJpIjoiMDE4ZjFmMmUtN2I0YS03YzEyLTljOGQtMTIzNDU2Nzg5YWJjIiwiaWF0IjoxNzE1MDAwMDAwLCJleHAiOjE3MTUwMDcyMDAsIm4iOiJBUUlEQkFVR0J3Z0pDZ3NNRFE0UEVCRVMifQ.wxJ0YGS21x9eW-Cn33t9V1INhyGNj1_U3qoQns3vdWA"

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

type blockingConsentTransport struct {
	calls   atomic.Int32
	active  atomic.Int32
	maximum atomic.Int32
	started chan struct{}
	release chan struct{}
}

func (transport *blockingConsentTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if !strings.HasSuffix(request.URL.Path, "/api/v2/consent/state") {
		var payload struct {
			Events []json.RawMessage `json:"events"`
		}
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			return nil, err
		}
		receipt := fmt.Sprintf(`{"accepted":%d,"dropped":0}`, len(payload.Events))
		return &http.Response{StatusCode: http.StatusAccepted, Body: io.NopCloser(strings.NewReader(receipt)), Header: make(http.Header)}, nil
	}
	transport.calls.Add(1)
	active := transport.active.Add(1)
	defer transport.active.Add(-1)
	for maximum := transport.maximum.Load(); active > maximum && !transport.maximum.CompareAndSwap(maximum, active); maximum = transport.maximum.Load() {
	}
	select {
	case transport.started <- struct{}{}:
	default:
	}
	select {
	case <-transport.release:
		return &http.Response{StatusCode: http.StatusServiceUnavailable, Body: io.NopCloser(strings.NewReader("")), Header: make(http.Header)}, nil
	case <-request.Context().Done():
		return nil, request.Context().Err()
	}
}

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

func TestEndpointEnvVarIsDefaultAndExplicitOptionWins(t *testing.T) {
	t.Setenv("AGENT_FEEDBACK_URL", "https://canary.epode.test/")
	fromEnv, err := New(Options{APIKey: conformanceKey})
	if err != nil {
		t.Fatal(err)
	}
	defer fromEnv.Shutdown(context.Background())
	if fromEnv.options.Endpoint != "https://canary.epode.test" {
		t.Fatalf("expected env endpoint, got %q", fromEnv.options.Endpoint)
	}
	explicit, err := New(Options{APIKey: conformanceKey, Endpoint: "https://feedback.test"})
	if err != nil {
		t.Fatal(err)
	}
	defer explicit.Shutdown(context.Background())
	if explicit.options.Endpoint != "https://feedback.test" {
		t.Fatalf("expected explicit endpoint to win, got %q", explicit.options.Endpoint)
	}
}

func TestAskOnceWithoutCustomerRefWarnsOnce(t *testing.T) {
	var buffer bytes.Buffer
	runtime, err := New(Options{
		APIKey:       conformanceKey,
		Endpoint:     "https://feedback.test",
		FeedbackMode: FeedbackAskOnce,
		Logger:       log.New(&buffer, "", 0),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Shutdown(context.Background())
	if state := runtime.cachedConsent(""); state != "unknown" {
		t.Fatalf("expected unknown consent, got %q", state)
	}
	if state := runtime.resolveConsent(" "); state != "unknown" {
		t.Fatalf("expected unknown consent, got %q", state)
	}
	warnings := strings.Count(buffer.String(), "using per-interaction permission")
	if warnings != 1 {
		t.Fatalf("expected exactly one warning, got %d in %q", warnings, buffer.String())
	}
}

func TestAskOnceUsesIdentityEstablishedByOuterAuthentication(t *testing.T) {
	type accountKey struct{}
	const customerRef = "acct_verified"
	var telemetry map[string]any
	runtime, err := New(Options{
		APIKey:       conformanceKey,
		Endpoint:     "https://feedback.test",
		FeedbackMode: FeedbackAskOnce,
		Include:      []string{"/search"},
		AccountRef:   func(*http.Request) string { return "org_verified" },
		UserRef:      func(*http.Request) string { return "user_verified" },
		AnonymousRef: func(*http.Request) string { return "anon_verified" },
		CustomerRef: func(request *http.Request) string {
			value, _ := request.Context().Value(accountKey{}).(string)
			return value
		},
		HTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Body:       io.NopCloser(strings.NewReader(`{"state":"unknown"}`)),
			}, nil
		})},
		FlushInterval: time.Hour,
		Sender: func(_ context.Context, _ string, _ http.Header, body []byte) error {
			return json.Unmarshal(body, &telemetry)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	product := http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"answer":"found"}`))
	})
	authenticate := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			ctx := context.WithValue(request.Context(), accountKey{}, customerRef)
			next.ServeHTTP(response, request.WithContext(ctx))
		})
	}
	handler := authenticate(runtime.Middleware(product))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/search", nil))
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	envelope := body["_agentFeedback"].(map[string]any)
	if envelope["mode"] != "ask_once" || envelope["consentPolicy"] != "once" {
		t.Fatalf("verified auth did not produce durable Ask once: %#v", envelope)
	}
	if strings.Contains(response.Body.String(), customerRef) {
		t.Fatal("raw customerRef leaked into the response envelope")
	}
	if err := runtime.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	events := telemetry["events"].([]any)
	event := events[0].(map[string]any)
	if event["customerRef"] != customerRef {
		t.Fatalf("telemetry lost verified customerRef: %#v", telemetry)
	}
	if event["accountRef"] != "org_verified" || event["userRef"] != "user_verified" || event["anonymousRef"] != "anon_verified" {
		t.Fatalf("telemetry lost progressive identity context: %#v", telemetry)
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
			var authorization []string
			handler := runtime.Middleware(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				authorization = append(authorization, request.Header.Get("Authorization"))
				response.Header().Set("Content-Type", "application/json")
				response.Header().Set("Cache-Control", "public, s-maxage=600")
				_, _ = response.Write([]byte(`{"answer":"cached"}`))
			}))
			request := httptest.NewRequest(http.MethodGet, "/status?scope=private", nil)
			request.Header.Set("Authorization", "Bearer customer-secret")
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
			if test.mode == CacheRequest {
				if got := response.Header().Values("Vary"); !strings.Contains(strings.Join(got, ","), "Agent-Feedback-Request") {
					t.Fatalf("Vary = %q, want Agent-Feedback-Request", got)
				}
				link := response.Header().Get("Link")
				if test.requestOptIn && link != "" {
					t.Fatalf("opted-in Link = %q, want no discovery link", link)
				}
				if !test.requestOptIn && link != `</status?scope=private>; rel="agent-feedback"; request-header="Agent-Feedback-Request: 1"` {
					t.Fatalf("ordinary Link = %q", link)
				}
			}
			if len(authorization) != 1 || authorization[0] != "Bearer customer-secret" {
				t.Fatalf("authorization changed: %q", authorization)
			}
			if err := runtime.Shutdown(context.Background()); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestSafeCacheRecognizesCDNSharedCacheHeadersWithoutFeedbackWork(t *testing.T) {
	var identityReads atomic.Int32
	var consentRequests atomic.Int32
	var telemetryBatches atomic.Int32
	runtime, err := New(Options{
		APIKey:       conformanceKey,
		Endpoint:     "https://feedback.test",
		FeedbackMode: FeedbackAskOnce,
		CacheMode:    CacheSafe,
		CustomerRef: func(*http.Request) string {
			identityReads.Add(1)
			return "acct_cached"
		},
		HTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			consentRequests.Add(1)
			return nil, errors.New("unexpected consent request")
		})},
		FlushInterval: time.Hour,
		Sender: func(context.Context, string, http.Header, []byte) error {
			telemetryBatches.Add(1)
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	body := []byte(" { \"answer\" : \"cached\" } ")
	handler := runtime.Middleware(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		response.Header().Set(request.Header.Get("X-Response-Cache-Header"), request.Header.Get("X-Response-Cache-Value"))
		_, _ = response.Write(body)
	}))
	for _, test := range []struct {
		header string
		value  string
	}{
		{header: "Cache-Control", value: "public, max-age=60"},
		{header: "CDN-Cache-Control", value: "public"},
		{header: "Cloudflare-CDN-Cache-Control", value: "s-maxage = 60"},
		{header: "Surrogate-Control", value: `content="ESI/1.0", max-age=60`},
	} {
		t.Run(test.header, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/cached", nil)
			request.Header.Set("X-Response-Cache-Header", test.header)
			request.Header.Set("X-Response-Cache-Value", test.value)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if !bytes.Equal(response.Body.Bytes(), body) {
				t.Fatalf("body changed: %q", response.Body.String())
			}
			if got := response.Header().Get(test.header); got != test.value {
				t.Fatalf("%s = %q, want %q", test.header, got, test.value)
			}
			if response.Header().Get("Agent-Feedback") != "" || strings.Contains(response.Body.String(), "_agentFeedback") {
				t.Fatal("shared-cache response was instrumented")
			}
		})
	}
	if err := runtime.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if identityReads.Load() != 0 || consentRequests.Load() != 0 || telemetryBatches.Load() != 0 {
		t.Fatalf("shared-cache response did feedback work: identity=%d consent=%d telemetry=%d", identityReads.Load(), consentRequests.Load(), telemetryBatches.Load())
	}
}

func TestInstrumentedResponsesRemoveCDNCacheOverrides(t *testing.T) {
	for _, mode := range []HTTPCacheMode{CachePrivate, CacheRequest} {
		t.Run(string(mode), func(t *testing.T) {
			runtime, err := New(Options{
				APIKey: conformanceKey, Endpoint: "https://feedback.test", CacheMode: mode,
				FlushInterval: time.Hour,
				Sender:        func(context.Context, string, http.Header, []byte) error { return nil },
			})
			if err != nil {
				t.Fatal(err)
			}
			handler := runtime.Middleware(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				response.Header().Set("Content-Type", "application/json")
				response.Header().Set("Cache-Control", "public, max-age=600")
				response.Header().Set("CDN-Cache-Control", "public, max-age=600")
				response.Header().Set("Cloudflare-CDN-Cache-Control", "s-maxage=600")
				response.Header().Set("Surrogate-Control", "max-age=600")
				_, _ = response.Write([]byte(`{"answer":"private"}`))
			}))
			request := httptest.NewRequest(http.MethodGet, "/private", nil)
			if mode == CacheRequest {
				request.Header.Set("Agent-Feedback-Request", "1")
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Header().Get("Cache-Control") != "private, no-store" {
				t.Fatalf("Cache-Control = %q", response.Header().Get("Cache-Control"))
			}
			for _, header := range []string{"CDN-Cache-Control", "Cloudflare-CDN-Cache-Control", "Surrogate-Control"} {
				if got := response.Header().Get(header); got != "" {
					t.Fatalf("instrumented response retained %s: %q", header, got)
				}
			}
			if !strings.Contains(response.Body.String(), "_agentFeedback") {
				t.Fatal("response was not instrumented")
			}
			if err := runtime.Shutdown(context.Background()); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestMiddlewareLeavesPartialRangedAndUnsupportedResponsesUntouchedWithoutFeedbackWork(t *testing.T) {
	tests := []struct {
		path         string
		status       int
		contentType  string
		body         string
		contentRange string
	}{
		{path: "/no-content", status: http.StatusNoContent, contentType: "text/html"},
		{path: "/reset-content", status: http.StatusResetContent, contentType: "text/html"},
		{path: "/partial", status: http.StatusPartialContent, contentType: "application/json", body: `{"answer":"partial"}`},
		{path: "/ranged-ok", status: http.StatusOK, contentType: "application/json", body: `{"answer":"range"}`, contentRange: "bytes 0-17/36"},
		{path: "/unsupported", status: http.StatusOK, contentType: "application/octet-stream", body: `{"answer":"raw"}`},
		{path: "/malformed-json", status: http.StatusOK, contentType: "application/json", body: `{"answer":`},
	}
	var identityReads atomic.Int32
	var consentRequests atomic.Int32
	var telemetryBatches atomic.Int32
	runtime, err := New(Options{
		APIKey:       conformanceKey,
		Endpoint:     "https://feedback.test",
		FeedbackMode: FeedbackAskOnce,
		CacheMode:    CachePrivate,
		CustomerRef: func(*http.Request) string {
			identityReads.Add(1)
			return "acct_ineligible"
		},
		HTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			consentRequests.Add(1)
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Body:       io.NopCloser(strings.NewReader(`{"state":"unknown"}`)),
			}, nil
		})},
		FlushInterval: time.Hour,
		Sender: func(context.Context, string, http.Header, []byte) error {
			telemetryBatches.Add(1)
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	handler := runtime.Middleware(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		for _, test := range tests {
			if request.URL.Path != test.path {
				continue
			}
			response.Header().Set("Content-Type", test.contentType)
			response.Header().Set("Content-Length", strconv.Itoa(len(test.body)))
			response.Header().Set("Cache-Control", "public, max-age=60")
			response.Header().Set("ETag", `"product-etag"`)
			if test.contentRange != "" {
				response.Header().Set("Content-Range", test.contentRange)
			}
			response.WriteHeader(test.status)
			_, _ = response.Write([]byte(test.body))
			return
		}
		http.NotFound(response, request)
	}))

	for _, test := range tests {
		t.Run(strings.TrimPrefix(test.path, "/"), func(t *testing.T) {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, test.path, nil))
			expectedHeaders := http.Header{
				"Content-Type":   []string{test.contentType},
				"Content-Length": []string{strconv.Itoa(len(test.body))},
				"Cache-Control":  []string{"public, max-age=60"},
				"Etag":           []string{`"product-etag"`},
			}
			if test.contentRange != "" {
				expectedHeaders.Set("Content-Range", test.contentRange)
			}
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d", response.Code, test.status)
			}
			if response.Body.String() != test.body {
				t.Fatalf("body changed: got %q, want %q", response.Body.String(), test.body)
			}
			if !reflect.DeepEqual(response.Header(), expectedHeaders) {
				t.Fatalf("headers changed:\n got %#v\nwant %#v", response.Header(), expectedHeaders)
			}
		})
	}
	time.Sleep(20 * time.Millisecond)
	if err := runtime.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := identityReads.Load(); got != 0 {
		t.Fatalf("ineligible responses resolved CustomerRef %d times", got)
	}
	if got := consentRequests.Load(); got != 0 {
		t.Fatalf("ineligible responses made %d consent-state requests", got)
	}
	if got := telemetryBatches.Load(); got != 0 {
		t.Fatalf("ineligible responses sent %d telemetry batches", got)
	}
}

func TestMiddlewareBodyRewritesStripStaleValidators(t *testing.T) {
	staleValidators := map[string]string{
		"ETag":           `"product-etag"`,
		"Content-MD5":    "deadbeef",
		"Digest":         "sha-256=deadbeef",
		"Content-Digest": "sha-256=:deadbeef:",
		"Repr-Digest":    "sha-256=:deadbeef:",
		"Accept-Ranges":  "bytes",
	}
	cases := []struct {
		path        string
		contentType string
		body        string
		rewritten   bool
	}{
		{path: "/json", contentType: "application/json", body: `{"answer":"available"}`, rewritten: true},
		{path: "/html", contentType: "text/html", body: "<html><body>available</body></html>", rewritten: true},
		{path: "/array", contentType: "application/json", body: `["available"]`},
	}
	var telemetryEvents atomic.Int32
	runtime, err := New(Options{
		APIKey:        conformanceKey,
		Endpoint:      "https://feedback.test",
		FeedbackMode:  FeedbackNeverAsk,
		CacheMode:     CachePrivate,
		FlushInterval: time.Hour,
		Sender: func(_ context.Context, _ string, _ http.Header, body []byte) error {
			var payload struct {
				Events []json.RawMessage `json:"events"`
			}
			if err := json.Unmarshal(body, &payload); err != nil {
				return err
			}
			telemetryEvents.Add(int32(len(payload.Events)))
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	handler := runtime.Middleware(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		for _, test := range cases {
			if request.URL.Path != test.path {
				continue
			}
			response.Header().Set("Content-Type", test.contentType)
			response.Header().Set("Content-Length", strconv.Itoa(len(test.body)))
			for name, value := range staleValidators {
				response.Header().Set(name, value)
			}
			_, _ = response.Write([]byte(test.body))
			return
		}
		http.NotFound(response, request)
	}))

	for _, test := range cases {
		t.Run(strings.TrimPrefix(test.path, "/"), func(t *testing.T) {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, test.path, nil))
			if response.Header().Get("Content-Length") != strconv.Itoa(response.Body.Len()) {
				t.Fatalf("Content-Length = %q, body has %d bytes", response.Header().Get("Content-Length"), response.Body.Len())
			}
			if test.rewritten {
				if response.Body.String() == test.body {
					t.Fatal("eligible body was not rewritten")
				}
				for name := range staleValidators {
					if values, present := response.Header()[http.CanonicalHeaderKey(name)]; present {
						t.Fatalf("rewritten response retained %s: %q", name, values)
					}
				}
				if response.Header().Get("Cache-Control") != "private, no-store" {
					t.Fatalf("Cache-Control = %q", response.Header().Get("Cache-Control"))
				}
			} else {
				if response.Body.String() != test.body {
					t.Fatalf("header fallback changed body: %q", response.Body.String())
				}
				for name, value := range staleValidators {
					if got := response.Header().Get(name); got != value {
						t.Fatalf("header fallback %s = %q, want %q", name, got, value)
					}
				}
				if response.Header().Get("Agent-Feedback") == "" {
					t.Fatal("JSON array did not receive header fallback")
				}
			}
		})
	}
	if err := runtime.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := telemetryEvents.Load(); got != int32(len(cases)) {
		t.Fatalf("telemetry events = %d, want %d", got, len(cases))
	}
}

func TestStripBodyValidatorsRemovesCompleteDenylist(t *testing.T) {
	headers := http.Header{"Content-Type": []string{"application/json"}}
	for _, name := range []string{
		"ETag",
		"Content-MD5",
		"Digest",
		"Content-Digest",
		"Repr-Digest",
		"Content-Range",
		"Accept-Ranges",
	} {
		headers.Set(name, "stale")
	}
	stripBodyValidators(headers)
	if headers.Get("Content-Type") != "application/json" {
		t.Fatalf("unrelated header changed: %#v", headers)
	}
	if len(headers) != 1 {
		t.Fatalf("stale body validators remain: %#v", headers)
	}
}

func TestRequestCacheDiscoveryUsesHeadersForHeadAndSkipsRedirects(t *testing.T) {
	runtime, err := New(Options{
		APIKey: conformanceKey, CacheMode: CacheRequest, Include: []string{"/status", "/redirect"},
		FlushInterval: time.Hour, Sender: func(context.Context, string, http.Header, []byte) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	handler := runtime.Middleware(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		if request.URL.Path == "/redirect" {
			response.WriteHeader(http.StatusFound)
			return
		}
		response.Header().Set("Content-Length", "19")
		_, _ = response.Write([]byte(`{"answer":"cached"}`))
	}))

	ordinary := httptest.NewRecorder()
	handler.ServeHTTP(ordinary, httptest.NewRequest(http.MethodHead, "/status", nil))
	if !strings.Contains(ordinary.Header().Get("Link"), `request-header="Agent-Feedback-Request: 1"`) {
		t.Fatalf("ordinary HEAD Link = %q", ordinary.Header().Get("Link"))
	}
	opting := httptest.NewRequest(http.MethodHead, "/status", nil)
	opting.Header.Set("Agent-Feedback-Request", "1")
	requested := httptest.NewRecorder()
	handler.ServeHTTP(requested, opting)
	if requested.Header().Get("Agent-Feedback") == "" {
		t.Fatal("opted-in HEAD did not receive Agent-Feedback")
	}
	redirect := httptest.NewRecorder()
	handler.ServeHTTP(redirect, httptest.NewRequest(http.MethodGet, "/redirect", nil))
	if redirect.Header().Get("Link") != "" {
		t.Fatalf("redirect Link = %q, want none", redirect.Header().Get("Link"))
	}
	networkPath := httptest.NewRecorder()
	handler.ServeHTTP(networkPath, httptest.NewRequest(http.MethodGet, "//status", nil))
	if networkPath.Header().Get("Link") != "" {
		t.Fatalf("network-path Link = %q, want none", networkPath.Header().Get("Link"))
	}
	if err := runtime.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestAskOnceMiddlewareDoesNotAwaitConsentAndKeepsSubjectBoundEnvelope(t *testing.T) {
	transport := &blockingConsentTransport{started: make(chan struct{}, 1), release: make(chan struct{})}
	runtime, err := New(Options{
		APIKey: conformanceKey, Endpoint: "https://feedback.test", FeedbackMode: FeedbackAskOnce,
		Include: []string{"/search"}, CustomerRef: func(*http.Request) string { return "acct_blocked" },
		HTTPClient: &http.Client{Transport: transport}, FlushInterval: time.Hour,
		Sender: func(context.Context, string, http.Header, []byte) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Shutdown(context.Background())
	handler := runtime.Middleware(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"answer":"found"}`))
	}))

	request := func() map[string]any {
		result := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/search", nil))
			result <- response
		}()
		select {
		case response := <-result:
			var body map[string]any
			if unmarshalErr := json.Unmarshal(response.Body.Bytes(), &body); unmarshalErr != nil {
				t.Fatal(unmarshalErr)
			}
			return body
		case <-time.After(250 * time.Millisecond):
			t.Fatal("product response awaited the consent-state lookup")
			return nil
		}
	}

	first := request()
	envelope := first["_agentFeedback"].(map[string]any)
	if envelope["state"] != "consent_required" || envelope["consentPolicy"] != "once" {
		t.Fatalf("outage response did not retain Ask-once consent: %#v", envelope)
	}
	authorization := envelope["requiredAction"].(map[string]any)["submitDecision"].(map[string]any)["authorization"].(string)
	token := strings.TrimPrefix(authorization, "Bearer ")
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("malformed capability: %q", token)
	}
	payload, decodeErr := base64.RawURLEncoding.DecodeString(parts[1])
	if decodeErr != nil {
		t.Fatal(decodeErr)
	}
	var claims map[string]any
	if json.Unmarshal(payload, &claims) != nil || !strings.HasPrefix(claims["s"].(string), "afsub1_") {
		t.Fatalf("Ask-once capability was not subject-bound: %s", payload)
	}
	if claims["r"] != float64(0) {
		t.Fatalf("Ask-once capability did not bind the observed revision: %s", payload)
	}
	select {
	case <-transport.started:
	case <-time.After(time.Second):
		t.Fatal("eligible response did not start a background consent refresh")
	}
	second := request()
	if second["_agentFeedback"].(map[string]any)["state"] != "consent_required" {
		t.Fatal("pending consent refresh suppressed the Ask-once envelope")
	}
	if transport.calls.Load() != 1 {
		t.Fatalf("concurrent consent lookups = %d, want 1", transport.calls.Load())
	}
	close(transport.release)
}

func TestAskOnceMiddlewareBoundsHighCardinalityConsentWarming(t *testing.T) {
	transport := &blockingConsentTransport{
		started: make(chan struct{}, maxConcurrentConsentLookups),
		release: make(chan struct{}),
	}
	runtime, err := New(Options{
		APIKey: conformanceKey, Endpoint: "https://feedback.test", FeedbackMode: FeedbackAskOnce,
		Include:     []string{"/search"},
		CustomerRef: func(request *http.Request) string { return request.Header.Get("X-Customer-Ref") },
		HTTPClient:  &http.Client{Transport: transport}, FlushInterval: time.Hour,
		Sender: func(context.Context, string, http.Header, []byte) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Shutdown(context.Background())
	handler := runtime.Middleware(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"answer":"found"}`))
	}))

	const requestCount = maxConcurrentConsentLookups * 8
	start := make(chan struct{})
	responses := make(chan *httptest.ResponseRecorder, requestCount)
	for index := 0; index < requestCount; index++ {
		go func(index int) {
			<-start
			request := httptest.NewRequest(http.MethodGet, "/search", nil)
			request.Header.Set("X-Customer-Ref", fmt.Sprintf("acct_%d", index))
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			responses <- response
		}(index)
	}
	close(start)
	for index := 0; index < requestCount; index++ {
		select {
		case response := <-responses:
			if response.Code != http.StatusOK {
				t.Fatalf("response status = %d, want 200", response.Code)
			}
		case <-time.After(500 * time.Millisecond):
			t.Fatal("product response waited for saturated consent warming")
		}
	}

	deadline := time.After(time.Second)
	for transport.calls.Load() < maxConcurrentConsentLookups {
		select {
		case <-deadline:
			t.Fatalf("started %d consent lookups, want %d", transport.calls.Load(), maxConcurrentConsentLookups)
		case <-time.After(time.Millisecond):
		}
	}
	time.Sleep(20 * time.Millisecond)
	if got := transport.maximum.Load(); got > maxConcurrentConsentLookups {
		t.Fatalf("maximum concurrent consent lookups = %d, want <= %d", got, maxConcurrentConsentLookups)
	}
	if got := transport.calls.Load(); got != maxConcurrentConsentLookups {
		t.Fatalf("consent lookups = %d, want %d with saturated work skipped", got, maxConcurrentConsentLookups)
	}
	close(transport.release)
}

func TestAskOnceMiddlewareSkipsLookupsAndPreservesIneligibleBytes(t *testing.T) {
	transport := &blockingConsentTransport{started: make(chan struct{}, 1), release: make(chan struct{})}
	runtime, err := New(Options{
		APIKey: conformanceKey, Endpoint: "https://feedback.test", FeedbackMode: FeedbackAskOnce,
		CustomerRef: func(*http.Request) string { return "acct_ineligible" }, MaxResponseBodyBytes: 32,
		HTTPClient: &http.Client{Transport: transport}, FlushInterval: time.Hour,
		Sender: func(context.Context, string, http.Header, []byte) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Shutdown(context.Background())
	handler := runtime.Middleware(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/error":
			response.WriteHeader(http.StatusServiceUnavailable)
			_, _ = response.Write([]byte("  {\n  \"error\": true\n}\n"))
		case "/shared":
			response.Header().Set("Cache-Control", "public, max-age=60")
			_, _ = response.Write([]byte(" { \"answer\" : \"cached\" } "))
		case "/existing":
			_, _ = response.Write([]byte(" { \"_agentFeedback\" : {\"state\":\"owned\"}, \"answer\": 1 } "))
		case "/large":
			_, _ = response.Write([]byte(`{"payload":"` + strings.Repeat("x", 64) + `"}`))
		case "/stream":
			_, _ = response.Write([]byte("first\n"))
			response.(http.Flusher).Flush()
			_, _ = response.Write([]byte("second\n"))
		default:
			_, _ = response.Write([]byte(" { \"answer\" : \"head\" } "))
		}
	}))

	for _, test := range []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/error", "  {\n  \"error\": true\n}\n"},
		{http.MethodHead, "/head", " { \"answer\" : \"head\" } "},
		{http.MethodGet, "/shared", " { \"answer\" : \"cached\" } "},
		{http.MethodGet, "/existing", " { \"_agentFeedback\" : {\"state\":\"owned\"}, \"answer\": 1 } "},
		{http.MethodGet, "/large", `{"payload":"` + strings.Repeat("x", 64) + `"}`},
		{http.MethodGet, "/stream", "first\nsecond\n"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Body.String() != test.body {
			t.Fatalf("%s %s bytes changed: %q", test.method, test.path, response.Body.String())
		}
	}
	time.Sleep(20 * time.Millisecond)
	if transport.calls.Load() != 0 {
		t.Fatalf("ineligible responses made %d consent-state lookups", transport.calls.Load())
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

func TestMiddlewarePrefersServeMuxPatternOverSensitiveRawPath(t *testing.T) {
	telemetry := make(chan map[string]any, 1)
	runtime, err := New(Options{
		APIKey: conformanceKey, Endpoint: "https://feedback.test",
		Include: []string{"/users/*"}, FlushInterval: time.Millisecond,
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
	mux := http.NewServeMux()
	mux.HandleFunc("GET /users/{account}", func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"available":true}`))
	})
	response := httptest.NewRecorder()
	runtime.Middleware(mux).ServeHTTP(
		response,
		httptest.NewRequest(http.MethodGet, "/users/alice@example.com", nil),
	)

	select {
	case batch := <-telemetry:
		event := batch["events"].([]any)[0].(map[string]any)
		if event["operation"] != "/users/{account}" {
			t.Fatalf("operation leaked the raw path: %#v", event["operation"])
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
	if FeedbackConsentAction(perUse.Envelope) != "skip" {
		t.Fatal("agent helper trusted a stale per-use consent snapshot")
	}
	if envelope.Submit != nil || envelope.RequiredAction == nil {
		t.Fatalf("report schema was exposed before approval: %#v", envelope)
	}
	if FeedbackConsentAction(envelope) != "skip" {
		t.Fatal("ask-once question was surfaced without authoritative inspection")
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
	if err == nil {
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
	if FeedbackConsentAction(alwaysPrepared.Envelope) != "skip" {
		t.Fatal("ask-always prompted from a stale response snapshot")
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

func TestAgentInspectionUsesCurrentAskOnceAuthority(t *testing.T) {
	state := "consent_required"
	reports := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/v2/capabilities/introspect":
			if request.Header.Get("Authorization") != "Bearer afr2_test.payload.signature" {
				t.Fatalf("inspection omitted capability: %q", request.Header.Get("Authorization"))
			}
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"state": state, "configuredMode": "ask_once", "consentPolicy": "once",
				"productName": "Test product", "canonicalQuestion": "May I send feedback?",
				"expiresAt": "2099-01-01T00:00:00Z",
			})
		case "/api/v2/reports":
			reports++
			_ = json.NewEncoder(writer).Encode(map[string]any{"accepted": true})
		default:
			http.Error(writer, "unexpected path", http.StatusNotFound)
		}
	}))
	defer server.Close()

	runtime, err := New(Options{APIKey: conformanceKey, FeedbackMode: FeedbackAskOnce})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Shutdown(context.Background())
	prepared, err := runtime.prepare(time.Now(), "acct_authority")
	if err != nil {
		t.Fatal(err)
	}
	envelope := prepared.Envelope
	envelope.RequiredAction.SubmitDecision.URL = server.URL + "/api/v2/consent/decisions"
	envelope.RequiredAction.SubmitDecision.Authorization = "Bearer afr2_test.payload.signature"

	inspection, err := InspectFeedbackConsent(context.Background(), envelope, []string{server.URL}, server.Client())
	if err != nil || inspection.Action != "ask" || inspection.CanonicalQuestion != "May I send feedback?" {
		t.Fatalf("unknown permission did not return the canonical ask: %#v %v", inspection, err)
	}
	state = "declined"
	inspection, err = InspectFeedbackConsent(context.Background(), envelope, []string{server.URL}, server.Client())
	if err != nil || inspection.Action != "skip" {
		t.Fatalf("declined permission was not quiet: %#v %v", inspection, err)
	}
	state = "feedback_ready"
	inspection, err = InspectFeedbackConsent(context.Background(), envelope, []string{server.URL}, server.Client())
	if err != nil || inspection.Action != "submit" {
		t.Fatalf("approved permission did not enable reporting: %#v %v", inspection, err)
	}
	_, err = SubmitProductFeedback(context.Background(), envelope, FeedbackReport{
		Summary: "The product completed the task successfully.", Impact: "helped",
	}, []string{server.URL}, server.Client())
	if err != nil || reports != 1 {
		t.Fatalf("approved permission did not submit exactly one report: reports=%d err=%v", reports, err)
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
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusAccepted)
		_, _ = response.Write([]byte(`{"accepted":1,"dropped":0}`))
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

func TestTelemetryDeliveryDefaults(t *testing.T) {
	runtime, err := New(Options{APIKey: conformanceKey})
	if err != nil {
		t.Fatal(err)
	}
	if runtime.options.TelemetryTimeout != 30*time.Second || runtime.options.MaxTelemetryAttempts != 6 || runtime.options.ShutdownTimeout != 10*time.Second {
		t.Fatalf("unexpected telemetry defaults: timeout=%s attempts=%d shutdown=%s", runtime.options.TelemetryTimeout, runtime.options.MaxTelemetryAttempts, runtime.options.ShutdownTimeout)
	}
	if err := runtime.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestTelemetryRejectsPartialReceiptWithoutRetry(t *testing.T) {
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		attempts.Add(1)
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusAccepted)
		_, _ = response.Write([]byte(`{"accepted":0,"dropped":1}`))
	}))
	defer server.Close()
	runtime, err := New(Options{
		APIKey: conformanceKey, Endpoint: server.URL, FlushInterval: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	runtime.record(TelemetryEvent{InteractionID: "partial-receipt", Surface: "http_json"})
	if err := runtime.Shutdown(context.Background()); err == nil || !strings.Contains(err.Error(), "not fully accepted") {
		t.Fatalf("partial telemetry receipt was not reported: %v", err)
	}
	if attempts.Load() != 1 {
		t.Fatalf("partial receipt attempts = %d, want 1", attempts.Load())
	}
}

func TestTelemetryShutdownBoundsAnInflightAttempt(t *testing.T) {
	runtime, err := New(Options{
		APIKey: conformanceKey, FlushInterval: time.Hour,
		ShutdownTimeout: 100 * time.Millisecond,
		Sender: func(ctx context.Context, _ string, _ http.Header, _ []byte) error {
			<-ctx.Done()
			return ctx.Err()
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	runtime.record(TelemetryEvent{InteractionID: "blocked-attempt", Surface: "http_json"})
	started := time.Now()
	err = runtime.Shutdown(context.Background())
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("shutdown error = %v, want deadline exceeded", err)
	}
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("shutdown exceeded its configured bound: %s", elapsed)
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
	if deadline <= 0 || deadline > runtime.options.ShutdownTimeout {
		t.Fatalf("unexpected telemetry deadline: %s", deadline)
	}
}

func TestMiddlewareSkipsNonIdentityContentEncodingWithoutFeedbackWork(t *testing.T) {
	var identityReads atomic.Int32
	var consentRequests atomic.Int32
	var telemetryBatches atomic.Int32
	runtime, err := New(Options{
		APIKey:       conformanceKey,
		FeedbackMode: FeedbackAskOnce,
		CacheMode:    CacheRequest,
		CustomerRef: func(*http.Request) string {
			identityReads.Add(1)
			return "acct_encoded"
		},
		HTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			consentRequests.Add(1)
			return nil, errors.New("unexpected consent request")
		})},
		FlushInterval: time.Hour,
		Sender: func(context.Context, string, http.Header, []byte) error {
			telemetryBatches.Add(1)
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	body := []byte("\x1f\x8bencoded-product-body")
	handler := runtime.Middleware(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "text/html")
		response.Header().Set("Content-Encoding", request.Header.Get("X-Test-Encoding"))
		response.Header().Set("Content-Length", strconv.Itoa(len(body)))
		response.Header().Set("ETag", `"product"`)
		response.Header().Set("Agent-Feedback", "product-owned")
		_, _ = response.Write(body)
	}))
	for _, encoding := range []string{"gzip", "br", "identity, GZip"} {
		request := httptest.NewRequest(http.MethodGet, "/status", nil)
		request.Header.Set("Agent-Feedback-Request", "1")
		request.Header.Set("X-Test-Encoding", encoding)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		expected := http.Header{
			"Content-Type":     []string{"text/html"},
			"Content-Encoding": []string{encoding},
			"Content-Length":   []string{strconv.Itoa(len(body))},
			"Etag":             []string{`"product"`},
			"Agent-Feedback":   []string{"product-owned"},
		}
		if !reflect.DeepEqual(response.Header(), expected) {
			t.Fatalf("%s headers changed:\n got %#v\nwant %#v", encoding, response.Header(), expected)
		}
		if !bytes.Equal(response.Body.Bytes(), body) {
			t.Fatalf("%s body changed", encoding)
		}
	}
	if err := runtime.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if identityReads.Load() != 0 || consentRequests.Load() != 0 || telemetryBatches.Load() != 0 {
		t.Fatalf("encoded response did feedback work: identity=%d consent=%d telemetry=%d", identityReads.Load(), consentRequests.Load(), telemetryBatches.Load())
	}
}

func TestHTMLMarkerFallbackReaderPrecedenceAndBoundaryInsertion(t *testing.T) {
	runtime, err := New(Options{
		APIKey: conformanceKey, Endpoint: "https://feedback.test", CacheMode: CachePrivate,
		FlushInterval: time.Hour, Sender: func(context.Context, string, http.Header, []byte) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	old, err := runtime.prepare(time.Now(), "", "unknown")
	if err != nil {
		t.Fatal(err)
	}
	oldJSON, _ := json.Marshal(old.Envelope)
	body := []byte(`<html><head></head><body><script ID = "AGENT-FEEDBACK" type="application/json">` + string(oldJSON) + `</script></body></html>`)
	handler := runtime.Middleware(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "text/html")
		response.Header().Set("Content-Length", strconv.Itoa(len(body)))
		response.Header().Set("ETag", `"product"`)
		response.Header().Set("Agent-Feedback", "stale")
		_, _ = response.Write(body)
	}))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/status", nil))
	if !bytes.Equal(response.Body.Bytes(), body) {
		t.Fatal("existing HTML marker body changed")
	}
	if response.Header().Get("Content-Length") != strconv.Itoa(len(body)) || response.Header().Get("ETag") != `"product"` {
		t.Fatalf("header fallback changed body metadata: %#v", response.Header())
	}
	if response.Header().Get("Agent-Feedback") == "stale" {
		t.Fatal("existing HTML marker did not receive a fresh header")
	}
	parsed, err := FeedbackFromResponse(&http.Response{Header: response.Header()}, body)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Submit == nil || old.Envelope.Submit == nil || parsed.Submit.Authorization == old.Envelope.Submit.Authorization {
		t.Fatal("reader did not prefer the fresh header envelope")
	}
	html := `<html><head><script>const x="</head>"</script><style>x{content:"</head>"}</style></head><body>ok</body></html>`
	injected := injectHTML(html, old.Envelope)
	if strings.Count(injected, `id="agent-feedback"`) != 1 {
		t.Fatalf("injected %d markers", strings.Count(injected, `id="agent-feedback"`))
	}
	if strings.Index(injected, `id="agent-feedback"`) < strings.Index(injected, "</style>") {
		t.Fatal("insertion corrupted a raw-text closing-head literal")
	}
	if err := runtime.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestHTMLInjectionBoundaryIgnoresAdversarialMarkup(t *testing.T) {
	envelope := &Envelope{V: 1, State: "feedback_ready"}
	for _, test := range []struct {
		name     string
		html     string
		boundary func(string) int
	}{
		{
			name: "fake head boundaries before the real boundary",
			html: `<html><head><!-- </head> --><meta content='</head>'><script data-value=">">const fake = "</head>";</script><style>p::after{content:"</head>"}</style></head><body>ok</body></html>`,
			boundary: func(html string) int {
				return strings.Index(html, "</style></head>") + len("</style>")
			},
		},
		{
			name: "fake head boundaries after the real boundary",
			html: `<html><head><title>ok</title></head><body><script data-value="</head>">const fake = "</head>";</script><style>p::after{content:"</head>"}</style><!-- </head> --></body></html>`,
			boundary: func(html string) int {
				return strings.Index(html, "</head><body>")
			},
		},
		{
			name: "body fallback ignores raw text",
			html: `<html><body><script>const fake = "</body>";</script><style>p::after{content:"</body>"}</style></body></html>`,
			boundary: func(html string) int {
				return strings.Index(html, "</style></body>") + len("</style>")
			},
		},
		{
			name: "unclosed raw text inserts before the element",
			html: `<html><body><script>const fake = "</head>";`,
			boundary: func(html string) int {
				return strings.Index(html, "<script>")
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			injected := injectHTML(test.html, envelope)
			marker := strings.Index(injected, `id="agent-feedback"`)
			if marker < 0 || strings.Count(injected, `id="agent-feedback"`) != 1 {
				t.Fatalf("expected exactly one marker: %s", injected)
			}
			openingTag := strings.LastIndex(injected[:marker], "<script")
			if openingTag < 0 || openingTag != test.boundary(test.html) {
				t.Fatalf("insertion starts at %d, want boundary %d", openingTag, test.boundary(test.html))
			}
		})
	}
}
