use std::{
    fmt,
    sync::atomic::Ordering,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use uuid::Uuid;

use crate::{
    CustomerIdentity, Error, Options, Runtime, ShutdownError, TelemetryEvent, iso_timestamp,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum McpOutcome {
    Success,
    Error,
}

impl TryFrom<&str> for McpOutcome {
    type Error = McpCompletionError;

    fn try_from(value: &str) -> Result<Self, McpCompletionError> {
        match value {
            "success" => Ok(Self::Success),
            "error" => Ok(Self::Error),
            _ => Err(McpCompletionError::InvalidOutcome),
        }
    }
}

#[derive(Clone, Debug)]
pub struct McpCompletion {
    operation: String,
    outcome: McpOutcome,
    identity: CustomerIdentity,
    session_ref: Option<String>,
    runtime_hint: Option<String>,
}

impl McpCompletion {
    pub fn new(operation: impl Into<String>, outcome: McpOutcome) -> Self {
        Self {
            operation: operation.into(),
            outcome,
            identity: CustomerIdentity::default(),
            session_ref: None,
            runtime_hint: None,
        }
    }

    pub fn identity(mut self, identity: CustomerIdentity) -> Self {
        self.identity = identity;
        self
    }

    pub fn session_ref(mut self, value: impl Into<String>) -> Self {
        self.session_ref = Some(value.into());
        self
    }

    pub fn runtime_hint(mut self, value: impl Into<String>) -> Self {
        self.runtime_hint = Some(value.into());
        self
    }
}

#[derive(Clone)]
pub struct AgentFeedbackRecorder {
    pub(crate) runtime: Runtime,
}

impl AgentFeedbackRecorder {
    pub fn new(options: Options) -> Result<Self, Error> {
        Ok(Self {
            runtime: Runtime::new(options)?,
        })
    }

    pub fn record_mcp_completion(
        &self,
        completion: McpCompletion,
    ) -> Result<(), McpCompletionError> {
        if !self.active() {
            return Ok(());
        }
        if !valid_operation(&completion.operation) {
            return Err(McpCompletionError::InvalidOperation);
        }
        let Some(prepared) = self.prepare_mcp_completion() else {
            return Ok(());
        };
        self.enqueue_mcp_completion(prepared, completion, None)
    }

    pub(crate) fn active(&self) -> bool {
        self.runtime.enabled() && !self.runtime.stopping.load(Ordering::Acquire)
    }

    #[cfg(feature = "rmcp")]
    pub(crate) fn valid_operation(value: &str) -> bool {
        valid_operation(value)
    }

    pub(crate) fn prepare_mcp_completion(&self) -> Option<PreparedMcpCompletion> {
        if !self.active() {
            return None;
        }
        let sequence = self
            .runtime
            .sequence
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |v| {
                Some(v.saturating_add(1).max(1))
            })
            .unwrap_or(u64::MAX)
            .saturating_add(1)
            .max(1);
        Some(PreparedMcpCompletion {
            interaction_id: Uuid::new_v4(),
            sequence,
            occurred_at: iso_timestamp(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
            ),
        })
    }

    pub(crate) fn enqueue_mcp_completion(
        &self,
        prepared: PreparedMcpCompletion,
        completion: McpCompletion,
        duration: Option<Duration>,
    ) -> Result<(), McpCompletionError> {
        if !valid_operation(&completion.operation) {
            return Err(McpCompletionError::InvalidOperation);
        }
        let mut identity = sanitize_identity(completion.identity);
        if identity.customer_ref.is_some()
            && (identity.account_ref.is_some() || identity.user_ref.is_some())
            && identity.account_ref != identity.customer_ref
        {
            identity.customer_ref = None;
        }
        let session_ref = completion.session_ref.and_then(sanitize_ref);
        let runtime_hint = completion.runtime_hint.and_then(sanitize_hint);
        self.runtime.record(TelemetryEvent {
            interaction_id: prepared.interaction_id,
            sequence: prepared.sequence,
            surface: "mcp".into(),
            operation: completion.operation,
            status_code: if completion.outcome == McpOutcome::Success {
                200
            } else {
                500
            },
            duration_ms: duration.map(|value| value.as_millis().min(u128::from(u64::MAX)) as u64),
            account_ref: identity.account_ref,
            user_ref: identity.user_ref,
            anonymous_ref: identity.anonymous_ref,
            customer_ref: identity.customer_ref,
            classification: "confirmed",
            confirmation_method: Some("mcp"),
            runtime_hint_source: runtime_hint.as_ref().map(|_| "mcp"),
            runtime_hint,
            session_source: session_ref.as_ref().map(|_| "mcp"),
            session_ref,
            occurred_at: prepared.occurred_at,
        });
        Ok(())
    }

    pub async fn shutdown(&self) -> Result<(), ShutdownError> {
        self.runtime.shutdown().await
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum McpCompletionError {
    InvalidOperation,
    InvalidOutcome,
}

impl fmt::Display for McpCompletionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidOperation => "invalid MCP operation",
            Self::InvalidOutcome => "invalid MCP outcome",
        })
    }
}
impl std::error::Error for McpCompletionError {}

fn trim_ascii(value: &str) -> &str {
    value.trim_matches(|c| matches!(c, '\t'..='\r' | ' '))
}
fn sanitize_ref(value: String) -> Option<String> {
    let value = trim_ascii(&value);
    (1..=160).contains(&value.len()).then_some(())?;
    value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
        .then(|| value.to_owned())
}
fn sanitize_hint(value: String) -> Option<String> {
    let value = trim_ascii(&value);
    (!value.is_empty() && value.chars().count() <= 200).then(|| value.to_owned())
}
fn sanitize_identity(value: CustomerIdentity) -> CustomerIdentity {
    CustomerIdentity {
        account_ref: value.account_ref.and_then(sanitize_ref),
        user_ref: value.user_ref.and_then(sanitize_ref),
        anonymous_ref: value.anonymous_ref.and_then(sanitize_ref),
        customer_ref: value.customer_ref.and_then(sanitize_ref),
    }
}
fn valid_operation(value: &str) -> bool {
    (1..=160).contains(&value.len())
        && !value.contains("://")
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/_:.*{}-".contains(&b))
}

pub(crate) struct PreparedMcpCompletion {
    interaction_id: Uuid,
    sequence: u64,
    occurred_at: String,
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc,
        thread,
        time::Duration,
    };

    use serde_json::Value;

    use super::*;

    const KEY: &str = "af_live_2123456789abcdef0123456789abcdef_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";

    fn server(statuses: Vec<u16>) -> (String, mpsc::Receiver<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            for status in statuses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 4096];
                let (end, length) = loop {
                    let n = stream.read(&mut buffer).unwrap();
                    request.extend_from_slice(&buffer[..n]);
                    if let Some(i) = request.windows(4).position(|v| v == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..i]);
                        let length: usize = headers
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse().unwrap())
                            })
                            .unwrap();
                        break (i + 4, length);
                    }
                };
                while request.len() < end + length {
                    let n = stream.read(&mut buffer).unwrap();
                    request.extend_from_slice(&buffer[..n]);
                }
                tx.send(request[end..end + length].to_vec()).unwrap();
                let body = if status == 202 {
                    let accepted = serde_json::from_slice::<Value>(&request[end..end + length])
                        .unwrap()["events"]
                        .as_array()
                        .unwrap()
                        .len();
                    format!(r#"{{"accepted":{accepted},"dropped":0}}"#)
                } else {
                    "{}".to_owned()
                };
                write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        (format!("http://{address}"), rx)
    }

    fn text(value: &Value, name: &str) -> Option<String> {
        value.get(name).and_then(Value::as_str).map(str::to_owned)
    }

    #[tokio::test]
    async fn recorder_executes_mcp_conformance_vectors() {
        let document: Value =
            serde_json::from_str(include_str!("../../../protocol/v1/conformance.json")).unwrap();
        for vector in document["mcpCompletion"]["vectors"].as_array().unwrap() {
            let expected = &vector["expectedEvent"];
            let count = usize::from(!expected.is_null());
            let (endpoint, bodies) = server(vec![202; count]);
            let mut options = Options::new(KEY).endpoint(endpoint);
            options.flush_interval = Duration::from_secs(3600);
            let recorder = AgentFeedbackRecorder::new(options).unwrap();
            let input = &vector["input"];
            let outcome = McpOutcome::try_from(input["outcome"].as_str().unwrap());
            if outcome == Err(McpCompletionError::InvalidOutcome) {
                assert_eq!(vector["name"], "invalid_outcome");
                continue;
            }
            let outcome = outcome.unwrap();
            let mut completion = McpCompletion::new(input["operation"].as_str().unwrap(), outcome)
                .identity(CustomerIdentity {
                    account_ref: text(input, "accountRef"),
                    user_ref: text(input, "userRef"),
                    anonymous_ref: text(input, "anonymousRef"),
                    customer_ref: text(input, "customerRef"),
                });
            if let Some(v) = text(input, "sessionRef") {
                completion = completion.session_ref(v);
            }
            if let Some(v) = text(input, "runtimeHint") {
                completion = completion.runtime_hint(v);
            }
            let result = recorder.record_mcp_completion(completion);
            if expected.is_null() {
                assert_eq!(
                    result,
                    Err(McpCompletionError::InvalidOperation),
                    "{}",
                    vector["name"]
                );
            } else {
                result.unwrap();
                recorder.shutdown().await.unwrap();
                let body: Value =
                    serde_json::from_slice(&bodies.recv_timeout(Duration::from_secs(1)).unwrap())
                        .unwrap();
                let mut event = body["events"][0].clone();
                let object = event.as_object_mut().unwrap();
                let id = object
                    .remove("interactionId")
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned();
                assert!(Uuid::parse_str(&id).unwrap().get_version_num() == 4);
                assert!(object.remove("sequence").unwrap().as_u64().unwrap() > 0);
                assert!(
                    object
                        .remove("occurredAt")
                        .unwrap()
                        .as_str()
                        .unwrap()
                        .ends_with('Z')
                );
                assert!(object.get("durationMs").is_none());
                assert_eq!(&event, expected, "{}", vector["name"]);
            }
        }
    }

    #[tokio::test]
    async fn recorder_executes_shared_linked_journey_fixture() {
        let document: Value =
            serde_json::from_str(include_str!("../../../protocol/v1/conformance.json")).unwrap();
        let fixture = &document["mcpLinkedJourney"];
        let identity = &fixture["identity"];
        let (endpoint, bodies) = server(vec![202]);
        let mut options = Options::new(KEY).endpoint(endpoint);
        options.flush_interval = Duration::from_secs(3600);
        let recorder = AgentFeedbackRecorder::new(options).unwrap();
        let mut expected = Vec::new();
        for run in fixture["runs"].as_array().unwrap() {
            for item in run["completions"].as_array().unwrap() {
                recorder
                    .record_mcp_completion(
                        McpCompletion::new(
                            item["operation"].as_str().unwrap(),
                            McpOutcome::try_from(item["outcome"].as_str().unwrap()).unwrap(),
                        )
                        .identity(CustomerIdentity {
                            account_ref: text(identity, "accountRef"),
                            user_ref: text(identity, "userRef"),
                            anonymous_ref: text(identity, "anonymousRef"),
                            customer_ref: None,
                        })
                        .session_ref(run["sessionRef"].as_str().unwrap())
                        .runtime_hint(fixture["runtimeHint"].as_str().unwrap()),
                    )
                    .unwrap();
                expected.push((
                    item["operation"].as_str().unwrap(),
                    item["outcome"].as_str().unwrap(),
                    run["sessionRef"].as_str(),
                ));
            }
        }
        for item in fixture["unlinked"].as_array().unwrap() {
            // Candidate proof is product input only; unresolved values are omitted.
            recorder
                .record_mcp_completion(
                    McpCompletion::new(
                        item["operation"].as_str().unwrap(),
                        McpOutcome::try_from(item["outcome"].as_str().unwrap()).unwrap(),
                    )
                    .identity(CustomerIdentity {
                        account_ref: text(identity, "accountRef"),
                        user_ref: text(identity, "userRef"),
                        anonymous_ref: text(identity, "anonymousRef"),
                        customer_ref: None,
                    })
                    .runtime_hint(fixture["runtimeHint"].as_str().unwrap()),
                )
                .unwrap();
            expected.push((
                item["operation"].as_str().unwrap(),
                item["outcome"].as_str().unwrap(),
                None,
            ));
        }
        recorder.shutdown().await.unwrap();
        let raw = bodies.recv_timeout(Duration::from_secs(1)).unwrap();
        let body: Value = serde_json::from_slice(&raw).unwrap();
        let events = body["events"].as_array().unwrap();
        assert_eq!(events.len(), expected.len());
        let mut ids = std::collections::HashSet::new();
        for (index, (event, (operation, outcome, session_ref))) in
            events.iter().zip(expected).enumerate()
        {
            assert_eq!(event["surface"], "mcp");
            assert_eq!(event["classification"], "confirmed");
            assert_eq!(event["confirmationMethod"], "mcp");
            assert_eq!(event["operation"], operation);
            assert_eq!(
                event["statusCode"],
                if outcome == "success" { 200 } else { 500 }
            );
            assert_eq!(event.get("sessionRef").and_then(Value::as_str), session_ref);
            assert_eq!(
                event.get("sessionSource").and_then(Value::as_str),
                session_ref.map(|_| "mcp")
            );
            if session_ref.is_none() {
                assert!(!event.as_object().unwrap().contains_key("sessionRef"));
                assert!(!event.as_object().unwrap().contains_key("sessionSource"));
            }
            assert_eq!(event["accountRef"], identity["accountRef"]);
            assert_eq!(event["userRef"], identity["userRef"]);
            assert_eq!(event["anonymousRef"], identity["anonymousRef"]);
            assert_eq!(event["runtimeHint"], fixture["runtimeHint"]);
            assert_eq!(event["runtimeHintSource"], "mcp");
            let id = event["interactionId"].as_str().unwrap();
            assert_eq!(Uuid::parse_str(id).unwrap().get_version_num(), 4);
            assert!(ids.insert(id));
            assert_eq!(event["sequence"], index + 1);
        }
        assert!(
            !String::from_utf8(raw)
                .unwrap()
                .contains(fixture["privateContentSentinel"].as_str().unwrap())
        );
    }

    #[tokio::test]
    async fn retry_reuses_the_exact_serialized_body() {
        let (endpoint, bodies) = server(vec![503, 202]);
        let mut options = Options::new(KEY).endpoint(endpoint);
        options.flush_interval = Duration::from_secs(3600);
        options.max_telemetry_attempts = 2;
        let recorder = AgentFeedbackRecorder::new(options).unwrap();
        recorder
            .record_mcp_completion(McpCompletion::new("create_item", McpOutcome::Success))
            .unwrap();
        recorder.shutdown().await.unwrap();
        let first = bodies.recv_timeout(Duration::from_secs(1)).unwrap();
        let second = bodies.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(first, second);
    }
}
