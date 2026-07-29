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

type OutcomeReview struct {
	Outcome        string `json:"outcome"`
	Note           string `json:"note"`
	UserApproved   bool   `json:"-"`
	ApprovalSource string `json:"-"`
}

// FeedbackConsentAction resolves a preference stored by the agent runtime.
// Epode never receives the stored decision or uses it as an identity.
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
	case FeedbackAuto:
		return !envelope.ConsentRequired && envelope.ConsentPolicy == "none" &&
			envelope.ConsentScope == "" && envelope.When == "after_outcome_known_before_final_response"
	case FeedbackAskOnce:
		matched, _ := regexp.MatchString(`^afcs1_[0-9a-f]{32}$`, envelope.ConsentScope)
		return envelope.ConsentRequired && envelope.ConsentPolicy == "once" && matched &&
			envelope.When == "after_outcome_known_and_consent_resolved"
	case FeedbackAskAlways:
		return envelope.ConsentRequired && envelope.ConsentPolicy == "always" &&
			envelope.ConsentScope == "" && envelope.When == "after_outcome_known_and_explicit_user_approval"
	default:
		return false
	}
}

func SubmitProductOutcome(ctx context.Context, envelope *Envelope, review OutcomeReview, allowedOrigins []string, client *http.Client) (map[string]any, error) {
	if !validEnvelope(envelope) {
		return nil, errors.New("invalid Agent Feedback submission contract")
	}
	if envelope.ConsentRequired && !review.UserApproved {
		return nil, errors.New("explicit user approval is required before submitting this outcome")
	}
	if envelope.Mode == FeedbackAskOnce && review.ApprovalSource != "granted_now" && review.ApprovalSource != "stored_grant" {
		return nil, errors.New("ask-once submission requires granted_now or stored_grant approval")
	}
	if envelope.Mode == FeedbackAskAlways && review.ApprovalSource != "granted_now" {
		return nil, errors.New("ask-every-time submission requires fresh approval")
	}
	if review.Outcome != "success" && review.Outcome != "partial" && review.Outcome != "failure" {
		return nil, errors.New("outcome must be success, partial, or failure")
	}
	review.Note = strings.TrimSpace(review.Note)
	if len(review.Note) < 8 || len(review.Note) > 500 {
		return nil, errors.New("note must contain 8 to 500 characters")
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
	body, _ := json.Marshal(review)
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
		return nil, fmt.Errorf("outcome submission failed with HTTP %d", response.StatusCode)
	}
	result := map[string]any{}
	if err := json.Unmarshal(responseBody, &result); err != nil {
		return nil, err
	}
	return result, nil
}
