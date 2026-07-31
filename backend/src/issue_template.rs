#![allow(
    clippy::redundant_pub_crate,
    reason = "crate-restricted visibility satisfies unreachable_pub in this binary-only crate"
)]

use std::{collections::HashSet, fmt::Write as _};

use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD},
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;

const GITHUB_BODY_LIMIT: usize = 65_536;
/// Shared by the renderer and the redaction pre-pass so the two cannot drift:
/// anything the pre-pass skips must also be absent from the body.
const MAX_IMPACT_VALUES: usize = 20;
const MAX_FINDING_GROUPS: usize = 25;
const MAX_DETAILS_PER_FINDING: usize = 3;
const MAX_WORKAROUNDS: usize = 20;
const MAX_WHERE_VALUES: usize = 20;
const MAX_ADJACENT_PUBLICATION_FIELDS: usize = 4;

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
    let policy = PublicationRedactions::for_issue(data);
    let title = format!(
        "[epode] {}: {} in {}",
        safe_customer_title_text(&data.primary_kind, 40, &policy),
        safe_customer_title_text(&data.primary_topic, 48, &policy),
        safe_customer_title_text(&data.primary_operation, 48, &policy)
    );
    truncate_chars(&title, 120)
}

pub(crate) fn render_issue_body(data: &IssueTemplateData) -> String {
    let policy = PublicationRedactions::for_issue(data);
    let mut body = String::new();
    let _ = writeln!(
        body,
        "{}",
        safe_customer_inline_text(&data.explanation, 1_000, &policy)
    );

    body.push_str("\n## Impact\n");
    if data.impacts.is_empty() {
        body.push_str("- No impact reported.\n");
    } else {
        for impact in data.impacts.iter().take(MAX_IMPACT_VALUES) {
            let _ = writeln!(
                body,
                "- {}: {}",
                safe_customer_inline_text(&impact.value, 100, &policy),
                impact.count
            );
        }
        append_more_line(
            &mut body,
            data.impacts.len(),
            MAX_IMPACT_VALUES,
            "impact values",
        );
    }

    body.push_str("\n## Findings\n");
    if data.findings.is_empty() {
        body.push_str("- No findings reported.\n");
    } else {
        for finding in data.findings.iter().take(MAX_FINDING_GROUPS) {
            let _ = writeln!(
                body,
                "- `{}/{}`: {} report(s)",
                clean_code_text(&finding.kind, 100, &policy),
                clean_code_text(&finding.topic, 100, &policy),
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
                if policy.must_redact(detail) {
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
            render_workaround(&mut body, workaround, &policy);
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
        render_values(&data.operations, MAX_WHERE_VALUES, &policy)
    );
    let _ = writeln!(
        body,
        "- Surface: {}",
        render_values(&data.surfaces, MAX_WHERE_VALUES, &policy)
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
    let footer = issue_footer(&data.group_key, &backlink);
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

pub(crate) fn group_marker_comment(group_key: &str) -> String {
    format!("<!-- epode-group: {} -->", group_marker(group_key))
}

pub(crate) fn contains_sensitive_report_text(value: &str) -> bool {
    // INGEST POLICY: rejecting here discards the entire customer report, which
    // is irreversible. Admission therefore blocks only credential forms with a
    // strong semantic signal and deliberately does not use entropy or shape.
    // Publication has the separate, aggressive `must_redact_before_publishing`
    // policy below, where a hit costs only one public field.
    // AWS access key IDs are uppercase and start with "AKIA" (long-lived) or
    // "ASIA" (temporary). Match case-sensitively on the raw value so ordinary
    // words such as "Asia" do not reject a report; requiring a run of
    // uppercase key characters after the prefix is a semantic signal, not
    // entropy scanning.
    let aws_access_key = ["AKIA", "ASIA"].iter().any(|prefix| {
        value.match_indices(prefix).any(|(index, _)| {
            let suffix = &value[index + prefix.len()..];
            suffix.len() >= 12
                && suffix
                    .chars()
                    .take(12)
                    .all(|character| character.is_ascii_uppercase() || character.is_ascii_digit())
        })
    });
    let value = value.to_ascii_lowercase();
    let forbidden_pattern = [
        "af_live_",
        "af_read_",
        "github_pat_",
        "ghp_",
        "aws_secret",
        "sk-ant-",
        "-----begin ",
        "xoxb-",
        "xoxp-",
        "sk-proj-",
        "api key",
        "password",
        "prompt was",
        "user asked",
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
    forbidden_pattern || bearer_credential || email_like || aws_access_key
}

#[derive(Debug, Default)]
struct PublicationRedactions {
    adjacent_split_values: HashSet<String>,
}

impl PublicationRedactions {
    fn for_issue(data: &IssueTemplateData) -> Self {
        let mut fields = vec![
            data.primary_kind.as_str(),
            data.primary_topic.as_str(),
            data.primary_operation.as_str(),
            data.explanation.as_str(),
        ];
        // Scan exactly what the body will render, using the same caps as the
        // renderer. Two reasons, both load-bearing:
        //  * only rendered text can leak, and `data.findings` is unbounded and
        //    customer-controlled (it aggregates across every report in the
        //    group), so scanning all of it puts unbounded work on the
        //    file-issue request path.
        //  * adjacency is a property of the OUTPUT. Windowing over fields that
        //    never appear, or never appear next to each other, invents splits
        //    that cannot occur and redacts text unnecessarily.
        fields.extend(
            data.impacts
                .iter()
                .take(MAX_IMPACT_VALUES)
                .map(|impact| impact.value.as_str()),
        );
        for finding in data.findings.iter().take(MAX_FINDING_GROUPS) {
            fields.push(finding.kind.as_str());
            fields.push(finding.topic.as_str());
            // NOT capped at MAX_DETAILS_PER_FINDING: that cap bounds how many
            // details the renderer EMITS, not how many it examines. It walks
            // every detail and stops once three have printed, so a later detail
            // is published whenever earlier ones are redacted. Scanning fewer
            // than the renderer can reach would publish an unscanned field.
            fields.extend(finding.details.iter().map(String::as_str));
        }
        fields.extend(
            data.workarounds
                .iter()
                .take(MAX_WORKAROUNDS)
                .filter_map(|workaround| workaround.get("detail").and_then(Value::as_str)),
        );
        fields.extend(
            data.operations
                .iter()
                .take(MAX_WHERE_VALUES)
                .map(String::as_str),
        );
        fields.extend(
            data.surfaces
                .iter()
                .take(MAX_WHERE_VALUES)
                .map(String::as_str),
        );

        let mut adjacent_split_values = HashSet::new();
        mark_sensitive_adjacent_windows(&mut adjacent_split_values, &fields);
        let finding_details = data
            .findings
            .iter()
            .take(MAX_FINDING_GROUPS)
            .flat_map(|finding| finding.details.iter().map(String::as_str))
            .collect::<Vec<_>>();
        mark_sensitive_adjacent_windows(&mut adjacent_split_values, &finding_details);
        Self {
            adjacent_split_values,
        }
    }

    fn must_redact(&self, value: &str) -> bool {
        self.adjacent_split_values.contains(value) || must_redact_before_publishing(value)
    }
}

fn mark_sensitive_adjacent_windows(redactions: &mut HashSet<String>, fields: &[&str]) {
    // Contiguous windows are O(fields × N), not combinatorial. N=4 closes the
    // observed three-field bypass and the next boundary without making issue
    // rendering meaningfully more expensive. Only credential-alphabet fields
    // participate, so widening the window does not fuse ordinary sentences
    // into one artificial opaque token.
    for window_size in 2..=MAX_ADJACENT_PUBLICATION_FIELDS.min(fields.len()) {
        for window in fields.windows(window_size) {
            if window
                .iter()
                .all(|value| is_credential_field_fragment(value))
                && must_redact_before_publishing(&window.concat())
            {
                redactions.extend(window.iter().map(|value| (*value).to_owned()));
            }
        }
    }
}

fn is_credential_field_fragment(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-._~+/=".contains(character))
}

/// PUBLICATION POLICY: a hit here omits one public field instead of discarding
/// the stored report, so this boundary deliberately fails closed on plausible
/// credential shapes as well as known credential semantics.
///
/// Detection covers ASCII credentials of at least 32 characters, known secret
/// prefixes, credential-bearing URLs and assignments, JSON string values,
/// percent encoding, one layer of base64 text, up to eight adjacent opaque
/// segments inside a field, and up to four contiguous rendered fields.
///
/// ACCEPTED LIMITATIONS: Unicode homoglyph substitution is not normalized
/// because it changes provider credentials rather than encoding them; base64
/// decoding is bounded to two nested detector passes; cross-field detection is
/// bounded to N=4 contiguous credential-character-only fields, while
/// non-contiguous and cross-report splits remain out of scope. Ingest-side
/// credential-prefix rejection and per-field redaction of every field in a
/// matched window compensate for that bound. Opaque values shorter than 32
/// characters still require a known prefix, bearer syntax, email shape, or
/// credential key.
fn must_redact_before_publishing(value: &str) -> bool {
    publication_text_is_sensitive(value, 0)
}

fn publication_text_is_sensitive(value: &str, decode_depth: usize) -> bool {
    if contains_sensitive_report_text(value) || contains_publish_only_pattern(value) {
        return true;
    }
    if contains_sensitive_url(value) || contains_sensitive_assignment(value) {
        return true;
    }
    if contains_sensitive_json(value, decode_depth) || contains_secret_shape(value) {
        return true;
    }

    if decode_depth >= 2 {
        return false;
    }
    if let Some(decoded) = percent_decode_text(value)
        && publication_text_is_sensitive(&decoded, decode_depth + 1)
    {
        return true;
    }
    decoded_base64_texts(value)
        .any(|decoded| publication_text_is_sensitive(&decoded, decode_depth + 1))
}

fn contains_publish_only_pattern(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    [
        "ghp_",
        "gho_",
        "ghs_",
        "ghr_",
        "akia",
        "asia",
        "xoxa-",
        "xapp-",
        "sk-ant-",
        "apikey",
        "api_key",
        "secret",
        "passwd",
        "authorization:",
    ]
    .iter()
    .any(|pattern| value.contains(pattern))
}

const CREDENTIAL_KEYS: &[&str] = &[
    "token",
    "access_token",
    "api_key",
    "apikey",
    "key",
    "secret",
    "password",
    "signature",
    "sig",
    "auth",
    "code",
    "session",
    "id_token",
    "refresh_token",
];

fn is_credential_key(value: &str) -> bool {
    CREDENTIAL_KEYS
        .iter()
        .any(|candidate| value.eq_ignore_ascii_case(candidate))
}

fn contains_sensitive_assignment(value: &str) -> bool {
    value
        .split(|character: char| {
            character.is_whitespace()
                || matches!(
                    character,
                    '&' | ';' | ',' | '(' | ')' | '[' | ']' | '{' | '}'
                )
        })
        .any(|part| {
            part.split_once('=').is_some_and(|(key, assigned)| {
                let key = key.trim_matches(|character: char| {
                    matches!(character, '\'' | '"' | '`' | '<' | '>')
                });
                is_credential_key(key) && !assigned.is_empty()
            })
        })
}

fn contains_sensitive_json(value: &str, decode_depth: usize) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(value) else {
        return false;
    };
    json_value_is_sensitive(&value, decode_depth)
}

fn json_value_is_sensitive(value: &Value, decode_depth: usize) -> bool {
    match value {
        Value::Object(values) => values.iter().any(|(key, value)| {
            (is_credential_key(key) && !value.is_null())
                || json_value_is_sensitive(value, decode_depth)
        }),
        Value::Array(values) => values
            .iter()
            .any(|value| json_value_is_sensitive(value, decode_depth)),
        Value::String(value) => publication_text_is_sensitive(value, decode_depth + 1),
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}

fn contains_sensitive_url(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let mut cursor = 0;
    while cursor < value.len() {
        let http = lower[cursor..].find("http://");
        let https = lower[cursor..].find("https://");
        let Some(relative_start) = [http, https].into_iter().flatten().min() else {
            break;
        };
        let start = cursor + relative_start;
        let end = value[start..]
            .char_indices()
            .find_map(|(offset, character)| {
                (character.is_whitespace() || matches!(character, '\'' | '"' | '<' | '>' | '`'))
                    .then_some(start + offset)
            })
            .unwrap_or(value.len());
        let candidate = value[start..end].trim_end_matches(|character: char| {
            matches!(character, ',' | ';' | '!' | '?' | ')' | ']' | '}')
        });
        if let Ok(url) = reqwest::Url::parse(candidate) {
            if !url.username().is_empty() || url.password().is_some() {
                return true;
            }
            if url
                .query_pairs()
                .any(|(key, _)| is_credential_key(key.as_ref()))
            {
                return true;
            }
            if url.path_segments().is_some_and(|segments| {
                segments.into_iter().any(|segment| {
                    let decoded =
                        percent_decode_text(segment).unwrap_or_else(|| segment.to_owned());
                    contains_secret_shape(&decoded)
                })
            }) {
                return true;
            }
        }
        cursor = end.max(start + 1);
    }
    false
}

fn percent_decode_text(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    let mut changed = false;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
        {
            decoded.push((high << 4) | low);
            index += 3;
            changed = true;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    changed.then(|| String::from_utf8(decoded).ok()).flatten()
}

const fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn decoded_base64_texts(value: &str) -> impl Iterator<Item = String> + '_ {
    opaque_segments(value).into_iter().filter_map(|segment| {
        if segment.value.len() < 16 {
            return None;
        }
        let unpadded = segment.value.trim_end_matches('=');
        [segment.value, unpadded]
            .into_iter()
            .flat_map(|candidate| {
                [STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD]
                    .into_iter()
                    .filter_map(move |engine| {
                        engine
                            .decode(candidate.as_bytes())
                            .ok()
                            .and_then(|bytes| String::from_utf8(bytes).ok())
                    })
            })
            .next()
            .filter(|decoded| {
                !decoded.is_empty()
                    && decoded
                        .chars()
                        .all(|character| !character.is_control() || character.is_whitespace())
            })
    })
}

#[derive(Debug, Clone, Copy)]
struct OpaqueSegment<'a> {
    value: &'a str,
    start: usize,
    end: usize,
}

fn opaque_segments(value: &str) -> Vec<OpaqueSegment<'_>> {
    let mut segments = Vec::new();
    let mut start = None;
    for (index, character) in value.char_indices() {
        if character.is_ascii_alphanumeric() || "-._~+/=".contains(character) {
            start.get_or_insert(index);
        } else if let Some(start) = start.take() {
            segments.push(OpaqueSegment {
                value: &value[start..index],
                start,
                end: index,
            });
        }
    }
    if let Some(start) = start {
        segments.push(OpaqueSegment {
            value: &value[start..],
            start,
            end: value.len(),
        });
    }
    segments
}

fn contains_secret_shape(value: &str) -> bool {
    let segments = opaque_segments(value);
    if segments
        .iter()
        .any(|segment| looks_like_secret_token(segment.value))
    {
        return true;
    }

    // Join up to eight adjacent opaque chunks separated by at most three bytes.
    // This catches line-wrapped and punctuation-split credentials without
    // concatenating arbitrary prose across a whole field.
    for start in 0..segments.len() {
        let mut joined = String::new();
        for end in start..segments.len().min(start + 8) {
            let segment = segments[end];
            if segment.value.len() < 4 {
                break;
            }
            if end > start && segment.start.saturating_sub(segments[end - 1].end) > 3 {
                break;
            }
            joined.push_str(segment.value);
            if end > start && looks_like_secret_token(&joined) {
                return true;
            }
        }
    }
    false
}

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

    let has_letter = token.chars().any(|c| c.is_ascii_alphabetic());
    let has_digit = token.chars().any(|c| c.is_ascii_digit());
    if !has_letter || !has_digit || looks_like_word_identifier(token) {
        return false;
    }

    shannon_entropy_bits_per_char(token) >= MIN_ENTROPY_BITS
}

fn looks_like_word_identifier(token: &str) -> bool {
    if token
        .chars()
        .any(|character| !character.is_ascii_alphanumeric() && !"_- .".contains(character))
    {
        return false;
    }
    let parts = token
        .split(['_', '-', '.'])
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let alpha = parts
        .iter()
        .filter(|part| {
            part.chars()
                .all(|character| character.is_ascii_alphabetic())
        })
        .collect::<Vec<_>>();
    let short_mixed = parts
        .iter()
        .filter(|part| {
            part.chars()
                .any(|character| character.is_ascii_alphabetic())
                && part.chars().any(|character| character.is_ascii_digit())
                && part.len() <= 4
        })
        .count();
    let wordlike = alpha
        .iter()
        .filter(|part| {
            part.chars()
                .any(|character| "aeiouAEIOU".contains(character))
        })
        .count();
    alpha.len() >= 3
        && short_mixed <= 1
        && wordlike * 2 >= alpha.len()
        && parts.iter().all(|part| {
            part.chars()
                .all(|character| character.is_ascii_alphabetic())
                || part.chars().all(|character| character.is_ascii_digit())
                || (part.len() <= 4
                    && part
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric()))
        })
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

fn render_workaround(body: &mut String, workaround: &Value, policy: &PublicationRedactions) {
    let used = workaround.get("used").and_then(Value::as_bool);
    let detail = workaround.get("detail").and_then(Value::as_str);
    match detail {
        Some(detail) if policy.must_redact(detail) => {
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

fn render_values(values: &[String], limit: usize, policy: &PublicationRedactions) -> String {
    if values.is_empty() {
        return "unknown".to_owned();
    }
    let mut rendered = values
        .iter()
        .take(limit)
        .map(|value| safe_customer_inline_text(value, 100, policy))
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

fn safe_customer_title_text(
    value: &str,
    max_chars: usize,
    policy: &PublicationRedactions,
) -> String {
    if policy.must_redact(value) {
        return "[redacted]".to_owned();
    }
    neutralize_github_references(&clean_text(value, max_chars))
}

fn safe_customer_inline_text(
    value: &str,
    max_chars: usize,
    policy: &PublicationRedactions,
) -> String {
    if policy.must_redact(value) {
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

fn clean_code_text(value: &str, max_chars: usize, policy: &PublicationRedactions) -> String {
    if policy.must_redact(value) {
        return "redacted".to_owned();
    }
    neutralize_github_references(&clean_text(value, max_chars)).replace('`', "'")
}

fn neutralize_github_references(value: &str) -> String {
    neutralize_www(
        &value
            .replace('@', "@\u{200b}")
            .replace('#', "#\u{200b}")
            .replace("://", ":\u{200b}//"),
    )
}

fn neutralize_www(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    let mut rendered = String::with_capacity(value.len());
    let mut cursor = 0;
    while let Some(relative) = lower[cursor..].find("www.") {
        let start = cursor + relative;
        let dot = start + 3;
        rendered.push_str(&value[cursor..dot]);
        rendered.push('\u{200b}');
        rendered.push('.');
        cursor = dot + 1;
    }
    rendered.push_str(&value[cursor..]);
    rendered
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
        "\n\n{}\n\n[View this feedback group in Epode]({backlink})",
        group_marker_comment(group_key)
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
                "0123456789abcdef0123456789abcdef",
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
                must_redact_before_publishing(secret),
                "expected redaction for: {secret}"
            );
        }
    }

    #[test]
    fn sensitive_guard_does_not_redact_ordinary_report_text() {
        // Ingest-side high-signal credential and prompt-paraphrase patterns.
        for sensitive in [
            "Access key AKIAIOSFODNN7EXAMPLE was rejected",
            "Temporary key ASIAJEXAMPLEKEY12345 expired mid-request",
            "config leaked aws_secret_access_key into the error body",
            "token ghp_16C7e42F292c6912E7710c838347Ae178B4a is invalid",
            "the response echoed sk-ant-api03-abc123",
            "the prompt was to summarize the customer's contract",
            "the user asked for a refund and the API refused",
        ] {
            assert!(
                contains_sensitive_report_text(sensitive),
                "expected ingest rejection for: {sensitive}"
            );
        }
        // Prose that merely mentions these providers or regions must pass.
        for benign in [
            "Requests from the Asia region timed out",
            "The AWS secret manager integration returned 403",
            "The ask-once flow succeeded for this user",
        ] {
            assert!(
                !contains_sensitive_report_text(benign),
                "unexpected ingest rejection for: {benign}"
            );
        }
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
                !must_redact_before_publishing(benign),
                "unexpected redaction for: {benign}"
            );
        }

        let benign_fields = ["search task", "retry window", "status 503"];
        let joined = benign_fields.concat();
        assert!(joined.len() >= 32);
        assert!(!must_redact_before_publishing(&joined));
        let mut data = template();
        data.operations = benign_fields.map(str::to_owned).to_vec();
        let body = render_issue_body(&data);
        for field in benign_fields {
            assert!(
                body.contains(field),
                "benign adjacent field was redacted: {field}"
            );
        }
    }

    #[test]
    fn publication_shape_detection_covers_credential_charsets_without_case_bias() {
        for secret in [
            "mfrggzdfmztwq2lknnwg23tpobyxg43u",
            "MFRGGZDFMZTWQ2LKNNWG23TPOBYXG43U",
            "Zx8Qp2LmVn4TbW9yRc6HdKe1JgAo5UfS",
            "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
            "3mJr7AoUXx2Wqd9NfT6YpK8sV4cH5BzE",
            "eyJzdWIiOiIxMjM0NTY3ODkwIiwia2V5IjoiYWJjMTIzIn0",
            "azbycxdwevfu1gthsirjqkplom2n+/=azby3cxd",
            "mfrggzdf_mztwq2lk-nnwg23tp.obyxg43u",
        ] {
            assert!(
                must_redact_before_publishing(secret),
                "charset or case bypassed publication redaction: {secret}"
            );
        }
    }

    #[test]
    fn publication_detection_unwraps_urls_json_encoding_and_quotes() {
        let opaque = "Zx8Qp2LmVn4TbW9yRc6HdKe1JgAo5UfS";
        for wrapped in [
            opaque.to_owned(),
            "https://user:short@host.test/resource".to_owned(),
            "https://short@host.test/resource".to_owned(),
            "https://host.test/resource?AcCeSs_ToKeN=short".to_owned(),
            format!("https://host.test/{opaque}"),
            format!(r#"{{"result":"{opaque}"}}"#),
            format!("value='{opaque}'"),
            format!("```text\n{opaque}\n```"),
            "af%5Flive%5Fnot%5Fa%5Freal%5Fsecret".to_owned(),
            "token=short".to_owned(),
            "YWZfbGl2ZV9ub3RfYV9yZWFsX3NlY3JldA==".to_owned(),
        ] {
            assert!(
                must_redact_before_publishing(&wrapped),
                "wrapper bypassed publication redaction: {wrapped}"
            );
        }
    }

    #[test]
    fn publication_detection_joins_short_adjacent_segments() {
        for split in [
            "Zx8Qp2Lm Vn4TbW9y Rc6HdKe1 JgAo5UfS",
            "Zx8Qp2Lm:Vn4TbW9y:Rc6HdKe1:JgAo5UfS",
            "Zx8Qp2Lm\nVn4TbW9y\nRc6HdKe1\nJgAo5UfS",
        ] {
            assert!(
                must_redact_before_publishing(split),
                "separator bypassed publication redaction: {split:?}"
            );
        }
    }

    #[test]
    fn issue_publication_joins_splits_across_fields_and_findings() {
        let first = "Zx8Qp2LmVn4TbW9y";
        let second = "Rc6HdKe1JgAo5UfS";
        let mut data = template();
        data.findings = vec![
            IssueFindingRollup {
                kind: "defect".to_owned(),
                topic: "first".to_owned(),
                count: 1,
                detail_count: 1,
                details: vec![first.to_owned()],
            },
            IssueFindingRollup {
                kind: "defect".to_owned(),
                topic: "second".to_owned(),
                count: 1,
                detail_count: 1,
                details: vec![second.to_owned()],
            },
        ];

        let body = render_issue_body(&data);
        assert!(!body.contains(first));
        assert!(!body.contains(second));
        assert!(body.contains("sensitive detail(s) omitted"));
    }

    #[test]
    fn issue_publication_joins_three_and_four_adjacent_field_splits() {
        let three_parts = ["Zx8Qp2LmVn4", "TbW9yRc6HdK", "e1JgAo5UfS"];
        assert!(three_parts.iter().all(|part| part.len() < 32));
        assert!(three_parts.windows(2).all(|pair| pair.concat().len() < 32));
        let mut three_fields = template();
        three_fields.operations = three_parts.map(str::to_owned).to_vec();
        let body = render_issue_body(&three_fields);
        for part in three_parts {
            assert!(
                !body.contains(part),
                "three-field credential part leaked: {part}"
            );
        }
        assert!(body.contains("Operation: [redacted], [redacted], [redacted]"));

        let four_parts = ["Zx8Qp2Lm", "Vn4TbW9y", "Rc6HdKe1", "JgAo5UfS"];
        assert!(
            four_parts
                .windows(3)
                .all(|window| window.concat().len() < 32)
        );
        let mut four_fields = template();
        four_fields.findings[0].detail_count = 4;
        four_fields.findings[0].details = four_parts.map(str::to_owned).to_vec();
        let body = render_issue_body(&four_fields);
        for part in four_parts {
            assert!(
                !body.contains(part),
                "four-field credential part leaked: {part}"
            );
        }
        assert!(body.contains("4 sensitive detail(s) omitted."));
    }

    #[test]
    fn publication_shape_threshold_is_explicit_and_homoglyph_labels_do_not_bypass_it() {
        let at_threshold = "Zx8Qp2LmVn4TbW9yRc6HdKe1JgAo5UfS";
        assert_eq!(at_threshold.len(), 32);
        assert!(!must_redact_before_publishing(&at_threshold[..31]));
        assert!(must_redact_before_publishing(at_threshold));
        assert!(must_redact_before_publishing(&format!(
            "tоken {at_threshold}"
        )));
    }

    #[test]
    fn ingest_admits_uuid_while_issue_publication_redacts_it() {
        let uuid = "123e4567-e89b-12d3-a456-426614174000";
        assert!(
            !contains_sensitive_report_text(uuid),
            "an opaque identifier is not enough to reject a whole report"
        );

        let mut data = template();
        data.explanation = format!("Request {uuid} failed after retry");
        let body = render_issue_body(&data);
        assert!(!body.contains(uuid));
        assert!(body.contains("[redacted]"));
    }

    #[test]
    fn issue_marker_writer_and_reader_use_identical_separator_safe_comments() {
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
            let expected = group_marker(group_key);
            let expected_comment = group_marker_comment(group_key);

            assert_eq!(body_marker, expected);
            assert!(body.contains(&expected_comment));
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
        assert_eq!(
            neutralize_github_references("WWW.example.test WwW.example.test"),
            "WWW\u{200b}.example.test WwW\u{200b}.example.test"
        );
    }

    #[test]
    fn backlink_uses_the_configured_app_host() {
        assert_eq!(
            group_backlink("https://app.epode.test/", "abc123"),
            "https://app.epode.test/?view=feedback&group=abc123"
        );
    }
}
