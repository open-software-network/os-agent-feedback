use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use agent_feedback::rmcp::{RmcpContextResolver, RmcpProductContext, RmcpToolCompletionHandler};
use agent_feedback::{AgentFeedbackRecorder, CustomerIdentity, Options};
use rmcp::{
    ErrorData, ServiceExt,
    handler::server::wrapper::{Json, Parameters},
    model::{CallToolRequestParams, CallToolResponse},
    service::{RequestContext, RoleServer},
    tool, tool_router,
};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, schemars::JsonSchema)]
struct Follow {
    session: String,
}
#[derive(Serialize, schemars::JsonSchema)]
struct Created {
    session: String,
    message: String,
}

#[derive(Clone)]
struct Demo {
    sessions: Arc<Mutex<HashMap<String, String>>>,
    account: String,
}

#[tool_router(server_handler)]
impl Demo {
    #[tool(
        name = "create_summary",
        description = "Create a product-owned demo session"
    )]
    fn create_summary(&self) -> Json<Created> {
        let session = uuid::Uuid::new_v4().to_string();
        self.sessions
            .lock()
            .unwrap()
            .insert(session.clone(), self.account.clone());
        Json(Created {
            session,
            message: "created".into(),
        })
    }

    #[tool(
        name = "follow_summary",
        description = "Follow a product-owned demo session"
    )]
    fn follow_summary(&self, Parameters(Follow { session }): Parameters<Follow>) -> Json<Created> {
        let owned = self.sessions.lock().unwrap().get(&session) == Some(&self.account);
        Json(Created {
            session,
            message: if owned { "followed" } else { "not found" }.into(),
        })
    }
}

#[derive(Clone)]
struct DemoResolver {
    sessions: Arc<Mutex<HashMap<String, String>>>,
    account: String,
}

impl DemoResolver {
    fn owns(&self, session: &str) -> bool {
        session.len() <= 160 && self.sessions.lock().unwrap().get(session) == Some(&self.account)
    }
}

impl RmcpContextResolver for DemoResolver {
    type State = Option<String>;

    fn begin(
        &self,
        request: &CallToolRequestParams,
        _: &RequestContext<RoleServer>,
    ) -> (Self::State, RmcpProductContext) {
        let candidate = request
            .arguments
            .as_ref()
            .and_then(|value| value.get("session"))
            .and_then(|value| value.as_str())
            .filter(|session| self.owns(session))
            .map(str::to_owned);
        (
            candidate,
            RmcpProductContext {
                identity: CustomerIdentity {
                    account_ref: Some(self.account.clone()),
                    ..Default::default()
                },
                runtime_hint: Some("rust-rmcp 3.1.0".into()),
                session_ref: None,
            },
        )
    }

    fn complete(
        &self,
        candidate: Self::State,
        mut initial: RmcpProductContext,
        outcome: &Result<CallToolResponse, ErrorData>,
    ) -> RmcpProductContext {
        let result_candidate = match outcome {
            Ok(CallToolResponse::Complete(result)) => result
                .structured_content
                .as_ref()
                .and_then(|value| value.get("session"))
                .and_then(|value| value.as_str())
                .filter(|session| self.owns(session))
                .map(str::to_owned),
            _ => None,
        };
        let candidate = result_candidate.or(candidate);
        initial.session_ref = candidate.map(|session| format!("demo:{session}"));
        initial
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let account = std::env::var("DEMO_ACCOUNT_REF")?;
    let registry = Arc::new(Mutex::new(HashMap::new()));
    let server = Demo {
        sessions: registry.clone(),
        account: account.clone(),
    };
    let recorder = AgentFeedbackRecorder::new(Options::new(std::env::var("AGENT_FEEDBACK_KEY")?))?;
    let resolver = DemoResolver {
        sessions: registry,
        account,
    };
    let handler =
        RmcpToolCompletionHandler::new(server, recorder.clone()).product_context(resolver);
    let service = handler.serve(rmcp::transport::io::stdio()).await?;
    service.waiting().await?;
    recorder.shutdown().await?;
    Ok(())
}
