package agentfeedback

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

const Version = "0.4.0"
const customerUserAgent = "@epode/go/0.4.0"

type CustomerPurpose string
type EnrichmentSurface string

const (
	ProductPersonalization CustomerPurpose = "product_personalization"
	TargetedAdvertising    CustomerPurpose = "targeted_advertising"
)

const (
	SurfaceHTTPJSON EnrichmentSurface = "http_json"
	SurfaceHTML     EnrichmentSurface = "html"
	SurfaceMCP      EnrichmentSurface = "mcp"
)

type CustomerIdentity struct {
	AccountRef   string `json:"accountRef,omitempty"`
	UserRef      string `json:"userRef,omitempty"`
	AnonymousRef string `json:"anonymousRef,omitempty"`
	CustomerRef  string `json:"customerRef,omitempty"`
}

type EnrichmentRequestInput struct {
	CustomerIdentity
	InteractionID string            `json:"interactionId"`
	Operation     string            `json:"operation"`
	Surface       EnrichmentSurface `json:"surface"`
	StatusCode    *int              `json:"statusCode,omitempty"`
	DurationMS    *int64            `json:"durationMs,omitempty"`
	// SessionRef is a product-issued journey reference, never prompt or tool input.
	SessionRef string `json:"sessionRef,omitempty"`
	// RuntimeHint is a bounded, non-sensitive product-observed label.
	RuntimeHint string          `json:"runtimeHint,omitempty"`
	Purpose     CustomerPurpose `json:"purpose"`
	Remember    bool            `json:"remember"`
}

type AgentAction struct {
	URL           string         `json:"url"`
	Method        string         `json:"method"`
	Authorization string         `json:"authorization"`
	ContentType   string         `json:"contentType"`
	BodySchema    map[string]any `json:"bodySchema,omitempty"`
}

type EnrichmentRequest struct {
	RequestID         string          `json:"requestId"`
	InteractionID     string          `json:"interactionId"`
	State             string          `json:"state"`
	Purpose           CustomerPurpose `json:"purpose"`
	IdentityLevel     string          `json:"identityLevel"`
	StageInstruction  string          `json:"stageInstruction"`
	Question          *string         `json:"question"`
	AnswerInstruction *string         `json:"answerInstruction"`
	ExpiresAt         string          `json:"expiresAt"`
	Consent           *AgentAction    `json:"consent"`
	Submit            *AgentAction    `json:"submit,omitempty"`
}

type CustomerAnswerItem struct {
	Key        string   `json:"key"`
	Type       string   `json:"type"`
	Value      string   `json:"value"`
	Summary    string   `json:"summary,omitempty"`
	Provenance string   `json:"provenance"`
	Confidence *float64 `json:"confidence,omitempty"`
	Remember   bool     `json:"remember"`
	ExpiresAt  string   `json:"expiresAt,omitempty"`
}

type CustomerAnswerInput struct {
	Status string               `json:"status"`
	Items  []CustomerAnswerItem `json:"items"`
}

type CustomerContextInput struct {
	CustomerIdentity
	InteractionID string          `json:"interactionId,omitempty"`
	Purpose       CustomerPurpose `json:"purpose"`
}

type CustomerContextItem struct {
	SignalID    string            `json:"signalId"`
	Key         string            `json:"key"`
	Type        string            `json:"type"`
	Value       any               `json:"value"`
	Summary     string            `json:"summary"`
	Provenance  string            `json:"provenance"`
	Confidence  *float64          `json:"confidence,omitempty"`
	ExpiresAt   *string           `json:"expiresAt,omitempty"`
	AllowedUses []CustomerPurpose `json:"allowedUses"`
	Remembered  bool              `json:"remembered"`
}

type CustomerContext struct {
	Available      bool                  `json:"available"`
	RetrievalID    string                `json:"retrievalId,omitempty"`
	IdentityLevel  string                `json:"identityLevel"`
	CustomerID     *string               `json:"customerId,omitempty"`
	InteractionID  *string               `json:"interactionId,omitempty"`
	ContextVersion string                `json:"contextVersion,omitempty"`
	Items          []CustomerContextItem `json:"items"`
}

type PersonalizationDecisionInput struct {
	ExternalDecisionID string   `json:"externalDecisionId"`
	ContextRetrievalID string   `json:"contextRetrievalId"`
	SignalIDs          []string `json:"signalIds"`
	Variant            string   `json:"variant,omitempty"`
}

type PersonalizationDecision struct {
	ID                 string          `json:"id"`
	ExternalDecisionID string          `json:"externalDecisionId"`
	Purpose            CustomerPurpose `json:"purpose"`
	SignalIDs          []string        `json:"signalIds"`
	Variant            *string         `json:"variant,omitempty"`
	CreatedAt          string          `json:"createdAt"`
}

type PersonalizationDecisionResult struct {
	Recorded bool                    `json:"recorded"`
	Decision PersonalizationDecision `json:"decision,omitempty"`
}

type PersonalizationOutcomeInput struct {
	ExternalOutcomeID string `json:"externalOutcomeId"`
	DecisionID        string `json:"decisionId"`
	Outcome           string `json:"outcome"`
	OccurredAt        string `json:"occurredAt,omitempty"`
}

type PersonalizationOutcome struct {
	ID                string `json:"id"`
	ExternalOutcomeID string `json:"externalOutcomeId"`
	DecisionID        string `json:"decisionId"`
	Outcome           string `json:"outcome"`
	OccurredAt        string `json:"occurredAt"`
	CreatedAt         string `json:"createdAt"`
}

type PersonalizationOutcomeResult struct {
	Recorded bool                   `json:"recorded"`
	Outcome  PersonalizationOutcome `json:"outcome,omitempty"`
}

type RelayRequest struct {
	Path          string
	Authorization string
	Body          any
}

type RelayResponse struct {
	Status int
	Body   any
}

type CustomerClientOptions struct {
	APIKey       string
	Endpoint     string
	Timeout      time.Duration
	RelayTimeout time.Duration
	HTTPClient   *http.Client
	Logger       *log.Logger
}

type CustomerClient struct {
	apiKey       string
	endpoint     string
	timeout      time.Duration
	relayTimeout time.Duration
	httpClient   *http.Client
	logger       *log.Logger
}

func NewCustomerClient(options CustomerClientOptions) (*CustomerClient, error) {
	if options.APIKey == "" {
		options.APIKey = os.Getenv("EPODE_API_KEY")
	}
	if !strings.HasPrefix(options.APIKey, "af_live_") {
		return nil, errors.New("EPODE_API_KEY must be a server-side product key")
	}
	if options.Endpoint == "" {
		options.Endpoint = os.Getenv("EPODE_API_URL")
		if options.Endpoint == "" {
			options.Endpoint = DefaultEndpoint
		}
	}
	if options.Timeout == 0 {
		options.Timeout = 250 * time.Millisecond
	}
	if options.RelayTimeout == 0 {
		options.RelayTimeout = 5 * time.Second
	}
	if options.Timeout < 0 || options.RelayTimeout < 0 {
		return nil, errors.New("timeouts must be positive and bounded")
	}
	client := &http.Client{}
	if options.HTTPClient != nil {
		copy := *options.HTTPClient
		client = &copy
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	if options.Logger == nil {
		options.Logger = log.Default()
	}
	return &CustomerClient{
		apiKey: options.APIKey, endpoint: strings.TrimRight(options.Endpoint, "/"),
		timeout: options.Timeout, relayTimeout: options.RelayTimeout,
		httpClient: client, logger: options.Logger,
	}, nil
}

func (client *CustomerClient) RequestEnrichment(ctx context.Context, input EnrichmentRequestInput) *EnrichmentRequest {
	if input.Purpose == "" {
		input.Purpose = ProductPersonalization
	}
	if input.Surface == "" {
		input.Surface = SurfaceHTTPJSON
	}
	if err := validateIdentity(input.CustomerIdentity); err != nil || !validOpaque(input.InteractionID) || !bounded(input.Operation, 160) || !validPurpose(input.Purpose) || !validEnrichmentMetadata(input) {
		client.warn("Customer enrichment input was invalid; the product response was not affected")
		return nil
	}
	var result EnrichmentRequest
	if err := client.companyPost(ctx, "/api/v2/enrichment/requests", input, &result); err != nil {
		client.warn("Customer enrichment is temporarily unavailable; the product response was not affected")
		return nil
	}
	return &result
}

func validEnrichmentMetadata(input EnrichmentRequestInput) bool {
	if input.Surface != SurfaceHTTPJSON && input.Surface != SurfaceHTML && input.Surface != SurfaceMCP {
		return false
	}
	if input.StatusCode != nil && (*input.StatusCode < 100 || *input.StatusCode > 599) {
		return false
	}
	if input.DurationMS != nil && (*input.DurationMS < 0 || *input.DurationMS > 86_400_000) {
		return false
	}
	if input.SessionRef != "" && !validOpaque(input.SessionRef) {
		return false
	}
	return input.RuntimeHint == "" || (bounded(input.RuntimeHint, 200) && !sensitiveText(input.RuntimeHint))
}

func (client *CustomerClient) GetCustomerContext(ctx context.Context, input CustomerContextInput) CustomerContext {
	if input.Purpose == "" {
		input.Purpose = ProductPersonalization
	}
	if err := validateIdentity(input.CustomerIdentity); err != nil || !validPurpose(input.Purpose) || (input.InteractionID != "" && !validOpaque(input.InteractionID)) {
		return unavailableCustomerContext()
	}
	var result CustomerContext
	if err := client.companyPost(ctx, "/api/v2/customer-context", input, &result); err != nil {
		client.warn("Customer context is temporarily unavailable; use the normal product experience")
		return unavailableCustomerContext()
	}
	result.Available = true
	if result.Items == nil {
		result.Items = []CustomerContextItem{}
	}
	return result
}

func (client *CustomerClient) RecordPersonalizationDecision(ctx context.Context, input PersonalizationDecisionInput) PersonalizationDecisionResult {
	if !validOpaque(input.ExternalDecisionID) || !validOpaque(input.ContextRetrievalID) {
		return PersonalizationDecisionResult{}
	}
	for _, signalID := range input.SignalIDs {
		if !validOpaque(signalID) {
			return PersonalizationDecisionResult{}
		}
	}
	var response struct {
		Decision PersonalizationDecision `json:"decision"`
	}
	if err := client.companyPost(ctx, "/api/v2/personalization/decisions", input, &response); err != nil {
		client.warn("Personalization decision was not recorded; the product experience may continue")
		return PersonalizationDecisionResult{}
	}
	return PersonalizationDecisionResult{Recorded: true, Decision: response.Decision}
}

func (client *CustomerClient) TrackPersonalizationOutcome(ctx context.Context, input PersonalizationOutcomeInput) PersonalizationOutcomeResult {
	if !validOpaque(input.ExternalOutcomeID) || !validOpaque(input.DecisionID) || !validOutcome(input.Outcome) {
		return PersonalizationOutcomeResult{}
	}
	var response struct {
		Outcome PersonalizationOutcome `json:"outcome"`
	}
	if err := client.companyPost(ctx, "/api/v2/personalization/outcomes", input, &response); err != nil {
		client.warn("Personalization outcome was not recorded; the product response was not affected")
		return PersonalizationOutcomeResult{}
	}
	return PersonalizationOutcomeResult{Recorded: true, Outcome: response.Outcome}
}

func (client *CustomerClient) Relay(ctx context.Context, input RelayRequest) RelayResponse {
	target := ""
	switch input.Path {
	case "/_epode/v1/enrichment/consent":
		target = "/api/v2/enrichment/consent/decisions"
	case "/_epode/v1/enrichment/answers":
		target = "/api/v2/enrichment/answers"
	default:
		return RelayResponse{Status: http.StatusNotFound, Body: map[string]any{"error": "not_found"}}
	}
	match := customerHandle.FindStringSubmatch(input.Authorization)
	if len(match) != 2 {
		return RelayResponse{Status: http.StatusUnauthorized, Body: map[string]any{"error": "invalid_customer_context_handle"}}
	}
	body, err := json.Marshal(input.Body)
	if err != nil || !validRelayBody(target, body) {
		return RelayResponse{Status: http.StatusBadRequest, Body: map[string]any{"error": "invalid_customer_context_body"}}
	}
	status, responseBody, err := client.post(ctx, target, "Bearer "+match[1], body, client.relayTimeout)
	if err != nil {
		return RelayResponse{Status: http.StatusServiceUnavailable, Body: map[string]any{"error": "customer_context_temporarily_unavailable", "retryable": true}}
	}
	if status >= 300 && status < 400 {
		return RelayResponse{Status: http.StatusBadGateway, Body: map[string]any{"error": "epode_redirect_rejected"}}
	}
	var parsed any = map[string]any{}
	if len(responseBody) > 0 && json.Unmarshal(responseBody, &parsed) != nil {
		parsed = map[string]any{"error": "Epode returned a non-JSON response"}
	}
	return RelayResponse{Status: status, Body: sameOriginRelayBody(parsed)}
}

func (client *CustomerClient) SubmitConsent(ctx context.Context, handle, decision string) RelayResponse {
	return client.Relay(ctx, RelayRequest{Path: "/_epode/v1/enrichment/consent", Authorization: "Bearer " + handle, Body: map[string]any{"decision": decision}})
}

func (client *CustomerClient) SubmitAnswer(ctx context.Context, handle string, answer CustomerAnswerInput) RelayResponse {
	return client.Relay(ctx, RelayRequest{Path: "/_epode/v1/enrichment/answers", Authorization: "Bearer " + handle, Body: answer})
}

func SameOriginEnrichmentRequest(input EnrichmentRequest) EnrichmentRequest {
	if input.Consent != nil {
		input.Consent.URL = "/_epode/v1/enrichment/consent"
		input.Consent.Method = http.MethodPost
		input.Consent.ContentType = "application/json"
	}
	if input.Submit != nil {
		input.Submit.URL = "/_epode/v1/enrichment/answers"
		input.Submit.Method = http.MethodPost
		input.Submit.ContentType = "application/json"
	}
	return input
}

var CustomerContextRelayPaths = []string{"/_epode/v1/enrichment/consent", "/_epode/v1/enrichment/answers"}

func (client *CustomerClient) companyPost(ctx context.Context, path string, input, output any) error {
	body, err := json.Marshal(input)
	if err != nil {
		return err
	}
	status, response, err := client.post(ctx, path, "Bearer "+client.apiKey, body, client.timeout)
	if err != nil {
		return err
	}
	if status >= 300 && status < 400 {
		return errors.New("redirect rejected")
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("epode returned HTTP %d", status)
	}
	return json.Unmarshal(response, output)
}

func (client *CustomerClient) post(ctx context.Context, path, authorization string, body []byte, timeout time.Duration) (int, []byte, error) {
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, client.endpoint+path, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("Authorization", authorization)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", customerUserAgent)
	response, err := client.httpClient.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	return response.StatusCode, responseBody, err
}

var customerOpaque = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,160}$`)
var customerHandle = regexp.MustCompile(`^Bearer (aqr1_[A-Za-z0-9._-]+)$`)
var answerKey = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,63}$`)
var awsCredential = regexp.MustCompile(`(?:AKIA|ASIA)[A-Z0-9]{12}`)
var bearerCredential = regexp.MustCompile(`(?i)bearer\s+[A-Za-z0-9._~+/=-]{20,}`)
var emailLike = regexp.MustCompile(`[^\s@]+@[^\s@]+\.[^\s@]+`)
var forbiddenKeyComponents = stringSet("name email phone address street zip postal age dob birthdate birthday sex gender health medical race ethnicity nationality citizenship immigration religion political sexual biometric genetic dna minor child teen income salary credit veteran military union criminal arrest legal credential password")
var forbiddenKeyPhrases = []string{"precise_location", "financial_account", "social_security", "date_of_birth", "dateofbirth", "net_worth", "creditworthiness", "marital_status"}
var sensitiveFragments = []string{"pregnan", "diagnos", "disabil", "medical", "health condition", "race", "ethnic", "religio", "politic", "sexual orientation", "gender identity", "biometric", "social security", "bank account", "credit card", "precise location", "home address", "street address", "zip code", "postal code", "date of birth", "birth date", "birthday", "years old", "age is", "biological sex", "sex assigned", "gender", "income", "salary", "net worth", "credit score", "creditworthiness", "nationality", "citizenship", "immigration status", "refugee", "veteran", "military service", "union member", "labor union", "criminal record", "arrest", "legal dispute", "lawsuit", "genetic", " dna ", "child", "minor", "teenager"}
var sensitiveWords = stringSet("male female man woman men women nonbinary transgender citizen visa felony conviction dna gay lesbian bisexual queer christian muslim jewish hindu buddhist sikh atheist catholic mormon hiv aids cancer diabetes asthma democrat republican")
var sensitiveSecretPatterns = []string{"af_live_", "af_read_", "github_pat_", "ghp_", "aws_secret", "sk-ant-", "-----begin ", "xoxb-", "xoxp-", "sk-proj-", "api key", "password", "prompt was", "user asked", "transcript:", "prompt:", "raw input:", "raw output:", "secret", "passwd", "api_key", "access_token", "access token", "refresh_token", "refresh token"}

func validOpaque(value string) bool { return customerOpaque.MatchString(value) }
func bounded(value string, maximum int) bool {
	return value != "" && len(value) <= maximum && !hasControl(value)
}
func validPurpose(value CustomerPurpose) bool {
	return value == ProductPersonalization || value == TargetedAdvertising
}
func validOutcome(value string) bool {
	switch value {
	case "conversion", "completion", "engagement", "dismissal", "abandonment":
		return true
	}
	return false
}
func unavailableCustomerContext() CustomerContext {
	return CustomerContext{Available: false, IdentityLevel: "ephemeral", Items: []CustomerContextItem{}}
}
func (client *CustomerClient) warn(message string) {
	if client.logger != nil {
		client.logger.Printf("[epode] %s", message)
	}
}

func validateIdentity(value CustomerIdentity) error {
	for _, reference := range []string{value.AccountRef, value.UserRef, value.AnonymousRef, value.CustomerRef} {
		if reference != "" && !validOpaque(reference) {
			return errors.New("identity must be a bounded opaque company reference")
		}
	}
	return nil
}

func validRelayBody(target string, encoded []byte) bool {
	var value map[string]any
	if json.Unmarshal(encoded, &value) != nil {
		return false
	}
	if strings.HasSuffix(target, "/decisions") {
		if len(value) != 1 {
			return false
		}
		decision, ok := value["decision"].(string)
		return ok && (decision == "approved" || decision == "declined")
	}
	if len(value) < 1 || len(value) > 2 {
		return false
	}
	status, ok := value["status"].(string)
	items := []any{}
	if rawItems, exists := value["items"]; exists {
		var itemsOK bool
		items, itemsOK = rawItems.([]any)
		if !itemsOK {
			return false
		}
	}
	if !ok || len(items) > 8 {
		return false
	}
	if status != "answered" && status != "declined" && status != "no_relevant_context" {
		return false
	}
	if (status == "answered") != (len(items) > 0) {
		return false
	}
	for _, raw := range items {
		if !validAnswerItem(raw) {
			return false
		}
	}
	return true
}

func validAnswerItem(raw any) bool {
	item, ok := raw.(map[string]any)
	if !ok || len(item) < 5 || len(item) > 8 {
		return false
	}
	allowed := map[string]bool{"key": true, "type": true, "value": true, "summary": true, "provenance": true, "confidence": true, "remember": true, "expiresAt": true}
	for key := range item {
		if !allowed[key] {
			return false
		}
	}
	key, keyOK := item["key"].(string)
	kind, kindOK := item["type"].(string)
	value, valueOK := item["value"].(string)
	summary, summaryExists := item["summary"]
	provenance, provenanceOK := item["provenance"].(string)
	_, rememberOK := item["remember"].(bool)
	if !keyOK || !answerKey.MatchString(key) || sensitiveKey(key) || !kindOK || !oneOf(kind, "intent", "preference", "constraint", "interest") || !valueOK || len([]rune(value)) < 1 || len([]rune(value)) > 160 || sensitiveText(value) || !provenanceOK || !oneOf(provenance, "agent_reports_user_statement", "agent_reports_current_task", "agent_inference") || !rememberOK {
		return false
	}
	if summaryExists {
		text, ok := summary.(string)
		if !ok || len([]rune(text)) < 3 || len([]rune(text)) > 350 || sensitiveText(text) {
			return false
		}
	}
	if confidence, exists := item["confidence"]; exists {
		number, ok := confidence.(float64)
		if !ok || number < 0 || number > 1 {
			return false
		}
	}
	if expires, exists := item["expiresAt"]; exists {
		text, ok := expires.(string)
		if !ok || len(text) > 64 {
			return false
		}
		if _, err := time.Parse(time.RFC3339Nano, text); err != nil {
			return false
		}
	}
	return true
}

func oneOf(value string, allowed ...string) bool {
	for _, item := range allowed {
		if value == item {
			return true
		}
	}
	return false
}
func stringSet(value string) map[string]bool {
	result := map[string]bool{}
	for _, item := range strings.Fields(value) {
		result[item] = true
	}
	return result
}

func sensitiveKey(value string) bool {
	for _, component := range strings.FieldsFunc(value, func(character rune) bool { return character == '.' || character == '_' || character == '-' }) {
		if forbiddenKeyComponents[component] {
			return true
		}
	}
	for _, phrase := range forbiddenKeyPhrases {
		if strings.Contains(value, phrase) {
			return true
		}
	}
	return false
}

func sensitiveText(value string) bool {
	lower := strings.ToLower(value)
	if strings.Contains(value, "@") || hasControl(value) || awsCredential.MatchString(value) || bearerCredential.MatchString(value) || emailLike.MatchString(value) {
		return true
	}
	for _, pattern := range sensitiveSecretPatterns {
		if strings.Contains(lower, pattern) {
			return true
		}
	}
	for _, fragment := range sensitiveFragments {
		if strings.Contains(lower, fragment) {
			return true
		}
	}
	for _, word := range strings.FieldsFunc(lower, func(character rune) bool {
		return !((character >= 'a' && character <= 'z') || (character >= '0' && character <= '9'))
	}) {
		if sensitiveWords[word] {
			return true
		}
	}
	return false
}
func hasControl(value string) bool {
	for _, character := range value {
		if character <= 31 || character == 127 {
			return true
		}
	}
	return false
}

func sameOriginRelayBody(value any) any {
	object, ok := value.(map[string]any)
	if !ok {
		return value
	}
	for key, path := range map[string]string{
		"consent": "/_epode/v1/enrichment/consent",
		"submit":  "/_epode/v1/enrichment/answers",
	} {
		action, exists := object[key].(map[string]any)
		if exists {
			copy := make(map[string]any, len(action)+1)
			for field, item := range action {
				copy[field] = item
			}
			copy["url"] = path
			object[key] = copy
		}
	}
	return object
}
