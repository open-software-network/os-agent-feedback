#![allow(
    clippy::redundant_pub_crate,
    reason = "crate-restricted visibility satisfies unreachable_pub in this binary-only crate"
)]

use std::{cmp::Reverse, collections::BTreeSet};

/// GitHub's code-search quota is small. This cap bounds the maximum work one
/// report can contribute before the worker applies its per-installation batch
/// budget.
pub(crate) const MAX_SEARCH_QUERIES_PER_REPORT: usize = 5;

/// Keep the stored/read payload bounded even when broad terms return many
/// files. GitHub relevance order is retained within equally-specific queries.
pub(crate) const MAX_CODE_HINTS_PER_REPORT: usize = 12;

const STOP_TOKENS: &[&str] = &[
    "api",
    "blocking",
    "call",
    "calls",
    "delete",
    "defect",
    "endpoint",
    "feedback",
    "finding",
    "friction",
    "gap",
    "get",
    "handler",
    "http",
    "https",
    "id",
    "major",
    "mcp",
    "minor",
    "other",
    "patch",
    "pending",
    "post",
    "put",
    "report",
    "reports",
    "request",
    "response",
    "strength",
    "suggestion",
    "tool",
    "tools",
    "uncertainty",
    "unknown",
    "v1",
    "v2",
];

#[derive(Debug, Clone, Copy)]
pub(crate) struct CodeMatchFinding<'a> {
    pub(crate) kind: &'a str,
    pub(crate) topic: &'a str,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct CodeMatchInput<'a> {
    pub(crate) repo_full_name: &'a str,
    pub(crate) path_prefix: Option<&'a str>,
    pub(crate) operation: &'a str,
    pub(crate) surface: &'a str,
    pub(crate) runtime_hint: Option<&'a str>,
    pub(crate) findings: &'a [CodeMatchFinding<'a>],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodeSearchQuery {
    pub(crate) expression: String,
    pub(crate) match_reason: String,
    specificity: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodeSearchCandidate {
    pub(crate) file: String,
    pub(crate) line_start: Option<u32>,
    pub(crate) line_end: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodeSearchMatches {
    pub(crate) query: CodeSearchQuery,
    pub(crate) candidates: Vec<CodeSearchCandidate>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodeHintCandidate {
    pub(crate) file: String,
    pub(crate) line_start: Option<u32>,
    pub(crate) line_end: Option<u32>,
    pub(crate) match_reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct QuerySeed {
    literal: String,
    reason: String,
    specificity: usize,
    insertion_order: usize,
}

pub(crate) fn derive_queries(input: CodeMatchInput<'_>) -> Vec<CodeSearchQuery> {
    let mut seeds = Vec::new();
    add_field_seeds(&mut seeds, input.operation, "operation", 60);
    if let Some(runtime_hint) = input.runtime_hint {
        add_field_seeds(&mut seeds, runtime_hint, "runtime hint", 50);
    }
    for finding in input.findings {
        add_field_seeds(&mut seeds, finding.topic, "finding topic", 40);
        add_field_seeds(&mut seeds, finding.kind, "finding kind", 20);
    }
    add_field_seeds(&mut seeds, input.surface, "surface", 10);

    seeds.sort_by_key(|seed| (Reverse(seed.specificity), seed.insertion_order));
    let mut seen = BTreeSet::new();
    seeds
        .into_iter()
        .filter(|seed| seen.insert(seed.literal.to_ascii_lowercase()))
        .take(MAX_SEARCH_QUERIES_PER_REPORT)
        .map(|seed| CodeSearchQuery {
            expression: scoped_expression(&seed.literal, input.repo_full_name, input.path_prefix),
            match_reason: seed.reason,
            specificity: seed.specificity,
        })
        .collect()
}

pub(crate) fn rank_matches(matches: Vec<CodeSearchMatches>) -> Vec<CodeHintCandidate> {
    let mut ranked = matches
        .into_iter()
        .enumerate()
        .flat_map(|(query_order, matches)| {
            let specificity = matches.query.specificity;
            let reason = matches.query.match_reason;
            matches
                .candidates
                .into_iter()
                .enumerate()
                .map(move |(result_order, candidate)| {
                    (
                        Reverse(specificity),
                        query_order,
                        result_order,
                        candidate,
                        reason.clone(),
                    )
                })
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        (&left.0, left.1, left.2, &left.3.file, left.3.line_start).cmp(&(
            &right.0,
            right.1,
            right.2,
            &right.3.file,
            right.3.line_start,
        ))
    });

    let mut seen = BTreeSet::new();
    ranked
        .into_iter()
        .filter_map(|(_, _, _, candidate, match_reason)| {
            let (line_start, line_end) = match (candidate.line_start, candidate.line_end) {
                (Some(line_start), Some(line_end)) => {
                    let line_start = line_start.max(1);
                    (Some(line_start), Some(line_end.max(line_start)))
                }
                _ => (None, None),
            };
            seen.insert((candidate.file.clone(), line_start, line_end))
                .then_some(CodeHintCandidate {
                    file: candidate.file,
                    line_start,
                    line_end,
                    match_reason,
                })
        })
        .take(MAX_CODE_HINTS_PER_REPORT)
        .collect()
}

fn add_field_seeds(seeds: &mut Vec<QuerySeed>, value: &str, label: &str, source_weight: usize) {
    for run in identifier_runs(value) {
        let parts = identifier_parts(&run);
        let meaningful_parts = parts.iter().filter(|part| useful_token(part)).count();
        if parts.len() >= 2 && meaningful_parts >= 1 {
            push_seed(
                seeds,
                run.clone(),
                format!("exact {label} identifier `{run}`"),
                200 + source_weight + meaningful_parts * 10 + run.len(),
            );
        }
        for part in parts {
            if useful_token(&part) {
                push_seed(
                    seeds,
                    part.clone(),
                    format!("{label} token `{part}`"),
                    100 + source_weight + part.len(),
                );
            }
        }
    }
}

fn push_seed(seeds: &mut Vec<QuerySeed>, literal: String, reason: String, specificity: usize) {
    let insertion_order = seeds.len();
    seeds.push(QuerySeed {
        literal,
        reason,
        specificity,
        insertion_order,
    });
}

fn identifier_runs(value: &str) -> Vec<String> {
    value
        .split(|character: char| !(character.is_ascii_alphanumeric() || character == '_'))
        .filter(|run| {
            run.len() >= 3 && run.len() <= 80 && !run.bytes().all(|byte| byte.is_ascii_digit())
        })
        .map(str::to_owned)
        .collect()
}

fn identifier_parts(identifier: &str) -> Vec<String> {
    let mut parts = Vec::new();
    for segment in identifier.split('_').filter(|segment| !segment.is_empty()) {
        let bytes = segment.as_bytes();
        let mut start = 0;
        for index in 1..bytes.len() {
            let boundary = bytes[index].is_ascii_uppercase()
                && (bytes[index - 1].is_ascii_lowercase()
                    || (index + 1 < bytes.len() && bytes[index + 1].is_ascii_lowercase()));
            if boundary {
                parts.push(segment[start..index].to_ascii_lowercase());
                start = index;
            }
        }
        parts.push(segment[start..].to_ascii_lowercase());
    }
    parts
}

fn useful_token(token: &str) -> bool {
    token.len() >= 3
        && token.len() <= 64
        && token.bytes().any(|byte| byte.is_ascii_alphabetic())
        && !STOP_TOKENS.contains(&token)
}

fn scoped_expression(literal: &str, repo_full_name: &str, path_prefix: Option<&str>) -> String {
    let mut expression = format!(
        "\"{}\" repo:{}",
        escape_quoted(literal),
        qualifier(repo_full_name)
    );
    if let Some(path_prefix) = path_prefix
        .map(str::trim)
        .map(|value| value.trim_matches('/'))
        .filter(|value| !value.is_empty())
    {
        expression.push_str(" path:");
        expression.push_str(&qualifier(path_prefix));
    }
    expression
}

fn qualifier(value: &str) -> String {
    if value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'_' | b'-'))
    {
        value.to_owned()
    } else {
        format!("\"{}\"", escape_quoted(value))
    }
}

fn escape_quoted(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input<'a>(
        operation: &'a str,
        surface: &'a str,
        runtime_hint: Option<&'a str>,
        findings: &'a [CodeMatchFinding<'a>],
    ) -> CodeMatchInput<'a> {
        CodeMatchInput {
            repo_full_name: "open-software/epode",
            path_prefix: Some("backend/src"),
            operation,
            surface,
            runtime_hint,
            findings,
        }
    }

    #[test]
    fn exact_identifier_is_first_and_every_query_is_scoped() {
        let queries = derive_queries(input("search_reports", "mcp", None, &[]));

        assert_eq!(
            queries[0].match_reason,
            "exact operation identifier `search_reports`"
        );
        assert_eq!(
            queries[0].expression,
            "\"search_reports\" repo:open-software/epode path:backend/src"
        );
        assert!(queries.iter().all(|query| {
            query.expression.contains("repo:open-software/epode")
                && query.expression.contains("path:backend/src")
        }));
    }

    #[test]
    fn camel_case_and_route_segments_become_literal_tokens() {
        let queries = derive_queries(input(
            "POST:/billing/getUserProfile/{id}",
            "http_json",
            None,
            &[],
        ));
        let reasons = queries
            .iter()
            .map(|query| query.match_reason.as_str())
            .collect::<Vec<_>>();

        assert!(reasons.contains(&"exact operation identifier `getUserProfile`"));
        assert!(reasons.contains(&"operation token `profile`"));
        assert!(reasons.contains(&"operation token `billing`"));
        assert!(
            !queries
                .iter()
                .any(|query| query.expression.starts_with("\"get\""))
        );
    }

    #[test]
    fn generic_fields_do_not_spend_search_budget() {
        let findings = [CodeMatchFinding {
            kind: "defect",
            topic: "unknown",
        }];

        assert!(derive_queries(input("pending", "mcp", None, &findings)).is_empty());
    }

    #[test]
    fn runtime_and_finding_tokens_fill_but_never_exceed_named_cap() {
        let findings = [
            CodeMatchFinding {
                kind: "defect",
                topic: "checkout_timeout_recovery",
            },
            CodeMatchFinding {
                kind: "gap",
                topic: "payment_confirmation_state",
            },
        ];
        let queries = derive_queries(input(
            "create_payment_session",
            "mcp",
            Some("StripeCheckoutAdapter"),
            &findings,
        ));

        assert_eq!(queries.len(), MAX_SEARCH_QUERIES_PER_REPORT);
        assert_eq!(
            queries[0].match_reason,
            "exact operation identifier `create_payment_session`"
        );
        assert!(queries.iter().any(|query| {
            query
                .match_reason
                .starts_with("exact runtime hint identifier")
        }));
    }

    #[test]
    fn duplicate_literals_keep_the_more_specific_source() {
        let findings = [CodeMatchFinding {
            kind: "gap",
            topic: "checkout",
        }];
        let queries = derive_queries(input("checkout", "mcp", Some("checkout"), &findings));

        assert_eq!(queries.len(), 1);
        assert_eq!(queries[0].match_reason, "operation token `checkout`");
    }

    #[test]
    fn unusual_path_prefix_is_quoted_without_changing_scope() {
        let mut match_input = input("checkout", "mcp", None, &[]);
        match_input.path_prefix = Some("apps/customer portal");

        let queries = derive_queries(match_input);

        assert_eq!(
            queries[0].expression,
            "\"checkout\" repo:open-software/epode path:\"apps/customer portal\""
        );
    }

    fn query(reason: &str, specificity: usize) -> CodeSearchQuery {
        CodeSearchQuery {
            expression: String::new(),
            match_reason: reason.to_owned(),
            specificity,
        }
    }

    fn candidate(file: &str, line_start: u32, line_end: u32) -> CodeSearchCandidate {
        CodeSearchCandidate {
            file: file.to_owned(),
            line_start: Some(line_start),
            line_end: Some(line_end),
        }
    }

    #[test]
    fn ranking_uses_query_specificity_and_preserves_result_relevance() {
        let hints = rank_matches(vec![
            CodeSearchMatches {
                query: query("broad", 10),
                candidates: vec![candidate("b.rs", 2, 2)],
            },
            CodeSearchMatches {
                query: query("specific", 20),
                candidates: vec![candidate("z.rs", 9, 9), candidate("a.rs", 1, 1)],
            },
        ]);

        assert_eq!(
            hints
                .iter()
                .map(|hint| (hint.file.as_str(), hint.match_reason.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("z.rs", "specific"),
                ("a.rs", "specific"),
                ("b.rs", "broad")
            ]
        );
    }

    #[test]
    fn ranking_deduplicates_ranges_normalizes_lines_and_caps_payload() {
        let many = (0..20)
            .map(|index| candidate(&format!("src/{index}.rs"), index, 0))
            .chain(std::iter::once(candidate("src/0.rs", 0, 0)))
            .collect();
        let hints = rank_matches(vec![CodeSearchMatches {
            query: query("operation token", 10),
            candidates: many,
        }]);

        assert_eq!(hints.len(), MAX_CODE_HINTS_PER_REPORT);
        assert_eq!((hints[0].line_start, hints[0].line_end), (Some(1), Some(1)));
        assert_eq!(
            hints.iter().filter(|hint| hint.file == "src/0.rs").count(),
            1
        );
    }

    #[test]
    fn ranking_preserves_an_honest_missing_line_range() {
        let hints = rank_matches(vec![CodeSearchMatches {
            query: query("operation token", 10),
            candidates: vec![CodeSearchCandidate {
                file: "src/unresolved.rs".to_owned(),
                line_start: None,
                line_end: None,
            }],
        }]);

        assert_eq!(hints[0].line_start, None);
        assert_eq!(hints[0].line_end, None);
    }
}
