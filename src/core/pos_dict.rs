use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PosEntry {
    pub pos: String,
    pub word: String,
    pub definitions: Vec<String>,
}

pub struct PosDictionary {
    // Maps a lowercase word to a list of its dictionary entries
    pub entries: HashMap<String, Vec<PosEntry>>,
}

impl PosDictionary {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    /// Loads the Webster's Dictionary from a JSON file.
    pub fn load_from_file<P: AsRef<Path>>(path: P) -> Result<Self, Box<dyn std::error::Error>> {
        let file = File::open(path)?;
        let reader = BufReader::new(file);
        
        let raw_entries: Vec<PosEntry> = serde_json::from_reader(reader)?;
        let mut entries_map: HashMap<String, Vec<PosEntry>> = HashMap::with_capacity(raw_entries.len());

        for entry in raw_entries {
            let key = entry.word.to_lowercase();
            entries_map.entry(key).or_default().push(entry);
        }

        Ok(Self { entries: entries_map })
    }

    /// Queries the dictionary for a specific word, returning its entries if found.
    pub fn lookup(&self, word: &str) -> Option<&Vec<PosEntry>> {
        self.entries.get(&word.to_lowercase())
    }
}
