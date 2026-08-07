//! Completion telemetry for servers built with the official `rmcp` SDK.

#![allow(deprecated)]

use std::{borrow::Cow, future::Future, panic::AssertUnwindSafe, time::Instant};

use futures_util::FutureExt;

use rmcp::{
    ErrorData,
    handler::server::ServerHandler,
    model::*,
    service::{
        MaybeSendFuture, NotificationContext, RequestContext, RoleServer, SubscriptionContext,
    },
};

use crate::{AgentFeedbackRecorder, CustomerIdentity, McpCompletion, McpOutcome};

/// Bounded, product-owned values returned by a resolver.
#[derive(Clone, Debug, Default)]
pub struct RmcpProductContext {
    pub identity: CustomerIdentity,
    pub session_ref: Option<String>,
    pub runtime_hint: Option<String>,
}

pub trait RmcpContextResolver: Send + Sync + 'static {
    /// Bounded product-owned evidence retained across the tool call.
    ///
    /// This state must not contain request or context objects, raw arguments,
    /// prompts, results, or other product content.
    type State: Send;

    fn begin(
        &self,
        request: &CallToolRequestParams,
        context: &RequestContext<RoleServer>,
    ) -> (Self::State, RmcpProductContext);

    fn complete(
        &self,
        state: Self::State,
        initial: RmcpProductContext,
        outcome: &Result<CallToolResponse, ErrorData>,
    ) -> RmcpProductContext;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Unlinked;

impl RmcpContextResolver for Unlinked {
    type State = ();
    fn begin(
        &self,
        _: &CallToolRequestParams,
        _: &RequestContext<RoleServer>,
    ) -> ((), RmcpProductContext) {
        ((), RmcpProductContext::default())
    }
    fn complete(
        &self,
        _: (),
        initial: RmcpProductContext,
        _: &Result<CallToolResponse, ErrorData>,
    ) -> RmcpProductContext {
        initial
    }
}

/// A transparent [`ServerHandler`] wrapper which records completed tool calls.
pub struct RmcpToolCompletionHandler<H, R = Unlinked> {
    inner: H,
    recorder: AgentFeedbackRecorder,
    resolver: R,
}

impl<H> RmcpToolCompletionHandler<H, Unlinked> {
    pub fn new(inner: H, recorder: AgentFeedbackRecorder) -> Self {
        Self {
            inner,
            recorder,
            resolver: Unlinked,
        }
    }

    pub fn product_context<R: RmcpContextResolver>(
        self,
        resolver: R,
    ) -> RmcpToolCompletionHandler<H, R> {
        RmcpToolCompletionHandler {
            inner: self.inner,
            recorder: self.recorder,
            resolver,
        }
    }
}

impl<H, R> RmcpToolCompletionHandler<H, R> {
    pub fn inner(&self) -> &H {
        &self.inner
    }
    pub fn into_inner(self) -> H {
        self.inner
    }
}

fn context_to_completion(
    operation: String,
    outcome: McpOutcome,
    context: RmcpProductContext,
) -> McpCompletion {
    let mut completion = McpCompletion::new(operation, outcome).identity(context.identity);
    if let Some(value) = context.session_ref {
        completion = completion.session_ref(value);
    }
    if let Some(value) = context.runtime_hint {
        completion = completion.runtime_hint(value);
    }
    completion
}

impl<H: ServerHandler, R: RmcpContextResolver> ServerHandler for RmcpToolCompletionHandler<H, R> {
    fn ping(
        &self,
        c: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<(), ErrorData>> + MaybeSendFuture + '_ {
        self.inner.ping(c)
    }
    fn initialize(
        &self,
        r: InitializeRequestParams,
        c: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<InitializeResult, ErrorData>> + MaybeSendFuture + '_ {
        self.inner.initialize(r, c)
    }
    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        self.inner.supported_protocol_versions()
    }
    fn discover(
        &self,
        c: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<DiscoverResult, ErrorData>> + MaybeSendFuture + '_ {
        self.inner.discover(c)
    }
    fn complete(
        &self,
        r: CompleteRequestParams,
        c: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<CompleteResult, ErrorData>> + MaybeSendFuture + '_ {
        self.inner.complete(r, c)
    }
    fn set_level(
        &self,
        r: SetLevelRequestParams,
        c: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<(), ErrorData>> + MaybeSendFuture + '_ {
        self.inner.set_level(r, c)
    }
    fn get_prompt(
        &self,
        r: GetPromptRequestParams,
        c: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<GetPromptResponse, ErrorData>> + MaybeSendFuture + '_ {
        self.inner.get_prompt(r, c)
    }
    fn list_prompts(
        &self,
        r: Option<PaginatedRequestParams>,
        c: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<ListPromptsResult, ErrorData>> + MaybeSendFuture + '_ {
        self.inner.list_prompts(r, c)
    }
    fn list_resources(
        &self,
        r: Option<PaginatedRequestParams>,
        c: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<ListResourcesResult, ErrorData>> + MaybeSendFuture + '_ {
        self.inner.list_resources(r, c)
    }
    fn list_resource_templates(
        &self,
        r: Option<PaginatedRequestParams>,
        c: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<ListResourceTemplatesResult, ErrorData>> + MaybeSendFuture + '_
    {
        self.inner.list_resource_templates(r, c)
    }
    fn read_resource(
        &self,
        r: ReadResourceRequestParams,
        c: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<ReadResourceResponse, ErrorData>> + MaybeSendFuture + '_ {
        self.inner.read_resource(r, c)
    }
    fn accepted_subscription_filter(&self, r: &SubscriptionFilter) -> Option<SubscriptionFilter> {
        self.inner.accepted_subscription_filter(r)
    }
    fn listen(
        &self,
        c: SubscriptionContext,
    ) -> impl Future<Output = Result<(), ErrorData>> + MaybeSendFuture + '_ {
        self.inner.listen(c)
    }
    fn subscribe(
        &self,
        r: SubscribeRequestParams,
        c: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<(), ErrorData>> + MaybeSendFuture + '_ {
        self.inner.subscribe(r, c)
    }
    fn unsubscribe(
        &self,
        r: UnsubscribeRequestParams,
        c: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<(), ErrorData>> + MaybeSendFuture + '_ {
        self.inner.unsubscribe(r, c)
    }

    fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<CallToolResponse, ErrorData>> + MaybeSendFuture + '_ {
        let operation = request.name.to_string();
        let eligible = self.recorder.active() && AgentFeedbackRecorder::valid_operation(&operation);
        let begun = eligible.then(|| {
            std::panic::catch_unwind(AssertUnwindSafe(|| self.resolver.begin(&request, &context)))
        });
        let start = Instant::now();
        let inner = match std::panic::catch_unwind(AssertUnwindSafe(|| {
            self.inner.call_tool(request, context)
        })) {
            Ok(inner) => inner,
            Err(payload) => {
                let duration = start.elapsed();
                if eligible {
                    let initial = match begun {
                        Some(Ok((_, initial))) => initial,
                        _ => RmcpProductContext::default(),
                    };
                    let completion = context_to_completion(operation, McpOutcome::Error, initial);
                    if let Some(prepared) = self.recorder.prepare_mcp_completion() {
                        let _ = self.recorder.enqueue_mcp_completion(
                            prepared,
                            completion,
                            Some(duration),
                        );
                    }
                }
                std::panic::resume_unwind(payload)
            }
        };

        async move {
            let caught = AssertUnwindSafe(inner).catch_unwind().await;
            let duration = start.elapsed();
            let prepared = eligible
                .then(|| self.recorder.prepare_mcp_completion())
                .flatten();
            let response = match caught {
                Ok(response) => response,
                Err(payload) => {
                    if eligible {
                        let initial = match begun {
                            Some(Ok((_, initial))) => initial,
                            _ => RmcpProductContext::default(),
                        };
                        let completion =
                            context_to_completion(operation, McpOutcome::Error, initial);
                        if let Some(prepared) = prepared {
                            let _ = self.recorder.enqueue_mcp_completion(
                                prepared,
                                completion,
                                Some(duration),
                            );
                        }
                    }
                    std::panic::resume_unwind(payload)
                }
            };
            if !matches!(response, Ok(CallToolResponse::Complete(_))) || !self.recorder.active() {
                return response;
            }
            let Some(begin_result) = begun else {
                return response;
            };
            let resolved = match begin_result {
                Ok((state, initial)) => std::panic::catch_unwind(AssertUnwindSafe(|| {
                    self.resolver.complete(state, initial, &response)
                }))
                .ok(),
                Err(_) => None,
            }
            .unwrap_or_default();
            let outcome = match &response {
                Ok(CallToolResponse::Complete(result)) if result.is_error == Some(true) => {
                    McpOutcome::Error
                }
                _ => McpOutcome::Success,
            };
            let completion = context_to_completion(operation, outcome, resolved);
            if let Some(prepared) = prepared {
                let _ = self
                    .recorder
                    .enqueue_mcp_completion(prepared, completion, Some(duration));
            }
            response
        }
    }

    fn list_tools(
        &self,
        r: Option<PaginatedRequestParams>,
        c: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<ListToolsResult, ErrorData>> + MaybeSendFuture + '_ {
        self.inner.list_tools(r, c)
    }
    fn get_tool(&self, n: &str) -> Option<Tool> {
        self.inner.get_tool(n)
    }
    fn on_custom_request(
        &self,
        r: CustomRequest,
        c: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<CustomResult, ErrorData>> + MaybeSendFuture + '_ {
        self.inner.on_custom_request(r, c)
    }
    fn on_cancelled(
        &self,
        n: CancelledNotificationParam,
        c: NotificationContext<RoleServer>,
    ) -> impl Future<Output = ()> + MaybeSendFuture + '_ {
        self.inner.on_cancelled(n, c)
    }
    fn on_progress(
        &self,
        n: ProgressNotificationParam,
        c: NotificationContext<RoleServer>,
    ) -> impl Future<Output = ()> + MaybeSendFuture + '_ {
        self.inner.on_progress(n, c)
    }
    fn on_initialized(
        &self,
        c: NotificationContext<RoleServer>,
    ) -> impl Future<Output = ()> + MaybeSendFuture + '_ {
        self.inner.on_initialized(c)
    }
    fn on_roots_list_changed(
        &self,
        c: NotificationContext<RoleServer>,
    ) -> impl Future<Output = ()> + MaybeSendFuture + '_ {
        self.inner.on_roots_list_changed(c)
    }
    fn on_custom_notification(
        &self,
        n: CustomNotification,
        c: NotificationContext<RoleServer>,
    ) -> impl Future<Output = ()> + MaybeSendFuture + '_ {
        self.inner.on_custom_notification(n, c)
    }
    fn get_info(&self) -> ServerInfo {
        self.inner.get_info()
    }
    fn get_task(
        &self,
        r: GetTaskParams,
        c: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<GetTaskResult, ErrorData>> + MaybeSendFuture + '_ {
        self.inner.get_task(r, c)
    }
    fn update_task(
        &self,
        r: UpdateTaskParams,
        c: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<(), ErrorData>> + MaybeSendFuture + '_ {
        self.inner.update_task(r, c)
    }
    fn cancel_task(
        &self,
        r: CancelTaskParams,
        c: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<(), ErrorData>> + MaybeSendFuture + '_ {
        self.inner.cancel_task(r, c)
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        io::{Read, Write},
        net::TcpListener,
        sync::{Arc, Mutex, mpsc},
        thread,
        time::Duration,
    };

    use rmcp::{
        ServiceExt,
        handler::server::{router::tool::ToolRouter, wrapper::Parameters},
        tool, tool_handler, tool_router,
    };
    use serde::Deserialize;
    use serde_json::{Value, json};
    use uuid::Uuid;

    use super::*;
    use crate::Options;

    const KEY: &str = "af_live_0123456789abcdef0123456789abcdef_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
    const ARG_SENTINEL: &str = "RAW_ARGUMENT_SENTINEL";
    const RESULT_SENTINEL: &str = "RAW_RESULT_SENTINEL";
    const ERROR_SENTINEL: &str = "RAW_ERROR_SENTINEL";
    static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn telemetry_server() -> (String, mpsc::Receiver<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            let (end, length) = loop {
                let n = stream.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..n]);
                if let Some(i) = request.windows(4).position(|v| v == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..i]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    break (i + 4, length);
                }
            };
            while request.len() < end + length {
                let n = stream.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..n]);
            }
            let payload = request[end..end + length].to_vec();
            let accepted = serde_json::from_slice::<Value>(&payload).unwrap()["events"]
                .as_array()
                .unwrap()
                .len();
            tx.send(payload).unwrap();
            let body = format!(r#"{{"accepted":{accepted},"dropped":0}}"#);
            write!(stream, "HTTP/1.1 202 Accepted\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        });
        (format!("http://{address}"), rx)
    }

    fn recorder(endpoint: String) -> AgentFeedbackRecorder {
        let mut options = Options::new(KEY).endpoint(endpoint);
        options.flush_interval = Duration::from_secs(3600);
        AgentFeedbackRecorder::new(options).unwrap()
    }

    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    struct SummaryArgs {
        proof: String,
        secret: String,
    }

    #[derive(Clone)]
    struct SummaryServer {
        #[expect(dead_code, reason = "tool_handler macro accesses the generated router")]
        tool_router: ToolRouter<Self>,
    }

    impl SummaryServer {
        fn new() -> Self {
            Self {
                tool_router: Self::tool_router(),
            }
        }
    }

    #[tool_router]
    impl SummaryServer {
        #[tool]
        async fn create_summary(&self, Parameters(args): Parameters<SummaryArgs>) -> String {
            format!("created:{}:{}:{RESULT_SENTINEL}", args.proof, args.secret)
        }
        #[tool]
        async fn follow_summary(&self, Parameters(args): Parameters<SummaryArgs>) -> String {
            format!("followed:{}:{}:{RESULT_SENTINEL}", args.proof, args.secret)
        }
    }

    #[tool_handler]
    impl ServerHandler for SummaryServer {
        fn get_info(&self) -> ServerInfo {
            ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
        }
    }

    #[derive(Clone)]
    struct RegistryResolver {
        registry: Arc<HashMap<String, (&'static str, &'static str)>>,
    }
    impl RmcpContextResolver for RegistryResolver {
        type State = Option<(&'static str, &'static str)>;
        fn begin(
            &self,
            request: &CallToolRequestParams,
            _: &RequestContext<RoleServer>,
        ) -> (Self::State, RmcpProductContext) {
            let proof = request
                .arguments
                .as_ref()
                .and_then(|a| a.get("proof"))
                .and_then(Value::as_str);
            (
                proof.and_then(|p| self.registry.get(p).copied()),
                RmcpProductContext::default(),
            )
        }
        fn complete(
            &self,
            state: Self::State,
            _: RmcpProductContext,
            _: &Result<CallToolResponse, ErrorData>,
        ) -> RmcpProductContext {
            state.map_or_else(RmcpProductContext::default, |(account, session)| {
                RmcpProductContext {
                    identity: CustomerIdentity {
                        account_ref: Some(account.into()),
                        ..Default::default()
                    },
                    session_ref: Some(session.into()),
                    runtime_hint: None,
                }
            })
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rmcp_duplex_macro_tools_partition_trusted_context_and_preserve_privacy() {
        let _guard = TEST_LOCK.lock().await;
        let (endpoint, bodies) = telemetry_server();
        let recorder = recorder(endpoint);
        let registry = Arc::new(HashMap::from([
            ("proof-a".into(), ("account-a", "session-a")),
            ("proof-b".into(), ("account-b", "session-b")),
        ]));
        let wrapped = RmcpToolCompletionHandler::new(SummaryServer::new(), recorder.clone())
            .product_context(RegistryResolver { registry });
        let (server_io, client_io) = tokio::io::duplex(16 * 1024);
        let server = tokio::spawn(async move {
            wrapped
                .serve(server_io)
                .await
                .unwrap()
                .waiting()
                .await
                .unwrap()
        });
        let client = ().serve(client_io).await.unwrap();
        for (name, proof) in [
            ("create_summary", "proof-a"),
            ("follow_summary", "proof-a"),
            ("create_summary", "proof-b"),
            ("follow_summary", "proof-b"),
            ("follow_summary", "unknown-proof"),
        ] {
            let request = CallToolRequestParams::new(name).with_arguments(
                json!({"proof":proof,"secret":ARG_SENTINEL})
                    .as_object()
                    .unwrap()
                    .clone(),
            );
            let response = client.call_tool_once(request).await.unwrap();
            let CallToolResponse::Complete(result) = response else {
                panic!("unexpected response")
            };
            assert_eq!(result.is_error, Some(false));
            assert!(
                serde_json::to_string(&result)
                    .unwrap()
                    .contains(RESULT_SENTINEL)
            );
        }
        client.cancel().await.unwrap();
        server.await.unwrap();
        recorder.shutdown().await.unwrap();
        let body = bodies.recv_timeout(Duration::from_secs(1)).unwrap();
        let serialized = String::from_utf8(body.clone()).unwrap();
        for forbidden in [
            ARG_SENTINEL,
            RESULT_SENTINEL,
            ERROR_SENTINEL,
            "unknown-proof",
        ] {
            assert!(!serialized.contains(forbidden), "leaked {forbidden}");
        }
        let value: Value = serde_json::from_slice(&body).unwrap();
        let events = value["events"].as_array().unwrap();
        assert_eq!(events.len(), 5);
        assert_eq!(
            events
                .iter()
                .filter(|e| e["accountRef"] == "account-a" && e["sessionRef"] == "session-a")
                .count(),
            2
        );
        assert_eq!(
            events
                .iter()
                .filter(|e| e["accountRef"] == "account-b" && e["sessionRef"] == "session-b")
                .count(),
            2
        );
        assert!(events[4].get("accountRef").is_none());
        let sequences: Vec<_> = events
            .iter()
            .map(|e| e["sequence"].as_u64().unwrap())
            .collect();
        assert!(sequences.windows(2).all(|w| w[0] < w[1]));
        let ids: std::collections::HashSet<_> = events
            .iter()
            .map(|e| e["interactionId"].as_str().unwrap())
            .collect();
        assert_eq!(ids.len(), 5);
        assert!(
            ids.iter()
                .all(|id| Uuid::parse_str(id).unwrap().get_version_num() == 4)
        );
        assert!(events.iter().all(|e| e["durationMs"].is_number()));
        assert_eq!(events.iter().filter(|e| e["statusCode"] == 200).count(), 5);
    }

    #[derive(Clone)]
    struct MatrixServer {
        responses: Arc<Mutex<Vec<Result<CallToolResponse, ErrorData>>>>,
    }
    impl ServerHandler for MatrixServer {
        async fn call_tool(
            &self,
            _: CallToolRequestParams,
            _: RequestContext<RoleServer>,
        ) -> Result<CallToolResponse, ErrorData> {
            self.responses.lock().unwrap().remove(0)
        }
        fn get_info(&self) -> ServerInfo {
            ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
        }
        fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
            Cow::Borrowed(&[ProtocolVersion::V_2026_07_28])
        }
    }

    #[derive(Clone)]
    struct StandardClient;
    impl rmcp::ClientHandler for StandardClient {
        fn get_info(&self) -> ClientInfo {
            let mut info = ClientInfo::default();
            info.protocol_version = ProtocolVersion::V_2026_07_28;
            info
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rmcp_adapter_classifies_complete_and_ignores_error_and_input_required() {
        let _guard = TEST_LOCK.lock().await;
        let (endpoint, bodies) = telemetry_server();
        let recorder = recorder(endpoint);
        let mut no_flag = CallToolResult::success(vec![]);
        no_flag.is_error = None;
        let responses = vec![
            Ok(no_flag.into()),
            Ok(CallToolResult::success(vec![]).into()),
            Ok(CallToolResult::error(vec![]).into()),
            Err(ErrorData::invalid_params(ERROR_SENTINEL, None)),
            Ok(InputRequiredResult::from_request_state("opaque-state").into()),
        ];
        let wrapped = RmcpToolCompletionHandler::new(
            MatrixServer {
                responses: Arc::new(Mutex::new(responses)),
            },
            recorder.clone(),
        );
        let (server_io, client_io) = tokio::io::duplex(8192);
        let server = tokio::spawn(async move {
            wrapped
                .serve(server_io)
                .await
                .unwrap()
                .waiting()
                .await
                .unwrap()
        });
        let client = StandardClient.serve(client_io).await.unwrap();
        for expected in [None, Some(false), Some(true)] {
            let CallToolResponse::Complete(result) = client
                .call_tool_once(CallToolRequestParams::new("matrix"))
                .await
                .unwrap()
            else {
                panic!()
            };
            assert_eq!(result.is_error, expected);
        }
        assert!(
            client
                .call_tool_once(CallToolRequestParams::new("matrix"))
                .await
                .is_err()
        );
        assert!(matches!(
            client
                .call_tool_once(CallToolRequestParams::new("matrix"))
                .await
                .unwrap(),
            CallToolResponse::InputRequired(_)
        ));
        client.cancel().await.unwrap();
        server.await.unwrap();
        recorder.shutdown().await.unwrap();
        let body = bodies.recv_timeout(Duration::from_secs(1)).unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        let events = value["events"].as_array().unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(
            events
                .iter()
                .map(|e| e["statusCode"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            [200, 200, 500]
        );
        assert!(!String::from_utf8(body).unwrap().contains(ERROR_SENTINEL));
    }

    #[derive(Clone)]
    struct ConstructorPanicServer;

    impl ServerHandler for ConstructorPanicServer {
        fn call_tool(
            &self,
            _: CallToolRequestParams,
            _: RequestContext<RoleServer>,
        ) -> impl Future<Output = Result<CallToolResponse, ErrorData>> + MaybeSendFuture + '_
        {
            if std::hint::black_box(true) {
                std::panic::panic_any("SYNC_HANDLER_PANIC_SENTINEL");
            }
            std::future::ready(Ok(CallToolResult::success(vec![]).into()))
        }

        fn get_info(&self) -> ServerInfo {
            ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rmcp_adapter_records_synchronous_handler_panic_without_leaking_payload() {
        let _guard = TEST_LOCK.lock().await;
        let (endpoint, bodies) = telemetry_server();
        let recorder = recorder(endpoint);
        let wrapped = RmcpToolCompletionHandler::new(ConstructorPanicServer, recorder.clone());
        let (server_io, client_io) = tokio::io::duplex(8192);
        let server =
            tokio::spawn(async move { wrapped.serve(server_io).await.unwrap().waiting().await });
        let client = ().serve(client_io).await.unwrap();
        let call = tokio::time::timeout(
            Duration::from_millis(250),
            client.call_tool_once(CallToolRequestParams::new("panic_tool")),
        )
        .await;
        assert!(call.is_err() || call.is_ok_and(|result| result.is_err()));
        drop(client);
        server.abort();
        let _ = server.await;

        recorder.shutdown().await.unwrap();
        let body = bodies.recv_timeout(Duration::from_secs(1)).unwrap();
        let serialized = String::from_utf8(body.clone()).unwrap();
        assert!(!serialized.contains("SYNC_HANDLER_PANIC_SENTINEL"));
        let value: Value = serde_json::from_slice(&body).unwrap();
        let events = value["events"].as_array().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["operation"], "panic_tool");
        assert_eq!(events[0]["statusCode"], 500);
    }
}
