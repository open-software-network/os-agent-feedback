#![allow(
    clippy::redundant_pub_crate,
    reason = "crate-restricted visibility satisfies unreachable_pub in this binary-only crate"
)]

use std::{env, fmt, net::IpAddr, str::FromStr};

use axum::{
    Form, Router,
    extract::{Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{Html, IntoResponse, Redirect, Response},
    routing::{get, post},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    AppState, append_cookie,
    error::ApiError,
    os_accounts::{ACCESS_COOKIE, OsUser, PKCE_COOKIE, REFRESH_COOKIE, STATE_COOKIE},
    security::{clear_cookie, cookie},
};

type HmacSha256 = Hmac<Sha256>;

pub(crate) const DEV_AUTH_COOKIE: &str = "af_dev_identity";
const COOKIE_LIFETIME_SECONDS: i64 = 8 * 60 * 60;
const MAX_TOKEN_LENGTH: usize = 1_024;

#[derive(Clone)]
pub(crate) struct DevAuthConfig {
    signing_key: [u8; 32],
    public_origin: String,
    public_authority: String,
    web_app_url: reqwest::Url,
    bind_ip: IpAddr,
}

impl fmt::Debug for DevAuthConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DevAuthConfig")
            .field("signing_key", &"[redacted]")
            .field("public_origin", &self.public_origin)
            .field("public_authority", &self.public_authority)
            .field("web_app_url", &self.web_app_url)
            .field("bind_ip", &self.bind_ip)
            .finish()
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DevIdentityClaims {
    v: u8,
    email: String,
    iat: i64,
    exp: i64,
}

#[derive(Deserialize)]
struct DevPageQuery {
    #[serde(rename = "returnTo")]
    return_to: Option<String>,
}

#[derive(Deserialize)]
struct DevLoginForm {
    email: String,
    #[serde(rename = "returnTo")]
    return_to: Option<String>,
}

impl DevAuthConfig {
    pub(crate) fn from_env(
        port: u16,
        public_base_url: &str,
        configured_web_app_url: Option<&str>,
    ) -> anyhow::Result<Option<Self>> {
        let enabled = match env::var("DEV_AUTH_ENABLED") {
            Err(env::VarError::NotPresent) => false,
            Ok(value) if value == "false" => false,
            Ok(value) if value == "true" => true,
            Ok(_) => anyhow::bail!("DEV_AUTH_ENABLED must be either true or false"),
            Err(env::VarError::NotUnicode(_)) => {
                anyhow::bail!("DEV_AUTH_ENABLED must be valid Unicode")
            }
        };
        if !enabled {
            return Ok(None);
        }
        anyhow::ensure!(
            env::var("APP_ENV").as_deref() == Ok("development"),
            "DEV_AUTH_ENABLED requires APP_ENV=development"
        );
        anyhow::ensure!(
            env::var("RAILWAY_ENVIRONMENT").is_err(),
            "DEV_AUTH_ENABLED is not allowed on Railway"
        );
        let encoded_key = env::var("DEV_AUTH_SIGNING_KEY")
            .map_err(|_| anyhow::anyhow!("DEV_AUTH_SIGNING_KEY is required"))?;
        let web_app_url = configured_web_app_url
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| anyhow::anyhow!("DEV_AUTH_ENABLED requires WEB_APP_URL"))?;
        Self::from_values(port, public_base_url, web_app_url, &encoded_key).map(Some)
    }

    fn from_values(
        port: u16,
        public_base_url: &str,
        web_app_url: &str,
        encoded_key: &str,
    ) -> anyhow::Result<Self> {
        let key = URL_SAFE_NO_PAD.decode(encoded_key).map_err(|_| {
            anyhow::anyhow!("DEV_AUTH_SIGNING_KEY must be base64url without padding")
        })?;
        let signing_key: [u8; 32] = key
            .try_into()
            .map_err(|_| anyhow::anyhow!("DEV_AUTH_SIGNING_KEY must decode to exactly 32 bytes"))?;
        let public_url = validate_local_url("PUBLIC_BASE_URL", public_base_url)?;
        anyhow::ensure!(
            public_url.port_or_known_default() == Some(port),
            "PUBLIC_BASE_URL port must match PORT"
        );
        let web_url = validate_local_url("WEB_APP_URL", web_app_url)?;
        anyhow::ensure!(
            public_url.host_str() == web_url.host_str(),
            "PUBLIC_BASE_URL and WEB_APP_URL must use the same hostname for local dev auth"
        );
        let host = public_url
            .host_str()
            .ok_or_else(|| anyhow::anyhow!("PUBLIC_BASE_URL must include a host"))?;
        let bind_ip = if host == "localhost" {
            IpAddr::from([127, 0, 0, 1])
        } else {
            IpAddr::from_str(host)?
        };
        let public_authority = authority(&public_url);
        Ok(Self {
            signing_key,
            public_origin: public_url.origin().ascii_serialization(),
            public_authority,
            web_app_url: web_url,
            bind_ip,
        })
    }

    pub(crate) const fn bind_ip(&self) -> IpAddr {
        self.bind_ip
    }

    pub(crate) fn resolve_identity(
        &self,
        headers: &HeaderMap,
        now: DateTime<Utc>,
    ) -> Option<OsUser> {
        if !self.has_local_authority(headers) {
            return None;
        }
        let token = cookie(headers, DEV_AUTH_COOKIE)?;
        self.verify_identity(&token, now).ok()
    }

    fn issue_cookie(&self, email: &str, now: DateTime<Utc>) -> Result<String, ApiError> {
        let claims = DevIdentityClaims {
            v: 1,
            email: email.to_owned(),
            iat: now.timestamp(),
            exp: (now + Duration::seconds(COOKIE_LIFETIME_SECONDS)).timestamp(),
        };
        let payload =
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).map_err(ApiError::internal)?);
        let signing_input = format!("v1.{payload}");
        let mut mac = HmacSha256::new_from_slice(&self.signing_key).map_err(ApiError::internal)?;
        mac.update(signing_input.as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        Ok(format!(
            "{DEV_AUTH_COOKIE}={signing_input}.{signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age={COOKIE_LIFETIME_SECONDS}"
        ))
    }

    fn verify_identity(&self, token: &str, now: DateTime<Utc>) -> Result<OsUser, ()> {
        if token.len() > MAX_TOKEN_LENGTH {
            return Err(());
        }
        let mut parts = token.split('.');
        let version = parts.next().ok_or(())?;
        let payload = parts.next().ok_or(())?;
        let signature = parts.next().ok_or(())?;
        if version != "v1" || parts.next().is_some() {
            return Err(());
        }
        let signature = URL_SAFE_NO_PAD.decode(signature).map_err(|_| ())?;
        let signing_input = format!("{version}.{payload}");
        let mut mac = HmacSha256::new_from_slice(&self.signing_key).map_err(|_| ())?;
        mac.update(signing_input.as_bytes());
        mac.verify_slice(&signature).map_err(|_| ())?;
        let claims: DevIdentityClaims =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).map_err(|_| ())?)
                .map_err(|_| ())?;
        let normalized = normalize_email(&claims.email).map_err(|_| ())?;
        if claims.v != 1
            || normalized != claims.email
            || claims.iat > (now + Duration::minutes(5)).timestamp()
            || claims.exp <= now.timestamp()
            || claims.exp <= claims.iat
            || claims.exp - claims.iat > COOKIE_LIFETIME_SECONDS
        {
            return Err(());
        }
        Ok(local_user(&normalized))
    }

    fn has_local_authority(&self, headers: &HeaderMap) -> bool {
        headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|host| host.eq_ignore_ascii_case(&self.public_authority))
    }

    fn require_local_authority(&self, headers: &HeaderMap) -> Result<(), ApiError> {
        if self.has_local_authority(headers) {
            Ok(())
        } else {
            Err(ApiError::not_found("Not found"))
        }
    }

    fn require_same_origin(&self, headers: &HeaderMap) -> Result<(), ApiError> {
        let matches = headers
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|origin| origin == self.public_origin);
        if matches {
            Ok(())
        } else {
            Err(ApiError::forbidden(
                "Local login requires a same-origin form submission",
            ))
        }
    }

    fn redirect_url(&self, return_to: &str) -> Result<String, ApiError> {
        self.web_app_url
            .join(return_to)
            .map(|url| url.to_string())
            .map_err(|_| ApiError::bad_request("Invalid returnTo path"))
    }

    fn page_content_security_policy(&self) -> Result<HeaderValue, ApiError> {
        HeaderValue::from_str(&format!(
            "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' {}",
            self.web_app_url.origin().ascii_serialization()
        ))
        .map_err(ApiError::internal)
    }
}

pub(crate) fn router() -> Router<std::sync::Arc<AppState>> {
    Router::new()
        .route("/__dev", get(dev_page))
        .route("/__dev/log-me-in", post(log_me_in))
}

pub(crate) fn clear_dev_cookie() -> String {
    format!("{DEV_AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0")
}

async fn dev_page(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<DevPageQuery>,
) -> Result<Response, ApiError> {
    let config = enabled_config(&state)?;
    config.require_local_authority(&headers)?;
    let return_to = validate_return_to(query.return_to.as_deref().unwrap_or("/"))?;
    let html = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Epode local developer login</title></head><body><main><h1>Epode local developer login</h1><p>This development-only route bypasses OS Accounts identity verification. Epode still reads workspace membership and roles from PostgreSQL.</p><form method=\"post\" action=\"/__dev/log-me-in\"><label>Email <input name=\"email\" type=\"email\" required maxlength=\"160\" autocomplete=\"email\"></label><input name=\"returnTo\" type=\"hidden\" value=\"{}\"><button type=\"submit\">Log me in</button></form><h2>Routes</h2><dl><dt><code>GET /__dev</code></dt><dd>Shows this local login page.</dd><dt><code>POST /__dev/log-me-in</code></dt><dd>Creates a signed local identity session.</dd><dt><code>POST /api/auth/logout</code></dt><dd>Clears the current session.</dd></dl></main></body></html>",
        escape_html_attribute(return_to)
    );
    let mut response = Html(html).into_response();
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        config.page_content_security_policy()?,
    );
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("same-origin"),
    );
    no_store(&mut response);
    Ok(response)
}

async fn log_me_in(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
    Form(form): Form<DevLoginForm>,
) -> Result<Response, ApiError> {
    let config = enabled_config(&state)?;
    config.require_local_authority(&headers)?;
    config.require_same_origin(&headers)?;
    let email = normalize_email(&form.email)?;
    let return_to = validate_return_to(form.return_to.as_deref().unwrap_or("/"))?;
    let redirect_url = config.redirect_url(return_to)?;
    let mut response = Redirect::to(&redirect_url).into_response();
    *response.status_mut() = StatusCode::SEE_OTHER;
    append_cookie(
        &mut response,
        &clear_cookie(ACCESS_COOKIE, state.secure_cookies),
    )?;
    append_cookie(
        &mut response,
        &clear_cookie(REFRESH_COOKIE, state.secure_cookies),
    )?;
    append_cookie(
        &mut response,
        &clear_cookie(PKCE_COOKIE, state.secure_cookies),
    )?;
    append_cookie(
        &mut response,
        &clear_cookie(STATE_COOKIE, state.secure_cookies),
    )?;
    append_cookie(&mut response, &config.issue_cookie(&email, Utc::now())?)?;
    no_store(&mut response);
    Ok(response)
}

fn enabled_config(state: &AppState) -> Result<&DevAuthConfig, ApiError> {
    state
        .dev_auth
        .as_ref()
        .ok_or_else(|| ApiError::not_found("Not found"))
}

fn validate_local_url(name: &str, value: &str) -> anyhow::Result<reqwest::Url> {
    let url = reqwest::Url::parse(value)
        .map_err(|error| anyhow::anyhow!("{name} is invalid: {error}"))?;
    anyhow::ensure!(
        url.scheme() == "http",
        "{name} must use HTTP for local dev auth"
    );
    anyhow::ensure!(
        url.username().is_empty() && url.password().is_none(),
        "{name} must not include credentials"
    );
    anyhow::ensure!(
        url.path() == "/" && url.query().is_none() && url.fragment().is_none(),
        "{name} must be an origin without a path, query, or fragment"
    );
    let host = url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("{name} must include a host"))?;
    let loopback =
        host == "localhost" || IpAddr::from_str(host).is_ok_and(|address| address.is_loopback());
    anyhow::ensure!(loopback, "{name} must use a loopback host");
    Ok(url)
}

fn authority(url: &reqwest::Url) -> String {
    let host = url.host_str().unwrap_or_default();
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    url.port()
        .map_or_else(|| host.clone(), |port| format!("{host}:{port}"))
}

fn normalize_email(value: &str) -> Result<String, ApiError> {
    let value = value.trim().to_lowercase();
    let valid = (3..=160).contains(&value.len())
        && !value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
        && value.split('@').count() == 2
        && !value.starts_with('@')
        && !value.ends_with('@');
    if !valid {
        return Err(ApiError::bad_request("Enter a valid email address"));
    }
    Ok(value)
}

fn local_user(email: &str) -> OsUser {
    let digest = Sha256::digest(format!("epode-dev-auth-user:v1\0{email}").as_bytes());
    let encoded = URL_SAFE_NO_PAD.encode(digest);
    OsUser {
        id: format!("usr_dev_{encoded}"),
        handle: format!("dev_{}", &encoded[..16]),
        email: Some(email.to_owned()),
        display_name: Some(email.to_owned()),
        avatar_url: None,
    }
}

fn validate_return_to(value: &str) -> Result<&str, ApiError> {
    let valid = !value.is_empty()
        && value.len() <= 2_048
        && value.starts_with('/')
        && !value.starts_with("//")
        && !value.contains(['\\', '#'])
        && !value.chars().any(char::is_control)
        && value
            .parse::<axum::http::Uri>()
            .is_ok_and(|uri| uri.scheme().is_none() && uri.authority().is_none());
    if !valid {
        return Err(ApiError::bad_request("Invalid returnTo path"));
    }
    Ok(value)
}

fn escape_html_attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn no_store(response: &mut Response) {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::expect_used,
        reason = "test failures should abort at the assertion site"
    )]

    use super::*;
    use chrono::TimeZone as _;

    fn config() -> DevAuthConfig {
        DevAuthConfig::from_values(
            8080,
            "http://localhost:8080",
            "http://localhost:3000",
            &URL_SAFE_NO_PAD.encode([7_u8; 32]),
        )
        .unwrap()
    }

    #[test]
    fn configuration_requires_matching_local_origins_and_strong_key() {
        let key = URL_SAFE_NO_PAD.encode([7_u8; 32]);
        assert!(
            DevAuthConfig::from_values(
                8080,
                "http://localhost:8080",
                "http://localhost:3000",
                &key
            )
            .is_ok()
        );
        assert!(
            DevAuthConfig::from_values(8080, "http://0.0.0.0:8080", "http://0.0.0.0:3000", &key)
                .is_err()
        );
        assert!(
            DevAuthConfig::from_values(
                8080,
                "http://localhost:8080",
                "http://127.0.0.1:3000",
                &key
            )
            .is_err()
        );
        assert!(
            DevAuthConfig::from_values(
                8080,
                "http://localhost:8080",
                "http://localhost:3000",
                &URL_SAFE_NO_PAD.encode([7_u8; 16])
            )
            .is_err()
        );
    }

    #[test]
    fn identity_is_normalized_stable_and_signed() {
        let config = config();
        let email = normalize_email(" Developer@Example.TEST ").unwrap();
        let now = Utc.timestamp_opt(1_700_000_000, 0).unwrap();
        let cookie = config.issue_cookie(&email, now).unwrap();
        let token = cookie
            .split(';')
            .next()
            .unwrap()
            .strip_prefix("af_dev_identity=")
            .unwrap();
        let user = config.verify_identity(token, now).unwrap();
        assert_eq!(user.email.as_deref(), Some("developer@example.test"));
        assert!(user.id.starts_with("usr_dev_"));
        assert!(!user.handle.contains("developer"));
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Strict"));

        let mut tampered = token.to_owned();
        tampered.push('x');
        assert!(config.verify_identity(&tampered, now).is_err());
        assert!(
            config
                .verify_identity(token, now + Duration::hours(9))
                .is_err()
        );
    }

    #[test]
    fn return_paths_are_relative_and_html_escaped() {
        assert_eq!(
            validate_return_to("/?view=team&tab=members").unwrap(),
            "/?view=team&tab=members"
        );
        for invalid in [
            "https://evil.test",
            "//evil.test",
            "/\\evil",
            "/page#fragment",
        ] {
            assert!(validate_return_to(invalid).is_err());
        }
        assert_eq!(
            escape_html_attribute("/?a=1&b=\"two\""),
            "/?a=1&amp;b=&quot;two&quot;"
        );
    }

    #[test]
    fn debug_output_redacts_the_signing_key() {
        let debug = format!("{:?}", config());
        assert!(debug.contains("[redacted]"));
        assert!(!debug.contains(&URL_SAFE_NO_PAD.encode([7_u8; 32])));
    }
}
