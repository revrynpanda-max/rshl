//! User Isolation Layer.
//!
//! Every claim that enters the Epistemic Vault must carry a user_hash.
//! Queries are scoped to the requesting user’s hash unless the user explicitly
//! requests universal (Tier 4) data. This module provides the hashing and
//! validation functions.

use sha2::{Sha256, Digest};

/// Generate a deterministic hash from a user identifier (Discord ID, etc.).
/// The hash is truncated to 8 hex characters for brevity in Claim IDs.
pub fn hash_user_id(user_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(user_id.as_bytes());
    let result = hasher.finalize();
    format!("{:x}", result)[..8].to_string()
}

/// Validate that a claim’s user_hash matches the expected user.
/// Returns `true` if the claim belongs to the user or is a universal claim
/// (user_hash empty).
pub fn claim_belongs_to_user(claim_user_hash: &str, user_hash: &str) -> bool {
    claim_user_hash.is_empty() || claim_user_hash == user_hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hash_determinism() {
        let h1 = hash_user_id("ryan#1234");
        let h2 = hash_user_id("ryan#1234");
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 8);
    }

    #[test]
    fn test_claim_belongs_to_user_universal() {
        assert!(claim_belongs_to_user("", "user1"));
    }

    #[test]
    fn test_claim_belongs_to_user_mismatch() {
        assert!(!claim_belongs_to_user("abc123", "def456"));
    }
}
