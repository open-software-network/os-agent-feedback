#![allow(
    clippy::redundant_pub_crate,
    reason = "crate-restricted visibility satisfies unreachable_pub in this binary-only crate"
)]

use uuid::Uuid;

use crate::{models::FeedbackFindingInput, security::sha256};

#[derive(Debug)]
pub(crate) struct GroupInput<'a> {
    pub(crate) product_id: Uuid,
    pub(crate) operation: &'a str,
    pub(crate) surface: &'a str,
    pub(crate) status_code: Option<i32>,
    pub(crate) findings: &'a [FeedbackFindingInput],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GroupAssignment {
    pub(crate) group_key: String,
    pub(crate) explanation: String,
}

pub(crate) trait ReportGrouper: Send + Sync {
    fn name(&self) -> &'static str;
    fn version(&self) -> i32;
    fn assign(&self, input: &GroupInput<'_>) -> GroupAssignment;
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct FingerprintGrouper;

impl ReportGrouper for FingerprintGrouper {
    fn name(&self) -> &'static str {
        "fingerprint"
    }

    fn version(&self) -> i32 {
        1
    }

    fn assign(&self, input: &GroupInput<'_>) -> GroupAssignment {
        let (finding_kind, finding_topic) = primary_finding(input.findings)
            .map_or(("none", "none"), |finding| {
                (finding.kind.as_str(), finding.topic.as_str())
            });
        let status_class = status_class(input.status_code);

        // PostgreSQL TEXT rejects U+0000, so NUL cannot occur in any persisted
        // input component and makes component boundaries unambiguous.
        let canonical = format!(
            "{}\0{}\0{}\0{}\0{}\0{}",
            input.product_id,
            input.operation,
            input.surface,
            finding_kind,
            finding_topic,
            status_class
        );

        GroupAssignment {
            group_key: short_hex_sha256(&canonical),
            explanation: format!(
                "product {} · operation {} · surface {} · {}/{} · {}",
                input.product_id,
                input.operation,
                input.surface,
                finding_kind,
                finding_topic,
                status_class
            ),
        }
    }
}

fn primary_finding(findings: &[FeedbackFindingInput]) -> Option<&FeedbackFindingInput> {
    let mut primary = None;
    let mut primary_rank = (0, 0);

    for finding in findings {
        let rank = (
            severity_rank(finding.severity.as_deref()),
            kind_rank(&finding.kind),
        );
        if primary.is_none() || rank > primary_rank {
            primary = Some(finding);
            primary_rank = rank;
        }
    }

    primary
}

fn severity_rank(severity: Option<&str>) -> u8 {
    match severity {
        Some("blocking") => 3,
        Some("major") => 2,
        Some("minor") => 1,
        None | Some(_) => 0,
    }
}

fn kind_rank(kind: &str) -> u8 {
    match kind {
        "defect" => 7,
        "friction" => 6,
        "gap" => 5,
        "uncertainty" => 4,
        "suggestion" => 3,
        "other" => 2,
        "strength" => 1,
        _ => 0,
    }
}

fn status_class(status_code: Option<i32>) -> String {
    status_code.map_or_else(|| "none".to_owned(), |code| format!("{}xx", code / 100))
}

fn short_hex_sha256(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";

    let digest = sha256(value);
    let mut encoded = String::with_capacity(32);
    for byte in digest.iter().take(16).copied() {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRODUCT_ID: Uuid = Uuid::from_u128(1);

    fn finding(kind: &str, topic: &str, severity: Option<&str>) -> FeedbackFindingInput {
        FeedbackFindingInput {
            kind: kind.to_owned(),
            topic: topic.to_owned(),
            severity: severity.map(str::to_owned),
            detail: "A useful test finding.".to_owned(),
        }
    }

    fn assignment(
        product_id: Uuid,
        operation: &str,
        surface: &str,
        status_code: Option<i32>,
        findings: &[FeedbackFindingInput],
    ) -> GroupAssignment {
        FingerprintGrouper.assign(&GroupInput {
            product_id,
            operation,
            surface,
            status_code,
            findings,
        })
    }

    #[test]
    fn identical_inputs_have_identical_keys() {
        let findings = [finding("defect", "authentication", Some("major"))];
        let first = assignment(PRODUCT_ID, "create_session", "mcp", Some(500), &findings);
        let second = assignment(PRODUCT_ID, "create_session", "mcp", Some(500), &findings);

        assert_eq!(first.group_key, second.group_key);
        assert_eq!(first.group_key.len(), 32);
        assert!(first.group_key.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn every_fingerprint_dimension_changes_the_key() {
        let defect = [finding("defect", "authentication", Some("major"))];
        let other_topic = [finding("defect", "authorization", Some("major"))];
        let other_kind = [finding("friction", "authentication", Some("major"))];
        let baseline =
            assignment(PRODUCT_ID, "create_session", "mcp", Some(500), &defect).group_key;
        let variants = [
            assignment(
                Uuid::from_u128(2),
                "create_session",
                "mcp",
                Some(500),
                &defect,
            ),
            assignment(PRODUCT_ID, "refresh_session", "mcp", Some(500), &defect),
            assignment(
                PRODUCT_ID,
                "create_session",
                "http_json",
                Some(500),
                &defect,
            ),
            assignment(PRODUCT_ID, "create_session", "mcp", Some(400), &defect),
            assignment(PRODUCT_ID, "create_session", "mcp", Some(500), &other_kind),
            assignment(PRODUCT_ID, "create_session", "mcp", Some(500), &other_topic),
        ];

        for variant in variants {
            assert_ne!(baseline, variant.group_key);
        }
    }

    #[test]
    fn primary_finding_prefers_severity_then_kind_then_array_order() {
        let severity_precedence = [
            (None, Some("minor")),
            (Some("minor"), Some("major")),
            (Some("major"), Some("blocking")),
        ];
        for (lower, higher) in severity_precedence {
            let findings = [
                finding("defect", "lower_severity", lower),
                finding("strength", "higher_severity", higher),
            ];
            assert_eq!(
                primary_finding(&findings).map(|finding| finding.topic.as_str()),
                Some("higher_severity")
            );
        }

        let kind_precedence = [
            ("strength", "other"),
            ("other", "suggestion"),
            ("suggestion", "uncertainty"),
            ("uncertainty", "gap"),
            ("gap", "friction"),
            ("friction", "defect"),
        ];
        for (lower, higher) in kind_precedence {
            let findings = [
                finding(lower, "lower_kind", Some("major")),
                finding(higher, "higher_kind", Some("major")),
            ];
            assert_eq!(
                primary_finding(&findings).map(|finding| finding.topic.as_str()),
                Some("higher_kind")
            );
        }

        let tied_findings = [
            finding("defect", "first_topic", Some("major")),
            finding("defect", "second_topic", Some("major")),
        ];
        assert_eq!(
            primary_finding(&tied_findings).map(|finding| finding.topic.as_str()),
            Some("first_topic")
        );
    }

    #[test]
    fn empty_findings_use_explicit_sentinels() {
        let assignment = assignment(PRODUCT_ID, "pending", "unknown", None, &[]);

        assert!(assignment.explanation.contains("none/none"));
        assert!(assignment.explanation.ends_with(" · none"));
    }

    #[test]
    fn status_codes_map_to_hundreds_classes() {
        assert_eq!(status_class(None), "none");
        assert_eq!(status_class(Some(204)), "2xx");
        assert_eq!(status_class(Some(404)), "4xx");
        assert_eq!(status_class(Some(599)), "5xx");
        assert_eq!(
            assignment(PRODUCT_ID, "pending", "unknown", Some(500), &[]).group_key,
            assignment(PRODUCT_ID, "pending", "unknown", Some(599), &[]).group_key
        );
    }

    #[test]
    fn nul_delimiter_keeps_component_splits_distinct() {
        let first = assignment(PRODUCT_ID, "ab", "c", None, &[]);
        let second = assignment(PRODUCT_ID, "a", "bc", None, &[]);

        assert_ne!(first.group_key, second.group_key);
    }

    #[test]
    fn fingerprint_grouper_identity_is_stable() {
        assert_eq!(FingerprintGrouper.name(), "fingerprint");
        assert_eq!(FingerprintGrouper.version(), 1);
    }
}
