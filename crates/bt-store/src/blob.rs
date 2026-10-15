//! Content-addressed file storage: `<root>/<hash[0..2]>/<hash>` where `hash` is the blake3 hex
//! digest of the bytes. Identical uploads are stored once.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct BlobStore {
    root: PathBuf,
}

impl BlobStore {
    pub fn new(root: impl Into<PathBuf>) -> io::Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn hash(bytes: &[u8]) -> String {
        blake3::hash(bytes).to_hex().to_string()
    }

    /// True for a lowercase 64-char hex digest; anything else is rejected before touching disk.
    pub fn is_valid_hash(hash: &str) -> bool {
        hash.len() == 64
            && hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }

    pub fn path_of(&self, hash: &str) -> Option<PathBuf> {
        Self::is_valid_hash(hash).then(|| self.root.join(&hash[..2]).join(hash))
    }

    /// Stores `bytes` and returns their hash. Writing is atomic (temp file + rename).
    pub fn put(&self, bytes: &[u8]) -> io::Result<String> {
        let hash = Self::hash(bytes);
        let path = self.root.join(&hash[..2]).join(&hash);
        if !path.exists() {
            let dir = path.parent().expect("blob path has a parent");
            fs::create_dir_all(dir)?;
            let tmp = dir.join(format!(".{hash}.{}.tmp", std::process::id()));
            fs::write(&tmp, bytes)?;
            if let Err(err) = fs::rename(&tmp, &path) {
                let _ = fs::remove_file(&tmp);
                if !path.exists() {
                    return Err(err);
                }
            }
        }
        Ok(hash)
    }

    pub fn read(&self, hash: &str) -> io::Result<Vec<u8>> {
        let path = self
            .path_of(hash)
            .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
        fs::read(path)
    }

    pub fn exists(&self, hash: &str) -> bool {
        self.path_of(hash).is_some_and(|p| p.exists())
    }

    pub fn remove(&self, hash: &str) -> io::Result<()> {
        match self.path_of(hash) {
            Some(path) => match fs::remove_file(path) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
                other => other,
            },
            None => Err(io::ErrorKind::InvalidInput.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_is_idempotent_and_readable() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::new(dir.path().join("blobs")).unwrap();
        let a = store.put(b"hello").unwrap();
        let b = store.put(b"hello").unwrap();
        assert_eq!(a, b);
        assert!(BlobStore::is_valid_hash(&a));
        assert_eq!(store.read(&a).unwrap(), b"hello");
        store.remove(&a).unwrap();
        assert!(!store.exists(&a));
    }

    #[test]
    fn rejects_path_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::new(dir.path()).unwrap();
        assert!(store.path_of("../etc/passwd").is_none());
        assert!(store.read("..").is_err());
    }
}
