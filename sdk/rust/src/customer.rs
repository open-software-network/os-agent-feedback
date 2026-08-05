use std::time::Duration;

use reqwest::{Client, redirect::Policy};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

const DEFAULT_ENDPOINT: &str = "https://app.epode.ai";
const USER_AGENT: &str = "@epode/rust/0.4.0";

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CustomerPurpose {
    #[default]
    ProductPersonalization,
    TargetedAdvertising,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EnrichmentSurface {
    #[default]
    HttpJson,
    Html,
    Mcp,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CustomerIdentity {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anonymous_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub customer_ref: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrichmentRequestInput {
    #[serde(flatten)]
    pub identity: CustomerIdentity,
    pub interaction_id: String,
    pub operation: String,
    #[serde(default)]
    pub surface: EnrichmentSurface,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_code: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Product-issued journey reference; never derive from prompts or tool arguments.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_ref: Option<String>,
    /// Bounded, non-sensitive product-observed runtime label.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_hint: Option<String>,
    pub purpose: CustomerPurpose,
    pub remember: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAction {
    pub url: String,
    pub method: String,
    pub authorization: String,
    pub content_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_schema: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrichmentRequest {
    pub request_id: String,
    pub interaction_id: String,
    pub state: String,
    pub purpose: CustomerPurpose,
    pub identity_level: String,
    pub stage_instruction: String,
    pub question: Option<String>,
    pub answer_instruction: Option<String>,
    pub expires_at: String,
    pub consent: Option<AgentAction>,
    pub submit: Option<AgentAction>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerAnswerItem {
    pub key: String,
    pub r#type: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub provenance: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    pub remember: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CustomerAnswerStatus {
    Answered,
    Declined,
    NoRelevantContext,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerAnswerInput {
    pub status: CustomerAnswerStatus,
    pub items: Vec<CustomerAnswerItem>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerContextInput {
    #[serde(flatten)]
    pub identity: CustomerIdentity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interaction_id: Option<String>,
    pub purpose: CustomerPurpose,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerContextItem {
    pub signal_id: String,
    pub key: String,
    pub r#type: String,
    pub value: Value,
    pub summary: String,
    pub provenance: String,
    pub confidence: Option<f64>,
    pub expires_at: Option<String>,
    pub allowed_uses: Vec<CustomerPurpose>,
    pub remembered: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerContext {
    #[serde(default)]
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retrieval_id: Option<String>,
    pub identity_level: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub customer_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interaction_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_version: Option<String>,
    pub items: Vec<CustomerContextItem>,
}

impl CustomerContext {
    fn unavailable() -> Self {
        Self {
            available: false,
            retrieval_id: None,
            identity_level: "ephemeral".into(),
            customer_id: None,
            interaction_id: None,
            context_version: None,
            items: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalizationDecisionInput {
    pub external_decision_id: String,
    pub context_retrieval_id: String,
    pub signal_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalizationDecision {
    pub id: String,
    pub external_decision_id: String,
    pub purpose: CustomerPurpose,
    pub signal_ids: Vec<String>,
    pub variant: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalizationDecisionResult {
    pub recorded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision: Option<PersonalizationDecision>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PersonalizationOutcomeKind {
    Conversion,
    Completion,
    Engagement,
    Dismissal,
    Abandonment,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalizationOutcomeInput {
    pub external_outcome_id: String,
    pub decision_id: String,
    pub outcome: PersonalizationOutcomeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub occurred_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalizationOutcome {
    pub id: String,
    pub external_outcome_id: String,
    pub decision_id: String,
    pub outcome: PersonalizationOutcomeKind,
    pub occurred_at: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalizationOutcomeResult {
    pub recorded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<PersonalizationOutcome>,
}

#[derive(Clone, Debug)]
pub struct RelayRequest {
    pub path: String,
    pub authorization: Option<String>,
    pub body: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RelayResponse {
    pub status: u16,
    pub body: Value,
}

#[derive(Clone, Debug)]
pub struct EpodeClientOptions {
    pub api_key: String,
    pub endpoint: String,
    pub timeout: Duration,
    pub relay_timeout: Duration,
}

impl EpodeClientOptions {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            endpoint: std::env::var("EPODE_API_URL").unwrap_or_else(|_| DEFAULT_ENDPOINT.into()),
            timeout: Duration::from_millis(250),
            relay_timeout: Duration::from_secs(5),
        }
    }

    pub fn from_env() -> Result<Self, CustomerClientError> {
        let key = std::env::var("EPODE_API_KEY")
            .map_err(|_| CustomerClientError("EPODE_API_KEY is required".into()))?;
        Ok(Self::new(key))
    }

    pub fn endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.endpoint = endpoint.into();
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn relay_timeout(mut self, timeout: Duration) -> Self {
        self.relay_timeout = timeout;
        self
    }
}

#[derive(Clone)]
pub struct EpodeClient {
    endpoint: String,
    api_key: String,
    timeout: Duration,
    relay_timeout: Duration,
    http: Client,
}

impl EpodeClient {
    pub fn new(options: EpodeClientOptions) -> Result<Self, CustomerClientError> {
        if !options.api_key.starts_with("af_live_") {
            return Err(CustomerClientError(
                "EPODE_API_KEY must be a server-side product key".into(),
            ));
        }
        if options.timeout.is_zero() || options.relay_timeout.is_zero() {
            return Err(CustomerClientError(
                "timeouts must be positive and bounded".into(),
            ));
        }
        let http = Client::builder()
            .redirect(Policy::none())
            .build()
            .map_err(|error| CustomerClientError(error.to_string()))?;
        Ok(Self {
            endpoint: options.endpoint.trim_end_matches('/').into(),
            api_key: options.api_key,
            timeout: options.timeout,
            relay_timeout: options.relay_timeout,
            http,
        })
    }

    pub async fn request_enrichment(
        &self,
        input: &EnrichmentRequestInput,
    ) -> Option<EnrichmentRequest> {
        if !valid_identity(&input.identity)
            || !valid_opaque(&input.interaction_id)
            || !bounded(&input.operation, 160)
            || input
                .status_code
                .is_some_and(|value| !(100..=599).contains(&value))
            || input.duration_ms.is_some_and(|value| value > 86_400_000)
            || input
                .session_ref
                .as_deref()
                .is_some_and(|value| !valid_opaque(value))
            || input
                .runtime_hint
                .as_deref()
                .is_some_and(|value| !bounded(value, 200) || sensitive_text(value))
        {
            return None;
        }
        self.company_post("/api/v2/enrichment/requests", input)
            .await
            .ok()
    }

    pub async fn get_customer_context(&self, input: &CustomerContextInput) -> CustomerContext {
        if !valid_identity(&input.identity)
            || input
                .interaction_id
                .as_deref()
                .is_some_and(|value| !valid_opaque(value))
        {
            return CustomerContext::unavailable();
        }
        match self
            .company_post::<_, CustomerContext>("/api/v2/customer-context", input)
            .await
        {
            Ok(mut context) => {
                context.available = true;
                context
            }
            Err(_) => CustomerContext::unavailable(),
        }
    }

    pub async fn record_personalization_decision(
        &self,
        input: &PersonalizationDecisionInput,
    ) -> PersonalizationDecisionResult {
        if !valid_opaque(&input.external_decision_id)
            || !valid_opaque(&input.context_retrieval_id)
            || input.signal_ids.iter().any(|value| !valid_opaque(value))
        {
            return PersonalizationDecisionResult::default();
        }
        #[derive(Deserialize)]
        struct Response {
            decision: PersonalizationDecision,
        }
        match self
            .company_post::<_, Response>("/api/v2/personalization/decisions", input)
            .await
        {
            Ok(value) => PersonalizationDecisionResult {
                recorded: true,
                decision: Some(value.decision),
            },
            Err(_) => PersonalizationDecisionResult::default(),
        }
    }

    pub async fn track_personalization_outcome(
        &self,
        input: &PersonalizationOutcomeInput,
    ) -> PersonalizationOutcomeResult {
        if !valid_opaque(&input.external_outcome_id) || !valid_opaque(&input.decision_id) {
            return PersonalizationOutcomeResult::default();
        }
        #[derive(Deserialize)]
        struct Response {
            outcome: PersonalizationOutcome,
        }
        match self
            .company_post::<_, Response>("/api/v2/personalization/outcomes", input)
            .await
        {
            Ok(value) => PersonalizationOutcomeResult {
                recorded: true,
                outcome: Some(value.outcome),
            },
            Err(_) => PersonalizationOutcomeResult::default(),
        }
    }

    pub async fn relay(&self, request: RelayRequest) -> RelayResponse {
        let target = match request.path.as_str() {
            "/_epode/v1/enrichment/consent" => "/api/v2/enrichment/consent/decisions",
            "/_epode/v1/enrichment/answers" => "/api/v2/enrichment/answers",
            _ => return relay_error(404, "not_found"),
        };
        let Some(handle) = request
            .authorization
            .as_deref()
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|value| valid_handle(value))
        else {
            return relay_error(401, "invalid_customer_context_handle");
        };
        let valid = if target.ends_with("/decisions") {
            valid_consent(&request.body)
        } else {
            valid_answer(&request.body)
        };
        if !valid {
            return relay_error(400, "invalid_customer_context_body");
        }
        match self
            .post(
                target,
                &format!("Bearer {handle}"),
                &request.body,
                self.relay_timeout,
            )
            .await
        {
            Ok((status, _)) if (300..400).contains(&status) => {
                relay_error(502, "epode_redirect_rejected")
            }
            Ok((status, body)) => RelayResponse {
                status,
                body: same_origin_relay_body(body),
            },
            Err(_) => RelayResponse {
                status: 503,
                body: json!({
                    "error": "customer_context_temporarily_unavailable",
                    "retryable": true
                }),
            },
        }
    }

    pub async fn submit_consent(&self, handle: &str, decision: &str) -> RelayResponse {
        self.relay(RelayRequest {
            path: "/_epode/v1/enrichment/consent".into(),
            authorization: Some(format!("Bearer {handle}")),
            body: json!({ "decision": decision }),
        })
        .await
    }

    pub async fn submit_answer(&self, handle: &str, answer: &CustomerAnswerInput) -> RelayResponse {
        self.relay(RelayRequest {
            path: "/_epode/v1/enrichment/answers".into(),
            authorization: Some(format!("Bearer {handle}")),
            body: serde_json::to_value(answer).unwrap_or(Value::Null),
        })
        .await
    }

    async fn company_post<I: Serialize + ?Sized, O: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        input: &I,
    ) -> Result<O, CustomerClientError> {
        let body =
            serde_json::to_value(input).map_err(|error| CustomerClientError(error.to_string()))?;
        let (status, response) = self
            .post(
                path,
                &format!("Bearer {}", self.api_key),
                &body,
                self.timeout,
            )
            .await?;
        if (300..400).contains(&status) {
            return Err(CustomerClientError("redirect rejected".into()));
        }
        if !(200..300).contains(&status) {
            return Err(CustomerClientError(format!("Epode returned HTTP {status}")));
        }
        serde_json::from_value(response).map_err(|error| CustomerClientError(error.to_string()))
    }

    async fn post(
        &self,
        path: &str,
        authorization: &str,
        body: &Value,
        timeout: Duration,
    ) -> Result<(u16, Value), CustomerClientError> {
        let response = self
            .http
            .post(format!("{}{}", self.endpoint, path))
            .header("authorization", authorization)
            .header("user-agent", USER_AGENT)
            .json(body)
            .timeout(timeout)
            .send()
            .await
            .map_err(|error| CustomerClientError(error.to_string()))?;
        let status = response.status().as_u16();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| CustomerClientError(error.to_string()))?;
        let body = if bytes.is_empty() {
            json!({})
        } else {
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| json!({ "error": "Epode returned a non-JSON response" }))
        };
        Ok((status, body))
    }
}

pub fn same_origin_enrichment_request(mut request: EnrichmentRequest) -> EnrichmentRequest {
    if let Some(consent) = request.consent.as_mut() {
        consent.url = "/_epode/v1/enrichment/consent".into();
        consent.method = "POST".into();
        consent.content_type = "application/json".into();
    }
    if let Some(submit) = request.submit.as_mut() {
        submit.url = "/_epode/v1/enrichment/answers".into();
        submit.method = "POST".into();
        submit.content_type = "application/json".into();
    }
    request
}

pub const CUSTOMER_CONTEXT_RELAY_PATHS: [&str; 2] = [
    "/_epode/v1/enrichment/consent",
    "/_epode/v1/enrichment/answers",
];

#[derive(Clone, Debug)]
pub struct CustomerClientError(pub String);

impl std::fmt::Display for CustomerClientError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for CustomerClientError {}

fn relay_error(status: u16, error: &str) -> RelayResponse {
    RelayResponse {
        status,
        body: json!({ "error": error }),
    }
}

fn valid_identity(identity: &CustomerIdentity) -> bool {
    [
        identity.account_ref.as_deref(),
        identity.user_ref.as_deref(),
        identity.anonymous_ref.as_deref(),
        identity.customer_ref.as_deref(),
    ]
    .into_iter()
    .flatten()
    .all(valid_opaque)
}

fn valid_opaque(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-'))
}

fn bounded(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && !value.bytes().any(|byte| byte <= 31 || byte == 127)
}

fn valid_handle(value: &str) -> bool {
    value.starts_with("aqr1_")
        && value.len() > 5
        && value
            .bytes()
            .skip(5)
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

fn exact_keys(value: &Map<String, Value>, allowed: &[&str]) -> bool {
    value.keys().all(|key| allowed.contains(&key.as_str()))
}

fn valid_consent(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.len() == 1
        && matches!(
            object.get("decision").and_then(Value::as_str),
            Some("approved" | "declined")
        )
}

fn valid_answer(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.is_empty() || object.len() > 2 || !exact_keys(object, &["status", "items"]) {
        return false;
    }
    let Some(status) = object.get("status").and_then(Value::as_str) else {
        return false;
    };
    let empty = Vec::new();
    let items = match object.get("items") {
        Some(value) => match value.as_array() {
            Some(items) => items,
            None => return false,
        },
        None => &empty,
    };
    if items.len() > 8
        || !matches!(status, "answered" | "declined" | "no_relevant_context")
        || (status == "answered") == items.is_empty()
    {
        return false;
    }
    items.iter().all(valid_answer_item)
}

fn valid_answer_item(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if !exact_keys(
        object,
        &[
            "key",
            "type",
            "value",
            "summary",
            "provenance",
            "confidence",
            "remember",
            "expiresAt",
        ],
    ) {
        return false;
    }
    let Some(key) = object.get("key").and_then(Value::as_str) else {
        return false;
    };
    let Some(kind) = object.get("type").and_then(Value::as_str) else {
        return false;
    };
    let Some(answer) = object.get("value").and_then(Value::as_str) else {
        return false;
    };
    let Some(provenance) = object.get("provenance").and_then(Value::as_str) else {
        return false;
    };
    if key.is_empty()
        || key.len() > 64
        || !key.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (index > 0 && matches!(byte, b'_' | b'-' | b'.'))
        })
        || sensitive_key(key)
        || !valid_question_type(kind)
        || !bounded(answer, 160)
        || sensitive_text(answer)
        || !matches!(
            provenance,
            "agent_reports_user_statement" | "agent_reports_current_task" | "agent_inference"
        )
        || !object.get("remember").is_some_and(Value::is_boolean)
    {
        return false;
    }
    if object.get("summary").is_some_and(|value| {
        value.as_str().is_none_or(|summary| {
            summary.len() < 3 || !bounded(summary, 350) || sensitive_text(summary)
        })
    }) {
        return false;
    }
    if object.get("confidence").is_some_and(|value| {
        value
            .as_f64()
            .is_none_or(|number| !(0.0..=1.0).contains(&number))
    }) {
        return false;
    }
    object
        .get("expiresAt")
        .is_none_or(|value| value.as_str().is_some_and(|value| bounded(value, 64)))
}

fn valid_question_type(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 48
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn sensitive_key(value: &str) -> bool {
    const COMPONENTS: &[&str] = &[
        "name",
        "email",
        "phone",
        "address",
        "street",
        "zip",
        "postal",
        "age",
        "dob",
        "birthdate",
        "birthday",
        "sex",
        "gender",
        "health",
        "medical",
        "race",
        "ethnicity",
        "nationality",
        "citizenship",
        "immigration",
        "religion",
        "political",
        "sexual",
        "biometric",
        "genetic",
        "dna",
        "minor",
        "child",
        "teen",
        "income",
        "salary",
        "credit",
        "veteran",
        "military",
        "union",
        "criminal",
        "arrest",
        "legal",
        "credential",
        "password",
    ];
    const PHRASES: &[&str] = &[
        "precise_location",
        "financial_account",
        "social_security",
        "date_of_birth",
        "dateofbirth",
        "net_worth",
        "creditworthiness",
        "marital_status",
    ];
    value
        .split(['.', '_', '-'])
        .any(|component| COMPONENTS.contains(&component))
        || PHRASES.iter().any(|phrase| value.contains(phrase))
}

fn sensitive_text(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    const SECRET_PATTERNS: &[&str] = &[
        "af_live_",
        "af_read_",
        "github_pat_",
        "ghp_",
        "aws_secret",
        "sk-ant-",
        "-----begin ",
        "xoxb-",
        "xoxp-",
        "sk-proj-",
        "api key",
        "password",
        "prompt was",
        "user asked",
        "transcript:",
        "prompt:",
        "raw input:",
        "raw output:",
        "secret",
        "passwd",
        "api_key",
        "access_token",
        "access token",
        "refresh_token",
        "refresh token",
    ];
    const FRAGMENTS: &[&str] = &[
        "pregnan",
        "diagnos",
        "disabil",
        "medical",
        "health condition",
        "race",
        "ethnic",
        "religio",
        "politic",
        "sexual orientation",
        "gender identity",
        "biometric",
        "social security",
        "bank account",
        "credit card",
        "precise location",
        "home address",
        "street address",
        "zip code",
        "postal code",
        "date of birth",
        "birth date",
        "birthday",
        "years old",
        "age is",
        "biological sex",
        "sex assigned",
        "gender",
        "income",
        "salary",
        "net worth",
        "credit score",
        "creditworthiness",
        "nationality",
        "citizenship",
        "immigration status",
        "refugee",
        "veteran",
        "military service",
        "union member",
        "labor union",
        "criminal record",
        "arrest",
        "legal dispute",
        "lawsuit",
        "genetic",
        " dna ",
        "child",
        "minor",
        "teenager",
    ];
    const WORDS: &[&str] = &[
        "male",
        "female",
        "man",
        "woman",
        "men",
        "women",
        "nonbinary",
        "transgender",
        "citizen",
        "visa",
        "felony",
        "conviction",
        "dna",
        "gay",
        "lesbian",
        "bisexual",
        "queer",
        "christian",
        "muslim",
        "jewish",
        "hindu",
        "buddhist",
        "sikh",
        "atheist",
        "catholic",
        "mormon",
        "hiv",
        "aids",
        "cancer",
        "diabetes",
        "asthma",
        "democrat",
        "republican",
    ];
    value.contains('@')
        || value.bytes().any(|byte| byte <= 31 || byte == 127)
        || SECRET_PATTERNS.iter().any(|needle| lower.contains(needle))
        || FRAGMENTS.iter().any(|fragment| lower.contains(fragment))
        || lower
            .split(|character: char| !character.is_ascii_alphanumeric())
            .any(|word| WORDS.contains(&word))
        || contains_email_like(value)
        || contains_bearer_credential(value)
        || contains_aws_access_key(value)
}

fn contains_email_like(value: &str) -> bool {
    value.split_whitespace().any(|word| {
        let trimmed = word.trim_matches(|character: char| {
            !character.is_ascii_alphanumeric() && !"@._+-".contains(character)
        });
        trimmed
            .split_once('@')
            .is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.'))
    })
}

fn contains_bearer_credential(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.match_indices("bearer ").any(|(index, _)| {
        let candidate = value[index + "bearer ".len()..]
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .trim_matches(|character: char| {
                !character.is_ascii_alphanumeric() && !"-._~+/=".contains(character)
            });
        candidate.len() >= 20
            && candidate
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "-._~+/=".contains(character))
    })
}

fn contains_aws_access_key(value: &str) -> bool {
    ["AKIA", "ASIA"].iter().any(|prefix| {
        value.match_indices(prefix).any(|(index, _)| {
            value[index + prefix.len()..].chars().take(12).count() == 12
                && value[index + prefix.len()..]
                    .chars()
                    .take(12)
                    .all(|character| character.is_ascii_uppercase() || character.is_ascii_digit())
        })
    })
}

fn same_origin_relay_body(mut value: Value) -> Value {
    let Some(object) = value.as_object_mut() else {
        return value;
    };
    for (key, path) in [
        ("consent", "/_epode/v1/enrichment/consent"),
        ("submit", "/_epode/v1/enrichment/answers"),
    ] {
        if let Some(action) = object.get_mut(key).and_then(Value::as_object_mut) {
            action.insert("url".into(), Value::String(path.into()));
        }
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    fn key() -> String {
        format!(
            "af_live_0123456789abcdef0123456789abcdef_{}",
            "x".repeat(32)
        )
    }

    fn client(endpoint: &str) -> EpodeClient {
        EpodeClient::new(
            EpodeClientOptions::new(key())
                .endpoint(endpoint)
                .timeout(Duration::from_millis(20))
                .relay_timeout(Duration::from_millis(20)),
        )
        .unwrap()
    }

    fn backend(
        responses: Vec<(&'static str, &'static str, &'static str)>,
    ) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = thread::spawn(move || {
            for (path, authorization, response_body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = Vec::new();
                let mut buffer = [0_u8; 4096];
                loop {
                    let read = stream.read(&mut buffer).unwrap();
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                    if let Some(boundary) =
                        request.windows(4).position(|value| value == b"\r\n\r\n")
                    {
                        let headers = String::from_utf8_lossy(&request[..boundary + 4]);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length: ")
                                    .and_then(|value| value.parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if request.len() >= boundary + 4 + length {
                            break;
                        }
                    }
                }
                let text = String::from_utf8_lossy(&request);
                assert!(
                    text.starts_with(&format!("POST {path} HTTP/1.1\r\n")),
                    "{text}"
                );
                assert!(
                    text.to_ascii_lowercase().contains(&format!(
                        "authorization: {}",
                        authorization.to_ascii_lowercase()
                    )),
                    "{text}"
                );
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    response_body.len(),
                    response_body
                )
                .unwrap();
            }
        });
        (url, task)
    }

    #[test]
    fn same_origin_contract_never_contains_company_key() {
        let visible = same_origin_enrichment_request(EnrichmentRequest {
            request_id: "request-1".into(),
            interaction_id: "interaction-1".into(),
            state: "consent_required".into(),
            purpose: CustomerPurpose::ProductPersonalization,
            identity_level: "verified".into(),
            stage_instruction: "Answer before asking.".into(),
            question: Some("May Example remember relevant preferences?".into()),
            answer_instruction: Some("Answer first.".into()),
            expires_at: "2026-08-02T15:00:00Z".into(),
            consent: Some(AgentAction {
                url: "https://app.epode.ai/api/v2/enrichment/consent/decisions".into(),
                method: "POST".into(),
                authorization: "Bearer aqr1_request-1".into(),
                content_type: "application/json".into(),
                body_schema: None,
            }),
            submit: None,
        });
        assert_eq!(
            visible.consent.as_ref().map(|action| action.url.as_str()),
            Some("/_epode/v1/enrichment/consent")
        );
        assert!(!serde_json::to_string(&visible).unwrap().contains(&key()));
    }

    #[tokio::test]
    async fn typed_client_uses_exact_company_and_relay_endpoints() {
        let company_authorization = format!("Bearer {}", key());
        let company_authorization: &'static str = Box::leak(company_authorization.into_boxed_str());
        let (url, server) = backend(vec![
            (
                "/api/v2/enrichment/requests",
                company_authorization,
                r#"{"requestId":"request-1","interactionId":"interaction-1","state":"consent_required","purpose":"product_personalization","identityLevel":"verified","stageInstruction":"Answer before asking.","question":"May Example remember relevant preferences?","answerInstruction":"Answer first.","expiresAt":"2026-08-02T15:00:00Z","consent":{"url":"https://app.epode.ai/api/v2/enrichment/consent/decisions","method":"POST","authorization":"Bearer aqr1_request-1","contentType":"application/json"},"submit":null}"#,
            ),
            (
                "/api/v2/customer-context",
                company_authorization,
                r#"{"retrievalId":"retrieval-1","identityLevel":"pseudonymous","customerId":"customer-1","interactionId":null,"contextVersion":"context-1","items":[{"signalId":"signal-1","key":"budget","type":"constraint","value":{"currency":"USD","maximum":150},"summary":"Customer set a budget under $150.","provenance":"agent_reports_user_statement","confidence":1,"expiresAt":null,"allowedUses":["product_personalization"],"remembered":true}]}"#,
            ),
            (
                "/api/v2/personalization/decisions",
                company_authorization,
                r#"{"decision":{"id":"decision-1","externalDecisionId":"recommendation-1","purpose":"product_personalization","signalIds":["signal-1"],"variant":null,"createdAt":"2026-08-02T15:01:00Z"}}"#,
            ),
            (
                "/api/v2/personalization/outcomes",
                company_authorization,
                r#"{"outcome":{"id":"outcome-1","externalOutcomeId":"order-1","decisionId":"decision-1","outcome":"conversion","occurredAt":"2026-08-02T15:02:00Z","createdAt":"2026-08-02T15:02:01Z"}}"#,
            ),
            (
                "/api/v2/enrichment/consent/decisions",
                "Bearer aqr1_request-1",
                r#"{"requestId":"request-1","state":"answer_ready","changed":true,"submit":{"url":"https://app.epode.ai/api/v2/enrichment/answers","method":"POST","authorization":"Bearer aqr1_answer-1","contentType":"application/json"}}"#,
            ),
            (
                "/api/v2/enrichment/answers",
                "Bearer aqr1_answer-1",
                r#"{"accepted":true,"requestId":"request-1","interactionId":"interaction-1","customerId":"customer-1","signals":[]}"#,
            ),
        ]);
        let epode = client(&url);
        let request = epode
            .request_enrichment(&EnrichmentRequestInput {
                identity: CustomerIdentity {
                    user_ref: Some("user_42".into()),
                    ..CustomerIdentity::default()
                },
                interaction_id: "interaction-1".into(),
                operation: "recommendations".into(),
                surface: EnrichmentSurface::HttpJson,
                status_code: Some(200),
                duration_ms: Some(31),
                session_ref: Some("journey_42".into()),
                runtime_hint: Some("rust-api/1.0".into()),
                purpose: CustomerPurpose::ProductPersonalization,
                remember: true,
            })
            .await
            .expect("enrichment request");
        assert!(request.consent.is_some());
        let context = epode
            .get_customer_context(&CustomerContextInput {
                identity: CustomerIdentity {
                    anonymous_ref: Some("visitor_42".into()),
                    ..CustomerIdentity::default()
                },
                interaction_id: None,
                purpose: CustomerPurpose::ProductPersonalization,
            })
            .await;
        assert!(context.available);
        assert!(context.items[0].value.is_object());
        let decision = epode
            .record_personalization_decision(&PersonalizationDecisionInput {
                external_decision_id: "recommendation-1".into(),
                context_retrieval_id: "retrieval-1".into(),
                signal_ids: vec!["signal-1".into()],
                variant: None,
            })
            .await;
        assert_eq!(
            decision.decision.as_ref().map(|value| value.id.as_str()),
            Some("decision-1")
        );
        let outcome = epode
            .track_personalization_outcome(&PersonalizationOutcomeInput {
                external_outcome_id: "order-1".into(),
                decision_id: "decision-1".into(),
                outcome: PersonalizationOutcomeKind::Conversion,
                occurred_at: None,
            })
            .await;
        assert!(outcome.recorded);
        let consent = epode.submit_consent("aqr1_request-1", "approved").await;
        assert_eq!(consent.status, 200);
        assert_eq!(
            consent.body["submit"]["url"],
            Value::String("/_epode/v1/enrichment/answers".into())
        );
        let answer = epode
            .submit_answer(
                "aqr1_answer-1",
                &CustomerAnswerInput {
                    status: CustomerAnswerStatus::Answered,
                    items: vec![CustomerAnswerItem {
                        key: "shopping.budget_band".into(),
                        r#type: "customer_goal".into(),
                        value: "50_150".into(),
                        summary: None,
                        provenance: "agent_reports_user_statement".into(),
                        confidence: Some(1.0),
                        remember: true,
                        expires_at: None,
                    }],
                },
            )
            .await;
        assert_eq!(answer.status, 200);
        server.join().unwrap();
    }

    #[tokio::test]
    async fn fail_open_and_relay_validation_are_bounded() {
        let epode = client("http://127.0.0.1:9");
        assert!(
            epode
                .request_enrichment(&EnrichmentRequestInput {
                    identity: CustomerIdentity::default(),
                    interaction_id: "interaction-1".into(),
                    operation: "search".into(),
                    surface: EnrichmentSurface::default(),
                    status_code: None,
                    duration_ms: None,
                    session_ref: None,
                    runtime_hint: None,
                    purpose: CustomerPurpose::ProductPersonalization,
                    remember: false,
                })
                .await
                .is_none()
        );
        assert!(
            !epode
                .get_customer_context(&CustomerContextInput {
                    identity: CustomerIdentity::default(),
                    interaction_id: Some("interaction-1".into()),
                    purpose: CustomerPurpose::ProductPersonalization,
                })
                .await
                .available
        );
        assert!(
            !epode
                .record_personalization_decision(&PersonalizationDecisionInput {
                    external_decision_id: "decision-1".into(),
                    context_retrieval_id: "retrieval-1".into(),
                    signal_ids: Vec::new(),
                    variant: None,
                })
                .await
                .recorded
        );
        assert!(
            !epode
                .track_personalization_outcome(&PersonalizationOutcomeInput {
                    external_outcome_id: "outcome-1".into(),
                    decision_id: "decision-1".into(),
                    outcome: PersonalizationOutcomeKind::Conversion,
                    occurred_at: None,
                })
                .await
                .recorded
        );
        assert_eq!(
            epode
                .submit_consent("aqr1_request-1", "approved")
                .await
                .status,
            503
        );

        let sensitive = epode
            .relay(RelayRequest {
                path: "/_epode/v1/enrichment/answers".into(),
                authorization: Some("Bearer aqr1_answer-1".into()),
                body: json!({
                    "status": "answered",
                    "items": [{
                        "key": "contact",
                        "type": "preference",
                        "value": "person@example.com",
                        "summary": "Customer email",
                        "provenance": "agent_reports_user_statement",
                        "remember": true
                    }]
                }),
            })
            .await;
        assert_eq!(sensitive.status, 400);
    }

    #[test]
    fn enrichment_metadata_is_typed_bounded_and_privacy_safe() {
        let input = EnrichmentRequestInput {
            identity: CustomerIdentity::default(),
            interaction_id: "interaction-1".into(),
            operation: "/api/recommendations".into(),
            surface: EnrichmentSurface::Mcp,
            status_code: Some(200),
            duration_ms: Some(12),
            session_ref: Some("journey_42".into()),
            runtime_hint: Some("mcp-runtime/1.0".into()),
            purpose: CustomerPurpose::ProductPersonalization,
            remember: false,
        };
        let encoded = serde_json::to_value(&input).unwrap();
        assert_eq!(encoded["surface"], "mcp");
        assert_eq!(encoded["statusCode"], 200);
        assert_eq!(encoded["durationMs"], 12);
        assert_eq!(encoded["sessionRef"], "journey_42");
        assert_eq!(encoded["runtimeHint"], "mcp-runtime/1.0");
        assert!(valid_opaque(input.session_ref.as_deref().unwrap()));
        assert!(!sensitive_text(input.runtime_hint.as_deref().unwrap()));
        assert!(sensitive_text("political affiliation"));
        assert!(sensitive_text("prompt: private customer content"));
    }

    #[tokio::test]
    async fn relay_matches_backend_regulated_taxonomy() {
        let epode = client("http://127.0.0.1:9");
        let vectors = [
            ("medical_condition", "asthma"),
            ("shopping.preference", "political affiliation"),
            ("email", "person@example.com"),
            ("precise_location", "home"),
            ("date_of_birth", "1990-01-01"),
            ("demographics.gender", "woman"),
            ("household_income", "over 100000"),
            ("creditworthiness", "excellent"),
            ("shipping.zip", "10001"),
            ("citizenship", "citizen"),
            ("immigration_status", "temporary visa"),
            ("veteran_status", "veteran"),
            ("union_membership", "union member"),
            ("legal_history", "prior arrest"),
            ("genetic_profile", "dna marker"),
            ("audience", "teenager"),
            ("shopping.segment", "women"),
            ("account.status", "US citizen"),
            ("risk.label", "felony conviction"),
            ("shopping.preference", "gay"),
            ("shopping.preference", "Christian"),
            ("shopping.preference", "Muslim"),
            ("shopping.preference", "HIV positive"),
            ("shopping.preference", "has cancer"),
            ("shopping.preference", "Democrat"),
            ("shopping.preference", "handle@localhost"),
            ("shopping.preference", "af_live_deadbeef"),
        ];
        for (key, value) in vectors {
            let result = epode
                .relay(RelayRequest {
                    path: "/_epode/v1/enrichment/answers".into(),
                    authorization: Some("Bearer aqr1_targeted_ads".into()),
                    body: json!({
                        "status": "answered",
                        "items": [{
                            "key": key,
                            "type": "preference",
                            "value": value,
                            "summary": "Customer supplied this targeting context.",
                            "provenance": "agent_reports_user_statement",
                            "remember": true
                        }]
                    }),
                })
                .await;
            assert_eq!(
                result.status, 400,
                "regulated vector escaped: {key}={value}"
            );
        }
    }
}
