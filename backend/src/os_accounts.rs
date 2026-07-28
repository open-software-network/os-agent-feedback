use std::env;

use axum::http::HeaderMap;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{
    error::ApiError,
    security::{cookie, random_token, sha256},
};

pub const ACCESS_COOKIE: &str = "af_oa_access";
pub const REFRESH_COOKIE: &str = "af_oa_refresh";
pub const PKCE_COOKIE: &str = "af_oa_pkce";
pub const STATE_COOKIE: &str = "af_oa_state";
const TOKEN_EXPIRED: i64 = 3001;

#[derive(Clone)]
pub struct OsAccountsClient {
    portal_url: Url,
    api_url: Url,
    client_id: String,
    redirect_uri: String,
    http: Client,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TokenPair {
    pub access_token: String,
    pub refresh_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OsUser {
    pub id: String,
    pub handle: String,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

pub struct ResolvedSession {
    pub user: OsUser,
    pub rotated_tokens: Option<TokenPair>,
}

#[derive(Deserialize)]
struct Envelope<T> {
    data: Option<T>,
    success: bool,
    error_code: Option<i64>,
    message: Option<String>,
}

impl OsAccountsClient {
    pub fn from_env(public_base_url: &str) -> anyhow::Result<Self> {
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
        })
    }

    pub fn new_flow(&self) -> anyhow::Result<(String, String, Url)> {
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

    pub async fn exchange_code(&self, code: &str, verifier: &str) -> Result<TokenPair, ApiError> {
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

    pub async fn resolve(&self, headers: &HeaderMap) -> Result<ResolvedSession, ApiError> {
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
        let tokens: TokenPair = self
            .post_envelope(
                "/auth/refresh",
                serde_json::json!({ "refresh_token": refresh }),
            )
            .await?;
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

    pub async fn profile(&self, access_token: &str) -> Result<OsUser, ApiError> {
        let envelope = self.get_me(access_token).await?;
        if !envelope.success {
            return Err(ApiError::unauthorized());
        }
        let user = envelope.data.ok_or_else(ApiError::unauthorized)?;
        validate_user(&user)?;
        Ok(user)
    }

    pub async fn logout(&self, refresh_token: Option<&str>) {
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
}
