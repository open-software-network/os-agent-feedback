#![allow(
    clippy::redundant_pub_crate,
    reason = "crate-restricted visibility keeps the graph projection private to this binary"
)]

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::models::{
    ObservedCustomerFact, ObservedCustomerFactEvidence, ObservedCustomerFactScope,
    ObservedCustomerProfile,
};

const MAX_FACT_EVIDENCE: usize = 3;
pub(crate) const PROFILE_NODE_LIMIT: usize = 5_000;

#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct ObservedActivity {
    pub session_id: Uuid,
    pub session_ref: String,
    pub session_source: String,
    pub operation: String,
    pub observed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Eq, Ord, PartialEq, PartialOrd)]
struct FactSeed {
    key: String,
    domain: String,
    label: String,
    value: String,
    kind: String,
    strength: Option<String>,
    status: String,
}

#[derive(Debug, Clone, Eq, Ord, PartialEq, PartialOrd)]
struct ScopedFactSeed {
    fact: FactSeed,
    scope: ObservedCustomerFactScope,
    scope_ref: Option<String>,
}

struct FactAccumulator {
    seed: ScopedFactSeed,
    sessions: BTreeSet<Uuid>,
    observation_count: i64,
    first_observed_at: DateTime<Utc>,
    last_observed_at: DateTime<Utc>,
    evidence: Vec<ObservedCustomerFactEvidence>,
}

/// Derive a bounded, evidence-backed customer profile from retained session activity.
///
/// Operations are deliberately normalized, non-sensitive graph paths. This
/// projection distinguishes customer-wide traits from journey, item, and
/// session context. Every fact also carries the evidence that justifies
/// displaying it.
pub(crate) fn derive_observed_customer_profile(
    mut activities: Vec<ObservedActivity>,
) -> ObservedCustomerProfile {
    activities.sort_by(|left, right| {
        right
            .observed_at
            .cmp(&left.observed_at)
            .then_with(|| right.session_id.cmp(&left.session_id))
            .then_with(|| right.operation.cmp(&left.operation))
    });
    let truncated = activities.len() > PROFILE_NODE_LIMIT;
    activities.truncate(PROFILE_NODE_LIMIT);
    let mut session_ids = BTreeSet::new();
    let mut facts = BTreeMap::<ScopedFactSeed, FactAccumulator>::new();

    for activity in &activities {
        session_ids.insert(activity.session_id);
        let mut facts_in_activity = BTreeSet::new();
        for parsed in parse_operation(&activity.operation) {
            let (scope, scope_ref) = fact_scope(activity, &parsed);
            let seed = ScopedFactSeed {
                fact: parsed.fact,
                scope,
                scope_ref,
            };
            if !facts_in_activity.insert(seed.clone()) {
                continue;
            }
            let entry = facts
                .entry(seed.clone())
                .or_insert_with(|| FactAccumulator {
                    seed,
                    sessions: BTreeSet::new(),
                    observation_count: 0,
                    first_observed_at: activity.observed_at,
                    last_observed_at: activity.observed_at,
                    evidence: Vec::new(),
                });
            entry.sessions.insert(activity.session_id);
            entry.observation_count += 1;
            entry.first_observed_at = entry.first_observed_at.min(activity.observed_at);
            entry.last_observed_at = entry.last_observed_at.max(activity.observed_at);
            if entry.evidence.len() < MAX_FACT_EVIDENCE
                && !entry
                    .evidence
                    .iter()
                    .any(|evidence| evidence.session_id == activity.session_id)
            {
                entry.evidence.push(ObservedCustomerFactEvidence {
                    session_id: activity.session_id,
                    session_ref: activity.session_ref.clone(),
                    operation: activity.operation.clone(),
                    observed_at: activity.observed_at,
                });
            }
        }
    }

    let mut facts = facts
        .into_values()
        .map(|fact| ObservedCustomerFact {
            key: fact.seed.fact.key,
            domain: fact.seed.fact.domain,
            label: fact.seed.fact.label,
            value: fact.seed.fact.value,
            kind: fact.seed.fact.kind,
            strength: fact.seed.fact.strength,
            status: fact.seed.fact.status,
            scope: fact.seed.scope,
            scope_ref: fact.seed.scope_ref,
            session_count: count_to_i64(fact.sessions.len()),
            observation_count: fact.observation_count,
            first_observed_at: fact.first_observed_at,
            last_observed_at: fact.last_observed_at,
            evidence: fact.evidence,
        })
        .collect::<Vec<_>>();
    facts.sort_by(|left, right| {
        right
            .last_observed_at
            .cmp(&left.last_observed_at)
            .then_with(|| right.session_count.cmp(&left.session_count))
            .then_with(|| left.key.cmp(&right.key))
            .then_with(|| left.value.cmp(&right.value))
    });

    ObservedCustomerProfile {
        session_count: count_to_i64(session_ids.len()),
        activity_count: count_to_i64(activities.len()),
        truncated,
        last_observed_at: activities.first().map(|activity| activity.observed_at),
        facts,
    }
}

fn count_to_i64(count: usize) -> i64 {
    i64::try_from(count).unwrap_or(i64::MAX)
}

#[derive(Debug, Clone, Eq, Ord, PartialEq, PartialOrd)]
struct ParsedFact {
    fact: FactSeed,
    item_ref: Option<String>,
}

fn parse_operation(operation: &str) -> Vec<ParsedFact> {
    let segments = operation
        .trim_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let Some((domain, tokens, item_ref)) = operation_state_tokens(&segments) else {
        return Vec::new();
    };
    tokens
        .iter()
        .filter_map(|token| {
            parse_token(domain, token).map(|fact| ParsedFact {
                fact,
                item_ref: item_ref.map(str::to_owned),
            })
        })
        .collect()
}

fn operation_state_tokens<'a>(
    segments: &'a [&'a str],
) -> Option<(&'a str, &'a [&'a str], Option<&'a str>)> {
    match segments {
        ["agent-negotiate" | "agent-decide", domain, tokens @ ..] => Some((domain, tokens, None)),
        ["agent-pet-household", tokens @ ..] => Some(("petsmart", tokens, None)),
        [
            "agent-product" | "agent-item",
            domain,
            item_ref,
            tokens @ ..,
        ] if !matches!(*item_ref, "evaluate-fit" | "alternatives") => {
            let tokens = if tokens
                .last()
                .is_some_and(|token| matches!(*token, "evaluate-fit" | "alternatives"))
            {
                &tokens[..tokens.len() - 1]
            } else {
                tokens
            };
            Some((domain, tokens, Some(item_ref)))
        }
        _ => None,
    }
}

fn fact_scope(
    activity: &ObservedActivity,
    parsed: &ParsedFact,
) -> (ObservedCustomerFactScope, Option<String>) {
    if is_customer_wide(&parsed.fact) {
        return (ObservedCustomerFactScope::Customer, None);
    }
    if let Some(item_ref) = parsed.item_ref.as_ref() {
        return (ObservedCustomerFactScope::Item, Some(item_ref.clone()));
    }
    if activity.session_source == "customer" {
        return (
            ObservedCustomerFactScope::Journey,
            Some(activity.session_ref.clone()),
        );
    }
    (
        ObservedCustomerFactScope::Session,
        Some(activity.session_ref.clone()),
    )
}

fn is_customer_wide(fact: &FactSeed) -> bool {
    // Only semantics that explicitly describe the household cross the
    // customer-wide boundary. Everything ambiguous stays scoped.
    matches!(fact.key.rsplit('.').next(), Some("household" | "pets"))
}

fn parse_token(domain: &str, token: &str) -> Option<FactSeed> {
    if token.starts_with("consider-") || token == "ready-to-decide" {
        return None;
    }
    if let Some(key) = token.strip_suffix("-unknown") {
        return Some(fact(
            domain,
            &key.replace('-', "_"),
            &humanize(key),
            "Not expressed",
            "unknown",
            None,
            "unknown",
        ));
    }
    if let Some(rest) = token.strip_prefix("budget-") {
        let (strength, amount) = rest.split_once('-')?;
        if matches!(strength, "hard" | "target") && amount.chars().all(|c| c.is_ascii_digit()) {
            return Some(fact(
                domain,
                "budget",
                "Budget",
                &format_budget(domain, amount),
                if strength == "hard" {
                    "constraint"
                } else {
                    "preference"
                },
                Some(strength),
                "observed",
            ));
        }
    }
    if let Some(amount) = token.strip_prefix("max-")
        && amount.chars().all(|c| c.is_ascii_digit())
    {
        return Some(fact(
            domain,
            "budget",
            "Budget",
            &format_budget(domain, amount),
            "constraint",
            Some("hard"),
            "observed",
        ));
    }
    if let Some(amount) = token.strip_prefix("target-")
        && amount.chars().all(|c| c.is_ascii_digit())
    {
        return Some(fact(
            domain,
            "budget",
            "Budget",
            &format_budget(domain, amount),
            "preference",
            Some("target"),
            "observed",
        ));
    }
    if let Some(rest) = token.strip_prefix("commute-") {
        let (strength, minutes) = rest.split_once('-')?;
        if matches!(strength, "hard" | "target") && minutes.chars().all(|c| c.is_ascii_digit()) {
            return Some(fact(
                domain,
                "commute",
                "Commute",
                &format!("{minutes} minutes"),
                if strength == "hard" {
                    "constraint"
                } else {
                    "preference"
                },
                Some(strength),
                "observed",
            ));
        }
    }
    for (prefix, key, label) in [
        ("color-", "color", "Color"),
        ("brand-", "brand", "Brand"),
        ("area-", "area", "Area"),
        ("cabin-", "cabin", "Cabin"),
        ("cuisine-", "cuisine", "Cuisine"),
    ] {
        if let Some(rest) = token.strip_prefix(prefix) {
            let (strength, value) = rest.split_once('-')?;
            if matches!(strength, "require" | "prefer") {
                let required = strength == "require";
                return Some(fact(
                    domain,
                    key,
                    label,
                    &humanize(value),
                    if required { "constraint" } else { "preference" },
                    Some(if required { "required" } else { "preferred" }),
                    "observed",
                ));
            }
        }
    }
    if let Some(value) = token.strip_prefix("must-have-") {
        return Some(fact(
            domain,
            "amenity",
            "Amenity",
            &humanize(value),
            "constraint",
            Some("required"),
            "observed",
        ));
    }
    if let Some(value) = token.strip_prefix("prefer-") {
        return Some(fact(
            domain,
            "amenity",
            "Amenity",
            &humanize(value),
            "preference",
            Some("preferred"),
            "observed",
        ));
    }
    if let Some(amount) = token.strip_prefix("stretch-budget-") {
        return Some(fact(
            domain,
            "budget_flexibility",
            "Budget flexibility",
            &format!("Can stretch to {}", format_budget(domain, amount)),
            "preference",
            Some("flexible"),
            "observed",
        ));
    }
    if let Some(value) = token.strip_prefix("flex-") {
        return Some(fact(
            domain,
            &format!("{}_flexibility", value.replace('-', "_")),
            &format!("{} flexibility", humanize(value)),
            "Flexible",
            "preference",
            Some("flexible"),
            "observed",
        ));
    }

    match token {
        "no-pets" => return Some(simple_fact(domain, "pets", "Pets", "No pets", "context")),
        "nonstop-only" => {
            return Some(fact(
                domain,
                "schedule",
                "Schedule",
                "Nonstop flights only",
                "constraint",
                Some("required"),
                "observed",
            ));
        }
        "no-redeye" => {
            return Some(fact(
                domain,
                "schedule",
                "Schedule",
                "No redeye flights",
                "constraint",
                Some("required"),
                "observed",
            ));
        }
        "schedule-flexible" => {
            return Some(fact(
                domain,
                "schedule",
                "Schedule",
                "Flexible schedule",
                "preference",
                Some("flexible"),
                "observed",
            ));
        }
        "cabin-any" => {
            return Some(simple_fact(
                domain,
                "cabin",
                "Cabin",
                "Any cabin",
                "context",
            ));
        }
        "food-dry-wet" => {
            return Some(simple_fact(
                domain,
                "food_format",
                "Food format",
                "Dry kibble and wet pâté",
                "context",
            ));
        }
        _ => {}
    }

    for (prefix, key, label, kind) in [
        ("target-pet-", "target_pet", "Shopping for", "intent"),
        ("life-stage-", "life_stage", "Life stage", "context"),
        ("animal-size-", "animal_size", "Animal size", "context"),
        ("feeding-goal-", "feeding_goal", "Feeding goal", "intent"),
        ("party-size-", "party_size", "Party size", "context"),
        ("team-size-", "team_size", "Team size", "context"),
        ("move-in-", "move_in", "Move-in", "intent"),
        ("food-format-", "food_format", "Food format", "context"),
        ("destination-", "destination", "Destination", "intent"),
        ("purpose-", "purpose", "Purpose", "intent"),
        ("priority-", "priority", "Priority", "preference"),
        ("household-", "household", "Household", "context"),
        ("behavior-", "behavior", "Behavior", "context"),
        ("occasion-", "occasion", "Occasion", "intent"),
        ("dietary-", "dietary", "Dietary need", "constraint"),
        ("fulfillment-", "fulfillment", "Fulfillment", "constraint"),
        (
            "constraint-",
            "required_constraint",
            "Requirement",
            "constraint",
        ),
        ("cadence-", "cadence", "Purchase cadence", "context"),
        (
            "evidence-",
            "evidence_required",
            "Evidence required",
            "constraint",
        ),
        ("dates-", "date_flexibility", "Date flexibility", "context"),
        ("pet-", "pet", "Pet", "context"),
        ("need-", "product_need", "Product need", "intent"),
        ("beds-", "beds", "Bedrooms", "constraint"),
        ("has-", "pets", "Pets", "context"),
    ] {
        if let Some(value) = token.strip_prefix(prefix) {
            let value = if key == "beds" {
                if value == "studio" {
                    "Studio".to_owned()
                } else {
                    format!(
                        "At least {value} bedroom{}",
                        if value == "1" { "" } else { "s" }
                    )
                }
            } else if key == "party_size" {
                format!("{value} people")
            } else if key == "team_size" {
                format!("{value} seats")
            } else {
                humanize(value)
            };
            return Some(simple_fact(domain, key, label, &value, kind));
        }
    }

    match token {
        "home-one" => Some(simple_fact(
            domain,
            "household",
            "Household",
            "One pet",
            "context",
        )),
        "home-2cat" => Some(simple_fact(
            domain,
            "household",
            "Household",
            "Two cats",
            "context",
        )),
        "home-catdog" => Some(simple_fact(
            domain,
            "household",
            "Household",
            "Cats and a dog",
            "context",
        )),
        "home-2catdog" => Some(simple_fact(
            domain,
            "household",
            "Household",
            "Two cats and a dog",
            "context",
        )),
        "home-multi" => Some(simple_fact(
            domain,
            "household",
            "Household",
            "Multiple pets",
            "context",
        )),
        "beh-typical" => Some(simple_fact(
            domain, "behavior", "Behavior", "Typical", "context",
        )),
        "beh-motivated" => Some(simple_fact(
            domain,
            "behavior",
            "Behavior",
            "Food motivated",
            "context",
        )),
        "beh-stealing" => Some(simple_fact(
            domain,
            "behavior",
            "Behavior",
            "Food stealing observed",
            "context",
        )),
        "goal-schedule" => Some(simple_fact(
            domain,
            "feeding_goal",
            "Feeding goal",
            "Scheduled meals",
            "intent",
        )),
        "goal-portion" => Some(simple_fact(
            domain,
            "feeding_goal",
            "Feeding goal",
            "Portion control",
            "intent",
        )),
        "goal-access" => Some(simple_fact(
            domain,
            "feeding_goal",
            "Feeding goal",
            "Individual access",
            "intent",
        )),
        "goal-away" => Some(simple_fact(
            domain,
            "feeding_goal",
            "Feeding goal",
            "Feed while away",
            "intent",
        )),
        _ => None,
    }
}

fn simple_fact(domain: &str, key: &str, label: &str, value: &str, kind: &str) -> FactSeed {
    fact(domain, key, label, value, kind, None, "observed")
}

fn fact(
    domain: &str,
    key: &str,
    label: &str,
    value: &str,
    kind: &str,
    strength: Option<&str>,
    status: &str,
) -> FactSeed {
    FactSeed {
        key: format!("{domain}.{key}"),
        domain: domain.to_owned(),
        label: label.to_owned(),
        value: value.to_owned(),
        kind: kind.to_owned(),
        strength: strength.map(str::to_owned),
        status: status.to_owned(),
    }
}

fn format_budget(domain: &str, amount: &str) -> String {
    let amount = amount
        .parse::<u64>()
        .map_or_else(|_| amount.to_owned(), format_number);
    match domain {
        "apartments" => format!("${amount}/month"),
        "hotels" => format!("${amount}/night"),
        "restaurants" => format!("${amount}/person"),
        "saas" => format!("${amount}/seat/month"),
        _ => format!("${amount}"),
    }
}

fn format_number(number: u64) -> String {
    let digits = number.to_string();
    let mut rendered = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, character) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            rendered.push(',');
        }
        rendered.push(character);
    }
    rendered
}

fn humanize(value: &str) -> String {
    value
        .split(['-', '_'])
        .filter(|word| !word.is_empty())
        .enumerate()
        .map(|(index, word)| match word {
            "api" => "API".to_owned(),
            "sso" => "SSO".to_owned(),
            "usd" => "USD".to_owned(),
            "nyc" => "NYC".to_owned(),
            _ if index == 0 => {
                let mut characters = word.chars();
                characters
                    .next()
                    .map(|first| first.to_uppercase().collect::<String>() + characters.as_str())
                    .unwrap_or_default()
            }
            _ => word.to_owned(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone as _, Utc};

    use super::*;

    fn activity(session: Uuid, operation: &str, minute: u32) -> ObservedActivity {
        activity_from("customer", session, operation, minute)
    }

    fn activity_from(
        source: &str,
        session: Uuid,
        operation: &str,
        minute: u32,
    ) -> ObservedActivity {
        ObservedActivity {
            session_id: session,
            session_ref: format!("session-{}", &session.simple().to_string()[..8]),
            session_source: source.to_owned(),
            operation: operation.to_owned(),
            observed_at: Utc.with_ymd_and_hms(2026, 8, 5, 12, minute, 0).unwrap(),
        }
    }

    #[test]
    fn derives_scoped_customer_facts_from_cumulative_graph_paths() -> Result<(), &'static str> {
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let profile = derive_observed_customer_profile(vec![
            activity(first, "/agent-negotiate/apartments", 0),
            activity(
                first,
                "/agent-decide/apartments/beds-2/has-cat/budget-hard-4000/prefer-elevator",
                1,
            ),
            activity(
                second,
                "/agent-decide/apartments/beds-2/has-cat/budget-hard-4000/area-prefer-brooklyn",
                2,
            ),
        ]);

        assert_eq!(profile.session_count, 2);
        assert_eq!(profile.activity_count, 3);
        let budgets = profile
            .facts
            .iter()
            .filter(|fact| fact.key == "apartments.budget")
            .collect::<Vec<_>>();
        assert_eq!(budgets.len(), 2);
        assert!(budgets.iter().all(|budget| {
            budget.value == "$4,000/month"
                && budget.strength.as_deref() == Some("hard")
                && budget.scope == ObservedCustomerFactScope::Journey
                && budget.scope_ref.is_some()
                && budget.session_count == 1
                && budget.observation_count == 1
                && budget.evidence.len() == 1
        }));
        let pets = profile
            .facts
            .iter()
            .find(|fact| fact.key == "apartments.pets")
            .ok_or("missing customer-wide pet fact")?;
        assert_eq!(pets.scope, ObservedCustomerFactScope::Customer);
        assert_eq!(pets.scope_ref, None);
        assert_eq!(pets.session_count, 2);
        assert!(profile.facts.iter().any(|fact| {
            fact.key == "apartments.amenity"
                && fact.value == "Elevator"
                && fact.kind == "preference"
                && fact.scope == ObservedCustomerFactScope::Journey
        }));
        Ok(())
    }

    #[test]
    fn keeps_uncertainty_and_household_context_explicit() {
        let session = Uuid::new_v4();
        let profile = derive_observed_customer_profile(vec![
            activity(
                session,
                "/agent-pet-household/target-pet-both/home-2catdog/beh-motivated/food-dry-wet/goal-portion/target-100",
                0,
            ),
            activity(
                session,
                "/agent-decide/flights/destination-tokyo/purpose-unknown/cabin-prefer-premium",
                1,
            ),
        ]);

        assert!(profile.facts.iter().any(|fact| {
            fact.key == "petsmart.household"
                && fact.value == "Two cats and a dog"
                && fact.scope == ObservedCustomerFactScope::Customer
        }));
        assert!(profile.facts.iter().any(|fact| {
            fact.key == "petsmart.food_format" && fact.value == "Dry kibble and wet pâté"
        }));
        assert!(profile.facts.iter().any(|fact| {
            fact.key == "flights.purpose"
                && fact.status == "unknown"
                && fact.value == "Not expressed"
                && fact.scope == ObservedCustomerFactScope::Journey
        }));
    }

    #[test]
    fn scopes_non_customer_context_to_items_or_sessions_when_available() {
        let item_session = Uuid::new_v4();
        let mcp_session = Uuid::new_v4();
        let mcp_session_ref = format!("session-{}", &mcp_session.simple().to_string()[..8]);
        let profile = derive_observed_customer_profile(vec![
            activity(
                item_session,
                "/agent-product/lamps/task-lamp/budget-hard-150/purpose-coding/evaluate-fit",
                0,
            ),
            activity_from("mcp", mcp_session, "/agent-decide/lamps/budget-hard-200", 1),
        ]);

        assert!(profile.facts.iter().any(|fact| {
            fact.key == "lamps.budget"
                && fact.value == "$150"
                && fact.scope == ObservedCustomerFactScope::Item
                && fact.scope_ref.as_deref() == Some("task-lamp")
        }));
        assert!(profile.facts.iter().any(|fact| {
            fact.key == "lamps.budget"
                && fact.value == "$200"
                && fact.scope == ObservedCustomerFactScope::Session
                && fact.scope_ref.as_deref() == Some(mcp_session_ref.as_str())
        }));
    }

    #[test]
    fn ignores_navigation_and_item_routes_that_do_not_encode_need_state() {
        let session = Uuid::new_v4();
        let profile = derive_observed_customer_profile(vec![
            activity(session, "/agent-negotiate/petsmart/consider-pet", 0),
            activity(session, "/agent-item/petsmart/45442", 1),
        ]);

        assert_eq!(profile.activity_count, 2);
        assert!(profile.facts.is_empty());
    }

    #[test]
    fn preserves_a_complete_final_token_at_the_operation_length_limit() {
        let session = Uuid::new_v4();
        let prefix = "/agent-decide/lamps/";
        let suffix = "/purpose-coding";
        let operation = format!(
            "{prefix}{}{suffix}",
            "x".repeat(160 - prefix.len() - suffix.len())
        );
        assert_eq!(operation.len(), 160);

        let profile = derive_observed_customer_profile(vec![activity(session, &operation, 0)]);

        assert!(
            profile
                .facts
                .iter()
                .any(|fact| fact.key == "lamps.purpose" && fact.value == "Coding")
        );
    }
}
