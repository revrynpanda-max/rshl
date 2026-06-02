use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GrammarBundle {
    pub word: String,
    pub pos: String,
    pub synonyms: Vec<String>,
    pub definition: String,
}

#[derive(Serialize, Deserialize)]
pub struct SemanticDictionary {
    pub words: HashMap<String, GrammarBundle>,
}

pub fn get_global_dict() -> Arc<Mutex<SemanticDictionary>> {
    static DICT: OnceLock<Arc<Mutex<SemanticDictionary>>> = OnceLock::new();
    DICT.get_or_init(|| {
        Arc::new(Mutex::new(SemanticDictionary::load()))
    }).clone()
}

impl SemanticDictionary {
    pub fn load() -> Self {
        if let Ok(data) = std::fs::read_to_string("data/semantic_dict.json") {
            if let Ok(dict) = serde_json::from_str(&data) {
                return dict;
            }
        }
        
        let mut dict = Self { words: HashMap::new() };
        // Pre-seed with some common words to avoid massive initial lag
        let commons = vec![
            ("i", "pronoun", "the speaker", vec!["me", "myself"]),
            ("you", "pronoun", "the person addressed", vec!["thou", "yourself"]),
            ("the", "article", "denoting one or more people or things already mentioned", vec![]),
            ("a", "article", "used when mentioning someone or something for the first time", vec![]),
            ("to", "preposition", "expressing motion in the direction of", vec!["toward"]),
            ("and", "conjunction", "used to connect words of the same part of speech", vec!["also", "plus"]),
            ("is", "verb", "third person singular present of be", vec!["exists", "equals"]),
            ("are", "verb", "second person singular present and first, second, third person plural present of be", vec!["exist"]),
            ("was", "verb", "first and third person singular past of be", vec!["existed"]),
            ("fractal", "noun", "a curve or geometric figure, each part of which has the same statistical character as the whole", vec!["pattern", "geometry"]),
        ];
        
        for (w, pos, def, syns) in commons {
            dict.words.insert(w.to_string(), GrammarBundle {
                word: w.to_string(),
                pos: pos.to_string(),
                definition: def.to_string(),
                synonyms: syns.into_iter().map(|s| s.to_string()).collect(),
            });
        }
        
        dict.save();
        dict
    }

    pub fn save(&self) {
        if let Ok(json) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write("data/semantic_dict.json", json);
        }
    }
}

use std::sync::atomic::{AtomicUsize, Ordering};

static ACTIVE_FETCHES: AtomicUsize = AtomicUsize::new(0);

pub fn lookup_word(word: &str) -> GrammarBundle {
    let w = word.to_lowercase();
    let dict_arc = get_global_dict();
    
    {
        let dict = dict_arc.lock().unwrap();
        if let Some(bundle) = dict.words.get(&w) {
            return bundle.clone();
        }
    }
    
    // Return dummy immediately, fetch asynchronously
    let dummy = GrammarBundle {
        word: w.clone(),
        pos: "unknown".to_string(),
        synonyms: vec![],
        definition: "unknown".to_string(),
    };
    
    // Prevent OS thread starvation / stack overflow by capping concurrent LLM fetches to 4
    if ACTIVE_FETCHES.load(Ordering::Relaxed) >= 4 {
        return dummy;
    }
    
    // Also, we want to ensure we don't spawn a thread for a word that's already in the process of being fetched.
    // A more rigorous way is a HashSet, but since this is best-effort background loading, 
    // simply bounding the threads ensures the OS won't crash.
    ACTIVE_FETCHES.fetch_add(1, Ordering::Relaxed);
    
    let dict_clone = dict_arc.clone();
    let w_clone = w.clone();
    
    std::thread::spawn(move || {
        // Build the prompt for Ollama
        let prompt = format!(
            "Analyze the word '{}'. Reply ONLY in valid JSON format with this exact structure: \
            {{\"pos\": \"(part of speech)\", \"definition\": \"(short definition)\", \"synonyms\": [\"syn1\", \"syn2\", \"syn3\"]}} \
            Do not include any other text or markdown block.",
            w_clone
        );
        
        if let Ok(output) = std::process::Command::new("ollama")
            .arg("run")
            .arg("gemma4")
            .arg(&prompt)
            .output()
        {
            if let Ok(response) = String::from_utf8(output.stdout) {
                // Find { and } to extract JSON
                if let Some(start) = response.find('{') {
                    if let Some(end) = response.rfind('}') {
                        let json_str = &response[start..=end];
                        #[derive(Deserialize)]
                        struct OllamaRes {
                            pos: String,
                            definition: String,
                            synonyms: Vec<String>,
                        }
                        if let Ok(parsed) = serde_json::from_str::<OllamaRes>(json_str) {
                            let bundle = GrammarBundle {
                                word: w_clone.clone(),
                                pos: parsed.pos,
                                definition: parsed.definition,
                                synonyms: parsed.synonyms,
                            };
                            
                            let mut d = dict_clone.lock().unwrap();
                            d.words.insert(w_clone.clone(), bundle);
                            d.save();
                            println!("[SemanticDict] Learned new word bundle: {}", w_clone);
                        }
                    }
                }
            }
        }
        
        ACTIVE_FETCHES.fetch_sub(1, Ordering::Relaxed);
    });
    
    dummy
}
