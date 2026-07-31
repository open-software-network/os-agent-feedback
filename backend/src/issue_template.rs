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
        clean_markdown_text(&data.primary_kind, 40),
        clean_markdown_text(&data.primary_topic, 48),
        clean_markdown_text(&data.primary_operation, 48)
    );
    truncate_chars(&title, 120)
}

pub(crate) fn render_issue_body(data: &IssueTemplateData) -> String {
    let mut body = String::new();
    let _ = writeln!(body, "{}", clean_markdown_text(&data.explanation, 1_000));

    body.push_str("\n## Impact\n");
    if data.impacts.is_empty() {
        body.push_str("- No impact reported.\n");
    } else {
        for impact in data.impacts.iter().take(20) {
            let _ = writeln!(
                body,
                "- {}: {}",
                clean_markdown_text(&impact.value, 100),
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
                let _ = writeln!(body, "  - {}", clean_markdown_text(detail, 300));
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

    let backlink = clean_link(&data.backlink);
    let _ = write!(body, "\n[View this feedback group in Epode]({backlink})");
    cap_body(body, &backlink)
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

pub(crate) fn contains_sensitive_report_text(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    let forbidden_pattern = [
        "af_live_",
        "af_read_",
        "github_pat_",
        "-----begin ",
        "xoxb-",
        "xoxp-",
        "sk-proj-",
        "api key",
        "password",
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
    forbidden_pattern || bearer_credential || email_like
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
            let _ = writeln!(
                body,
                "- {} {}",
                if used == Some(true) {
                    "Used:"
                } else {
                    "Reported:"
                },
                clean_markdown_text(detail, 350)
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
        .map(|value| clean_markdown_text(value, 100))
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

fn clean_markdown_text(value: &str, max_chars: usize) -> String {
    truncate_chars(
        &value.split_whitespace().collect::<Vec<_>>().join(" "),
        max_chars,
    )
}

fn clean_code_text(value: &str, max_chars: usize) -> String {
    clean_markdown_text(value, max_chars).replace('`', "'")
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

fn cap_body(mut body: String, backlink: &str) -> String {
    if body.len() <= GITHUB_BODY_LIMIT {
        return body;
    }
    let suffix = format!(
        "\n\n… and additional content was omitted.\n\n[View this feedback group in Epode]({backlink})"
    );
    let prefix_limit = GITHUB_BODY_LIMIT.saturating_sub(suffix.len());
    let mut boundary = prefix_limit.min(body.len());
    while !body.is_char_boundary(boundary) {
        boundary = boundary.saturating_sub(1);
    }
    body.truncate(boundary);
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
    fn issue_template_omits_sensitive_details() {
        let mut data = template();
        data.findings[0].details = vec!["The response exposed customer@example.com".to_owned()];
        data.workarounds = vec![json!({"used": true, "detail": "Use github_pat_not_a_real_token"})];
        let body = render_issue_body(&data);
        assert!(!body.contains("customer@example.com"));
        assert!(!body.contains("github_pat_"));
        assert!(body.contains("sensitive detail(s) omitted"));
        assert!(body.contains("Sensitive detail omitted"));
    }

    #[test]
    fn backlink_uses_the_configured_app_host() {
        assert_eq!(
            group_backlink("https://app.epode.test/", "abc123"),
            "https://app.epode.test/?view=feedback&group=abc123"
        );
    }
}
