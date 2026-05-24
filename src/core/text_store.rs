//! TextStore — Memory-mapped full-text storage for the fractal lattice.
//!
//! Design: KAI's Cell structs keep only a short micro-label (≤80 chars) in RAM.
//! Full text strings live in a mmap'd file on disk, fetched on demand.
//!
//! File format:
//!   [header: 16 bytes]
//!   [index:  (offset: u64, len: u32) × count ]
//!   [data:   concatenated UTF-8 strings ]
//!
//! This drops text RAM from ~4 GB to ~200 MB for 400K cells.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

const MAGIC: &[u8; 8] = b"KAITEXT1";
const HEADER_LEN: usize = 16;

#[derive(Debug)]
pub struct TextStore {
    index: Vec<(u64, u32)>, // (offset in data section, byte length)
    data: memmap2::Mmap,
    count: u32,
}

#[derive(Debug)]
pub enum TextStoreError {
    Io(std::io::Error),
    Corrupt(&'static str),
}

impl From<std::io::Error> for TextStoreError {
    fn from(e: std::io::Error) -> Self { TextStoreError::Io(e) }
}

impl TextStore {
    /// Open an existing text store from disk.
    pub fn open(path: &Path) -> Result<Self, TextStoreError> {
        let file = OpenOptions::new().read(true).open(path)?;
        let mmap = unsafe { memmap2::MmapOptions::new().map(&file)? };
        if mmap.len() < HEADER_LEN {
            return Err(TextStoreError::Corrupt("file too short for header"));
        }
        if &mmap[0..8] != MAGIC {
            return Err(TextStoreError::Corrupt("bad magic"));
        }
        let version = u32::from_le_bytes([mmap[8], mmap[9], mmap[10], mmap[11]]);
        if version != 1 {
            return Err(TextStoreError::Corrupt("unknown version"));
        }
        let count = u32::from_le_bytes([mmap[12], mmap[13], mmap[14], mmap[15]]);
        let index_offset = HEADER_LEN;
        let index_size = count as usize * 12; // u64 + u32 = 12 bytes
        if mmap.len() < index_offset + index_size {
            return Err(TextStoreError::Corrupt("truncated index"));
        }
        let mut index = Vec::with_capacity(count as usize);
        let mut cursor = index_offset;
        for _ in 0..count {
            let offset = u64::from_le_bytes([
                mmap[cursor], mmap[cursor+1], mmap[cursor+2], mmap[cursor+3],
                mmap[cursor+4], mmap[cursor+5], mmap[cursor+6], mmap[cursor+7],
            ]);
            let len = u32::from_le_bytes([
                mmap[cursor+8], mmap[cursor+9], mmap[cursor+10], mmap[cursor+11],
            ]);
            index.push((offset, len));
            cursor += 12;
        }
        let data_offset = index_offset + index_size;
        // Sanity check last entry
        if let Some(&(last_off, last_len)) = index.last() {
            let end = last_off + last_len as u64;
            if (mmap.len() as u64) < end {
                return Err(TextStoreError::Corrupt("data extends past file end"));
            }
        }
        Ok(Self { index, data: mmap, count })
    }

    /// Build a text store from a vec of strings and write to disk.
    pub fn build(path: &Path, texts: &[String]) -> Result<Self, TextStoreError> {
        let mut file = OpenOptions::new().create(true).write(true).truncate(true).open(path)?;
        let count = texts.len() as u32;
        // Header
        file.write_all(MAGIC)?;
        file.write_all(&1u32.to_le_bytes())?; // version
        file.write_all(&count.to_le_bytes())?;
        // Compute index and data
        let index_offset = HEADER_LEN as u64;
        let index_size = count as u64 * 12;
        let data_offset = index_offset + index_size;
        let mut offsets = Vec::with_capacity(texts.len());
        let mut current_offset = data_offset;
        for text in texts {
            let bytes = text.as_bytes();
            offsets.push((current_offset, bytes.len() as u32));
            current_offset += bytes.len() as u64;
        }
        // Write index
        for (off, len) in &offsets {
            file.write_all(&off.to_le_bytes())?;
            file.write_all(&len.to_le_bytes())?;
        }
        // Write data
        for text in texts {
            file.write_all(text.as_bytes())?;
        }
        file.flush()?;
        drop(file);
        Self::open(path)
    }

    /// Get the number of entries.
    pub fn len(&self) -> usize {
        self.index.len()
    }

    /// Lookup text by ID. Returns empty string if out of bounds.
    pub fn get(&self, id: u32) -> String {
        let idx = id as usize;
        if idx >= self.index.len() {
            return String::new();
        }
        let (offset, len) = self.index[idx];
        let start = offset as usize;
        let end = start + len as usize;
        if end > self.data.len() {
            return String::new();
        }
        match std::str::from_utf8(&self.data[start..end]) {
            Ok(s) => s.to_string(),
            Err(_) => String::new(),
        }
    }

    /// Lookup text by ID, returning a borrowed string if possible.
    pub fn get_borrowed(&self, id: u32) -> Option<&str> {
        let idx = id as usize;
        if idx >= self.index.len() {
            return None;
        }
        let (offset, len) = self.index[idx];
        let start = offset as usize;
        let end = start + len as usize;
        if end > self.data.len() {
            return None;
        }
        std::str::from_utf8(&self.data[start..end]).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_store_roundtrip() {
        let texts: Vec<String> = vec![
            "The mitochondria is the powerhouse of the cell.".to_string(),
            "Neurons communicate via synaptic transmission.".to_string(),
            "Consciousness emerges from integrated information.".to_string(),
        ];
        let path = std::path::Path::new("test_text_store.bin");
        let store = TextStore::build(path, &texts).unwrap();
        assert_eq!(store.len(), 3);
        assert_eq!(store.get(0), texts[0]);
        assert_eq!(store.get(1), texts[1]);
        assert_eq!(store.get(2), texts[2]);
        assert_eq!(store.get(999), "");
        let _ = std::fs::remove_file(path);
    }
}
