#![allow(
    clippy::redundant_pub_crate,
    reason = "crate-restricted visibility satisfies unreachable_pub in this binary-only crate"
)]

use std::{
    collections::{HashMap, VecDeque},
    env,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use axum::http::{HeaderMap, StatusCode};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio::sync::{Mutex, OnceCell};

use crate::{
    error::ApiError,
    security::{cookie, random_token, sha256},
};

pub(crate) const ACCESS_COOKIE: &str = "af_oa_access";
pub(crate) const REFRESH_COOKIE: &str = "af_oa_refresh";
pub(crate) const PKCE_COOKIE: &str = "af_oa_pkce";
pub(crate) const STATE_COOKIE: &str = "af_oa_state";
const TOKEN_EXPIRED: i64 = 3001;
const REFRESH_RESULT_TTL: Duration = Duration::from_mins(1);
const MAX_REFRESH_RESULTS: usize = 512;

#[derive(Clone)]
pub(crate) struct OsAccountsClient {
    portal_url: Url,
    api_url: Url,
    client_id: String,
    redirect_uri: String,
    http: Client,
    refreshes: Arc<Mutex<RefreshCoordinator>>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct TokenPair {
    pub access_token: String,
    pub refresh_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct OsUser {
    pub id: String,
    pub handle: String,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

pub(crate) struct ResolvedSession {
    pub user: OsUser,
    pub rotated_tokens: Option<TokenPair>,
}

#[derive(Default)]
struct RefreshCoordinator {
    entries: HashMap<Vec<u8>, Arc<RefreshFlight>>,
    order: VecDeque<Vec<u8>>,
}

struct RefreshFlight {
    started_at: Instant,
    result: OnceCell<RefreshOutcome>,
    cleanup_scheduled: AtomicBool,
}

#[derive(Clone)]
enum RefreshOutcome {
    Success(TokenPair),
    Unauthorized,
    Unavailable,
}

#[derive(Deserialize)]
struct Envelope<T> {
    data: Option<T>,
    success: bool,
    error_code: Option<i64>,
    message: Option<String>,
}

impl OsAccountsClient {
    pub(crate) fn from_env(public_base_url: &str) -> anyhow::Result<Self> {
        let portal_url = Url::parse(&required_env("OS_ACCOUNTS_URL")?)?;
        let api_url = Url::parse(&required_env("OS_ACCOUNTS_API_URL")?)?;
        let client_id = required_env("OS_ACCOUNTS_CLIENT_ID")?;
        if !client_id.starts_with("ocl_") {
            anyhow::bail!("OS_ACCOUNTS_CLIENT_ID must be an ocl_ client id");
        }
        let redirect_uri = format!("{}/auth/callback", public_base_url.trim_end_matches('/'));
        let http = Client::builder()
            .user_agent("agent-feedback/1.0")
            .timeout(std::time::Duration::from_secs(20))
            .build()?;
        Ok(Self {
            portal_url,
            api_url,
            client_id,
            redirect_uri,
            http,
            refreshes: Arc::new(Mutex::new(RefreshCoordinator::default())),
        })
    }

    pub(crate) fn new_flow(&self) -> anyhow::Result<(String, String, Url)> {
        let verifier = random_token("");
        let state = random_token("");
        let challenge = URL_SAFE_NO_PAD.encode(sha256(&verifier));
        let mut login = self.portal_url.join("/login")?;
        login
            .query_pairs_mut()
            .append_pair("client_id", &self.client_id)
            .append_pair("redirect_uri", &self.redirect_uri)
            .append_pair("scope", "profile:read")
            .append_pair("state", &state)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256");
        Ok((verifier, state, login))
    }

    pub(crate) async fn exchange_code(
        &self,
        code: &str,
        verifier: &str,
    ) -> Result<TokenPair, ApiError> {
        self.post_envelope(
            "/auth/token",
            serde_json::json!({
                "grant_type": "authorization_code",
                "code": code,
                "code_verifier": verifier,
                "redirect_uri": self.redirect_uri,
            }),
        )
        .await
    }

    pub(crate) async fn resolve(&self, headers: &HeaderMap) -> Result<ResolvedSession, ApiError> {
        let access = cookie(headers, ACCESS_COOKIE);
        let refresh = cookie(headers, REFRESH_COOKIE);
        if let Some(access) = access {
            let envelope = self.get_me(&access).await?;
            if envelope.success {
                let user = envelope.data.ok_or_else(ApiError::unauthorized)?;
                validate_user(&user)?;
                return Ok(ResolvedSession {
                    user,
                    rotated_tokens: None,
                });
            }
            if envelope.error_code != Some(TOKEN_EXPIRED) {
                return Err(ApiError::unauthorized());
            }
        }

        let refresh = refresh.ok_or_else(ApiError::unauthorized)?;
        let tokens = self.refresh_tokens(&refresh).await?;
        let envelope = self.get_me(&tokens.access_token).await?;
        if !envelope.success {
            return Err(ApiError::unauthorized());
        }
        let user = envelope.data.ok_or_else(ApiError::unauthorized)?;
        validate_user(&user)?;
        Ok(ResolvedSession {
            user,
            rotated_tokens: Some(tokens),
        })
    }

    pub(crate) async fn profile(&self, access_token: &str) -> Result<OsUser, ApiError> {
        let envelope = self.get_me(access_token).await?;
        if !envelope.success {
            return Err(ApiError::unauthorized());
        }
        let user = envelope.data.ok_or_else(ApiError::unauthorized)?;
        validate_user(&user)?;
        Ok(user)
    }

    pub(crate) async fn logout(&self, refresh_token: Option<&str>) {
        let Some(refresh_token) = refresh_token else {
            return;
        };
        let Ok(url) = self.api_url.join("/auth/logout") else {
            return;
        };
        let _ = self
            .http
            .post(url)
            .json(&serde_json::json!({ "refresh_token": refresh_token }))
            .send()
            .await;
    }

    async fn get_me(&self, access_token: &str) -> Result<Envelope<OsUser>, ApiError> {
        let url = self.api_url.join("/me").map_err(ApiError::internal)?;
        self.http
            .get(url)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(ApiError::internal)?
            .json::<Envelope<OsUser>>()
            .await
            .map_err(ApiError::internal)
    }

    async fn refresh_tokens(&self, refresh_token: &str) -> Result<TokenPair, ApiError> {
        let key = sha256(refresh_token);
        let flight = {
            let now = Instant::now();
            let mut coordinator = self.refreshes.lock().await;
            coordinator.prune(now);
            if let Some(existing) = coordinator.entries.get(&key) {
                Arc::clone(existing)
            } else {
                coordinator.make_room();
                if coordinator.entries.len() >= MAX_REFRESH_RESULTS {
                    return Err(ApiError::internal(
                        "OS Accounts refresh coordination is at capacity",
                    ));
                }
                let flight = Arc::new(RefreshFlight {
                    started_at: now,
                    result: OnceCell::new(),
                    cleanup_scheduled: AtomicBool::new(false),
                });
                coordinator.order.push_back(key.clone());
                coordinator.entries.insert(key.clone(), Arc::clone(&flight));
                flight
            }
        };

        let outcome = flight
            .result
            .get_or_init(|| async {
                match self
                    .post_envelope(
                        "/auth/refresh",
                        serde_json::json!({ "refresh_token": refresh_token }),
                    )
                    .await
                {
                    Ok(tokens) => RefreshOutcome::Success(tokens),
                    Err(error) if error.status == StatusCode::UNAUTHORIZED => {
                        RefreshOutcome::Unauthorized
                    }
                    Err(_) => RefreshOutcome::Unavailable,
                }
            })
            .await;
        if !flight.cleanup_scheduled.swap(true, Ordering::SeqCst) {
            let refreshes = Arc::clone(&self.refreshes);
            let cleanup_key = key;
            let cleanup_flight = Arc::clone(&flight);
            tokio::spawn(async move {
                tokio::time::sleep(REFRESH_RESULT_TTL).await;
                let mut coordinator = refreshes.lock().await;
                if coordinator
                    .entries
                    .get(&cleanup_key)
                    .is_some_and(|current| Arc::ptr_eq(current, &cleanup_flight))
                {
                    coordinator.entries.remove(&cleanup_key);
                    coordinator
                        .order
                        .retain(|candidate| candidate != &cleanup_key);
                }
            });
        }
        match outcome {
            RefreshOutcome::Success(tokens) => Ok(tokens.clone()),
            RefreshOutcome::Unauthorized => Err(ApiError::unauthorized()),
            RefreshOutcome::Unavailable => {
                Err(ApiError::internal("OS Accounts refresh is unavailable"))
            }
        }
    }

    async fn post_envelope<T: DeserializeOwned>(
        &self,
        path: &str,
        body: serde_json::Value,
    ) -> Result<T, ApiError> {
        let url = self.api_url.join(path).map_err(ApiError::internal)?;
        let envelope = self
            .http
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(ApiError::internal)?
            .json::<Envelope<T>>()
            .await
            .map_err(ApiError::internal)?;
        if envelope.success {
            envelope
                .data
                .ok_or_else(|| ApiError::internal("OS Accounts returned no data"))
        } else {
            tracing::warn!(
                path,
                error_code = envelope.error_code,
                message = envelope.message,
                "OS Accounts request rejected"
            );
            Err(ApiError::unauthorized())
        }
    }
}

impl RefreshCoordinator {
    fn prune(&mut self, now: Instant) {
        self.entries.retain(|_, flight| {
            flight.result.get().is_none()
                || now.saturating_duration_since(flight.started_at) <= REFRESH_RESULT_TTL
        });
        self.order.retain(|key| self.entries.contains_key(key));
    }

    fn make_room(&mut self) {
        while self.entries.len() >= MAX_REFRESH_RESULTS {
            let Some(key) = self
                .order
                .iter()
                .find(|key| {
                    self.entries
                        .get(*key)
                        .is_some_and(|flight| flight.result.get().is_some())
                })
                .cloned()
            else {
                break;
            };
            self.entries.remove(&key);
            self.order.retain(|candidate| candidate != &key);
        }
    }
}

fn validate_user(user: &OsUser) -> Result<(), ApiError> {
    if user.id.starts_with("usr_") {
        Ok(())
    } else {
        Err(ApiError::unauthorized())
    }
}

fn required_env(key: &str) -> anyhow::Result<String> {
    let value = env::var(key).unwrap_or_default().trim().to_string();
    if value.is_empty() {
        anyhow::bail!("{key} is required")
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::expect_used,
        reason = "test failures should abort at the assertion site"
    )]

    use std::sync::atomic::AtomicUsize;

    use axum::{
        Json, Router,
        extract::State,
        http::{HeaderValue, header},
        routing::{get, post},
    };
    use serde_json::{Value, json};

    use super::*;

    #[test]
    fn os_user_shape_is_required() {
        let valid = OsUser {
            id: "usr_test".into(),
            handle: "test".into(),
            email: None,
            display_name: None,
            avatar_url: None,
        };
        let invalid = OsUser {
            id: "local_test".into(),
            handle: "test".into(),
            email: None,
            display_name: None,
            avatar_url: None,
        };
        assert!(validate_user(&valid).is_ok());
        assert!(validate_user(&invalid).is_err());
    }

    #[derive(Clone)]
    struct MockAccountsState {
        refresh_calls: Arc<AtomicUsize>,
    }

    async fn mock_profile(headers: HeaderMap) -> Json<Value> {
        let authorization = headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok());
        if authorization == Some("Bearer rotated_access") {
            return Json(json!({
                "success": true,
                "data": {
                    "id": "usr_concurrent",
                    "handle": "concurrent",
                    "email": null,
                    "display_name": "Concurrent User",
                    "avatar_url": null
                }
            }));
        }
        Json(json!({
            "success": false,
            "error_code": TOKEN_EXPIRED,
            "message": "expired"
        }))
    }

    async fn mock_refresh(
        State(state): State<MockAccountsState>,
        Json(body): Json<Value>,
    ) -> Json<Value> {
        assert_eq!(
            body.get("refresh_token").and_then(Value::as_str),
            Some("rotating_refresh")
        );
        let attempt = state.refresh_calls.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(40)).await;
        if attempt == 0 {
            Json(json!({
                "success": true,
                "data": {
                    "access_token": "rotated_access",
                    "refresh_token": "rotated_refresh"
                }
            }))
        } else {
            Json(json!({
                "success": false,
                "error_code": 3002,
                "message": "refresh token already rotated"
            }))
        }
    }

    #[tokio::test]
    async fn concurrent_refreshes_share_one_rotation_result() {
        let refresh_calls = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("mock Accounts listener should bind");
        let address = listener
            .local_addr()
            .expect("mock Accounts address should resolve");
        let app = Router::new()
            .route("/me", get(mock_profile))
            .route("/auth/refresh", post(mock_refresh))
            .with_state(MockAccountsState {
                refresh_calls: Arc::clone(&refresh_calls),
            });
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("mock Accounts server should run");
        });

        let api_url =
            Url::parse(&format!("http://{address}")).expect("mock Accounts URL should parse");
        let client = OsAccountsClient {
            portal_url: api_url.clone(),
            api_url,
            client_id: "ocl_test".into(),
            redirect_uri: "http://epode.test/auth/callback".into(),
            http: Client::builder()
                .timeout(Duration::from_secs(2))
                .build()
                .expect("test HTTP client should build"),
            refreshes: Arc::new(Mutex::new(RefreshCoordinator::default())),
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("af_oa_access=expired_access; af_oa_refresh=rotating_refresh"),
        );

        let (first, second, third) = tokio::join!(
            client.resolve(&headers),
            client.resolve(&headers),
            client.resolve(&headers),
        );
        for result in <[_; 3]>::from((first, second, third)) {
            let resolved = result.expect("every concurrent request should authenticate");
            let tokens = resolved
                .rotated_tokens
                .expect("every response should receive the same rotated cookies");
            assert_eq!(tokens.access_token, "rotated_access");
            assert_eq!(tokens.refresh_token, "rotated_refresh");
        }
        let trailing = client
            .resolve(&headers)
            .await
            .expect("an immediately trailing request with the old cookie should reuse the result");
        assert_eq!(
            trailing
                .rotated_tokens
                .expect("trailing request should receive rotated cookies")
                .refresh_token,
            "rotated_refresh"
        );
        assert_eq!(refresh_calls.load(Ordering::SeqCst), 1);
        server.abort();
    }
}
