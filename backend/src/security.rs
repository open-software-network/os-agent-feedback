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
pub struct CapabilityClaims {
    pub v: u8,
    pub i: Uuid,
    pub iat: i64,
    pub exp: i64,
    pub n: String,
}

#[derive(Debug, Clone)]
pub struct ParsedCapability {
    pub key_id: Uuid,
    pub claims: CapabilityClaims,
    pub signing_input: String,
    pub signature: Vec<u8>,
}

pub fn random_token(prefix: &str) -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    format!("{prefix}{}", URL_SAFE_NO_PAD.encode(bytes))
}

pub fn sha256(value: &str) -> Vec<u8> {
    Sha256::digest(value.as_bytes()).to_vec()
}

pub fn parse_capability(token: &str) -> Result<ParsedCapability, ApiError> {
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

pub fn verify_capability(
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
        || issued_at > now + Duration::minutes(5)
        || expires_at <= now
        || expires_at - issued_at > Duration::hours(2)
        || expires_at <= issued_at
    {
        return Err(ApiError::unauthorized());
    }
    Ok(parsed.claims)
}

pub fn bearer_token(headers: &HeaderMap) -> Option<String> {
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

pub fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
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

pub fn http_only_cookie(name: &str, value: &str, max_age: u64, secure: bool) -> String {
    format!(
        "{name}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{}",
        if secure { "; Secure" } else { "" }
    )
}

pub fn clear_cookie(name: &str, secure: bool) -> String {
    format!(
        "{name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{}",
        if secure { "; Secure" } else { "" }
    )
}

pub fn reject_sensitive_fields(value: &serde_json::Value) -> Result<(), &'static str> {
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
    use super::*;

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
        };
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        let input = format!("afr2_{}.{payload}", key_id.simple());
        let mut mac = HmacSha256::new_from_slice(&key_hash).unwrap();
        mac.update(input.as_bytes());
        let token = format!(
            "{input}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        );
        let parsed = parse_capability(&token).unwrap();
        assert_eq!(
            verify_capability(parsed, &key_hash, now).unwrap().i,
            claims.i
        );

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
}
