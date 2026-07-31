#![allow(
    clippy::redundant_pub_crate,
    reason = "crate-restricted visibility satisfies unreachable_pub in this binary-only crate"
)]

use std::fmt::Write as _;

use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;

const GITHUB_BODY_LIMIT: usize = 65_536;
const MAX_FINDING_GROUPS: usize = 25;
const MAX_DETAILS_PER_FINDING: usize = 3;
const MAX_WORKAROUNDS: usize = 20;
const MAX_WHERE_VALUES: usize = 20;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IssueCount {
    pub(crate) value: String,
    pub(crate) count: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IssueFindingRollup {
    pub(crate) kind: String,
    pub(crate) topic: String,
    pub(crate) count: i64,
    pub(crate) detail_count: i64,
    pub(crate) details: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct IssueTemplateData {
    pub(crate) group_key: String,
    pub(crate) explanation: String,
    pub(crate) primary_kind: String,
    pub(crate) primary_topic: String,
    pub(crate) primary_operation: String,
    pub(crate) impacts: Vec<IssueCount>,
    pub(crate) findings: Vec<IssueFindingRollup>,
    pub(crate) workarounds: Vec<Value>,
    pub(crate) operations: Vec<String>,
    pub(crate) surfaces: Vec<String>,
    pub(crate) status_codes: Vec<i32>,
    pub(crate) earliest_occurred_at: Option<DateTime<Utc>>,
    pub(crate) latest_occurred_at: Option<DateTime<Utc>>,
    pub(crate) report_count: i64,
    pub(crate) backlink: String,
}

pub(crate) fn render_issue_title(data: &IssueTemplateData) -> String {
    let title = format!(
        "[epode] {}: {} in {}",
        safe_customer_title_text(&data.primary_kind, 40),
        safe_customer_title_text(&data.primary_topic, 48),
        safe_customer_title_text(&data.primary_operation, 48)
    );
    truncate_chars(&title, 120)
}

pub(crate) fn render_issue_body(data: &IssueTemplateData) -> String {
    let mut body = String::new();
    let _ = writeln!(
        body,
        "{}",
        safe_customer_inline_text(&data.explanation, 1_000)
    );

    body.push_str("\n## Impact\n");
    if data.impacts.is_empty() {
        body.push_str("- No impact reported.\n");
    } else {
        for impact in data.impacts.iter().take(20) {
            let _ = writeln!(
                body,
                "- {}: {}",
                safe_customer_inline_text(&impact.value, 100),
                impact.count
            );
        }
        append_more_line(&mut body, data.impacts.len(), 20, "impact values");
    }

    body.push_str("\n## Findings\n");
    if data.findings.is_empty() {
        body.push_str("- No findings reported.\n");
    } else {
        for finding in data.findings.iter().take(MAX_FINDING_GROUPS) {
            let _ = writeln!(
                body,
                "- `{}/{}`: {} report(s)",
                clean_code_text(&finding.kind, 100),
                clean_code_text(&finding.topic, 100),
                finding.count
            );
            let mut emitted = 0_i64;
            let mut sensitive = 0_i64;
            let mut seen_details = Vec::new();
            for detail in &finding.details {
                if seen_details.contains(&detail.as_str()) {
                    continue;
                }
                seen_details.push(detail.as_str());
                if contains_sensitive_report_text(detail) {
                    sensitive += 1;
                    continue;
                }
                render_fenced_detail(&mut body, "  ", "Detail", detail, 300);
                emitted += 1;
                if emitted >= i64::try_from(MAX_DETAILS_PER_FINDING).unwrap_or(i64::MAX) {
                    break;
                }
            }
            if sensitive > 0 {
                let _ = writeln!(body, "  - {sensitive} sensitive detail(s) omitted.");
            }
            let remaining = finding
                .detail_count
                .saturating_sub(emitted)
                .saturating_sub(sensitive);
            if remaining > 0 {
                let _ = writeln!(body, "  - … and {remaining} more detail(s).");
            }
        }
        append_more_line(
            &mut body,
            data.findings.len(),
            MAX_FINDING_GROUPS,
            "finding groups",
        );
    }

    body.push_str("\n## Workaround\n");
    if data.workarounds.is_empty() {
        body.push_str("- No workaround reported.\n");
    } else {
        for workaround in data.workarounds.iter().take(MAX_WORKAROUNDS) {
            render_workaround(&mut body, workaround);
        }
        append_more_line(
            &mut body,
            data.workarounds.len(),
            MAX_WORKAROUNDS,
            "workarounds",
        );
    }

    body.push_str("\n## Where\n");
    let _ = writeln!(
        body,
        "- Operation: {}",
        render_values(&data.operations, MAX_WHERE_VALUES)
    );
    let _ = writeln!(
        body,
        "- Surface: {}",
        render_values(&data.surfaces, MAX_WHERE_VALUES)
    );
    let statuses = if data.status_codes.is_empty() {
        "none".to_owned()
    } else {
        data.status_codes
            .iter()
            .map(i32::to_string)
            .collect::<Vec<_>>()
            .join(", ")
    };
    let _ = writeln!(body, "- Status codes: {statuses}");

    body.push_str("\n## When\n");
    let range = match (data.earliest_occurred_at, data.latest_occurred_at) {
        (Some(earliest), Some(latest)) => format!(
            "{} → {}",
            format_occurred_at(earliest),
            format_occurred_at(latest)
        ),
        _ => "No occurrence time available.".to_owned(),
    };
    let _ = writeln!(body, "{range}");

    body.push_str("\n## Volume\n");
    let _ = writeln!(body, "{} report(s)", data.report_count);

    let group_key = group_marker(&data.group_key);
    let backlink = clean_link(&data.backlink);
    let footer = issue_footer(&group_key, &backlink);
    body.push_str(&footer);
    cap_body(body, &footer)
}

pub(crate) fn render_evidence_comment(
    new_report_count: i64,
    earliest: Option<DateTime<Utc>>,
    latest: Option<DateTime<Utc>>,
) -> String {
    let range = match (earliest, latest) {
        (Some(earliest), Some(latest)) => format!(
            "{} → {}",
            format_occurred_at(earliest),
            format_occurred_at(latest)
        ),
        _ => "occurrence time unavailable".to_owned(),
    };
    format!("{new_report_count} new report(s) since the last update ({range}).")
}

pub(crate) fn group_backlink(web_app_url: &str, group_key: &str) -> String {
    format!(
        "{}/?view=feedback&group={}",
        web_app_url.trim_end_matches('/'),
        group_key
    )
}

/// Encodes every UTF-8 byte into one alphanumeric GitHub-search token.
///
/// This is reversible rather than lossy or hashed: distinct group keys cannot
/// collide, while the `g` prefix plus lowercase hex is safe in both an HTML
/// comment and an unquoted GitHub search qualifier.
pub(crate) fn group_marker(group_key: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut marker = String::with_capacity(1 + group_key.len() * 2);
    marker.push('g');
    for byte in group_key.bytes() {
        marker.push(char::from(HEX[usize::from(byte >> 4)]));
        marker.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    marker
}

pub(crate) fn contains_sensitive_report_text(value: &str) -> bool {
    // Shape detection needs the original casing — lowercasing first would erase
    // the mixed-case signal that distinguishes a credential from an identifier.
    let original = value;
    let value = value.to_ascii_lowercase();
    let forbidden_pattern = [
        "af_live_",
        "af_read_",
        "github_pat_",
        "ghp_",
        "gho_",
        "ghs_",
        "ghr_",
        "akia",
        "asia",
        "-----begin ",
        "xoxb-",
        "xoxp-",
        "xoxa-",
        "xapp-",
        "sk-proj-",
        "sk-ant-",
        "api key",
        "apikey",
        "api_key",
        "secret",
        "password",
        "passwd",
        "authorization:",
        "transcript:",
        "prompt:",
        "raw input:",
        "raw output:",
    ]
    .iter()
    .any(|pattern| value.contains(pattern));
    let email_like = value.split_whitespace().any(|word| {
        let trimmed = word.trim_matches(|character: char| {
            !character.is_ascii_alphanumeric() && !"@._+-".contains(character)
        });
        trimmed
            .split_once('@')
            .is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.'))
    });
    let bearer_credential = value.match_indices("bearer ").any(|(index, _)| {
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
    });
    let secret_shaped = original.split_whitespace().any(looks_like_secret_token);
    forbidden_pattern || bearer_credential || email_like || secret_shaped
}

/// Fails closed on credential-shaped tokens the prefix list does not know.
///
/// Matching only known prefixes lets any unrecognised or future credential
/// format through into a public issue body, so shape is checked too. The
/// signal is deliberately narrow to avoid redacting ordinary text: an opaque
/// run of at least 32 characters with letters, digits and high per-character
/// entropy. Pure alphanumeric tokens are case-independent; identifier-shaped
/// strings containing `_`, `-`, or `.` retain the stricter mixed-case/hex rule
/// so ordinary long log identifiers remain useful.
fn looks_like_secret_token(word: &str) -> bool {
    const MIN_TOKEN_LEN: usize = 32;
    const MIN_ENTROPY_BITS: f64 = 3.0;

    let token = word.trim_matches(|character: char| {
        !character.is_ascii_alphanumeric() && !"-._~+/=".contains(character)
    });
    if token.len() < MIN_TOKEN_LEN {
        return false;
    }
    // A URL is not a credential; its query string is handled by the caller's
    // other checks.
    if token.contains("://") {
        return false;
    }
    if !token
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "-._~+/=".contains(character))
    {
        return false;
    }

    let hex_like = token
        .chars()
        .all(|character| character.is_ascii_hexdigit() || character == '-');
    let has_letter = token.chars().any(|c| c.is_ascii_alphabetic());
    let has_digit = token.chars().any(|c| c.is_ascii_digit());
    let mixed_case_with_digits = token.chars().any(|c| c.is_ascii_lowercase())
        && token.chars().any(|c| c.is_ascii_uppercase())
        && has_digit;
    let has_identifier_separator = token.bytes().any(|byte| matches!(byte, b'_' | b'-' | b'.'));
    let pure_alphanumeric =
        !has_identifier_separator && token.bytes().all(|byte| byte.is_ascii_alphanumeric());
    let case_independent_alphanumeric = pure_alphanumeric && has_letter && has_digit;
    if !hex_like && !mixed_case_with_digits && !case_independent_alphanumeric {
        return false;
    }

    shannon_entropy_bits_per_char(token) >= MIN_ENTROPY_BITS
}

/// Shannon entropy per character, used to separate opaque credentials from
/// repetitive strings of the same shape (`aaaa…` is hex-like but not a secret).
fn shannon_entropy_bits_per_char(value: &str) -> f64 {
    let mut counts = [0_u32; 256];
    let mut total = 0_u32;
    for byte in value.bytes() {
        counts[usize::from(byte)] += 1;
        total += 1;
    }
    if total == 0 {
        return 0.0;
    }
    let total_bits = f64::from(total);
    counts
        .iter()
        .filter(|&&count| count > 0)
        .map(|&count| {
            let probability = f64::from(count) / total_bits;
            -probability * probability.log2()
        })
        .sum()
}

fn render_workaround(body: &mut String, workaround: &Value) {
    let used = workaround.get("used").and_then(Value::as_bool);
    let detail = workaround.get("detail").and_then(Value::as_str);
    match detail {
        Some(detail) if contains_sensitive_report_text(detail) => {
            let _ = writeln!(
                body,
                "- {} Sensitive detail omitted.",
                if used == Some(true) {
                    "Used."
                } else {
                    "Reported."
                }
            );
        }
        Some(detail) => {
            render_fenced_detail(
                body,
                "",
                if used == Some(true) {
                    "Used"
                } else {
                    "Reported"
                },
                detail,
                350,
            );
        }
        None => {
            let _ = writeln!(
                body,
                "- {}",
                if used == Some(true) {
                    "A workaround was used; no detail was provided."
                } else {
                    "No workaround was used."
                }
            );
        }
    }
}

fn render_values(values: &[String], limit: usize) -> String {
    if values.is_empty() {
        return "unknown".to_owned();
    }
    let mut rendered = values
        .iter()
        .take(limit)
        .map(|value| safe_customer_inline_text(value, 100))
        .collect::<Vec<_>>()
        .join(", ");
    if values.len() > limit {
        let _ = write!(rendered, ", … and {} more", values.len() - limit);
    }
    rendered
}

fn append_more_line(body: &mut String, actual: usize, shown: usize, noun: &str) {
    if actual > shown {
        let _ = writeln!(body, "- … and {} more {noun}.", actual - shown);
    }
}

fn clean_text(value: &str, max_chars: usize) -> String {
    truncate_chars(
        &value.split_whitespace().collect::<Vec<_>>().join(" "),
        max_chars,
    )
}

fn safe_customer_title_text(value: &str, max_chars: usize) -> String {
    if contains_sensitive_report_text(value) {
        return "[redacted]".to_owned();
    }
    neutralize_github_references(&clean_text(value, max_chars))
}

fn safe_customer_inline_text(value: &str, max_chars: usize) -> String {
    if contains_sensitive_report_text(value) {
        return "[redacted]".to_owned();
    }
    let value = neutralize_github_references(&clean_text(value, max_chars));
    let mut escaped = String::with_capacity(value.len());
    for (index, character) in value.chars().enumerate() {
        if matches!(
            character,
            '\\' | '`' | '*' | '_' | '~' | '[' | ']' | '(' | ')' | '<' | '>' | '|' | '!'
        ) || (index == 0 && matches!(character, '-' | '+' | '>'))
        {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

fn clean_code_text(value: &str, max_chars: usize) -> String {
    if contains_sensitive_report_text(value) {
        return "redacted".to_owned();
    }
    neutralize_github_references(&clean_text(value, max_chars)).replace('`', "'")
}

fn neutralize_github_references(value: &str) -> String {
    value
        .replace('@', "@\u{200b}")
        .replace('#', "#\u{200b}")
        .replace("://", ":\u{200b}//")
        .replace("www.", "www\u{200b}.")
}

fn render_fenced_detail(
    body: &mut String,
    prefix: &str,
    label: &str,
    detail: &str,
    max_chars: usize,
) {
    let detail = clean_text(&detail.replace("```", ""), max_chars);
    let indent = format!("{prefix}  ");
    let _ = writeln!(body, "{prefix}- {label}:");
    let _ = writeln!(body, "{indent}```text");
    let _ = writeln!(body, "{indent}{detail}");
    let _ = writeln!(body, "{indent}```");
}

fn clean_link(value: &str) -> String {
    truncate_chars(&value.replace(['(', ')', ' '], ""), 2_048)
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_owned();
    }
    let mut truncated = value
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    truncated.push('…');
    truncated
}

fn issue_footer(group_key: &str, backlink: &str) -> String {
    format!(
        "\n\n<!-- epode-group: {group_key} -->\n\n[View this feedback group in Epode]({backlink})"
    )
}

fn cap_body(mut body: String, footer: &str) -> String {
    if body.len() <= GITHUB_BODY_LIMIT {
        return body;
    }
    let suffix = format!("\n\n… and additional content was omitted.{footer}");
    // Reserve room for a closing fence as well: customer text is rendered
    // inside ```text blocks, so a cut can land inside an open one.
    let fence_close = "\n```";
    let prefix_limit = GITHUB_BODY_LIMIT.saturating_sub(suffix.len() + fence_close.len());
    let mut boundary = prefix_limit.min(body.len());
    while !body.is_char_boundary(boundary) {
        boundary = boundary.saturating_sub(1);
    }
    body.truncate(boundary);
    // An odd number of fences means the truncation landed inside a block; close
    // it so the omission notice and the backlink render as text and a clickable
    // link rather than as more code.
    if body.matches("```").count() % 2 == 1 {
        body.push_str(fence_close);
    }
    body.push_str(&suffix);
    body
}

fn format_occurred_at(value: DateTime<Utc>) -> String {
    value.format("%Y-%m-%d %H:%M:%S UTC").to_string()
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "fixed timestamps in unit tests should fail at their construction site"
    )]

    use chrono::TimeZone as _;
    use serde_json::json;

    use super::*;

    fn timestamp(hour: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 7, 31, hour, 2, 3)
            .single()
            .expect("test timestamp is valid")
    }

    fn template() -> IssueTemplateData {
        IssueTemplateData {
            group_key: "0123456789abcdef0123456789abcdef".to_owned(),
            explanation: "A stable feedback group.".to_owned(),
            primary_kind: "defect".to_owned(),
            primary_topic: "authentication".to_owned(),
            primary_operation: "create_session".to_owned(),
            impacts: vec![IssueCount {
                value: "blocked".to_owned(),
                count: 2,
            }],
            findings: vec![IssueFindingRollup {
                kind: "defect".to_owned(),
                topic: "authentication".to_owned(),
                count: 2,
                detail_count: 1,
                details: vec!["Valid credentials were rejected.".to_owned()],
            }],
            workarounds: vec![json!({"used": true, "detail": "Retried once."})],
            operations: vec!["create_session".to_owned()],
            surfaces: vec!["mcp".to_owned()],
            status_codes: vec![401, 503],
            earliest_occurred_at: Some(timestamp(1)),
            latest_occurred_at: Some(timestamp(4)),
            report_count: 2,
            backlink: "https://app.epode.test/?view=feedback&group=group-key".to_owned(),
        }
    }

    #[test]
    fn issue_template_has_every_section_in_order_and_formats_range_and_statuses() {
        let data = template();
        let body = render_issue_body(&data);
        let headings = [
            "## Impact",
            "## Findings",
            "## Workaround",
            "## Where",
            "## When",
            "## Volume",
        ];
        let mut previous = 0;
        for heading in headings {
            let index = body.find(heading).expect("section should be present");
            assert!(index >= previous);
            previous = index;
        }
        assert!(body.contains("Status codes: 401, 503"));
        assert!(body.contains("2026-07-31 01:02:03 UTC → 2026-07-31 04:02:03 UTC"));
        assert!(body.contains(&data.backlink));
        assert!(body.contains(&format!(
            "<!-- epode-group: {} -->",
            group_marker(&data.group_key)
        )));
        assert_eq!(
            render_issue_title(&data),
            "[epode] defect: authentication in create_session"
        );
    }

    #[test]
    fn issue_template_handles_empty_findings_and_missing_workaround() {
        let mut data = template();
        data.findings.clear();
        data.workarounds.clear();
        let body = render_issue_body(&data);
        assert!(body.contains("No findings reported."));
        assert!(body.contains("No workaround reported."));
    }

    #[test]
    fn issue_template_caps_large_groups_and_marks_omitted_finding_groups() {
        let mut data = template();
        data.findings = (0..2_000)
            .map(|index| IssueFindingRollup {
                kind: "defect".to_owned(),
                topic: format!("topic_{index}"),
                count: 1,
                detail_count: 4,
                details: vec!["x".repeat(1_000); 4],
            })
            .collect();
        let body = render_issue_body(&data);
        assert!(body.len() <= GITHUB_BODY_LIMIT);
        assert!(body.contains("… and 1975 more finding groups."));
        assert!(body.contains("… and 3 more detail(s)."));
    }

    #[test]
    fn capped_body_closes_open_fences_so_the_backlink_stays_clickable() {
        // A cut inside a ```text block would otherwise render the omission
        // notice and the backlink as code instead of a link.
        let open_fence_body = format!("intro\n\n```text\n{}\n", "x".repeat(GITHUB_BODY_LIMIT));
        let capped = cap_body(
            open_fence_body,
            &issue_footer(
                &group_marker("0123456789abcdef0123456789abcdef"),
                "https://app.example/?view=feedback&group=abc",
            ),
        );

        assert!(capped.len() <= GITHUB_BODY_LIMIT);
        assert_eq!(
            capped.matches("```").count() % 2,
            0,
            "every fence opened in the capped body must also be closed"
        );
        assert!(capped.ends_with(
            "[View this feedback group in Epode](https://app.example/?view=feedback&group=abc)"
        ));
        assert!(capped.contains(&format!(
            "<!-- epode-group: {} -->",
            group_marker("0123456789abcdef0123456789abcdef")
        )));
        assert!(capped.contains("… and additional content was omitted."));
    }

    #[test]
    fn sensitive_guard_fails_closed_on_unrecognised_credential_shapes() {
        // None of these carry a prefix the allowlist knows; they must still be
        // caught on shape alone, or they reach a public issue body.
        for secret in [
            "Token was Zx8Qp2LmVn4TbW9yRc6HdKe1JgAo5UfS",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r",
            "digest 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
            "digest 9F86D081884C7D659A2FEAA0C55AD015A3BF4F1B2B0B822CD15D6C15B0F00A08",
            "token mfrggzdfmztwq2lknnwg23tpobyxg43u",
            "token MFRGGZDFMZTWQ2LKNNWG23TPOBYXG43U",
            "token Zx8Qp2LmVn4TbW9yRc6HdKe1JgAo5UfS",
        ] {
            assert!(
                contains_sensitive_report_text(secret),
                "expected redaction for: {secret}"
            );
        }
    }

    #[test]
    fn sensitive_guard_does_not_redact_ordinary_report_text() {
        // Long identifiers and prose must survive; over-redacting would gut the
        // issue body that makes filing useful.
        for benign in [
            "The search_reports operation returned a 503 after retrying three times",
            "Handler com.example.service.internal.SearchReportsController failed",
            "error_code_5xx_timeout_exceeded_during_retry_backoff_window",
            "lowercase_identifier_1234_with_underscores_5678",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ] {
            assert!(
                !contains_sensitive_report_text(benign),
                "unexpected redaction for: {benign}"
            );
        }
    }

    #[test]
    fn issue_marker_writer_and_searcher_use_identical_separator_safe_tokens() {
        for group_key in [
            "abc-def-012",
            "123e4567-e89b-12d3-a456-426614174000",
            "v2:abcdef0123",
            "abc_def_012",
        ] {
            let mut data = template();
            data.group_key = group_key.to_owned();
            let body = render_issue_body(&data);
            let body_marker = body
                .split_once("<!-- epode-group: ")
                .and_then(|(_, suffix)| suffix.split_once(" -->"))
                .map(|(marker, _)| marker)
                .expect("rendered issue body should carry a group marker");
            let query = crate::github::issue_search_query("owner/repository", group_key);
            let query_marker = query
                .rsplit_once(" in:body ")
                .map(|(_, marker)| marker)
                .expect("reconciliation query should search one body marker");
            let expected = group_marker(group_key);

            assert_eq!(
                body_marker.as_bytes(),
                query_marker.as_bytes(),
                "{group_key}"
            );
            assert_eq!(body_marker, expected);
            assert!(body_marker.bytes().all(|byte| byte.is_ascii_alphanumeric()));
        }

        assert_ne!(group_marker("abc-def"), group_marker("abcdef"));
        assert_ne!(group_marker("abc_def"), group_marker("abcdef"));
    }

    #[test]
    fn issue_template_omits_sensitive_details() {
        let mut data = template();
        data.findings[0].detail_count = 2;
        data.findings[0].details = vec![
            "The response exposed customer@example.com".to_owned(),
            "The token was mfrggzdfmztwq2lknnwg23tpobyxg43u".to_owned(),
        ];
        data.workarounds = vec![json!({"used": true, "detail": "Use github_pat_not_a_real_token"})];
        let body = render_issue_body(&data);
        assert!(!body.contains("customer@example.com"));
        assert!(!body.contains("mfrggzdfmztwq2lknnwg23tpobyxg43u"));
        assert!(!body.contains("github_pat_"));
        assert!(body.contains("sensitive detail(s) omitted"));
        assert!(body.contains("Sensitive detail omitted"));
    }

    #[test]
    fn issue_template_redacts_sensitive_operation_and_other_inline_fields() {
        let mut data = template();
        let secret = "GET /sessions?key=af_live_not_a_real_secret";
        data.explanation = format!("operation {secret}");
        data.primary_operation = secret.to_owned();
        data.operations = vec![secret.to_owned()];
        data.surfaces = vec!["github_pat_not_a_real_token".to_owned()];
        data.primary_topic = "sk-proj-not-a-real-key".to_owned();
        data.findings[0].topic = "sk-proj-not-a-real-key".to_owned();

        let title = render_issue_title(&data);
        let body = render_issue_body(&data);
        for sensitive in ["af_live_", "github_pat_", "sk-proj-"] {
            assert!(!title.contains(sensitive));
            assert!(!body.contains(sensitive));
        }
        assert!(title.contains("[redacted]"));
        assert!(body.contains("[redacted]"));
    }

    #[test]
    fn issue_template_neutralizes_inline_markdown_and_fences_free_text() {
        let mut data = template();
        data.explanation = "# heading @ops [link](https://example.test)".to_owned();
        data.operations = vec!["> quoted @ops #123".to_owned()];
        data.findings[0].details =
            vec!["@ops [link](https://example.test) ``` ## forged".to_owned()];
        data.workarounds =
            vec![json!({"used": true, "detail": "@ops ``` [link](https://example.test)"})];

        let body = render_issue_body(&data);
        let summary = body.lines().next().expect("summary line should exist");
        assert!(summary.starts_with("#\u{200b} heading"));
        assert!(!summary.starts_with("# "));
        assert!(!summary.contains("@ops"));
        assert!(summary.contains("@\u{200b}ops"));
        assert!(summary.contains("\\[link\\]\\(https:\u{200b}//example.test\\)"));
        assert!(!summary.contains("https://"));
        assert_eq!(body.matches("```").count(), 4);
        assert!(body.contains("```text"));
    }

    #[test]
    fn backlink_uses_the_configured_app_host() {
        assert_eq!(
            group_backlink("https://app.epode.test/", "abc123"),
            "https://app.epode.test/?view=feedback&group=abc123"
        );
    }
}
