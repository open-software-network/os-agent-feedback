//! Human-friendly labels for pseudonymous customers.
//!
//! Anonymous visitors used to surface on the dashboard through auto-generated
//! identifier hints such as `anonymous-9f2abC1d` or the generic `Anonymous
//! customer` fallback. Those labels are hard to scan and impossible to talk
//! about. This module maps a stable customer id to a deterministic
//! `<Adjective> <Animal>` label (the same approach `LogRocket` uses for
//! anonymous sessions) so every dashboard surface can show a name a human can
//! remember and reference. The mapping is derived from the customer UUID, so
//! the same visitor keeps the same name across sessions and restarts without
//! any extra storage.

#![allow(
    clippy::redundant_pub_crate,
    reason = "crate-restricted visibility satisfies unreachable_pub in this binary-only crate"
)]

use uuid::Uuid;

const ADJECTIVES: &[&str] = &[
    "Amber", "Bouncy", "Brave", "Bright", "Brisk", "Bubbly", "Calm", "Cheerful", "Clever", "Cozy",
    "Crisp", "Curious", "Daring", "Dapper", "Eager", "Earnest", "Fancy", "Fizzy", "Fleet",
    "Fluffy", "Gentle", "Giddy", "Glad", "Gleeful", "Graceful", "Happy", "Hardy", "Jolly", "Jumpy",
    "Keen", "Kind", "Lively", "Lucky", "Mellow", "Merry", "Mighty", "Nimble", "Noble", "Peppy",
    "Perky", "Playful", "Plucky", "Polite", "Proud", "Quick", "Quiet", "Quirky", "Rapid", "Rowdy",
    "Shiny", "Silly", "Sleek", "Snappy", "Snug", "Sparky", "Speedy", "Spry", "Steady", "Sunny",
    "Swift", "Tidy", "Trusty", "Velvet", "Wavy", "Whimsy", "Wily", "Witty", "Zany", "Zesty",
];

const ANIMALS: &[&str] = &[
    "Albatross",
    "Badger",
    "Beaver",
    "Bison",
    "Bobcat",
    "Cardinal",
    "Cheetah",
    "Chipmunk",
    "Condor",
    "Cougar",
    "Coyote",
    "Crane",
    "Dolphin",
    "Falcon",
    "Ferret",
    "Finch",
    "Fox",
    "Gazelle",
    "Gecko",
    "Gopher",
    "Heron",
    "Hedgehog",
    "Ibex",
    "Jackal",
    "Jaguar",
    "Koala",
    "Lark",
    "Lemur",
    "Lynx",
    "Marmot",
    "Mole",
    "Moose",
    "Newt",
    "Ocelot",
    "Opossum",
    "Orca",
    "Otter",
    "Owl",
    "Panda",
    "Panther",
    "Pelican",
    "Penguin",
    "Puffin",
    "Quail",
    "Rabbit",
    "Raccoon",
    "Raven",
    "Robin",
    "Salmon",
    "Seal",
    "Sparrow",
    "Stoat",
    "Stork",
    "Swift",
    "Tapir",
    "Tiger",
    "Toad",
    "Toucan",
    "Trout",
    "Turtle",
    "Viper",
    "Vole",
    "Walrus",
    "Weasel",
    "Wombat",
    "Wren",
    "Yak",
    "Zebra",
];

/// Deterministic `<Adjective> <Animal>` label for a customer id.
pub(crate) fn friendly_customer_name(customer_id: Uuid) -> String {
    let bytes = customer_id.as_bytes();
    let adjective = ADJECTIVES[usize::from(bytes[0]) % ADJECTIVES.len()];
    let animal = ANIMALS[usize::from(bytes[1]) % ANIMALS.len()];
    format!("{adjective} {animal}")
}

/// True when a resolved dashboard label is one of the auto-generated anonymous
/// placeholders rather than a real product-provided name. These patterns are
/// only produced by Epode itself (`customer_identifier_hint` for anonymous
/// identifiers and the pseudonymous `CASE` fallback in dashboard queries), so
/// matching them is safe without checking the customer's identity level.
fn is_generated_anonymous_label(name: &str) -> bool {
    name == "Anonymous customer" || name.starts_with("anonymous-")
}

fn replace_generated_label(customer_id: Option<Uuid>, current: Option<&str>) -> Option<String> {
    match current {
        Some(label) if is_generated_anonymous_label(label) => {
            customer_id.map(friendly_customer_name)
        }
        _ => None,
    }
}

/// Returns a friendly replacement label when the resolved label is an
/// auto-generated anonymous placeholder, or when a pseudonymous customer has
/// no label at all. Returns `None` when the current label should be kept as-is
/// (explicit display names or product-provided hints).
pub(crate) fn friendly_label_for(
    identity_level: Option<&str>,
    customer_id: Option<Uuid>,
    current: Option<&str>,
) -> Option<String> {
    if let Some(label) = replace_generated_label(customer_id, current) {
        return Some(label);
    }
    if identity_level == Some("pseudonymous") && current.is_none() {
        return customer_id.map(friendly_customer_name);
    }
    None
}

/// Returns a friendly replacement for an auto-generated anonymous placeholder
/// label, for read models that do not carry the customer's identity level.
pub(crate) fn friendly_label_for_placeholder(
    customer_id: Option<Uuid>,
    current: Option<&str>,
) -> Option<String> {
    replace_generated_label(customer_id, current)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn friendly_name_is_deterministic() {
        let id = Uuid::new_v4();
        assert_eq!(friendly_customer_name(id), friendly_customer_name(id));
    }

    #[test]
    fn friendly_name_uses_adjective_animal_shape() {
        let name = friendly_customer_name(Uuid::new_v4());
        let parts = name.split(' ').collect::<Vec<_>>();
        assert_eq!(parts.len(), 2, "expected two words, got {name}");
        assert!(ADJECTIVES.contains(&parts[0]), "unknown adjective {name}");
        assert!(ANIMALS.contains(&parts[1]), "unknown animal {name}");
    }

    #[test]
    fn replaces_generated_anonymous_labels() {
        let id = Uuid::new_v4();
        for label in ["Anonymous customer", "anonymous-9f2abC1d"] {
            let replacement = friendly_label_for(Some("pseudonymous"), Some(id), Some(label));
            assert_eq!(replacement, Some(friendly_customer_name(id)));
        }
    }

    #[test]
    fn keeps_real_names_and_verified_customers() {
        let id = Uuid::new_v4();
        assert_eq!(
            friendly_label_for(Some("pseudonymous"), Some(id), Some("Acme Ops")),
            None
        );
        assert_eq!(
            friendly_label_for(Some("pseudonymous"), Some(id), Some("visitor-123")),
            None
        );
        assert_eq!(
            friendly_label_for(Some("pseudonymous"), None, Some("Anonymous customer")),
            None
        );
        assert_eq!(
            friendly_label_for(None, Some(id), Some("Anonymous customer")),
            Some(friendly_customer_name(id))
        );
    }

    #[test]
    fn fills_missing_label_for_pseudonymous_customers() {
        let id = Uuid::new_v4();
        let replacement = friendly_label_for(Some("pseudonymous"), Some(id), None);
        assert_eq!(replacement, Some(friendly_customer_name(id)));
        assert_eq!(friendly_label_for(Some("verified"), Some(id), None), None);
    }

    #[test]
    fn placeholder_helper_replaces_only_generated_labels() {
        let id = Uuid::new_v4();
        assert_eq!(
            friendly_label_for_placeholder(Some(id), Some("anonymous-9f2abC1d")),
            Some(friendly_customer_name(id))
        );
        assert_eq!(
            friendly_label_for_placeholder(Some(id), Some("Anonymous customer")),
            Some(friendly_customer_name(id))
        );
        assert_eq!(
            friendly_label_for_placeholder(Some(id), Some("Acme Ops")),
            None
        );
        assert_eq!(friendly_label_for_placeholder(Some(id), None), None);
        assert_eq!(
            friendly_label_for_placeholder(None, Some("anonymous-9f2abC1d")),
            None
        );
    }
}
