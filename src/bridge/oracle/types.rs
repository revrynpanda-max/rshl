// oracle/types.rs — Data structures for the Oracle roundtable.
//
// All structs live here so the router, model client, and handlers can share
// them without circular dependencies.

use std::collections::HashMap;
use serde::{Serialize, Deserialize};

pub const SESSION_PATH: &str = "data/oracle_session.json";

/// Truncate a string to `max` characters at a character boundary.
#[inline]
pub fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max { return s.to_string(); }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) { end -= 1; }
    s[..end].to_string()
}

/// Current timestamp in seconds since UNIX epoch.
#[inline]
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// ═══════════════════════════════════════════════════════════════════════════════
//  API Keys
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ApiKeys {
    pub openai: Option<String>,
    pub kai: Option<String>,
    pub google: Option<String>,
    pub groq: Option<String>,
    pub xai: Option<String>,
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Session & Vitals
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Session {
    #[serde(default)]
    pub id: u64,
    /// Short title for the meeting - set by Ryan on startup.
    #[serde(default)]
    pub meeting_title: String,
    /// The current working objective / topic.
    pub task: String,
    /// Full transcript of all turns.
    pub turns: Vec<Turn>,
    /// Exact Discord message archive for transcript recall with sender/time/context.
    #[serde(default)]
    pub discord_messages: Vec<DiscordMessageRecord>,
    /// Per-AI draft sandbox (internal thinking before speaking).
    pub drafts: HashMap<String, Draft>,
    /// KAI's live vitals (updated by heartbeat every 5 s).
    pub vitals: Vitals,
    /// Test runs requested by AIs, pending Ryan's approval.
    #[serde(default)]
    pub pending_tests: Vec<PendingTest>,
    #[serde(default)]
    pub pending_tools: Vec<PendingToolAction>,
    #[serde(default)]
    pub active_participant: String,
    /// Temporary findings the private Oracle agents can build while Ryan is away.
    #[serde(default)]
    pub oracle_cache: Vec<OracleCacheEntry>,
    /// Last autonomous live-roundtable tick, used to avoid Discord spam.
    #[serde(default)]
    pub last_live_roundtable_ts: u64,
    /// Autonomous interjections from AIs who jumped in after the primary reply.
    #[serde(default)]
    pub pending_interjections: Vec<Interjection>,
    /// Files shared into the meeting (path → content snippet).
    #[serde(default)]
    pub file_cache: HashMap<String, String>,
    #[serde(default)]
    pub last_save: u64,
    #[serde(default)]
    pub approved: Vec<u64>,
    /// If Oracle has proposed a plan to Ryan, it's stored here until approved/rejected.
    #[serde(default)]
    pub pending_proposal: Option<String>,
    /// Stores the last reason/feedback provided by Ryan (e.g. for a denial).
    #[serde(default)]
    pub last_user_feedback: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Vitals {
    pub tick: u64,
    pub phi_g: f32,
    pub chi: f32,
    pub rho: f32,
    pub valence: f32,
    pub mood: String,
    #[serde(default)]
    pub cell_count: usize,
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Messages & Drafts
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Turn {
    pub ts: u64,
    pub from: String,
    pub text: String,
    /// system | kai | ai | human | correction | question | test-request | test-result | file-share
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TranscriptContextMessage {
    pub ts: u64,
    pub from: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DiscordMessageRecord {
    pub ts: u64,
    pub from: String,
    pub text: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub message_id: String,
    #[serde(default)]
    pub channel_id: String,
    #[serde(default)]
    pub guild_id: String,
    #[serde(default)]
    pub author_id: String,
    #[serde(default)]
    pub author_name: String,
    #[serde(default)]
    pub reply_to_message_id: String,
    #[serde(default)]
    pub reply_to_from: String,
    #[serde(default)]
    pub reply_to_text: String,
    #[serde(default)]
    pub context_before: Vec<TranscriptContextMessage>,
    #[serde(default)]
    pub context_after: Vec<TranscriptContextMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Draft {
    pub ts: u64,
    pub from: String,
    pub text: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Interjection {
    pub from: String,
    pub text: String,
    pub ts: u64,
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Tests & Tools
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingTest {
    pub id: u64,
    pub requested_by: String,
    pub command: String,
    pub reason: String,
    /// pending | approved | denied | running | done
    pub status: String,
    pub result: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub id: String,
    pub label: String,
    pub source_path: String,
    pub capability: String,
    pub risk: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingToolAction {
    pub id: u64,
    pub requested_by: String,
    pub task: String,
    pub plan: Vec<String>,
    pub tools: Vec<ToolDefinition>,
    #[serde(default)]
    pub action: Option<ToolExecutionRequest>,
    /// pending | approved | denied | done | failed
    pub status: String,
    pub result: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolExecutionRequest {
    pub tool_id: String,
    pub input: String,
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Cache & Proposals
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OracleCacheEntry {
    pub ts: u64,
    pub speaker: String,
    pub topic: String,
    pub evidence: String,
    pub suggested_action: String,
    /// temporary | surfaced | accepted | rejected
    pub status: String,
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Request Bodies (deserialised from HTTP JSON)
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Debug, Deserialize, Default)]
pub struct KaiTurnRequest {
    #[serde(default)]
    pub hint: String,
}

#[derive(Debug, Deserialize, Default)]
pub struct AiTurnRequest {
    pub model: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub selective: bool,
}

#[derive(Debug, Deserialize, Default)]
pub struct TaskRequest {
    #[serde(default)]
    pub task: String,
    #[serde(default)]
    pub title: String,
}

#[derive(Debug, Deserialize)]
pub struct HumanTurnRequest {
    #[serde(default = "default_from")]
    pub from: String,
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<String>,
}

fn default_from() -> String { "Ryan".into() }

#[derive(Debug, Deserialize)]
pub struct FileReadRequest { pub path: String }

#[derive(Debug, Deserialize)]
pub struct TestApproveRequest { pub id: u64 }

#[derive(Debug, Deserialize)]
pub struct ManualTestRequest {
    pub requested_by: String,
    pub command: String,
    pub reason: String,
}

#[derive(Debug, Deserialize)]
pub struct ToolPlanRequest {
    #[serde(default = "default_from")]
    pub requested_by: String,
    pub task: String,
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Internal routing types
// ═══════════════════════════════════════════════════════════════════════════════

pub enum DiscordTurnTarget {
    Oracle,
    Kai,
    OracleCoder,
    Model(&'static str),
    Unsupported(&'static str),
}

pub struct DiscordTurnRoute {
    pub target: DiscordTurnTarget,
    pub prompt: String,
    pub explicit: bool,
}
