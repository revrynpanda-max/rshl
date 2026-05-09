//! Session Transcript — Full conversation history that survives restarts.
//!
//! Every turn is appended as a JSON line to data/kai-transcript.jsonl
//! KAI can recall any part of its full history using `recall <query>`.
//! The `brief` command summarizes the current session.
//!
//! Format (one JSON object per line):
//! {"ts": 1234567890, "session": "abc123", "role": "user", "text": "..."}
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};

/// UTF-8 safe byte slice — never splits a multi-byte character.
fn safe_str_slice(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

const TRANSCRIPT_FILE: &str = "data/kai-transcript.jsonl";

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TranscriptEntry {
    pub ts: u64,
    pub session: String,
    pub role: String,
    pub text: String,
    #[serde(default)]
    pub label: String,
}

/// Append a single turn to the transcript file.
pub fn append(base_dir: &str, session_id: &str, role: &str, text: &str) {
    let path = format!("{}/{}", base_dir, TRANSCRIPT_FILE);

    // Ensure directory exists
    if let Some(parent) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let entry = TranscriptEntry {
        ts: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        session: session_id.to_string(),
        role: role.to_string(),
        text: safe_str_slice(text, 2000).to_string(),
        label: safe_str_slice(text, 2000).to_string(),
    };

    if let Ok(json) = serde_json::to_string(&entry) {
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "{}", json);
        }
    }
}

/// Search the transcript for lines matching a query string.
/// Returns entries where text contains any word from the query (case-insensitive).
pub fn recall(base_dir: &str, query: &str, max_results: usize) -> Vec<TranscriptEntry> {
    let path = format!("{}/{}", base_dir, TRANSCRIPT_FILE);
    let mut results: Vec<TranscriptEntry> = Vec::new();

    let file = match File::open(&path) {
        Ok(f) => f,
        Err(_) => return results,
    };

    let query_lower = query.to_lowercase();
    let query_words: Vec<&str> = query_lower
        .split_whitespace()
        .filter(|w| w.len() > 3)
        .collect();

    if query_words.is_empty() {
        // No meaningful words — return recent entries
        let reader = BufReader::new(file);
        let all: Vec<TranscriptEntry> = reader
            .lines()
            .flatten()
            .filter_map(|l| serde_json::from_str(&l).ok())
            .collect();
        return all.into_iter().rev().take(max_results).rev().collect();
    }

    let reader = BufReader::new(file);
    for line in reader.lines().flatten() {
        if let Ok(entry) = serde_json::from_str::<TranscriptEntry>(&line) {
            let text_lower = entry.label.to_lowercase();
            let matches = query_words
                .iter()
                .filter(|w| text_lower.contains(*w))
                .count();
            if matches > 0 {
                results.push(entry);
            }
        }
    }

    // Score by match count and recency — keep last N matching
    results.into_iter().rev().take(max_results).rev().collect()
}

/// Get all entries from the current session.
pub fn current_session(base_dir: &str, session_id: &str) -> Vec<TranscriptEntry> {
    let path = format!("{}/{}", base_dir, TRANSCRIPT_FILE);

    let file = match File::open(&path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };

    BufReader::new(file)
        .lines()
        .flatten()
        .filter_map(|l| serde_json::from_str::<TranscriptEntry>(&l).ok())
        .filter(|e| e.session == session_id)
        .collect()
}

/// Brief summary of the current session — who said what about what.
pub fn brief(base_dir: &str, session_id: &str) -> String {
    let entries = current_session(base_dir, session_id);

    if entries.is_empty() {
        return "No turns recorded in this session yet.".to_string();
    }

    let user_turns: Vec<&TranscriptEntry> = entries.iter().filter(|e| e.role == "user").collect();
    let kai_turns: Vec<&TranscriptEntry> = entries.iter().filter(|e| e.role == "kai").collect();

    let mut lines = vec![
        format!(
            "Session brief — {} total turns ({} from you, {} from KAI):",
            entries.len(),
            user_turns.len(),
            kai_turns.len()
        ),
        String::new(),
    ];

    // Show user's messages as the "agenda" of the conversation
    lines.push("What you covered:".to_string());
    for entry in user_turns.iter().take(12) {
        let preview = entry.label.lines().next().unwrap_or("").trim();
        if preview.len() > 5 {
            lines.push(format!("  > {}", safe_str_slice(preview, 90)));
        }
    }
    if user_turns.len() > 12 {
        lines.push(format!("  ... and {} more turns", user_turns.len() - 12));
    }

    lines.join("\n")
}

/// Count total transcript entries.
pub fn entry_count(base_dir: &str) -> usize {
    let path = format!("{}/{}", base_dir, TRANSCRIPT_FILE);
    if let Ok(file) = File::open(&path) {
        BufReader::new(file).lines().count()
    } else {
        0
    }
}
