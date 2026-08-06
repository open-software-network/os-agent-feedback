#![allow(
    clippy::redundant_pub_crate,
    reason = "crate-restricted visibility keeps the graph projection private to this binary"
)]

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::models::{ObservedCustomerFact, ObservedCustomerFactEvidence, ObservedCustomerProfile};

const MAX_FACT_EVIDENCE: usize = 3;
pub(crate) const PROFILE_NODE_LIMIT: usize = 5_000;

#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct ObservedGraphNode {
    pub session_id: Uuid,
    pub session_ref: String,
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

struct FactAccumulator {
    seed: FactSeed,
    journeys: BTreeSet<Uuid>,
    observation_count: i64,
    first_observed_at: DateTime<Utc>,
    last_observed_at: DateTime<Utc>,
    evidence: Vec<ObservedCustomerFactEvidence>,
}

/// Derive a bounded, evidence-backed customer profile from retained graph nodes.
///
/// Operations are deliberately normalized, non-sensitive graph paths. This
/// projection never promotes a task observation into durable memory: every fact
/// carries the journeys, node count, and recency that justify displaying it.
pub(crate) fn derive_observed_customer_profile(
    mut nodes: Vec<ObservedGraphNode>,
) -> ObservedCustomerProfile {
    nodes.sort_by(|left, right| {
        right
            .observed_at
            .cmp(&left.observed_at)
            .then_with(|| right.session_id.cmp(&left.session_id))
            .then_with(|| right.operation.cmp(&left.operation))
    });
    let truncated = nodes.len() > PROFILE_NODE_LIMIT;
    nodes.truncate(PROFILE_NODE_LIMIT);
    let mut journey_ids = BTreeSet::new();
    let mut facts = BTreeMap::<FactSeed, FactAccumulator>::new();

    for node in &nodes {
        journey_ids.insert(node.session_id);
        let mut facts_in_node = BTreeSet::new();
        for seed in parse_operation(&node.operation) {
            if !facts_in_node.insert(seed.clone()) {
                continue;
            }
            let entry = facts
                .entry(seed.clone())
                .or_insert_with(|| FactAccumulator {
                    seed,
                    journeys: BTreeSet::new(),
                    observation_count: 0,
                    first_observed_at: node.observed_at,
                    last_observed_at: node.observed_at,
                    evidence: Vec::new(),
                });
            entry.journeys.insert(node.session_id);
            entry.observation_count += 1;
            entry.first_observed_at = entry.first_observed_at.min(node.observed_at);
            entry.last_observed_at = entry.last_observed_at.max(node.observed_at);
            if entry.evidence.len() < MAX_FACT_EVIDENCE
                && !entry
                    .evidence
                    .iter()
                    .any(|evidence| evidence.session_id == node.session_id)
            {
                entry.evidence.push(ObservedCustomerFactEvidence {
                    session_id: node.session_id,
                    session_ref: node.session_ref.clone(),
                    operation: node.operation.clone(),
                    observed_at: node.observed_at,
                });
            }
        }
    }

    let mut facts = facts
        .into_values()
        .map(|fact| ObservedCustomerFact {
            key: fact.seed.key,
            domain: fact.seed.domain,
            label: fact.seed.label,
            value: fact.seed.value,
            kind: fact.seed.kind,
            strength: fact.seed.strength,
            status: fact.seed.status,
            journey_count: count_to_i64(fact.journeys.len()),
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
            .then_with(|| right.journey_count.cmp(&left.journey_count))
            .then_with(|| left.key.cmp(&right.key))
            .then_with(|| left.value.cmp(&right.value))
    });

    ObservedCustomerProfile {
        journey_count: count_to_i64(journey_ids.len()),
        node_count: count_to_i64(nodes.len()),
        truncated,
        last_observed_at: nodes.first().map(|node| node.observed_at),
        facts,
    }
}

fn count_to_i64(count: usize) -> i64 {
    i64::try_from(count).unwrap_or(i64::MAX)
}

fn parse_operation(operation: &str) -> Vec<FactSeed> {
    let segments = operation
        .trim_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let Some((domain, tokens)) = operation_state_tokens(&segments) else {
        return Vec::new();
    };
    let token_count = if operation.chars().count() == 160 {
        tokens.len().saturating_sub(1)
    } else {
        tokens.len()
    };
    tokens[..token_count]
        .iter()
        .filter_map(|token| parse_token(domain, token))
        .collect()
}

fn operation_state_tokens<'a>(segments: &'a [&'a str]) -> Option<(&'a str, &'a [&'a str])> {
    match segments {
        ["agent-negotiate" | "agent-decide", domain, tokens @ ..] => Some((domain, tokens)),
        ["agent-pet-household", tokens @ ..] => Some(("petsmart", tokens)),
        _ => None,
    }
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

    fn node(session: Uuid, operation: &str, minute: u32) -> ObservedGraphNode {
        ObservedGraphNode {
            session_id: session,
            session_ref: format!("session-{}", &session.simple().to_string()[..8]),
            operation: operation.to_owned(),
            observed_at: Utc.with_ymd_and_hms(2026, 8, 5, 12, minute, 0).unwrap(),
        }
    }

    #[test]
    fn derives_scoped_customer_facts_from_cumulative_graph_paths() -> Result<(), &'static str> {
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let profile = derive_observed_customer_profile(vec![
            node(first, "/agent-negotiate/apartments", 0),
            node(
                first,
                "/agent-decide/apartments/beds-2/has-cat/budget-hard-4000/prefer-elevator",
                1,
            ),
            node(
                second,
                "/agent-decide/apartments/beds-2/has-cat/budget-hard-4000/area-prefer-brooklyn",
                2,
            ),
        ]);

        assert_eq!(profile.journey_count, 2);
        assert_eq!(profile.node_count, 3);
        let budget = profile
            .facts
            .iter()
            .find(|fact| fact.key == "apartments.budget")
            .ok_or("missing budget fact")?;
        assert_eq!(budget.value, "$4,000/month");
        assert_eq!(budget.strength.as_deref(), Some("hard"));
        assert_eq!(budget.journey_count, 2);
        assert_eq!(budget.observation_count, 2);
        assert_eq!(budget.evidence.len(), 2);
        assert!(profile.facts.iter().any(|fact| {
            fact.key == "apartments.amenity"
                && fact.value == "Elevator"
                && fact.kind == "preference"
        }));
        Ok(())
    }

    #[test]
    fn keeps_uncertainty_and_household_context_explicit() {
        let session = Uuid::new_v4();
        let profile = derive_observed_customer_profile(vec![
            node(
                session,
                "/agent-pet-household/target-pet-both/home-2catdog/beh-motivated/food-dry-wet/goal-portion/target-100",
                0,
            ),
            node(
                session,
                "/agent-decide/flights/destination-tokyo/purpose-unknown/cabin-prefer-premium",
                1,
            ),
        ]);

        assert!(profile.facts.iter().any(|fact| {
            fact.key == "petsmart.household" && fact.value == "Two cats and a dog"
        }));
        assert!(profile.facts.iter().any(|fact| {
            fact.key == "petsmart.food_format" && fact.value == "Dry kibble and wet pâté"
        }));
        assert!(profile.facts.iter().any(|fact| {
            fact.key == "flights.purpose"
                && fact.status == "unknown"
                && fact.value == "Not expressed"
        }));
    }

    #[test]
    fn ignores_navigation_and_item_routes_that_do_not_encode_need_state() {
        let session = Uuid::new_v4();
        let profile = derive_observed_customer_profile(vec![
            node(session, "/agent-negotiate/petsmart/consider-pet", 0),
            node(session, "/agent-item/petsmart/45442", 1),
        ]);

        assert_eq!(profile.node_count, 2);
        assert!(profile.facts.is_empty());
    }

    #[test]
    fn drops_a_possibly_clipped_final_token_from_max_length_operations() {
        let session = Uuid::new_v4();
        let prefix = "/agent-decide/apartments/beds-2/";
        let clipped = format!("{prefix}purpose-{}", "x".repeat(160 - prefix.len() - 8));
        assert_eq!(clipped.len(), 160);

        let profile = derive_observed_customer_profile(vec![node(session, &clipped, 0)]);

        assert!(
            profile
                .facts
                .iter()
                .any(|fact| fact.key == "apartments.beds")
        );
        assert!(
            !profile
                .facts
                .iter()
                .any(|fact| fact.key == "apartments.purpose")
        );
    }
}
