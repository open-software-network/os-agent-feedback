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

// FeedbackConsentAction resolves Epode's server-managed response state.
func FeedbackConsentAction(envelope *Envelope) string {
	if !validEnvelope(envelope) {
		return "skip"
	}
	if envelope.State == "feedback_ready" {
		return "submit"
	}
	if envelope.State == "consent_required" {
		return "ask"
	}
	return "skip"
}

func FeedbackFromResponse(response *http.Response, body []byte) (*Envelope, error) {
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
	if encoded := response.Header.Get("Agent-Feedback"); encoded != "" {
		decoded, err := base64.RawURLEncoding.DecodeString(encoded)
		if err == nil {
			var envelope Envelope
			if json.Unmarshal(decoded, &envelope) == nil && validEnvelope(&envelope) {
				return &envelope, nil
			}
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

// SubmitFeedbackConsent records only an explicit approved or declined answer.
// Epode returns a separate feedback_ready contract after approval.
func SubmitFeedbackConsent(ctx context.Context, envelope *Envelope, decision string, allowedOrigins []string, client *http.Client) (map[string]any, error) {
	if !validEnvelope(envelope) || envelope.State != "consent_required" || envelope.RequiredAction == nil {
		return nil, errors.New("invalid Agent Feedback consent contract")
	}
	if decision != "approved" && decision != "declined" {
		return nil, errors.New("decision must be approved or declined")
	}
	action := envelope.RequiredAction.SubmitDecision
	decisionURL, err := url.Parse(action.URL)
	if err != nil || decisionURL.Scheme != "https" {
		return nil, errors.New("Agent Feedback decisions require HTTPS")
	}
	if len(allowedOrigins) == 0 {
		allowedOrigins = []string{DefaultEndpoint}
	}
	trusted := false
	for _, value := range allowedOrigins {
		origin, parseErr := url.Parse(value)
		if parseErr == nil && origin.Scheme == decisionURL.Scheme && origin.Host == decisionURL.Host {
			trusted = true
			break
		}
	}
	if !trusted {
		return nil, fmt.Errorf("refusing to submit a consent decision to untrusted origin %s://%s", decisionURL.Scheme, decisionURL.Host)
	}
	body, _ := json.Marshal(map[string]string{"decision": decision})
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, action.URL, bytes.NewReader(body))
	request.Header.Set("Authorization", action.Authorization)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "agent-feedback-go-agent/0.2.1")
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
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
	if !validEnvelope(envelope) || envelope.State != "feedback_ready" || envelope.Submit == nil {
		return nil, errors.New("invalid Agent Feedback submission contract")
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
	submitURL, err := url.Parse(envelope.Submit.URL)
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
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, envelope.Submit.URL, bytes.NewReader(body))
	request.Header.Set("Authorization", envelope.Submit.Authorization)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "agent-feedback-go-agent/0.2.1")
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
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
