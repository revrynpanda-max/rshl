use super::{Cell, SparseVec};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::Path;

/// Mathematical compression format for dormant cells.
#[derive(Serialize, Deserialize)]
pub struct MathCell {
    pub v: SparseVec,
    pub c: f32, // confidence
    pub t: u64, // timestamp
    // The textual payload is mathematically transformed (byte-level) and then compressed.
    pub payload: Vec<u8>,
}

const VAULT_DIR: &str = "data/deep_vault";
const CIPHER_KEY: u8 = 0x5A; // Custom KAI encryption cipher key (XOR base)

pub fn init_vault() {
    let _ = fs::create_dir_all(VAULT_DIR);
}

/// Convert a memory cell into a compressed, encrypted mathematical structure.
pub fn archive_to_vault(cell: &Cell, label_hash: u64) -> Result<(), Box<dyn std::error::Error>> {
    // 1. Math Conversion
    let payload_str = format!("{}|{}|{}", cell.label, cell.claim.text, cell.claim.source);
    let mut payload_bytes = payload_str.into_bytes();
    
    let math_cell = MathCell {
        v: cell.claim.vec.clone(),
        c: cell.claim.confidence,
        t: cell.claim.created_at,
        payload: payload_bytes,
    };
    
    let serialized = bincode::serialize(&math_cell)?;
    
    // 2. Deep Compression (zstd)
    let mut compressed = Vec::new();
    let mut encoder = zstd::stream::Encoder::new(&mut compressed, 21)?; // Max compression level
    encoder.write_all(&serialized)?;
    encoder.finish()?;
    
    // 3. Custom Encryption (XOR cipher cascade)
    let mut ciphertext = compressed;
    let mut rolling_key = CIPHER_KEY;
    for byte in ciphertext.iter_mut() {
        *byte ^= rolling_key;
        rolling_key = rolling_key.wrapping_add(11);
    }
    
    let path = format!("{}/{}.kai", VAULT_DIR, label_hash);
    fs::write(path, ciphertext)?;
    
    Ok(())
}

/// Decrypt, decompress, and un-math a cell from the Deep Vault.
pub fn recall_from_vault(label_hash: u64) -> Result<MathCell, Box<dyn std::error::Error>> {
    let path = format!("{}/{}.kai", VAULT_DIR, label_hash);
    let mut ciphertext = fs::read(path)?;
    
    // 1. Custom Decryption
    let mut rolling_key = CIPHER_KEY;
    for byte in ciphertext.iter_mut() {
        *byte ^= rolling_key;
        rolling_key = rolling_key.wrapping_add(11);
    }
    
    // 2. Deep Decompression
    let mut decompressed = Vec::new();
    let mut decoder = zstd::stream::Decoder::new(ciphertext.as_slice())?;
    decoder.read_to_end(&mut decompressed)?;
    
    // 3. Un-math
    let math_cell: MathCell = bincode::deserialize(&decompressed)?;
    Ok(math_cell)
}
