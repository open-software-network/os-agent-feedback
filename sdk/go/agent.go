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
	Outcome string `json:"outcome"`
	Note    string `json:"note"`
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
	return envelope != nil && envelope.V == 1 && envelope.Submit.Method == http.MethodPost && strings.HasPrefix(envelope.Submit.Authorization, "Bearer afr2_")
}

func SubmitProductOutcome(ctx context.Context, envelope *Envelope, review OutcomeReview, allowedOrigins []string, client *http.Client) (map[string]any, error) {
	if !validEnvelope(envelope) {
		return nil, errors.New("invalid Agent Feedback submission contract")
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
