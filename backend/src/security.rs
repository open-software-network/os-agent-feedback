#![allow(
    clippy::redundant_pub_crate,
    reason = "crate-restricted visibility satisfies unreachable_pub in this binary-only crate"
)]

use axum::http::HeaderMap;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, Utc};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::ApiError;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CapabilityClaims {
    pub v: u8,
    pub i: Uuid,
    pub iat: i64,
    pub exp: i64,
    pub n: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub s: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r: Option<i64>,
}

#[derive(Debug, Clone)]
pub(crate) struct ParsedCapability {
    pub key_id: Uuid,
    pub claims: CapabilityClaims,
    pub signing_input: String,
    pub signature: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EnrichmentCapabilityClaims {
    pub v: u8,
    pub q: Uuid,
    pub i: Uuid,
    pub iat: i64,
    pub exp: i64,
    pub n: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ParsedEnrichmentCapability {
    pub key_id: Uuid,
    pub claims: EnrichmentCapabilityClaims,
    pub signing_input: String,
    pub signature: Vec<u8>,
}

pub(crate) fn random_token(prefix: &str) -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    format!("{prefix}{}", URL_SAFE_NO_PAD.encode(bytes))
}

pub(crate) fn sha256(value: &str) -> Vec<u8> {
    sha256_bytes(value.as_bytes())
}

pub(crate) fn sha256_bytes(value: &[u8]) -> Vec<u8> {
    Sha256::digest(value).to_vec()
}

pub(crate) fn parse_capability(token: &str) -> Result<ParsedCapability, ApiError> {
    let encoded = token
        .strip_prefix("afr2_")
        .ok_or_else(ApiError::unauthorized)?;
    let mut parts = encoded.split('.');
    let key_id_text = parts.next().ok_or_else(ApiError::unauthorized)?;
    let payload = parts.next().ok_or_else(ApiError::unauthorized)?;
    let signature_text = parts.next().ok_or_else(ApiError::unauthorized)?;
    if parts.next().is_some() {
        return Err(ApiError::unauthorized());
    }
    let key_id = Uuid::parse_str(key_id_text).map_err(|_| ApiError::unauthorized())?;
    let payload_bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| ApiError::unauthorized())?;
    let claims: CapabilityClaims =
        serde_json::from_slice(&payload_bytes).map_err(|_| ApiError::unauthorized())?;
    let signature = URL_SAFE_NO_PAD
        .decode(signature_text)
        .map_err(|_| ApiError::unauthorized())?;
    Ok(ParsedCapability {
        key_id,
        claims,
        signing_input: format!("afr2_{key_id_text}.{payload}"),
        signature,
    })
}

#[cfg(test)]
pub(crate) fn sign_enrichment_capability(
    key_id: Uuid,
    key_hash: &[u8],
    request_id: Uuid,
    interaction_id: Uuid,
    now: DateTime<Utc>,
    expires_at: DateTime<Utc>,
) -> Result<(String, Vec<u8>), ApiError> {
    let nonce = random_token("");
    sign_enrichment_capability_with_nonce(
        key_id,
        key_hash,
        request_id,
        interaction_id,
        now,
        expires_at,
        &nonce,
    )
}

fn sign_enrichment_capability_with_nonce(
    key_id: Uuid,
    key_hash: &[u8],
    request_id: Uuid,
    interaction_id: Uuid,
    now: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    nonce: &str,
) -> Result<(String, Vec<u8>), ApiError> {
    let claims = EnrichmentCapabilityClaims {
        v: 1,
        q: request_id,
        i: interaction_id,
        iat: now.timestamp(),
        exp: expires_at.timestamp(),
        n: nonce.to_owned(),
    };
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).map_err(ApiError::internal)?);
    let signing_input = format!("aqr1_{}.{payload}", key_id.simple());
    let mut mac = HmacSha256::new_from_slice(key_hash).map_err(ApiError::internal)?;
    mac.update(signing_input.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    Ok((format!("{signing_input}.{signature}"), sha256(nonce)))
}

/// Creates an idempotent, request-bound capability. The nonce remains secret because
/// it is derived with the product key hash, while identical request retries can
/// reconstruct the same winning token without storing bearer credentials.
pub(crate) fn sign_deterministic_enrichment_capability(
    key_id: Uuid,
    key_hash: &[u8],
    request_id: Uuid,
    interaction_id: Uuid,
    issued_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    contract_digest: Option<&[u8]>,
) -> Result<(String, Vec<u8>), ApiError> {
    let mut mac = HmacSha256::new_from_slice(key_hash).map_err(ApiError::internal)?;
    mac.update(b"epode-enrichment-capability-nonce-v1\0");
    mac.update(request_id.as_bytes());
    mac.update(interaction_id.as_bytes());
    mac.update(&issued_at.timestamp().to_be_bytes());
    mac.update(&expires_at.timestamp().to_be_bytes());
    if let Some(digest) = contract_digest {
        mac.update(b"\0contract-v1\0");
        mac.update(digest);
    }
    let nonce = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    sign_enrichment_capability_with_nonce(
        key_id,
        key_hash,
        request_id,
        interaction_id,
        issued_at,
        expires_at,
        &nonce,
    )
}

pub(crate) fn parse_enrichment_capability(
    token: &str,
) -> Result<ParsedEnrichmentCapability, ApiError> {
    let encoded = token
        .strip_prefix("aqr1_")
        .ok_or_else(ApiError::unauthorized)?;
    let mut parts = encoded.split('.');
    let key_id_text = parts.next().ok_or_else(ApiError::unauthorized)?;
    let payload = parts.next().ok_or_else(ApiError::unauthorized)?;
    let signature_text = parts.next().ok_or_else(ApiError::unauthorized)?;
    if parts.next().is_some() {
        return Err(ApiError::unauthorized());
    }
    let key_id = Uuid::parse_str(key_id_text).map_err(|_| ApiError::unauthorized())?;
    let payload_bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| ApiError::unauthorized())?;
    let claims: EnrichmentCapabilityClaims =
        serde_json::from_slice(&payload_bytes).map_err(|_| ApiError::unauthorized())?;
    let signature = URL_SAFE_NO_PAD
        .decode(signature_text)
        .map_err(|_| ApiError::unauthorized())?;
    Ok(ParsedEnrichmentCapability {
        key_id,
        claims,
        signing_input: format!("aqr1_{key_id_text}.{payload}"),
        signature,
    })
}

pub(crate) fn verify_enrichment_capability(
    parsed: ParsedEnrichmentCapability,
    key_hash: &[u8],
    now: DateTime<Utc>,
) -> Result<EnrichmentCapabilityClaims, ApiError> {
    let mut mac = HmacSha256::new_from_slice(key_hash).map_err(ApiError::internal)?;
    mac.update(parsed.signing_input.as_bytes());
    mac.verify_slice(&parsed.signature)
        .map_err(|_| ApiError::unauthorized())?;
    let issued_at =
        DateTime::from_timestamp(parsed.claims.iat, 0).ok_or_else(ApiError::unauthorized)?;
    let expires_at =
        DateTime::from_timestamp(parsed.claims.exp, 0).ok_or_else(ApiError::unauthorized)?;
    if parsed.claims.v != 1
        || parsed.claims.n.len() < 16
        || parsed.claims.n.len() > 128
        || issued_at > now + Duration::minutes(5)
        || expires_at <= now
        || expires_at - issued_at > Duration::hours(2)
        || expires_at <= issued_at
    {
        return Err(ApiError::unauthorized());
    }
    Ok(parsed.claims)
}

pub(crate) fn verify_capability(
    parsed: ParsedCapability,
    key_hash: &[u8],
    now: DateTime<Utc>,
) -> Result<CapabilityClaims, ApiError> {
    let mut mac = HmacSha256::new_from_slice(key_hash).map_err(ApiError::internal)?;
    mac.update(parsed.signing_input.as_bytes());
    mac.verify_slice(&parsed.signature)
        .map_err(|_| ApiError::unauthorized())?;

    let issued_at =
        DateTime::from_timestamp(parsed.claims.iat, 0).ok_or_else(ApiError::unauthorized)?;
    let expires_at =
        DateTime::from_timestamp(parsed.claims.exp, 0).ok_or_else(ApiError::unauthorized)?;
    if parsed.claims.v != 1
        || parsed.claims.n.len() < 16
        || parsed.claims.n.len() > 128
        || parsed
            .claims
            .s
            .as_deref()
            .is_some_and(|subject| !valid_consent_subject(subject))
        || parsed.claims.r.is_some_and(|revision| revision < 0)
        || (parsed.claims.r.is_some() && parsed.claims.s.is_none())
        || issued_at > now + Duration::minutes(5)
        || expires_at <= now
        || expires_at - issued_at > Duration::hours(2)
        || expires_at <= issued_at
    {
        return Err(ApiError::unauthorized());
    }
    Ok(parsed.claims)
}

pub(crate) fn valid_consent_subject(value: &str) -> bool {
    value.strip_prefix("afsub1_").is_some_and(|suffix| {
        suffix.len() == 43
            && suffix
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "-_".contains(character))
    })
}

pub(crate) fn bearer_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            headers
                .get("x-api-key")
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
}

pub(crate) fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get("cookie")
        .and_then(|value| value.to_str().ok())
        .and_then(|cookies| {
            cookies.split(';').find_map(|part| {
                let (key, value) = part.trim().split_once('=')?;
                (key == name).then(|| value.to_string())
            })
        })
}

pub(crate) fn http_only_cookie(name: &str, value: &str, max_age: u64, secure: bool) -> String {
    format!(
        "{name}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{}",
        if secure { "; Secure" } else { "" }
    )
}

pub(crate) fn clear_cookie(name: &str, secure: bool) -> String {
    format!(
        "{name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{}",
        if secure { "; Secure" } else { "" }
    )
}

pub(crate) fn reject_sensitive_fields(value: &serde_json::Value) -> Result<(), &'static str> {
    const FORBIDDEN: &[&str] = &[
        "prompt",
        "prompts",
        "transcript",
        "messages",
        "raw_input",
        "raw_output",
        "tool_input",
        "tool_output",
        "secret",
        "api_key",
        "authorization",
        "customer_data",
        "email",
        "name",
        "user",
        "user_data",
        "personal_data",
    ];
    match value {
        serde_json::Value::Object(object) => {
            if object.keys().any(|key| {
                let normalized = key
                    .chars()
                    .flat_map(char::to_lowercase)
                    .map(|character| if character == '-' { '_' } else { character })
                    .collect::<String>();
                FORBIDDEN.contains(&normalized.as_str())
            }) {
                return Err(
                    "Raw prompts, transcripts, secrets, customer data, and tool payloads are not accepted",
                );
            }
            for nested in object.values() {
                reject_sensitive_fields(nested)?;
            }
        }
        serde_json::Value::Array(values) => {
            for nested in values {
                reject_sensitive_fields(nested)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::expect_used,
        reason = "test failures should abort at the assertion site"
    )]

    use super::*;

    fn signed_capability(key_id: Uuid, key_hash: &[u8], claims: &CapabilityClaims) -> String {
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap());
        let input = format!("afr2_{}.{payload}", key_id.simple());
        let mut mac = HmacSha256::new_from_slice(key_hash).unwrap();
        mac.update(input.as_bytes());
        format!(
            "{input}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        )
    }

    #[test]
    fn blocks_sensitive_payload_fields() {
        assert!(reject_sensitive_fields(&serde_json::json!({"prompt": "private"})).is_err());
        assert!(
            reject_sensitive_fields(&serde_json::json!({"metadata": {"transcript": "private"}}))
                .is_err()
        );
        assert!(reject_sensitive_fields(&serde_json::json!({"summary": "metadata only"})).is_ok());
    }

    #[test]
    fn verifies_short_lived_capability_and_rejects_tampering() {
        let key_id = Uuid::new_v4();
        let key_hash = sha256("af_live_test");
        let now = Utc::now();
        let claims = CapabilityClaims {
            v: 1,
            i: Uuid::new_v4(),
            iat: now.timestamp(),
            exp: (now + Duration::hours(2)).timestamp(),
            n: "0123456789abcdef".into(),
            s: Some(format!("afsub1_{}", "a".repeat(43))),
            r: Some(7),
        };
        let token = signed_capability(key_id, &key_hash, &claims);
        let parsed = parse_capability(&token).unwrap();
        let verified = verify_capability(parsed, &key_hash, now).unwrap();
        assert_eq!(verified.i, claims.i);
        assert_eq!(verified.r, Some(7));

        let mut tampered = token.into_bytes();
        let signature_start = tampered.iter().rposition(|value| *value == b'.').unwrap() + 1;
        tampered[signature_start] = if tampered[signature_start] == b'A' {
            b'B'
        } else {
            b'A'
        };
        let tampered = String::from_utf8(tampered).unwrap();
        assert!(verify_capability(parse_capability(&tampered).unwrap(), &key_hash, now).is_err());
    }

    #[test]
    fn rejects_invalid_subject_revision_claims() {
        let key_id = Uuid::new_v4();
        let key_hash = sha256("af_live_test");
        let now = Utc::now();
        let mut claims = CapabilityClaims {
            v: 1,
            i: Uuid::new_v4(),
            iat: now.timestamp(),
            exp: (now + Duration::hours(1)).timestamp(),
            n: "0123456789abcdef".into(),
            s: Some(format!("afsub1_{}", "a".repeat(43))),
            r: Some(-1),
        };
        let negative = signed_capability(key_id, &key_hash, &claims);
        assert!(verify_capability(parse_capability(&negative).unwrap(), &key_hash, now).is_err());

        claims.s = None;
        claims.r = Some(0);
        let unscoped = signed_capability(key_id, &key_hash, &claims);
        assert!(verify_capability(parse_capability(&unscoped).unwrap(), &key_hash, now).is_err());
    }

    #[test]
    fn enrichment_capabilities_are_request_bound_and_domain_separated() {
        let key_id = Uuid::new_v4();
        let key_hash = sha256("af_live_enrichment_test");
        let now = Utc::now();
        let request_id = Uuid::new_v4();
        let interaction_id = Uuid::new_v4();
        let (token, nonce_hash) = sign_enrichment_capability(
            key_id,
            &key_hash,
            request_id,
            interaction_id,
            now,
            now + Duration::hours(1),
        )
        .unwrap();
        assert!(token.starts_with("aqr1_"));
        assert!(parse_capability(&token).is_err());
        let parsed = parse_enrichment_capability(&token).unwrap();
        let claims = verify_enrichment_capability(parsed, &key_hash, now).unwrap();
        assert_eq!(claims.q, request_id);
        assert_eq!(claims.i, interaction_id);
        assert_eq!(nonce_hash, sha256(&claims.n));

        let expires_at = now + Duration::hours(1);
        let deterministic = sign_deterministic_enrichment_capability(
            key_id,
            &key_hash,
            request_id,
            interaction_id,
            now,
            expires_at,
            None,
        )
        .unwrap();
        let retry = sign_deterministic_enrichment_capability(
            key_id,
            &key_hash,
            request_id,
            interaction_id,
            now,
            expires_at,
            None,
        )
        .unwrap();
        let other = sign_deterministic_enrichment_capability(
            key_id,
            &key_hash,
            Uuid::new_v4(),
            interaction_id,
            now,
            expires_at,
            None,
        )
        .unwrap();
        assert_eq!(deterministic, retry);
        assert_ne!(deterministic.0, other.0);

        let mut tampered = token.into_bytes();
        let signature_start = tampered.iter().rposition(|value| *value == b'.').unwrap() + 1;
        tampered[signature_start] = if tampered[signature_start] == b'A' {
            b'B'
        } else {
            b'A'
        };
        let tampered = String::from_utf8(tampered).unwrap();
        assert!(
            verify_enrichment_capability(
                parse_enrichment_capability(&tampered).unwrap(),
                &key_hash,
                now,
            )
            .is_err()
        );
    }
}
