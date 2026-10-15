//! Secret storage encryption, session tokens and password hashing.

use std::io;
use std::path::Path;

use argon2::Argon2;
use argon2::password_hash::phc::PasswordHash;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use sha2::{Digest, Sha256};

/// Encrypts API keys at rest with XChaCha20-Poly1305 under a key kept in `secret.key`.
#[derive(Clone)]
pub struct SecretBox {
    cipher: XChaCha20Poly1305,
}

impl SecretBox {
    pub fn load_or_create(path: &Path) -> io::Result<Self> {
        let key = match std::fs::read(path) {
            Ok(bytes) if bytes.len() == 32 => bytes,
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "secret.key must contain 32 bytes",
                ));
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                let mut key = vec![0u8; 32];
                rand::fill(&mut key[..]);
                write_private(path, &key)?;
                key
            }
            Err(e) => return Err(e),
        };
        let cipher = XChaCha20Poly1305::new_from_slice(&key).expect("key has 32 bytes");
        Ok(Self { cipher })
    }

    /// Returns `nonce || ciphertext`.
    pub fn seal(&self, plaintext: &[u8]) -> Vec<u8> {
        let mut nonce = [0u8; 24];
        rand::fill(&mut nonce);
        let ciphertext = self
            .cipher
            .encrypt(&XNonce::from(nonce), plaintext)
            .expect("encryption with a valid key cannot fail");
        let mut out = nonce.to_vec();
        out.extend(ciphertext);
        out
    }

    pub fn open(&self, sealed: &[u8]) -> Option<Vec<u8>> {
        if sealed.len() < 24 {
            return None;
        }
        let (nonce, ciphertext) = sealed.split_at(24);
        let nonce: [u8; 24] = nonce.try_into().ok()?;
        self.cipher.decrypt(&XNonce::from(nonce), ciphertext).ok()
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(bytes)
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes)
    }
}

/// 256-bit random token, base64url without padding.
pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::fill(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Session tokens are stored hashed so a leaked database does not leak live sessions.
pub fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

pub fn hash_password(password: &str) -> anyhow::Result<String> {
    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|h| h.to_string())
        .map_err(|e| anyhow::anyhow!("password hashing failed: {e}"))
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash).is_ok_and(|parsed| {
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok()
    })
}

/// `sk-…abcd` style preview of an API key.
pub fn mask(secret: &str) -> String {
    let chars: Vec<char> = secret.trim().chars().collect();
    if chars.len() <= 10 {
        return "•".repeat(chars.len().clamp(4, 8));
    }
    let head: String = chars[..3].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret.key");
        let sbox = SecretBox::load_or_create(&path).unwrap();
        let sealed = sbox.seal(b"sk-test");
        assert_eq!(sbox.open(&sealed).unwrap(), b"sk-test");
        // Same key file → same box.
        let again = SecretBox::load_or_create(&path).unwrap();
        assert_eq!(again.open(&sealed).unwrap(), b"sk-test");
        let mut tampered = sealed.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert!(sbox.open(&tampered).is_none());
    }

    #[test]
    fn passwords_and_masks() {
        let hash = hash_password("hunter2").unwrap();
        assert!(verify_password("hunter2", &hash));
        assert!(!verify_password("hunter3", &hash));
        assert!(!verify_password("x", "not a hash"));
        assert_eq!(mask("sk-1234567890abcdef"), "sk-…cdef");
        assert_eq!(mask("short"), "•••••");
        assert_eq!(token_hash("a").len(), 64);
        assert_ne!(random_token(), random_token());
    }
}
