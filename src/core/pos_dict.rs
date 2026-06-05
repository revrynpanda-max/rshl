use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticEntry {
    pub word: String,
    pub pos: String,
    #[serde(default)]
    pub synonyms: Vec<String>,
    pub definition: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SemanticDictFile {
    pub words: HashMap<String, SemanticEntry>,
}

pub struct PosDictionary {
    // Maps a lowercase word to its semantic entry
    pub entries: HashMap<String, SemanticEntry>,
}

static GLOBAL_DICTIONARY: std::sync::OnceLock<PosDictionary> = std::sync::OnceLock::new();

pub fn get_dictionary() -> &'static PosDictionary {
    GLOBAL_DICTIONARY.get_or_init(|| {
        let mut dict = PosDictionary::new();
        if let Err(e) = dict.load_semantic_dict("data/semantic_dict.json") {
            println!("[Dictionary] Failed to load semantic dict: {}", e);
        } else {
            println!("[Dictionary] Loaded {} semantic entries.", dict.entries.len());
        }
        dict
    })
}

impl PosDictionary {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    /// Loads the semantic dictionary from a JSON file.
    pub fn load_semantic_dict<P: AsRef<Path>>(&mut self, path: P) -> Result<(), Box<dyn std::error::Error>> {
        let file = File::open(path)?;
        let reader = BufReader::new(file);
        let file_data: SemanticDictFile = serde_json::from_reader(reader)?;
        
        for (key, entry) in file_data.words {
            self.entries.insert(key.to_lowercase(), entry);
        }
        Ok(())
    }

    /// Queries the dictionary for a specific word, returning its entry if found.
    pub fn lookup(&self, word: &str) -> Option<&SemanticEntry> {
        self.entries.get(&word.to_lowercase())
    }
}
