package agentfeedback

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

type FeedbackFinding struct {
	Kind     string `json:"kind"`
	Topic    string `json:"topic"`
	Severity string `json:"severity,omitempty"`
	Detail   string `json:"detail"`
}

type FeedbackWorkaround struct {
	Used   bool   `json:"used"`
	Detail string `json:"detail,omitempty"`
}

type FeedbackReport struct {
	Summary    string              `json:"summary"`
	Impact     string              `json:"impact,omitempty"`
	Confidence *float64            `json:"confidence,omitempty"`
	Findings   []FeedbackFinding   `json:"findings,omitempty"`
	Workaround *FeedbackWorkaround `json:"workaround,omitempty"`
}

type FeedbackInspection struct {
	Action            string `json:"action"`
	State             string `json:"state"`
	ConfiguredMode    string `json:"configuredMode,omitempty"`
	ConsentPolicy     string `json:"consentPolicy,omitempty"`
	ProductName       string `json:"productName,omitempty"`
	CanonicalQuestion string `json:"canonicalQuestion,omitempty"`
	ExpiresAt         string `json:"expiresAt,omitempty"`
	SubmitURL         string `json:"submitUrl,omitempty"`
	Authorization     string `json:"-"`
}

// FeedbackConsentAction resolves Epode's server-managed response state.
func FeedbackConsentAction(envelope *Envelope) string {
	if !validEnvelope(envelope) {
		return "skip"
	}
	if envelope.State == "feedback_ready" {
		return "submit"
	}
	// A response envelope is only a snapshot. Ask once must be resolved with
	// InspectFeedbackConsent before prompting the user.
	return "skip"
}

func FeedbackFromResponse(response *http.Response, body []byte) (*Envelope, error) {
	if encoded := response.Header.Get("Agent-Feedback"); encoded != "" {
		decoded, err := base64.RawURLEncoding.DecodeString(encoded)
		if err == nil {
			var envelope Envelope
			if json.Unmarshal(decoded, &envelope) == nil && validEnvelope(&envelope) {
				return &envelope, nil
			}
		}
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(body, &object) == nil {
		if raw, ok := object["_agentFeedback"]; ok {
			var envelope Envelope
			if json.Unmarshal(raw, &envelope) == nil && validEnvelope(&envelope) {
				return &envelope, nil
			}
		}
	}
	match := regexp.MustCompile(`(?is)<script[^>]+id=["']agent-feedback["'][^>]*>(.*?)</script>`).FindSubmatch(body)
	if len(match) == 2 {
		var envelope Envelope
		if json.Unmarshal(match[1], &envelope) == nil && validEnvelope(&envelope) {
			return &envelope, nil
		}
	}
	return nil, errors.New("product response did not include a valid Agent Feedback contract")
}

func validEnvelope(envelope *Envelope) bool {
	if envelope == nil || envelope.V != 1 {
		return false
	}
	if envelope.State == "feedback_disabled" {
		return !envelope.Requested && envelope.Mode == FeedbackAskOnce &&
			envelope.ConfiguredMode == FeedbackAskOnce && !envelope.ConsentRequired &&
			envelope.ConsentPolicy == "once" && envelope.ConsentManagedBy == "epode" &&
			envelope.When == "only_after_explicit_user_request" && envelope.Submit == nil &&
			envelope.RequiredAction == nil && validManageConsent(envelope.ManageConsent, "declined")
	}
	if !envelope.Requested {
		return false
	}
	if envelope.State == "feedback_ready" {
		valid := envelope.Mode == FeedbackNeverAsk && !envelope.ConsentRequired &&
			envelope.ConsentPolicy == "none" && envelope.When == "after_experience_known_before_final_response" &&
			envelope.Submit != nil && envelope.RequiredAction == nil && envelope.Submit.URL != "" &&
			envelope.Submit.Method == http.MethodPost &&
			envelope.Submit.ContentType == "application/json" &&
			strings.HasPrefix(envelope.Submit.Authorization, "Bearer afr2_")
		if !valid {
			return false
		}
		if envelope.ConfiguredMode == FeedbackAskOnce {
			return validManageConsent(envelope.ManageConsent, "approved")
		}
		return envelope.ManageConsent == nil
	}
	if envelope.State != "consent_required" || !envelope.ConsentRequired ||
		envelope.ConsentManagedBy != "epode" || envelope.RequiredAction == nil || envelope.Submit != nil {
		return false
	}
	modeContract := envelope.Mode == FeedbackAskOnce && envelope.ConfiguredMode == FeedbackAskOnce &&
		envelope.ConsentPolicy == "once" && envelope.When == "after_experience_known_and_consent_resolved"
	modeContract = modeContract || envelope.Mode == FeedbackAskAlways && envelope.ConfiguredMode == FeedbackAskAlways &&
		envelope.ConsentPolicy == "always" && envelope.When == "after_experience_known_and_explicit_user_approval"
	modeContract = modeContract || envelope.Mode == FeedbackAskAlways && envelope.ConfiguredMode == FeedbackAskOnce &&
		envelope.ConsentPolicy == "always" && envelope.When == "after_experience_known_and_explicit_user_approval"
	action := envelope.RequiredAction.SubmitDecision
	decisions := action.BodySchema["decision"]
	return modeContract && envelope.RequiredAction.Type == "ask_user" && envelope.RequiredAction.Question != "" &&
		action.Method == http.MethodPost && action.ContentType == "application/json" && action.URL != "" &&
		strings.HasPrefix(action.Authorization, "Bearer afr2_") && len(action.BodySchema) == 1 && len(decisions) == 2 &&
		decisions[0] == "approved" && decisions[1] == "declined"
}

func validManageConsent(action *ManageConsentContract, current string) bool {
	if action == nil || action.Current != current || action.URL == "" || action.Method != http.MethodPost ||
		action.ContentType != "application/json" || !strings.HasPrefix(action.Authorization, "Bearer afr2_") {
		return false
	}
	decisions := action.BodySchema["decision"]
	return len(action.BodySchema) == 1 && len(decisions) == 2 && decisions[0] == "approved" && decisions[1] == "declined"
}

func feedbackCapability(envelope *Envelope) (string, *url.URL, error) {
	if !validEnvelope(envelope) {
		return "", nil, errors.New("invalid Agent Feedback contract")
	}
	actionURL := ""
	authorization := ""
	if envelope.State == "feedback_ready" && envelope.Submit != nil {
		actionURL = envelope.Submit.URL
		authorization = envelope.Submit.Authorization
	} else if envelope.RequiredAction != nil {
		actionURL = envelope.RequiredAction.SubmitDecision.URL
		authorization = envelope.RequiredAction.SubmitDecision.Authorization
	}
	parsed, err := url.Parse(actionURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return "", nil, errors.New("Agent Feedback inspection requires HTTPS")
	}
	return authorization, &url.URL{Scheme: parsed.Scheme, Host: parsed.Host}, nil
}

func trustedOrigin(origin *url.URL, allowedOrigins []string) bool {
	if len(allowedOrigins) == 0 {
		allowedOrigins = []string{DefaultEndpoint}
	}
	for _, value := range allowedOrigins {
		allowed, err := url.Parse(value)
		if err == nil && allowed.Scheme == origin.Scheme && allowed.Host == origin.Host {
			return true
		}
	}
	return false
}

func boundedNoRedirectClient(client *http.Client) *http.Client {
	if client == nil {
		client = http.DefaultClient
	}
	clone := *client
	clone.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	if clone.Timeout == 0 || clone.Timeout > 5*time.Second {
		clone.Timeout = 5 * time.Second
	}
	return &clone
}

// InspectFeedbackConsent resolves the current server-authoritative permission
// before an agent prompts, records a decision, or submits a report.
func InspectFeedbackConsent(ctx context.Context, envelope *Envelope, allowedOrigins []string, client *http.Client) (*FeedbackInspection, error) {
	authorization, origin, err := feedbackCapability(envelope)
	if err != nil {
		return nil, err
	}
	if !trustedOrigin(origin, allowedOrigins) {
		return nil, fmt.Errorf("refusing to inspect feedback at untrusted origin %s", origin.String())
	}
	inspectionURL := origin.ResolveReference(&url.URL{Path: "/api/v2/capabilities/introspect"})
	inspectionCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(inspectionCtx, http.MethodPost, inspectionURL.String(), strings.NewReader("{}"))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", authorization)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "agent-feedback-go-agent/0.3.1")
	response, err := boundedNoRedirectClient(client).Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusGone {
		return &FeedbackInspection{Action: "skip", State: "feedback_disabled"}, nil
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("feedback inspection failed with HTTP %d", response.StatusCode)
	}
	var body struct {
		State             string `json:"state"`
		ConfiguredMode    string `json:"configuredMode"`
		ConsentPolicy     string `json:"consentPolicy"`
		ProductName       string `json:"productName"`
		CanonicalQuestion string `json:"canonicalQuestion"`
		ExpiresAt         string `json:"expiresAt"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		return nil, err
	}
	if body.ConfiguredMode == "" || body.ConsentPolicy == "" || body.ProductName == "" || body.ExpiresAt == "" {
		return nil, errors.New("Epode returned an incomplete feedback inspection")
	}
	inspection := &FeedbackInspection{
		State: body.State, ConfiguredMode: body.ConfiguredMode, ConsentPolicy: body.ConsentPolicy,
		ProductName: body.ProductName, CanonicalQuestion: body.CanonicalQuestion, ExpiresAt: body.ExpiresAt,
	}
	switch body.State {
	case "feedback_ready":
		inspection.Action = "submit"
		inspection.SubmitURL = origin.ResolveReference(&url.URL{Path: "/api/v2/reports"}).String()
		inspection.Authorization = authorization
	case "consent_required":
		if body.CanonicalQuestion == "" {
			return nil, errors.New("Epode did not return the canonical permission question")
		}
		inspection.Action = "ask"
	case "declined":
		inspection.Action = "skip"
	default:
		return nil, errors.New("Epode returned an invalid feedback inspection")
	}
	return inspection, nil
}

// SubmitFeedbackConsent records only an explicit approved or declined answer.
// Epode returns a separate feedback_ready contract after approval.
func SubmitFeedbackConsent(ctx context.Context, envelope *Envelope, decision string, allowedOrigins []string, client *http.Client) (map[string]any, error) {
	if !validEnvelope(envelope) || envelope.State != "consent_required" || envelope.RequiredAction == nil {
		return nil, errors.New("invalid Agent Feedback consent contract")
	}
	if decision != "approved" && decision != "declined" {
		return nil, errors.New("decision must be approved or declined")
	}
	inspection, err := InspectFeedbackConsent(ctx, envelope, allowedOrigins, client)
	if err != nil {
		return nil, err
	}
	if inspection.State == "declined" {
		return map[string]any{"state": "declined"}, nil
	}
	if inspection.State == "feedback_ready" {
		return map[string]any{"state": "approved"}, nil
	}
	if inspection.State != "consent_required" {
		return nil, errors.New("feedback permission is no longer available")
	}
	action := envelope.RequiredAction.SubmitDecision
	_, origin, _ := feedbackCapability(envelope)
	decisionURL := origin.ResolveReference(&url.URL{Path: "/api/v2/consent/decisions"})
	body, _ := json.Marshal(map[string]string{"decision": decision})
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, decisionURL.String(), bytes.NewReader(body))
	request.Header.Set("Authorization", action.Authorization)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "agent-feedback-go-agent/0.3.1")
	response, err := boundedNoRedirectClient(client).Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("consent decision failed with HTTP %d", response.StatusCode)
	}
	result := map[string]any{}
	if err := json.Unmarshal(responseBody, &result); err != nil {
		return nil, err
	}
	return result, nil
}

func feedbackSubmissionBody(envelope *Envelope, report FeedbackReport) []byte {
	bodyValue := map[string]any{"summary": report.Summary}
	if report.Impact != "" {
		bodyValue["impact"] = report.Impact
	}
	if report.Confidence != nil {
		bodyValue["confidence"] = report.Confidence
	}
	if len(report.Findings) > 0 {
		bodyValue["findings"] = report.Findings
	}
	if report.Workaround != nil {
		bodyValue["workaround"] = report.Workaround
	}
	body, _ := json.Marshal(bodyValue)
	return body
}

func SubmitProductFeedback(ctx context.Context, envelope *Envelope, report FeedbackReport, allowedOrigins []string, client *http.Client) (map[string]any, error) {
	if !validEnvelope(envelope) {
		return nil, errors.New("invalid Agent Feedback submission contract")
	}
	inspection, err := InspectFeedbackConsent(ctx, envelope, allowedOrigins, client)
	if err != nil {
		return nil, err
	}
	if inspection.State != "feedback_ready" || inspection.SubmitURL == "" {
		return nil, errors.New("current Agent Feedback permission does not allow submission")
	}
	report.Summary = strings.TrimSpace(report.Summary)
	if len(report.Summary) < 8 || len(report.Summary) > 700 {
		return nil, errors.New("summary must contain 8 to 700 characters")
	}
	validImpact := map[string]bool{"": true, "helped": true, "helped_with_friction": true, "neutral": true, "hindered": true, "blocked": true, "unknown": true}
	if !validImpact[report.Impact] {
		return nil, errors.New("invalid impact")
	}
	if report.Confidence != nil && (*report.Confidence < 0 || *report.Confidence > 1) {
		return nil, errors.New("confidence must be between 0 and 1")
	}
	if len(report.Findings) > 8 {
		return nil, errors.New("findings cannot contain more than 8 items")
	}
	validKind := map[string]bool{"strength": true, "friction": true, "defect": true, "gap": true, "suggestion": true, "uncertainty": true, "other": true}
	for _, finding := range report.Findings {
		if !validKind[finding.Kind] {
			return nil, errors.New("invalid finding kind")
		}
		if matched, _ := regexp.MatchString(`^[a-z0-9][a-z0-9_-]{0,63}$`, finding.Topic); !matched {
			return nil, errors.New("finding topic must be a normalized slug")
		}
		if finding.Severity != "" && finding.Severity != "minor" && finding.Severity != "major" && finding.Severity != "blocking" {
			return nil, errors.New("invalid finding severity")
		}
		detail := strings.TrimSpace(finding.Detail)
		if len(detail) < 3 || len(detail) > 350 {
			return nil, errors.New("finding detail must contain 3 to 350 characters")
		}
	}
	if report.Workaround != nil && report.Workaround.Used && strings.TrimSpace(report.Workaround.Detail) == "" {
		return nil, errors.New("workaround detail is required when a workaround was used")
	}
	submitURL, err := url.Parse(inspection.SubmitURL)
	if err != nil || submitURL.Scheme != "https" {
		return nil, errors.New("Agent Feedback submissions require HTTPS")
	}
	if len(allowedOrigins) == 0 {
		allowedOrigins = []string{DefaultEndpoint}
	}
	trusted := false
	for _, value := range allowedOrigins {
		origin, parseErr := url.Parse(value)
		if parseErr == nil && origin.Scheme == submitURL.Scheme && origin.Host == submitURL.Host {
			trusted = true
			break
		}
	}
	if !trusted {
		return nil, fmt.Errorf("refusing to submit feedback to untrusted origin %s://%s", submitURL.Scheme, submitURL.Host)
	}
	body := feedbackSubmissionBody(envelope, report)
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, inspection.SubmitURL, bytes.NewReader(body))
	request.Header.Set("Authorization", inspection.Authorization)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "agent-feedback-go-agent/0.3.1")
	response, err := boundedNoRedirectClient(client).Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("feedback submission failed with HTTP %d", response.StatusCode)
	}
	result := map[string]any{}
	if err := json.Unmarshal(responseBody, &result); err != nil {
		return nil, err
	}
	return result, nil
}
