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
	Summary        string              `json:"summary"`
	Impact         string              `json:"impact,omitempty"`
	Confidence     *float64            `json:"confidence,omitempty"`
	Findings       []FeedbackFinding   `json:"findings,omitempty"`
	Workaround     *FeedbackWorkaround `json:"workaround,omitempty"`
	UserApproved   bool                `json:"-"`
	ApprovalSource string              `json:"-"`
}

type ConsentAttestation struct {
	UserApproved   bool   `json:"userApproved"`
	ApprovalSource string `json:"approvalSource"`
	ConsentScope   string `json:"consentScope,omitempty"`
}

// FeedbackConsentAction resolves a preference stored by the agent runtime.
// Epode never receives the preference store or uses this consent as an identity.
func FeedbackConsentAction(envelope *Envelope, storedDecision string) string {
	if !validEnvelope(envelope) {
		return "skip"
	}
	if !envelope.ConsentRequired {
		return "submit"
	}
	if envelope.Mode == FeedbackAskAlways {
		return "ask"
	}
	if envelope.Mode == FeedbackAskOnce {
		if storedDecision == "approved" {
			return "submit"
		}
		if storedDecision == "refused" {
			return "skip"
		}
	}
	return "ask"
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
	if envelope == nil || envelope.V != 1 || !envelope.Requested ||
		envelope.Submit.Method != http.MethodPost ||
		envelope.Submit.ContentType != "application/json" ||
		!strings.HasPrefix(envelope.Submit.Authorization, "Bearer afr2_") {
		return false
	}
	switch envelope.Mode {
	case FeedbackNeverAsk:
		return !envelope.ConsentRequired && envelope.ConsentPolicy == "none" &&
			envelope.ConsentScope == "" && envelope.When == "after_experience_known_before_final_response"
	case FeedbackAskOnce:
		matched, _ := regexp.MatchString(`^afcs1_[0-9a-f]{32}$`, envelope.ConsentScope)
		return envelope.ConsentRequired && envelope.ConsentPolicy == "once" && matched &&
			envelope.When == "after_experience_known_and_consent_resolved"
	case FeedbackAskAlways:
		return envelope.ConsentRequired && envelope.ConsentPolicy == "always" &&
			envelope.ConsentScope == "" && envelope.When == "after_experience_known_and_explicit_user_approval"
	default:
		return false
	}
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
	if envelope.Mode == FeedbackAskOnce {
		bodyValue["consent"] = ConsentAttestation{
			UserApproved: true, ApprovalSource: report.ApprovalSource,
			ConsentScope: envelope.ConsentScope,
		}
	} else if envelope.Mode == FeedbackAskAlways {
		bodyValue["consent"] = ConsentAttestation{
			UserApproved: true, ApprovalSource: "granted_now",
		}
	}
	body, _ := json.Marshal(bodyValue)
	return body
}

func SubmitProductFeedback(ctx context.Context, envelope *Envelope, report FeedbackReport, allowedOrigins []string, client *http.Client) (map[string]any, error) {
	if !validEnvelope(envelope) {
		return nil, errors.New("invalid Agent Feedback submission contract")
	}
	if envelope.ConsentRequired && !report.UserApproved {
		return nil, errors.New("explicit user approval is required before submitting this report")
	}
	if envelope.Mode == FeedbackAskOnce && report.ApprovalSource != "granted_now" && report.ApprovalSource != "stored_grant" {
		return nil, errors.New("ask-once submission requires granted_now or stored_grant approval")
	}
	if envelope.Mode == FeedbackAskAlways && report.ApprovalSource != "granted_now" {
		return nil, errors.New("ask-every-time submission requires fresh approval")
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
	request.Header.Set("User-Agent", "agent-feedback-go-agent/0.1.0")
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
