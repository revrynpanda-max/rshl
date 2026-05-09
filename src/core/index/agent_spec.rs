use serde::{Serialize, Deserialize};
use std::collections::HashMap;

/// Open Agent Specification (OAS) v1.0
/// A declarative schema for defining AI agents and their cognitive boundaries.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentSpec {
    pub id: String,
    pub name: String,
    pub persona: String,
    pub primary_region: String,
    pub capabilities: Vec<String>,
    pub model_preferences: HashMap<String, String>, // e.g., "fast": "groq-llama3", "high_iq": "gemini-2.0"
    pub context_logic: ContextLogic,
    pub metadata: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ContextLogic {
    pub sliding_window_size: usize,
    pub memory_retrieval_threshold: f32,
    pub personality_temperature: f32,
}

impl AgentSpec {
    pub fn new(id: &str, name: &str) -> Self {
        Self {
            id: id.to_string(),
            name: name.to_string(),
            ..Default::default()
        }
    }
}
