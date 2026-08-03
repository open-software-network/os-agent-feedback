#![allow(
    clippy::redundant_pub_crate,
    reason = "crate-restricted visibility satisfies unreachable_pub in this binary-only crate"
)]

use std::{env, fmt, time::Duration as StdDuration};

use anyhow::Context as _;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use hmac::{Hmac, Mac};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::code_match::{CodeSearchCandidate, CodeSearchVerification};

type HmacSha256 = Hmac<Sha256>;

const GITHUB_API_URL: &str = "https://api.github.com";
const GITHUB_API_VERSION: &str = "2022-11-28";
const GITHUB_ACCEPT: &str = "application/vnd.github+json";
const GITHUB_CODE_SEARCH_ACCEPT: &str = "application/vnd.github.text-match+json";
const GITHUB_RAW_CONTENT_ACCEPT: &str = "application/vnd.github.raw+json";
const GITHUB_USER_AGENT: &str = "epode-agent-feedback";
const CODE_SEARCH_RESULTS_PER_QUERY: usize = 10;
const MAX_CODE_FILE_BYTES: usize = 1_048_576;
const REPOSITORIES_PER_PAGE: usize = 100;
const MAX_REPOSITORY_PAGES: usize = 10;
const ISSUES_PER_PAGE: usize = 100;
const MAX_RECONCILIATION_ISSUE_PAGES: usize = 10;
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
    app_slug: String,
}

#[derive(Debug, Clone)]
pub(crate) struct GithubRepo {
    pub(crate) full_name: String,
    pub(crate) default_branch: String,
    pub(crate) private: bool,
}

#[derive(Clone)]
pub(crate) struct GithubInstallationToken(String);

impl GithubInstallationToken {
    fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for GithubInstallationToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("GithubInstallationToken([redacted])")
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct GithubRateLimit {
    pub(crate) remaining: Option<i64>,
    pub(crate) reset_at: Option<DateTime<Utc>>,
    pub(crate) retry_after: Option<StdDuration>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GithubCodeSearchResult {
    pub(crate) candidates: Vec<GithubCodeSearchCandidate>,
    pub(crate) rate_limit: GithubRateLimit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct GithubCodeSearchCandidate {
    file: String,
    text_match: Option<CodeSearchTextMatch>,
}

impl GithubCodeSearchCandidate {
    pub(crate) fn file(&self) -> &str {
        &self.file
    }

    pub(crate) const fn needs_content(&self) -> bool {
        self.text_match.is_some()
    }

    #[cfg(test)]
    pub(crate) fn fragmentless_for_test(file: &str) -> Self {
        Self {
            file: file.to_owned(),
            text_match: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_fragment_for_test(file: &str, fragment: &str) -> Self {
        Self {
            file: file.to_owned(),
            text_match: Some(CodeSearchTextMatch {
                fragment: fragment.to_owned(),
                matches: vec![CodeSearchTextMatchOccurrence {
                    indices: [0, fragment.len()],
                }],
            }),
        }
    }

    pub(crate) fn verify_against_pinned_content(
        self,
        content: &str,
    ) -> Option<CodeSearchCandidate> {
        let range = if let Some(text_match) = self.text_match.as_ref() {
            if !content_contains_fragment(content, &text_match.fragment) {
                return None;
            }
            locate_text_match(content, text_match)
        } else {
            None
        };
        Some(CodeSearchCandidate {
            file: self.file,
            line_start: range.map(|range| range.0),
            line_end: range.map(|range| range.1),
            verification: CodeSearchVerification::Verified,
        })
    }

    pub(crate) fn into_file_not_found(self) -> CodeSearchCandidate {
        CodeSearchCandidate {
            file: self.file,
            line_start: None,
            line_end: None,
            verification: CodeSearchVerification::FileNotFound,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GithubFileContentFailureKind {
    NotFound,
    Unauthorized,
    Forbidden,
    Server,
    Timeout,
    InvalidResponse,
    Transport,
}

#[derive(Debug)]
pub(crate) struct GithubFileContentError {
    kind: GithubFileContentFailureKind,
    source: anyhow::Error,
}

impl GithubFileContentError {
    fn from_source(source: anyhow::Error) -> Self {
        Self {
            kind: github_file_content_failure_kind(&source),
            source,
        }
    }

    pub(crate) const fn kind(&self) -> GithubFileContentFailureKind {
        self.kind
    }

    #[cfg(test)]
    pub(crate) fn for_test(kind: GithubFileContentFailureKind) -> Self {
        Self {
            kind,
            source: anyhow::anyhow!("test file-content failure: {kind:?}"),
        }
    }
}

impl fmt::Display for GithubFileContentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.source.fmt(formatter)
    }
}

impl std::error::Error for GithubFileContentError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.source.as_ref())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GithubPinnedCommitFailureKind {
    NotFound,
    Unauthorized,
    Forbidden,
    Server,
    Timeout,
    InvalidResponse,
    Transport,
}

impl GithubPinnedCommitFailureKind {
    pub(crate) const fn counts_toward_verification_ceiling(self) -> bool {
        matches!(self, Self::NotFound)
    }
}

#[derive(Debug)]
pub(crate) struct GithubPinnedCommitError {
    kind: GithubPinnedCommitFailureKind,
    source: anyhow::Error,
}

impl GithubPinnedCommitError {
    fn from_source(source: anyhow::Error) -> Self {
        Self {
            kind: github_pinned_commit_failure_kind(&source),
            source,
        }
    }

    pub(crate) const fn kind(&self) -> GithubPinnedCommitFailureKind {
        self.kind
    }

    #[cfg(test)]
    pub(crate) fn for_test(kind: GithubPinnedCommitFailureKind) -> Self {
        Self {
            kind,
            source: anyhow::anyhow!("test pinned-commit failure: {kind:?}"),
        }
    }
}

impl fmt::Display for GithubPinnedCommitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.source.fmt(formatter)
    }
}

impl std::error::Error for GithubPinnedCommitError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.source.as_ref())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GithubCodeSearchFailureKind {
    RateLimit,
    Unauthorized,
    Forbidden,
    NotFound,
    InvalidRequest,
    Server,
    Timeout,
    InvalidResponse,
    Transport,
}

#[derive(Debug)]
pub(crate) struct GithubCodeSearchError {
    kind: GithubCodeSearchFailureKind,
    rate_limit: GithubRateLimit,
    source: anyhow::Error,
}

impl GithubCodeSearchError {
    const fn new(
        kind: GithubCodeSearchFailureKind,
        rate_limit: GithubRateLimit,
        source: anyhow::Error,
    ) -> Self {
        Self {
            kind,
            rate_limit,
            source,
        }
    }

    fn from_request(error: reqwest::Error, context: &'static str) -> Self {
        let kind = if error.is_timeout() {
            GithubCodeSearchFailureKind::Timeout
        } else {
            GithubCodeSearchFailureKind::Transport
        };
        Self::new(
            kind,
            GithubRateLimit::default(),
            anyhow::Error::new(error).context(context),
        )
    }

    pub(crate) const fn kind(&self) -> GithubCodeSearchFailureKind {
        self.kind
    }

    pub(crate) const fn rate_limit(&self) -> &GithubRateLimit {
        &self.rate_limit
    }
}

impl fmt::Display for GithubCodeSearchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.source.fmt(formatter)
    }
}

impl std::error::Error for GithubCodeSearchError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.source.as_ref())
    }
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GithubIssue {
    pub(crate) number: i64,
    pub(crate) html_url: String,
    pub(crate) state: String,
    pub(crate) body: Option<String>,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) pull_request: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GithubIssueListFailureKind {
    Installation,
    Access,
    RateLimit,
    Timeout,
    NotFound,
    Server,
    InvalidResponse,
    PaginationCap,
    Transport,
}

#[derive(Debug)]
pub(crate) struct GithubIssueListError {
    kind: GithubIssueListFailureKind,
    page: usize,
    source: anyhow::Error,
}

impl GithubIssueListError {
    const fn new(kind: GithubIssueListFailureKind, page: usize, source: anyhow::Error) -> Self {
        Self { kind, page, source }
    }

    fn from_request(error: reqwest::Error, page: usize, context: &'static str) -> Self {
        let kind = issue_list_failure_kind(error.status(), error.is_timeout());
        Self::new(kind, page, anyhow::Error::new(error).context(context))
    }

    pub(crate) const fn kind(&self) -> GithubIssueListFailureKind {
        self.kind
    }

    pub(crate) const fn page(&self) -> usize {
        self.page
    }
}

impl fmt::Display for GithubIssueListError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.source.fmt(formatter)
    }
}

impl std::error::Error for GithubIssueListError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.source.as_ref())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GithubIssueCreationOutcome {
    DefiniteFailure,
    AmbiguousFailure,
}

#[derive(Debug)]
pub(crate) struct GithubIssueCreationError {
    outcome: GithubIssueCreationOutcome,
    source: anyhow::Error,
}

impl GithubIssueCreationError {
    const fn definite(source: anyhow::Error) -> Self {
        Self {
            outcome: GithubIssueCreationOutcome::DefiniteFailure,
            source,
        }
    }

    fn from_request(error: reqwest::Error, context: &'static str) -> Self {
        let failure =
            issue_creation_failure_kind(error.status(), error.is_timeout(), error.is_connect());
        Self {
            outcome: failure.outcome(),
            source: anyhow::Error::new(error).context(context),
        }
    }

    pub(crate) const fn outcome(&self) -> GithubIssueCreationOutcome {
        self.outcome
    }
}

impl fmt::Display for GithubIssueCreationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.source.fmt(formatter)
    }
}

impl std::error::Error for GithubIssueCreationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.source.as_ref())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GithubIssueCreationFailureKind {
    ClientResponse,
    ServerResponse,
    Timeout,
    Connect,
    Transport,
}

impl GithubIssueCreationFailureKind {
    const fn outcome(self) -> GithubIssueCreationOutcome {
        match self {
            Self::ClientResponse => GithubIssueCreationOutcome::DefiniteFailure,
            Self::ServerResponse | Self::Timeout | Self::Connect | Self::Transport => {
                GithubIssueCreationOutcome::AmbiguousFailure
            }
        }
    }
}

fn issue_creation_failure_kind(
    status: Option<reqwest::StatusCode>,
    is_timeout: bool,
    is_connect: bool,
) -> GithubIssueCreationFailureKind {
    if status.is_some_and(|status| status.is_client_error()) {
        GithubIssueCreationFailureKind::ClientResponse
    } else if status.is_some_and(|status| status.is_server_error()) {
        GithubIssueCreationFailureKind::ServerResponse
    } else if is_timeout {
        GithubIssueCreationFailureKind::Timeout
    } else if is_connect {
        GithubIssueCreationFailureKind::Connect
    } else {
        GithubIssueCreationFailureKind::Transport
    }
}

fn issue_list_failure_kind(
    status: Option<reqwest::StatusCode>,
    is_timeout: bool,
) -> GithubIssueListFailureKind {
    match status {
        Some(reqwest::StatusCode::NOT_FOUND) => GithubIssueListFailureKind::NotFound,
        Some(reqwest::StatusCode::TOO_MANY_REQUESTS | reqwest::StatusCode::FORBIDDEN) => {
            GithubIssueListFailureKind::RateLimit
        }
        Some(status) if status.is_server_error() => GithubIssueListFailureKind::Server,
        Some(_) => GithubIssueListFailureKind::Access,
        None if is_timeout => GithubIssueListFailureKind::Timeout,
        None => GithubIssueListFailureKind::Transport,
    }
}

fn github_file_content_failure_kind(error: &anyhow::Error) -> GithubFileContentFailureKind {
    let Some(request_error) = error.downcast_ref::<reqwest::Error>() else {
        // Size-limit, UTF-8, and local validation failures have no HTTP
        // status and therefore can never prove absence at the pinned SHA.
        return GithubFileContentFailureKind::InvalidResponse;
    };
    match request_error.status() {
        Some(reqwest::StatusCode::NOT_FOUND) => GithubFileContentFailureKind::NotFound,
        Some(reqwest::StatusCode::UNAUTHORIZED) => GithubFileContentFailureKind::Unauthorized,
        Some(reqwest::StatusCode::FORBIDDEN) => GithubFileContentFailureKind::Forbidden,
        Some(status) if status.is_server_error() => GithubFileContentFailureKind::Server,
        Some(_) => GithubFileContentFailureKind::InvalidResponse,
        None if request_error.is_timeout() => GithubFileContentFailureKind::Timeout,
        None => GithubFileContentFailureKind::Transport,
    }
}

fn github_pinned_commit_failure_kind(error: &anyhow::Error) -> GithubPinnedCommitFailureKind {
    let Some(request_error) = error.downcast_ref::<reqwest::Error>() else {
        return GithubPinnedCommitFailureKind::InvalidResponse;
    };
    match request_error.status() {
        Some(reqwest::StatusCode::NOT_FOUND) => GithubPinnedCommitFailureKind::NotFound,
        Some(reqwest::StatusCode::UNAUTHORIZED) => GithubPinnedCommitFailureKind::Unauthorized,
        Some(reqwest::StatusCode::FORBIDDEN) => GithubPinnedCommitFailureKind::Forbidden,
        Some(status) if status.is_server_error() => GithubPinnedCommitFailureKind::Server,
        Some(_) => GithubPinnedCommitFailureKind::InvalidResponse,
        None if request_error.is_timeout() => GithubPinnedCommitFailureKind::Timeout,
        None => GithubPinnedCommitFailureKind::Transport,
    }
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
    app_slug: String,
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

#[derive(Debug, Deserialize)]
struct CodeSearchResponse {
    items: Vec<CodeSearchItem>,
}

#[derive(Debug, Deserialize)]
struct CodeSearchItem {
    path: String,
    #[serde(default)]
    text_matches: Vec<CodeSearchTextMatch>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct CodeSearchTextMatch {
    fragment: String,
    #[serde(default)]
    matches: Vec<CodeSearchTextMatchOccurrence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct CodeSearchTextMatchOccurrence {
    indices: [usize; 2],
}

#[derive(Debug, Deserialize)]
struct CommitResponse {
    sha: String,
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
        let http = match Client::builder()
            .connect_timeout(StdDuration::from_secs(5))
            .timeout(StdDuration::from_secs(15))
            .build()
        {
            Ok(http) => http,
            Err(error) => {
                tracing::warn!(
                    %error,
                    "failed to build bounded GitHub HTTP client; using reqwest defaults"
                );
                Client::new()
            }
        };
        Self { http, config }
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
            app_slug: response.app_slug,
        })
    }

    pub(crate) async fn installation_token(
        &self,
        installation_id: i64,
    ) -> anyhow::Result<GithubInstallationToken> {
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
        Ok(GithubInstallationToken(response.token))
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
            .bearer_auth(token.as_str())
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
    ) -> Result<GithubIssue, GithubIssueCreationError> {
        validate_repo_full_name(repo_full_name).map_err(GithubIssueCreationError::definite)?;
        // A token-mint failure happens before the issue request is sent, so it
        // is a definite non-creation even when the token call itself times out.
        let token = self
            .installation_token(installation_id)
            .await
            .map_err(GithubIssueCreationError::definite)?;
        Self::request(
            self.http
                .post(format!("{GITHUB_API_URL}/repos/{repo_full_name}/issues")),
        )
        .bearer_auth(token.as_str())
        .json(&CreateIssueRequest { title, body })
        .send()
        .await
        .map_err(|error| {
            GithubIssueCreationError::from_request(error, "GitHub issue creation request failed")
        })?
        .error_for_status()
        .map_err(|error| {
            GithubIssueCreationError::from_request(
                error,
                "GitHub issue creation request was rejected",
            )
        })?
        .json::<GithubIssue>()
        .await
        .map_err(|error| {
            // A successful status with an unreadable response can arrive after
            // creation, so missing status information is deliberately ambiguous.
            GithubIssueCreationError::from_request(
                error,
                "GitHub issue creation response was invalid",
            )
        })
    }

    pub(crate) async fn reconciliation_issues(
        &self,
        installation_id: i64,
        repo_full_name: &str,
        since: DateTime<Utc>,
    ) -> Result<Vec<GithubIssue>, GithubIssueListError> {
        validate_repo_full_name(repo_full_name).map_err(|error| {
            GithubIssueListError::new(GithubIssueListFailureKind::Access, 0, error)
        })?;
        let installation = self.installation(installation_id).await.map_err(|error| {
            GithubIssueListError::new(GithubIssueListFailureKind::Installation, 0, error)
        })?;
        let token = self
            .installation_token(installation_id)
            .await
            .map_err(|error| {
                GithubIssueListError::new(GithubIssueListFailureKind::Access, 0, error)
            })?;
        let creator = app_bot_login(&installation.app_slug);
        let since = since.to_rfc3339_opts(SecondsFormat::Secs, true);
        let mut issues = Vec::new();
        for page in 1..=MAX_RECONCILIATION_ISSUE_PAGES {
            let page_number = page.to_string();
            let per_page = ISSUES_PER_PAGE.to_string();
            let response = Self::request(
                self.http
                    .get(format!("{GITHUB_API_URL}/repos/{repo_full_name}/issues"))
                    .query(&[
                        ("state", "all"),
                        ("creator", creator.as_str()),
                        ("since", since.as_str()),
                        ("per_page", per_page.as_str()),
                        ("page", page_number.as_str()),
                    ]),
            )
            .bearer_auth(token.as_str())
            .send()
            .await
            .map_err(|error| {
                GithubIssueListError::from_request(
                    error,
                    page,
                    "GitHub reconciliation issue listing failed",
                )
            })?
            .error_for_status()
            .map_err(|error| {
                GithubIssueListError::from_request(
                    error,
                    page,
                    "GitHub reconciliation issue listing was rejected",
                )
            })?
            .json::<Vec<GithubIssue>>()
            .await
            .map_err(|error| {
                GithubIssueListError::new(
                    GithubIssueListFailureKind::InvalidResponse,
                    page,
                    anyhow::Error::new(error)
                        .context("GitHub reconciliation issue listing response was invalid"),
                )
            })?;
            let page_len = response.len();
            issues.extend(response);
            if page_len < ISSUES_PER_PAGE {
                return Ok(issues);
            }
        }
        Err(GithubIssueListError::new(
            GithubIssueListFailureKind::PaginationCap,
            MAX_RECONCILIATION_ISSUE_PAGES,
            anyhow::anyhow!(
                "GitHub reconciliation issue listing hit the pagination cap before exhaustion"
            ),
        ))
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
        .bearer_auth(token.as_str())
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
        .bearer_auth(token.as_str())
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

    pub(crate) async fn repository_head_sha(
        &self,
        token: &GithubInstallationToken,
        repo_full_name: &str,
        default_branch: &str,
    ) -> anyhow::Result<String> {
        validate_repo_full_name(repo_full_name)?;
        anyhow::ensure!(!default_branch.trim().is_empty(), "default branch is empty");
        let commits = Self::request(
            self.http
                .get(format!("{GITHUB_API_URL}/repos/{repo_full_name}/commits"))
                .query(&[("sha", default_branch), ("per_page", "1")]),
        )
        .bearer_auth(token.as_str())
        .send()
        .await
        .context("GitHub repository HEAD request failed")?
        .error_for_status()
        .context("GitHub repository HEAD request was rejected")?
        .json::<Vec<CommitResponse>>()
        .await
        .context("GitHub repository HEAD response was invalid")?;
        let sha = commits
            .into_iter()
            .next()
            .map(|commit| commit.sha)
            .context("GitHub repository HEAD response was empty")?;
        anyhow::ensure!(
            valid_git_sha(&sha),
            "GitHub repository HEAD SHA was invalid"
        );
        Ok(sha.to_ascii_lowercase())
    }

    /// Proves that this installation can still fetch the exact immutable
    /// commit used for pinned-content verification. This deliberately issues
    /// a fresh request: branch reachability and batch-cached HEAD resolution
    /// cannot distinguish a missing path from a revoked or garbage-collected
    /// pinned commit.
    pub(crate) async fn repository_commit_is_fetchable(
        &self,
        token: &GithubInstallationToken,
        repo_full_name: &str,
        sha: &str,
    ) -> Result<(), GithubPinnedCommitError> {
        self.repository_commit_is_fetchable_untyped(token, repo_full_name, sha)
            .await
            .map_err(GithubPinnedCommitError::from_source)
    }

    async fn repository_commit_is_fetchable_untyped(
        &self,
        token: &GithubInstallationToken,
        repo_full_name: &str,
        sha: &str,
    ) -> anyhow::Result<()> {
        validate_repo_full_name(repo_full_name)?;
        anyhow::ensure!(
            valid_git_sha(sha),
            "GitHub repository commit SHA was invalid"
        );
        Self::request(self.http.get(format!(
            "{GITHUB_API_URL}/repos/{repo_full_name}/commits/{sha}"
        )))
        .bearer_auth(token.as_str())
        .send()
        .await
        .context("GitHub pinned commit request failed")?
        .error_for_status()
        .context("GitHub pinned commit request was rejected")?;
        Ok(())
    }

    pub(crate) async fn repository_file_content(
        &self,
        token: &GithubInstallationToken,
        repo_full_name: &str,
        path: &str,
        sha: &str,
    ) -> Result<String, GithubFileContentError> {
        self.repository_file_content_untyped(token, repo_full_name, path, sha)
            .await
            .map_err(GithubFileContentError::from_source)
    }

    async fn repository_file_content_untyped(
        &self,
        token: &GithubInstallationToken,
        repo_full_name: &str,
        path: &str,
        sha: &str,
    ) -> anyhow::Result<String> {
        validate_repo_full_name(repo_full_name)?;
        anyhow::ensure!(valid_git_sha(sha), "GitHub repository file SHA was invalid");
        let path_segments = path.split('/').collect::<Vec<_>>();
        anyhow::ensure!(
            !path_segments.is_empty()
                && path_segments
                    .iter()
                    .all(|segment| !segment.is_empty() && *segment != "." && *segment != ".."),
            "GitHub repository file path was invalid"
        );
        let mut url = reqwest::Url::parse(&format!(
            "{GITHUB_API_URL}/repos/{repo_full_name}/contents/"
        ))
        .context("GitHub repository file URL was invalid")?;
        url.path_segments_mut()
            .map_err(|()| {
                anyhow::anyhow!("GitHub repository file URL cannot contain path segments")
            })?
            .extend(path_segments);
        let mut response = Self::request(self.http.get(url).query(&[("ref", sha)]))
            .header(reqwest::header::ACCEPT, GITHUB_RAW_CONTENT_ACCEPT)
            .bearer_auth(token.as_str())
            .send()
            .await
            .context("GitHub repository file request failed")?
            .error_for_status()
            .context("GitHub repository file request was rejected")?;
        let mut content = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .context("GitHub repository file response was invalid")?
        {
            anyhow::ensure!(
                content.len().saturating_add(chunk.len()) <= MAX_CODE_FILE_BYTES,
                "GitHub repository file exceeded the code-hint size limit"
            );
            content.extend_from_slice(&chunk);
        }
        String::from_utf8(content).context("GitHub repository file was not UTF-8")
    }

    pub(crate) async fn search_code(
        &self,
        token: &GithubInstallationToken,
        query: &str,
    ) -> Result<GithubCodeSearchResult, GithubCodeSearchError> {
        if query.trim().is_empty() || query.len() > 512 || query.chars().any(char::is_control) {
            return Err(GithubCodeSearchError::new(
                GithubCodeSearchFailureKind::InvalidRequest,
                GithubRateLimit::default(),
                anyhow::anyhow!("GitHub code-search query was invalid"),
            ));
        }
        let response = Self::request(
            self.http
                .get(format!("{GITHUB_API_URL}/search/code"))
                .query(&[("q", query), ("per_page", "10")]),
        )
        .header(reqwest::header::ACCEPT, GITHUB_CODE_SEARCH_ACCEPT)
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| {
            GithubCodeSearchError::from_request(error, "GitHub code-search request failed")
        })?;

        let status = response.status();
        let rate_limit = parse_rate_limit(response.headers(), Utc::now());
        if !status.is_success() {
            // Consume the bounded GitHub error body only for secondary-limit
            // classification. Do not retain it in the error: it can echo query
            // text and is unnecessary for diagnostics.
            let body = response.text().await.unwrap_or_default();
            let kind = code_search_failure_kind(status, &rate_limit, &body);
            return Err(GithubCodeSearchError::new(
                kind,
                rate_limit,
                anyhow::anyhow!("GitHub code-search request was rejected with status {status}"),
            ));
        }

        let search = response
            .json::<CodeSearchResponse>()
            .await
            .map_err(|error| {
                GithubCodeSearchError::new(
                    GithubCodeSearchFailureKind::InvalidResponse,
                    rate_limit.clone(),
                    anyhow::Error::new(error).context("GitHub code-search response was invalid"),
                )
            })?;
        Ok(GithubCodeSearchResult {
            candidates: search
                .items
                .into_iter()
                .flat_map(code_search_candidates)
                .take(CODE_SEARCH_RESULTS_PER_QUERY)
                .collect(),
            rate_limit,
        })
    }

    fn request(request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        request
            .header(reqwest::header::ACCEPT, GITHUB_ACCEPT)
            .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
            .header(reqwest::header::USER_AGENT, GITHUB_USER_AGENT)
    }
}

fn code_search_failure_kind(
    status: reqwest::StatusCode,
    rate_limit: &GithubRateLimit,
    body: &str,
) -> GithubCodeSearchFailureKind {
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || (status == reqwest::StatusCode::FORBIDDEN
            && (rate_limit.remaining == Some(0)
                || rate_limit.retry_after.is_some()
                || body.to_ascii_lowercase().contains("rate limit")))
    {
        GithubCodeSearchFailureKind::RateLimit
    } else if status == reqwest::StatusCode::FORBIDDEN {
        GithubCodeSearchFailureKind::Forbidden
    } else if status == reqwest::StatusCode::UNAUTHORIZED {
        GithubCodeSearchFailureKind::Unauthorized
    } else if status == reqwest::StatusCode::NOT_FOUND {
        GithubCodeSearchFailureKind::NotFound
    } else if status == reqwest::StatusCode::UNPROCESSABLE_ENTITY
        || status == reqwest::StatusCode::BAD_REQUEST
    {
        GithubCodeSearchFailureKind::InvalidRequest
    } else if status.is_server_error() {
        GithubCodeSearchFailureKind::Server
    } else {
        GithubCodeSearchFailureKind::Transport
    }
}

fn parse_rate_limit(headers: &reqwest::header::HeaderMap, now: DateTime<Utc>) -> GithubRateLimit {
    let remaining = header_str(headers, "x-ratelimit-remaining")
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value >= 0);
    let reset_at = header_str(headers, "x-ratelimit-reset")
        .and_then(|value| value.parse::<i64>().ok())
        .and_then(|timestamp| DateTime::from_timestamp(timestamp, 0));
    let retry_after = header_str(headers, reqwest::header::RETRY_AFTER.as_str())
        .and_then(|value| parse_retry_after(value, now));
    GithubRateLimit {
        remaining,
        reset_at,
        retry_after,
    }
}

fn header_str<'a>(headers: &'a reqwest::header::HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn parse_retry_after(value: &str, now: DateTime<Utc>) -> Option<StdDuration> {
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(StdDuration::from_secs(seconds));
    }
    DateTime::parse_from_rfc2822(value)
        .ok()
        .and_then(|retry_at| (retry_at.with_timezone(&Utc) - now).to_std().ok())
}

fn code_search_candidates(item: CodeSearchItem) -> Vec<GithubCodeSearchCandidate> {
    if item.text_matches.is_empty() {
        return vec![GithubCodeSearchCandidate {
            file: item.path,
            text_match: None,
        }];
    }
    item.text_matches
        .into_iter()
        .map(|text_match| GithubCodeSearchCandidate {
            file: item.path.clone(),
            text_match: Some(text_match),
        })
        .collect()
}

fn locate_text_match(content: &str, text_match: &CodeSearchTextMatch) -> Option<(u32, u32)> {
    if text_match.fragment.is_empty() || text_match.matches.is_empty() {
        return None;
    }
    let mut fragment_offsets = content.match_indices(&text_match.fragment);
    let (fragment_offset, _) = fragment_offsets.next()?;
    if fragment_offsets.next().is_some() {
        return None;
    }
    let start_character = text_match
        .matches
        .iter()
        .map(|matched| matched.indices[0])
        .min()?;
    let end_character = text_match
        .matches
        .iter()
        .map(|matched| matched.indices[1])
        .max()?;
    if start_character >= end_character {
        return None;
    }
    let start_offset = fragment_offset + character_offset(&text_match.fragment, start_character)?;
    let end_offset = fragment_offset + character_offset(&text_match.fragment, end_character)?;
    let line_start = line_number_at(content, start_offset)?;
    let final_character_offset = content[..end_offset].char_indices().next_back()?.0;
    let line_end = line_number_at(content, final_character_offset)?;
    Some((line_start, line_end.max(line_start)))
}

fn content_contains_fragment(content: &str, fragment: &str) -> bool {
    if fragment.is_empty() {
        return false;
    }
    if content.contains(fragment) {
        return true;
    }
    if !content.contains('\r') && !fragment.contains('\r') {
        return false;
    }
    normalize_line_endings(content).contains(&normalize_line_endings(fragment))
}

fn normalize_line_endings(value: &str) -> String {
    value.replace("\r\n", "\n").replace('\r', "\n")
}

fn character_offset(value: &str, character: usize) -> Option<usize> {
    if character == value.chars().count() {
        return Some(value.len());
    }
    value
        .char_indices()
        .nth(character)
        .map(|(offset, _)| offset)
}

fn line_number_at(content: &str, byte_offset: usize) -> Option<u32> {
    content.is_char_boundary(byte_offset).then_some(())?;
    u32::try_from(
        content[..byte_offset]
            .bytes()
            .filter(|byte| *byte == b'\n')
            .count()
            + 1,
    )
    .ok()
}

fn valid_git_sha(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn app_bot_login(app_slug: &str) -> String {
    format!("{app_slug}[bot]")
}

pub(crate) fn validate_repo_full_name(value: &str) -> anyhow::Result<()> {
    let mut parts = value.split('/');
    let owner = parts.next().unwrap_or_default();
    let repository = parts.next().unwrap_or_default();
    let valid_component = |component: &str| {
        !component.is_empty()
            && component != "."
            && component != ".."
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
            "./x",
            "x/.",
            "../x",
            "x/..",
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

    #[test]
    fn classifies_issue_creation_failures_by_certainty() {
        use reqwest::StatusCode;

        for status in [StatusCode::BAD_REQUEST, StatusCode::TOO_MANY_REQUESTS] {
            assert_eq!(
                issue_creation_failure_kind(Some(status), false, false).outcome(),
                GithubIssueCreationOutcome::DefiniteFailure
            );
        }
        assert_eq!(
            issue_creation_failure_kind(Some(StatusCode::BAD_GATEWAY), false, false).outcome(),
            GithubIssueCreationOutcome::AmbiguousFailure
        );
        assert_eq!(
            issue_creation_failure_kind(None, true, false).outcome(),
            GithubIssueCreationOutcome::AmbiguousFailure
        );
        assert_eq!(
            issue_creation_failure_kind(None, false, true).outcome(),
            GithubIssueCreationOutcome::AmbiguousFailure
        );
        assert_eq!(
            issue_creation_failure_kind(None, false, false).outcome(),
            GithubIssueCreationOutcome::AmbiguousFailure
        );
    }

    #[test]
    fn reconciliation_listing_uses_installation_bot_identity_and_inconclusive_failures() {
        use reqwest::StatusCode;

        assert_eq!(app_bot_login("epode-ai"), "epode-ai[bot]");
        assert_eq!(
            issue_list_failure_kind(Some(StatusCode::TOO_MANY_REQUESTS), false),
            GithubIssueListFailureKind::RateLimit
        );
        assert_eq!(
            issue_list_failure_kind(Some(StatusCode::NOT_FOUND), false),
            GithubIssueListFailureKind::NotFound
        );
        assert_eq!(
            issue_list_failure_kind(Some(StatusCode::BAD_GATEWAY), false),
            GithubIssueListFailureKind::Server
        );
        assert_eq!(
            issue_list_failure_kind(None, true),
            GithubIssueListFailureKind::Timeout
        );
        assert_eq!(
            issue_list_failure_kind(None, false),
            GithubIssueListFailureKind::Transport
        );
    }

    #[test]
    fn installation_token_debug_output_is_redacted() {
        let token = GithubInstallationToken("github_pat_secret".to_owned());

        let debug = format!("{token:?}");

        assert_eq!(debug, "GithubInstallationToken([redacted])");
        assert!(!debug.contains("github_pat_secret"));
    }

    #[test]
    fn parses_success_and_failure_rate_limit_headers() -> anyhow::Result<()> {
        let now =
            DateTime::from_timestamp(1_800_000_000, 0).context("test timestamp should be valid")?;
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("x-ratelimit-remaining", "7".parse()?);
        headers.insert("x-ratelimit-reset", "1800000060".parse()?);
        headers.insert(reqwest::header::RETRY_AFTER, "12".parse()?);

        let limit = parse_rate_limit(&headers, now);

        assert_eq!(limit.remaining, Some(7));
        assert_eq!(limit.reset_at, DateTime::from_timestamp(1_800_000_060, 0));
        assert_eq!(limit.retry_after, Some(StdDuration::from_secs(12)));
        Ok(())
    }

    #[test]
    fn parses_http_date_retry_after() -> anyhow::Result<()> {
        let now =
            DateTime::parse_from_rfc2822("Wed, 21 Oct 2015 07:27:00 GMT")?.with_timezone(&Utc);

        assert_eq!(
            parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT", now),
            Some(StdDuration::from_mins(1))
        );
        Ok(())
    }

    #[test]
    fn code_search_distinguishes_forbidden_from_rate_limits() {
        use reqwest::StatusCode;

        let available = GithubRateLimit {
            remaining: Some(8),
            ..GithubRateLimit::default()
        };
        assert_eq!(
            code_search_failure_kind(StatusCode::FORBIDDEN, &available, "Resource not accessible"),
            GithubCodeSearchFailureKind::Forbidden
        );
        assert_eq!(
            code_search_failure_kind(
                StatusCode::FORBIDDEN,
                &GithubRateLimit {
                    remaining: Some(0),
                    ..GithubRateLimit::default()
                },
                ""
            ),
            GithubCodeSearchFailureKind::RateLimit
        );
        assert_eq!(
            code_search_failure_kind(
                StatusCode::FORBIDDEN,
                &available,
                "You have exceeded a secondary rate limit"
            ),
            GithubCodeSearchFailureKind::RateLimit
        );
        assert_eq!(
            code_search_failure_kind(StatusCode::TOO_MANY_REQUESTS, &available, ""),
            GithubCodeSearchFailureKind::RateLimit
        );
        assert_eq!(
            code_search_failure_kind(StatusCode::UNAUTHORIZED, &available, ""),
            GithubCodeSearchFailureKind::Unauthorized
        );
        assert_eq!(
            code_search_failure_kind(StatusCode::CONFLICT, &available, ""),
            GithubCodeSearchFailureKind::Transport
        );
        assert_eq!(
            code_search_failure_kind(StatusCode::UNPROCESSABLE_ENTITY, &available, ""),
            GithubCodeSearchFailureKind::InvalidRequest
        );
    }

    #[test]
    fn captured_code_search_text_match_resolves_against_pinned_file_content() -> anyhow::Result<()>
    {
        // Shape captured from GitHub's text-match response contract. The
        // indices are character offsets inside the fragment, not file lines.
        let response = serde_json::from_value::<CodeSearchResponse>(serde_json::json!({
            "total_count": 1,
            "incomplete_results": false,
            "items": [{
                "name": "store.rs",
                "path": "backend/src/store.rs",
                "sha": "0123456789abcdef0123456789abcdef01234567",
                "url": "https://api.github.com/repositories/1/contents/backend/src/store.rs",
                "git_url": "https://api.github.com/repositories/1/git/blobs/abc",
                "html_url": "https://github.com/open-software/epode/blob/main/backend/src/store.rs",
                "repository": { "id": 1, "name": "epode", "full_name": "open-software/epode" },
                "score": 1.0,
                "text_matches": [{
                    "object_url": "https://api.github.com/repositories/1/contents/backend/src/store.rs",
                    "object_type": "FileContent",
                    "property": "content",
                    "fragment": "pub async fn submit_product_feedback(\n    pool: &PgPool,\n)",
                    "matches": [{
                        "text": "submit_product_feedback",
                        "indices": [13, 36]
                    }]
                }]
            }]
        }))?;
        let candidates = response
            .items
            .into_iter()
            .flat_map(code_search_candidates)
            .collect::<Vec<_>>();
        let content = "use sqlx::PgPool;\n\npub async fn submit_product_feedback(\n    pool: &PgPool,\n) {}\n";

        assert_eq!(
            candidates[0].clone().verify_against_pinned_content(content),
            Some(CodeSearchCandidate {
                file: "backend/src/store.rs".to_owned(),
                line_start: Some(3),
                line_end: Some(3),
                verification: CodeSearchVerification::Verified,
            })
        );
        Ok(())
    }

    #[test]
    fn no_fragment_needs_no_content_and_ambiguous_fragment_is_verified_without_a_range() {
        let fragmentless = code_search_candidates(CodeSearchItem {
            path: "src/fallback.rs".to_owned(),
            text_matches: Vec::new(),
        });
        assert!(!fragmentless[0].needs_content());
        let duplicate = GithubCodeSearchCandidate {
            file: "src/duplicate.rs".to_owned(),
            text_match: Some(CodeSearchTextMatch {
                fragment: "needle".to_owned(),
                matches: vec![CodeSearchTextMatchOccurrence { indices: [0, 6] }],
            }),
        };
        assert_eq!(
            duplicate.verify_against_pinned_content("needle\nneedle\n"),
            Some(CodeSearchCandidate {
                file: "src/duplicate.rs".to_owned(),
                line_start: None,
                line_end: None,
                verification: CodeSearchVerification::Verified,
            })
        );
    }

    #[test]
    fn text_match_indices_are_character_offsets() {
        let candidate = GithubCodeSearchCandidate {
            file: "src/unicode.rs".to_owned(),
            text_match: Some(CodeSearchTextMatch {
                fragment: "fn café_lookup()".to_owned(),
                matches: vec![CodeSearchTextMatchOccurrence { indices: [3, 7] }],
            }),
        };

        assert_eq!(
            candidate.verify_against_pinned_content("// unicode\nfn café_lookup() {}\n"),
            Some(CodeSearchCandidate {
                file: "src/unicode.rs".to_owned(),
                line_start: Some(2),
                line_end: Some(2),
                verification: CodeSearchVerification::Verified,
            })
        );
    }

    #[test]
    fn branch_advanced_search_fragment_absent_at_pinned_sha_is_dropped() {
        let stale_search_hit = GithubCodeSearchCandidate {
            file: "src/old-module.rs".to_owned(),
            text_match: Some(CodeSearchTextMatch {
                fragment: "fn removed_after_search_indexed()".to_owned(),
                matches: vec![CodeSearchTextMatchOccurrence { indices: [3, 31] }],
            }),
        };
        let pinned_content = "fn replacement_at_pinned_sha() {}\n";

        assert_eq!(
            stale_search_hit.verify_against_pinned_content(pinned_content),
            None
        );
    }

    #[test]
    fn crlf_fragment_presence_is_verified_even_when_range_math_cannot_resolve_it() {
        let candidate = GithubCodeSearchCandidate {
            file: "src/windows.rs".to_owned(),
            text_match: Some(CodeSearchTextMatch {
                fragment: "fn windows() {\n    run();\n}".to_owned(),
                matches: vec![CodeSearchTextMatchOccurrence { indices: [3, 10] }],
            }),
        };

        assert_eq!(
            candidate.verify_against_pinned_content("fn windows() {\r\n    run();\r\n}\r\n"),
            Some(CodeSearchCandidate {
                file: "src/windows.rs".to_owned(),
                line_start: None,
                line_end: None,
                verification: CodeSearchVerification::Verified,
            })
        );
    }

    #[test]
    fn size_and_encoding_failures_cannot_be_mistaken_for_absence() {
        for error in [
            anyhow::anyhow!("GitHub repository file exceeded the code-hint size limit"),
            anyhow::anyhow!("GitHub repository file was not UTF-8"),
        ] {
            assert_eq!(
                github_file_content_failure_kind(&error),
                GithubFileContentFailureKind::InvalidResponse
            );
        }
    }

    #[test]
    fn file_content_status_survives_anyhow_context_for_typed_classification() -> anyhow::Result<()>
    {
        for (status, expected) in [
            (
                reqwest::StatusCode::NOT_FOUND,
                GithubFileContentFailureKind::NotFound,
            ),
            (
                reqwest::StatusCode::UNAUTHORIZED,
                GithubFileContentFailureKind::Unauthorized,
            ),
            (
                reqwest::StatusCode::FORBIDDEN,
                GithubFileContentFailureKind::Forbidden,
            ),
            (
                reqwest::StatusCode::INTERNAL_SERVER_ERROR,
                GithubFileContentFailureKind::Server,
            ),
        ] {
            let response = reqwest::Response::from(
                axum::http::Response::builder()
                    .status(status)
                    .body("request failed")?,
            );
            let Err(request_error) = response.error_for_status() else {
                anyhow::bail!("error status should produce a reqwest error");
            };
            let error = anyhow::Error::new(request_error)
                .context("GitHub repository file request was rejected");

            assert_eq!(github_file_content_failure_kind(&error), expected);
        }
        Ok(())
    }

    #[test]
    fn pinned_commit_404_is_terminal_counted_but_transient_failures_are_not() -> anyhow::Result<()>
    {
        for (status, expected, counts_toward_ceiling) in [
            (
                reqwest::StatusCode::NOT_FOUND,
                GithubPinnedCommitFailureKind::NotFound,
                true,
            ),
            (
                reqwest::StatusCode::UNAUTHORIZED,
                GithubPinnedCommitFailureKind::Unauthorized,
                false,
            ),
            (
                reqwest::StatusCode::FORBIDDEN,
                GithubPinnedCommitFailureKind::Forbidden,
                false,
            ),
            (
                reqwest::StatusCode::INTERNAL_SERVER_ERROR,
                GithubPinnedCommitFailureKind::Server,
                false,
            ),
        ] {
            let response = reqwest::Response::from(
                axum::http::Response::builder()
                    .status(status)
                    .body("request failed")?,
            );
            let Err(request_error) = response.error_for_status() else {
                anyhow::bail!("error status should produce a reqwest error");
            };
            let error = anyhow::Error::new(request_error)
                .context("GitHub pinned commit request was rejected");
            let kind = github_pinned_commit_failure_kind(&error);

            assert_eq!(kind, expected);
            assert_eq!(
                kind.counts_toward_verification_ceiling(),
                counts_toward_ceiling
            );
        }
        for transient_kind in [
            GithubPinnedCommitFailureKind::Unauthorized,
            GithubPinnedCommitFailureKind::Forbidden,
            GithubPinnedCommitFailureKind::Server,
            GithubPinnedCommitFailureKind::Timeout,
            GithubPinnedCommitFailureKind::InvalidResponse,
            GithubPinnedCommitFailureKind::Transport,
        ] {
            assert!(!transient_kind.counts_toward_verification_ceiling());
        }
        Ok(())
    }

    #[test]
    fn validates_repository_head_sha_shape() {
        assert!(valid_git_sha("0123456789abcdef0123456789abcdef01234567"));
        assert!(valid_git_sha("0123456789ABCDEF0123456789ABCDEF01234567"));
        assert!(!valid_git_sha("main"));
        assert!(!valid_git_sha("g123456789abcdef0123456789abcdef01234567"));
    }
}
