#![allow(
    clippy::redundant_pub_crate,
    reason = "crate-restricted visibility satisfies unreachable_pub in this binary-only crate"
)]

use std::{env, fmt};

use anyhow::Context as _;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::{DateTime, Duration, Utc};
use hmac::{Hmac, Mac};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

const GITHUB_API_URL: &str = "https://api.github.com";
const GITHUB_API_VERSION: &str = "2022-11-28";
const GITHUB_ACCEPT: &str = "application/vnd.github+json";
const GITHUB_USER_AGENT: &str = "epode-agent-feedback";
const REPOSITORIES_PER_PAGE: usize = 100;
const MAX_REPOSITORY_PAGES: usize = 10;
const REQUIRED_ENV: &[&str] = &[
    "GITHUB_APP_ID",
    "GITHUB_APP_SLUG",
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_CLIENT_SECRET",
    "GITHUB_APP_WEBHOOK_SECRET",
    "GITHUB_APP_PRIVATE_KEY",
];

#[derive(Clone)]
pub(crate) struct GithubAppConfig {
    app_id: String,
    slug: String,
    encoding_key: EncodingKey,
    webhook_secret: String,
}

impl fmt::Debug for GithubAppConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GithubAppConfig")
            .field("app_id", &self.app_id)
            .field("slug", &self.slug)
            .field("encoding_key", &"[redacted]")
            .field("webhook_secret", &"[redacted]")
            .finish()
    }
}

impl GithubAppConfig {
    pub(crate) fn from_env() -> anyhow::Result<Option<Self>> {
        let missing = REQUIRED_ENV
            .iter()
            .filter(|name| env::var(name).is_err())
            .copied()
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            tracing::warn!(
                missing = %missing.join(", "),
                "GitHub App integration disabled because environment variables are missing"
            );
            return Ok(None);
        }

        let app_id = required_env("GITHUB_APP_ID")?;
        let slug = required_env("GITHUB_APP_SLUG")?;
        anyhow::ensure!(
            slug.chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '-'),
            "GITHUB_APP_SLUG contains unsupported characters"
        );
        let webhook_secret = required_env("GITHUB_APP_WEBHOOK_SECRET")?;
        let private_key = normalize_private_key(&required_env("GITHUB_APP_PRIVATE_KEY")?)?;
        let encoding_key = EncodingKey::from_rsa_pem(private_key.as_bytes())
            .map_err(|_| anyhow::anyhow!("GITHUB_APP_PRIVATE_KEY is not a valid RSA PEM"))?;
        Ok(Some(Self {
            app_id,
            slug,
            encoding_key,
            webhook_secret,
        }))
    }
}

#[derive(Debug, Clone)]
pub(crate) struct GithubAppClient {
    http: Client,
    config: GithubAppConfig,
}

#[derive(Debug, Clone)]
pub(crate) struct InstallationAccount {
    pub(crate) login: String,
    pub(crate) account_type: String,
}

#[derive(Debug, Clone)]
pub(crate) struct GithubRepo {
    pub(crate) full_name: String,
    pub(crate) default_branch: String,
    pub(crate) private: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GithubIssue {
    pub(crate) number: i64,
    pub(crate) html_url: String,
    pub(crate) state: String,
}

/// Repositories read from one installation, plus whether the pagination cap cut
/// the listing short. GitHub's code-search and REST quotas are tight, so the
/// listing stops at `MAX_REPOSITORY_PAGES` rather than walking an unbounded
/// account; callers must surface `truncated` instead of presenting a partial
/// page as the complete set.
#[derive(Debug, Clone)]
pub(crate) struct GithubRepositoryPage {
    pub(crate) repositories: Vec<GithubRepo>,
    pub(crate) truncated: bool,
}

#[derive(Debug, Serialize)]
struct AppClaims<'a> {
    iat: i64,
    exp: i64,
    iss: &'a str,
}

#[derive(Debug, Deserialize)]
struct InstallationResponse {
    account: AccountResponse,
}

#[derive(Debug, Deserialize)]
struct AccountResponse {
    login: String,
    #[serde(rename = "type")]
    account_type: String,
}

#[derive(Deserialize)]
struct InstallationTokenResponse {
    token: String,
}

impl fmt::Debug for InstallationTokenResponse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("InstallationTokenResponse")
            .field("token", &"[redacted]")
            .finish()
    }
}

#[derive(Debug, Deserialize)]
struct RepositoriesResponse {
    repositories: Vec<RepositoryResponse>,
}

#[derive(Debug, Deserialize)]
struct RepositoryResponse {
    full_name: String,
    default_branch: String,
    private: bool,
}

#[derive(Debug, Serialize)]
struct CreateIssueRequest<'a> {
    title: &'a str,
    body: &'a str,
}

#[derive(Debug, Serialize)]
struct CreateIssueCommentRequest<'a> {
    body: &'a str,
}

impl GithubAppClient {
    pub(crate) fn new(config: GithubAppConfig) -> Self {
        Self {
            http: Client::new(),
            config,
        }
    }

    pub(crate) fn install_url(&self, state: &str) -> String {
        format!(
            "https://github.com/apps/{}/installations/new?state={}",
            self.config.slug,
            percent_encode_query_value(state)
        )
    }

    fn app_jwt(&self, now: DateTime<Utc>) -> anyhow::Result<String> {
        let claims = AppClaims {
            iat: (now - Duration::seconds(60)).timestamp(),
            exp: (now + Duration::seconds(540)).timestamp(),
            iss: &self.config.app_id,
        };
        encode(
            &Header::new(Algorithm::RS256),
            &claims,
            &self.config.encoding_key,
        )
        .context("failed to sign GitHub App JWT")
    }

    pub(crate) async fn installation(
        &self,
        installation_id: i64,
    ) -> anyhow::Result<InstallationAccount> {
        let jwt = self.app_jwt(Utc::now())?;
        let response = Self::request(self.http.get(format!(
            "{GITHUB_API_URL}/app/installations/{installation_id}"
        )))
        .bearer_auth(jwt)
        .send()
        .await
        .context("GitHub installation request failed")?
        .error_for_status()
        .context("GitHub installation request was rejected")?
        .json::<InstallationResponse>()
        .await
        .context("GitHub installation response was invalid")?;
        Ok(InstallationAccount {
            login: response.account.login,
            account_type: response.account.account_type,
        })
    }

    async fn installation_token(&self, installation_id: i64) -> anyhow::Result<String> {
        let jwt = self.app_jwt(Utc::now())?;
        let response = Self::request(self.http.post(format!(
            "{GITHUB_API_URL}/app/installations/{installation_id}/access_tokens"
        )))
        .bearer_auth(jwt)
        .send()
        .await
        .context("GitHub installation token request failed")?
        .error_for_status()
        .context("GitHub installation token request was rejected")?
        .json::<InstallationTokenResponse>()
        .await
        .context("GitHub installation token response was invalid")?;
        Ok(response.token)
    }

    pub(crate) async fn installation_repositories(
        &self,
        installation_id: i64,
    ) -> anyhow::Result<GithubRepositoryPage> {
        let token = self.installation_token(installation_id).await?;
        let mut repositories = Vec::new();
        // Stays true only if every page came back full and the cap ran out.
        let mut truncated = true;
        for page in 1..=MAX_REPOSITORY_PAGES {
            let response = Self::request(
                self.http
                    .get(format!("{GITHUB_API_URL}/installation/repositories"))
                    .query(&[("per_page", REPOSITORIES_PER_PAGE), ("page", page)]),
            )
            .bearer_auth(&token)
            .send()
            .await
            .context("GitHub repositories request failed")?
            .error_for_status()
            .context("GitHub repositories request was rejected")?
            .json::<RepositoriesResponse>()
            .await
            .context("GitHub repositories response was invalid")?;
            let page_len = response.repositories.len();
            repositories.extend(
                response
                    .repositories
                    .into_iter()
                    .map(|repository| GithubRepo {
                        full_name: repository.full_name,
                        default_branch: repository.default_branch,
                        private: repository.private,
                    }),
            );
            if page_len < REPOSITORIES_PER_PAGE {
                truncated = false;
                break;
            }
        }
        if truncated {
            tracing::warn!(
                installation_id,
                repositories = repositories.len(),
                "GitHub repository listing hit the pagination cap and is truncated"
            );
        }
        Ok(GithubRepositoryPage {
            repositories,
            truncated,
        })
    }

    pub(crate) async fn create_issue(
        &self,
        installation_id: i64,
        repo_full_name: &str,
        title: &str,
        body: &str,
    ) -> anyhow::Result<GithubIssue> {
        validate_repo_full_name(repo_full_name)?;
        let token = self.installation_token(installation_id).await?;
        Self::request(
            self.http
                .post(format!("{GITHUB_API_URL}/repos/{repo_full_name}/issues")),
        )
        .bearer_auth(token)
        .json(&CreateIssueRequest { title, body })
        .send()
        .await
        .context("GitHub issue creation request failed")?
        .error_for_status()
        .context("GitHub issue creation request was rejected")?
        .json::<GithubIssue>()
        .await
        .context("GitHub issue creation response was invalid")
    }

    pub(crate) async fn create_issue_comment(
        &self,
        installation_id: i64,
        repo_full_name: &str,
        issue_number: i64,
        body: &str,
    ) -> anyhow::Result<()> {
        validate_repo_full_name(repo_full_name)?;
        let token = self.installation_token(installation_id).await?;
        Self::request(self.http.post(format!(
            "{GITHUB_API_URL}/repos/{repo_full_name}/issues/{issue_number}/comments"
        )))
        .bearer_auth(token)
        .json(&CreateIssueCommentRequest { body })
        .send()
        .await
        .context("GitHub issue comment request failed")?
        .error_for_status()
        .context("GitHub issue comment request was rejected")?;
        Ok(())
    }

    pub(crate) async fn issue(
        &self,
        installation_id: i64,
        repo_full_name: &str,
        issue_number: i64,
    ) -> anyhow::Result<GithubIssue> {
        validate_repo_full_name(repo_full_name)?;
        let token = self.installation_token(installation_id).await?;
        Self::request(self.http.get(format!(
            "{GITHUB_API_URL}/repos/{repo_full_name}/issues/{issue_number}"
        )))
        .bearer_auth(token)
        .send()
        .await
        .context("GitHub issue request failed")?
        .error_for_status()
        .context("GitHub issue request was rejected")?
        .json::<GithubIssue>()
        .await
        .context("GitHub issue response was invalid")
    }

    pub(crate) fn verify_webhook_signature(&self, body: &[u8], header: &str) -> bool {
        verify_webhook_signature(&self.config.webhook_secret, body, header)
    }

    fn request(request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        request
            .header(reqwest::header::ACCEPT, GITHUB_ACCEPT)
            .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
            .header(reqwest::header::USER_AGENT, GITHUB_USER_AGENT)
    }
}

pub(crate) fn validate_repo_full_name(value: &str) -> anyhow::Result<()> {
    let mut parts = value.split('/');
    let owner = parts.next().unwrap_or_default();
    let repository = parts.next().unwrap_or_default();
    let valid_component = |component: &str| {
        !component.is_empty()
            && component
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    };
    anyhow::ensure!(
        parts.next().is_none()
            && !value.contains("..")
            && valid_component(owner)
            && valid_component(repository),
        "repository name must use the owner/name form"
    );
    Ok(())
}

pub(crate) fn verify_webhook_signature(secret: &str, body: &[u8], header: &str) -> bool {
    let Some(signature) = header.strip_prefix("sha256=") else {
        return false;
    };
    let Some(signature) = decode_hex(signature) else {
        return false;
    };
    let Ok(mut mac) = HmacSha256::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(body);
    mac.verify_slice(&signature).is_ok()
}

fn required_env(name: &str) -> anyhow::Result<String> {
    env::var(name).map_err(|_| anyhow::anyhow!("{name} is required for GitHub App integration"))
}

fn normalize_private_key(value: &str) -> anyhow::Result<String> {
    let pem = if value.starts_with("-----BEGIN") {
        value.to_owned()
    } else {
        let bytes = STANDARD
            .decode(value)
            .map_err(|_| anyhow::anyhow!("GITHUB_APP_PRIVATE_KEY is not valid base64 or PEM"))?;
        String::from_utf8(bytes)
            .map_err(|_| anyhow::anyhow!("GITHUB_APP_PRIVATE_KEY did not decode to UTF-8"))?
    };
    Ok(pem.replace("\\n", "\n"))
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    if !value.len().is_multiple_of(2) {
        return None;
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let high = decode_hex_digit(pair[0])?;
            let low = decode_hex_digit(pair[1])?;
            Some((high << 4) | low)
        })
        .collect()
}

const fn decode_hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn percent_encode_query_value(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(char::from(HEX[usize::from(byte >> 4)]));
            encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;

    use super::*;

    fn test_config(slug: &str) -> GithubAppConfig {
        GithubAppConfig {
            app_id: "1".to_owned(),
            slug: slug.to_owned(),
            encoding_key: EncodingKey::from_secret(b"test-only"),
            webhook_secret: "secret".to_owned(),
        }
    }

    fn signature(secret: &str, body: &[u8]) -> anyhow::Result<String> {
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes())?;
        mac.update(body);
        let bytes = mac.finalize().into_bytes();
        let mut hex = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            write!(&mut hex, "{byte:02x}")?;
        }
        Ok(format!("sha256={hex}"))
    }

    #[test]
    fn verifies_webhook_signature_known_vector_and_rejects_invalid_inputs() -> anyhow::Result<()> {
        let body = br#"{"action":"created"}"#;
        let expected = signature("secret", body)?;
        assert!(verify_webhook_signature("secret", body, &expected));
        assert!(!verify_webhook_signature("wrong", body, &expected));
        assert!(!verify_webhook_signature(
            "secret",
            br#"{"action":"deleted"}"#,
            &expected
        ));
        assert!(!verify_webhook_signature(
            "secret",
            body,
            expected.trim_start_matches("sha256=")
        ));
        assert!(!verify_webhook_signature("secret", body, "sha256=not-hex"));
        assert!(!verify_webhook_signature("secret", body, ""));
        Ok(())
    }

    #[test]
    fn normalizes_raw_escaped_and_base64_private_keys() -> anyhow::Result<()> {
        let raw = "-----BEGIN PRIVATE KEY-----\nvalue\n-----END PRIVATE KEY-----";
        assert_eq!(normalize_private_key(raw)?, raw);

        let escaped = "-----BEGIN PRIVATE KEY-----\\nvalue\\n-----END PRIVATE KEY-----";
        assert_eq!(normalize_private_key(escaped)?, raw);

        let encoded = STANDARD.encode(escaped);
        assert_eq!(normalize_private_key(&encoded)?, raw);
        Ok(())
    }

    #[test]
    fn install_url_uses_slug_and_percent_encodes_state() {
        let client = GithubAppClient::new(test_config("epode-ai"));
        assert_eq!(
            client.install_url("state with symbols/&"),
            "https://github.com/apps/epode-ai/installations/new?state=state%20with%20symbols%2F%26"
        );
    }

    #[test]
    fn validates_repository_full_names_before_url_interpolation() {
        assert!(validate_repo_full_name("owner/name").is_ok());
        for invalid in [
            "owner/../name",
            "/owner",
            "owner/name with spaces",
            "owner",
            "../owner/name",
            "owner/name/extra",
            "owner//name",
        ] {
            assert!(
                validate_repo_full_name(invalid).is_err(),
                "{invalid} should be rejected"
            );
        }
    }

    #[test]
    fn github_issue_payloads_have_the_expected_shape() -> anyhow::Result<()> {
        assert_eq!(
            serde_json::to_value(CreateIssueRequest {
                title: "A title",
                body: "A body",
            })?,
            serde_json::json!({"title": "A title", "body": "A body"})
        );
        assert_eq!(
            serde_json::to_value(CreateIssueCommentRequest { body: "Evidence" })?,
            serde_json::json!({"body": "Evidence"})
        );
        Ok(())
    }
}
