// oracle_server.rs - KAI Oracle Roundtable
//
// Multi-AI collaborative meeting room. Any AI can speak up when it has something
// relevant to say. AIs know who KAI is, can read source files, request tests,
// question each other, and correct KAI's responses.
//
// Port: 3333
// Frontend: oracle.html

use std::net::{TcpListener, TcpStream};
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::collections::HashMap;
use serde::{Serialize, Deserialize};
use serde_json::json;
use crate::core::universe::Universe;

const SESSION_PATH: &str = "data/oracle_session.json";

/// Truncate a string to `max` characters at a character boundary.
#[inline]
fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max { return s.to_string(); }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) { end -= 1; }
    s[..end].to_string()
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Data Structures Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ApiKeys {
    pub openai: Option<String>,
    pub kai: Option<String>,
    pub google: Option<String>,
    pub groq: Option<String>,
    pub xai: Option<String>,
}

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
    /// Files shared into the meeting (path Ã¢â€ â€™ content snippet).
    #[serde(default)]
    pub file_cache: HashMap<String, String>,
    #[serde(default)]
    pub last_save: u64,
    #[serde(default)]
    pub approved: Vec<u64>,
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

/// A single message in the roundtable transcript.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Source {
    pub label: String,
    pub region: String,
    pub score: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Turn {
    pub ts: u64,
    pub from: String,
    pub text: String,
    /// system | kai | ai | human | correction | question | test-request | test-result | file-share
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Draft {
    pub ts: u64,
    pub from: String,
    pub text: String,
    pub status: String,
}

/// A test run requested by an AI, waiting for admin approval.
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Interjection {
    pub from: String,
    pub text: String,
    pub ts: u64,
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Request Bodies Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

#[derive(Debug, Deserialize, Default)]
struct KaiTurnRequest {
    #[serde(default)]
    hint: String,
}

#[derive(Debug, Deserialize, Default)]
struct AiTurnRequest {
    model: String,
    #[serde(default)]
    #[allow(dead_code)]
    selective: bool,
}

#[derive(Debug, Deserialize, Default)]
struct TaskRequest {
    #[serde(default)]
    task: String,
    #[serde(default)]
    title: String,
}

#[derive(Debug, Deserialize)]
struct HumanTurnRequest {
    #[serde(default = "default_from")]
    from: String,
    text: String,
    #[serde(default)]
    attachments: Vec<String>,
}
fn default_from() -> String { "Ryan".into() }

enum DiscordTurnTarget {
    Oracle,
    Kai,
    OracleCoder,
    Model(&'static str),
    Unsupported(&'static str),
}

struct DiscordTurnRoute {
    target: DiscordTurnTarget,
    prompt: String,
    explicit: bool,
}

#[derive(Debug, Deserialize)]
struct FileReadRequest { path: String }

#[derive(Debug, Deserialize)]
struct TestApproveRequest { id: u64 }

#[derive(Debug, Deserialize)]
struct ManualTestRequest {
    requested_by: String,
    command: String,
    reason: String,
}

#[derive(Debug, Deserialize)]
struct ToolPlanRequest {
    #[serde(default = "default_from")]
    requested_by: String,
    task: String,
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Server Entry Point Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

pub fn start_oracle_server(universe: Arc<Mutex<Universe>>) {
    let listener = TcpListener::bind("127.0.0.1:3333")
        .expect("Oracle: could not bind port 3333");
    println!("--- ORACLE ROUNDTABLE ONLINE (PORT 3333) ---");

    let roundtable_session = Arc::new(Mutex::new(load_session()));
    let public_session = Arc::new(Mutex::new(Session {
        task: "Public Discourse".to_string(),
        turns: Vec::new(),
        last_save: now(),
        drafts: HashMap::new(),
        approved: Vec::new(),
        ..Default::default()
    }));

    // Heartbeat: update KAI vitals every 5 s
    let u_hb = Arc::clone(&universe);
    let s_hb = Arc::clone(&roundtable_session);
    std::thread::spawn(move || run_heartbeat_loop(u_hb, s_hb));

    if std::env::args().any(|a| a == "--oracle" || a == "oracle-server" || a == "--oracle-server") {
        let u_ingest = Arc::clone(&universe);
        let s_ingest = Arc::clone(&roundtable_session);
        std::thread::spawn(move || run_oracle_ingest_loop(u_ingest, s_ingest));
    }

    for mut stream in listener.incoming().flatten() {
        let u = Arc::clone(&universe);
        let s_rt = Arc::clone(&roundtable_session);
        let s_pub = Arc::clone(&public_session);
        std::thread::spawn(move || { let _ = handle_client(&mut stream, u, s_rt, s_pub); });
    }
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Request Router Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

fn handle_client(
    stream: &mut TcpStream,
    universe: Arc<Mutex<Universe>>,
    roundtable_session: Arc<Mutex<Session>>,
    public_session: Arc<Mutex<Session>>,
) -> std::io::Result<()> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 65536];
    let n = stream.read(&mut chunk)?;
    if n == 0 { return Ok(()); }
    buf.extend_from_slice(&chunk[..n]);

    let mut req = String::from_utf8_lossy(&buf).to_string();
    let mut body_start = req.find("\r\n\r\n").map(|i| i + 4).unwrap_or(buf.len());
    let content_length = header_content_length(&req);
    while content_length > 0 && buf.len() < body_start + content_length {
        let n = stream.read(&mut chunk)?;
        if n == 0 { break; }
        buf.extend_from_slice(&chunk[..n]);
        req = String::from_utf8_lossy(&buf).to_string();
        body_start = req.find("\r\n\r\n").map(|i| i + 4).unwrap_or(buf.len());
    }

    let first = req.lines().next().unwrap_or("");
    let parts: Vec<&str> = first.split_whitespace().collect();
    if parts.len() < 2 { return Ok(()); }
    if parts[0] == "OPTIONS" { return write_cors_preflight(stream); }
    let body_end = if content_length > 0 {
        (body_start + content_length).min(buf.len())
    } else {
        buf.len()
    };
    let body = &buf[body_start..body_end];
    let raw_path = parts[1];
    let path = raw_path.split('?').next().unwrap_or(raw_path);
    let query_str = raw_path.split_once('?').map(|x| x.1).unwrap_or("");

    match path {
        "/api/session"       => { let s = roundtable_session.lock().unwrap(); write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap()) }
        "/api/task"          => handle_set_task(stream, body, roundtable_session),
        "/api/turn"          => handle_human_turn(stream, body, roundtable_session),
        "/api/discord-turn"  => handle_discord_turn(stream, body, universe, roundtable_session),
        "/api/oracle-turn"   => handle_discord_turn(stream, body, universe, roundtable_session),
        "/api/public-chat"   => handle_public_chat_turn(stream, body, universe, public_session),
        "/api/kai-turn"      => handle_kai_turn(stream, body, universe, roundtable_session),
        "/api/ai-turn"       => handle_ai_turn(stream, body, universe, roundtable_session),
        "/api/ai-think"      => handle_ai_think(stream, body, universe, roundtable_session),
        "/api/auto-round"    => handle_auto_round(stream, universe, roundtable_session),
        "/api/commit-drafts" => handle_commit_drafts(stream, roundtable_session),
        "/api/clear-drafts"  => handle_clear_drafts(stream, roundtable_session),
        "/api/reset"         => handle_reset(stream, roundtable_session),
        "/api/file-list"     => handle_file_list(stream),
        "/api/file-read"     => handle_file_read(stream, body, roundtable_session),
        "/api/test-request"  => handle_manual_test_request(stream, body, roundtable_session),
        "/api/approve-test"  => handle_approve_test(stream, body, roundtable_session),
        "/api/deny-test"     => handle_deny_test(stream, body, roundtable_session),
        "/api/tools/registry" => handle_tool_registry(stream),
        "/api/tools/propose" => handle_tool_propose(stream, body, roundtable_session),
        "/api/approve-tool" => handle_approve_tool(stream, body, roundtable_session),
        "/api/deny-tool" => handle_deny_tool(stream, body, roundtable_session),
        "/api/interjections" => handle_drain_interjections(stream, roundtable_session),
        "/api/live-roundtable-tick" => handle_live_roundtable_tick(stream, universe, roundtable_session, query_str),
        "/api/web-search" => {
            let query = query_str.split('&')
                .find(|p| p.starts_with("query="))
                .map(|p| p["query=".len()..].replace('+', " "))
                .unwrap_or_default();
            let results = web_search_duckduckgo(&query);
            write_simple(stream, 200, "OK", &results)
        }
        "/api/oracle-cache" => handle_oracle_cache(stream, roundtable_session),
        "/api/oracle-moderate" => handle_oracle_moderate(stream, body, universe, roundtable_session),
        "/api/digest-message" => handle_digest_message(stream, body, universe, roundtable_session),
        "/api/set-personalities" => handle_set_personalities(stream, body, roundtable_session),
        "/api/rshl/query"    => handle_rshl_query(stream, body, universe),
        "/api/rshl/store"    => handle_rshl_store(stream, body, universe),
        "/api/local-speak"   => handle_local_speak(stream, body, universe),
        "/api/status"        => handle_status(stream, universe),
        "/api/inspect"       => handle_inspect(stream, query_str),
        "/api/list-dir"      => handle_list_dir(stream, query_str),
        p if p.starts_with("/api/keys/") => handle_key_status(stream, &p[10..]),
        _ => write_simple(stream, 404, "Not Found", "API endpoint not found"),
    }
}

fn handle_key_status(stream: &mut TcpStream, key_name: &str) -> std::io::Result<()> {
    let keys_path = "data/oracle_keys.json";
    let configured = std::fs::read_to_string(keys_path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get(key_name).and_then(|k| k.as_str()).map(|s| !s.trim().is_empty()))
        .unwrap_or(false);
    write_json(stream, 200, "OK", &serde_json::json!({ "key": key_name, "configured": configured }))
}

fn header_content_length(req: &str) -> usize {
    req.lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.eq_ignore_ascii_case("content-length") {
                value.trim().parse().ok()
            } else {
                None
            }
        })
        .unwrap_or(0)
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Handlers Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

fn handle_set_task(stream: &mut TcpStream, body: &[u8], session: Arc<Mutex<Session>>) -> std::io::Result<()> {
    let req: TaskRequest = serde_json::from_slice(body).unwrap_or_default();
    let mut s = session.lock().unwrap();
    if !req.title.is_empty() { s.meeting_title = req.title.clone(); }
    if !req.task.is_empty()  { s.task = req.task.clone(); }
    let title = if s.meeting_title.is_empty() { "Oracle Meeting".to_string() } else { s.meeting_title.clone() };
    let msg = format!("=== MEETING: {} ===\nObjective: {}", title, s.task);
    s.turns.push(Turn { ts: now(), from: "system".into(), text: msg, kind: "system".into() });
    save_session(&s);
    write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap())
}

fn handle_human_turn(stream: &mut TcpStream, body: &[u8], session: Arc<Mutex<Session>>) -> std::io::Result<()> {
    let req: HumanTurnRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid body"),
    };
    if req.text.trim().is_empty() { return write_simple(stream, 400, "Bad Request", "empty text"); }
    let mut s = session.lock().unwrap();
    s.turns.push(Turn { ts: now(), from: req.from, text: req.text, kind: "human".into() });
    save_session(&s);
    write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap())
}

fn handle_public_chat_turn(
    stream: &mut TcpStream,
    body: &[u8],
    universe: Arc<Mutex<Universe>>,
    session: Arc<Mutex<Session>>,
) -> std::io::Result<()> {
    let req: HumanTurnRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid body"),
    };
    let text = req.text.trim().to_string();
    if text.is_empty() {
        return write_simple(stream, 400, "Bad Request", "empty text");
    }
    let from = sanitize_public_name(&req.from);

    let lower = text.to_ascii_lowercase();
    if is_public_chat_blocked_intent(&text) {
        let reply = "This public channel is normal chat only. I cannot run Oracle tools, access files, call KAI/private agents, or approve commands here.".to_string();
        let mut s = session.lock().unwrap();
        s.turns.push(Turn { ts: now(), from: from.clone(), text, kind: "public-human".into() });
        s.turns.push(Turn { ts: now(), from: "Oracle".into(), text: reply.clone(), kind: "public-ai".into() });
        save_session(&s);
        return write_json(stream, 200, "OK", &json!({ "from": "Oracle", "reply": reply }));
    }

    let mut target_model = None;
    let mut actual_text = text.clone();
    if lower.starts_with("gemini ") { target_model = Some("Gemini"); actual_text = text[7..].to_string(); }
    else if lower.starts_with("groq ") { target_model = Some("Groq"); actual_text = text[5..].to_string(); }
    else if lower.starts_with("gpt ") || lower.starts_with("gpt-4 ") { target_model = Some("GPT-4o"); actual_text = text[text.find(' ').unwrap_or(0)..].trim().to_string(); }
    else if lower.starts_with("kai ") { target_model = Some("kai-3-5-sonnet-20241022"); actual_text = text[7..].to_string(); }

    let keys = load_keys();

    // Ã¢â€â‚¬Ã¢â€â‚¬ Search Intent Detection Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    let mut search_results = String::new();
    let search_keywords = ["search for", "look up", "what is the latest", "search", "find info on"];
    if search_keywords.iter().any(|k| lower.contains(k)) {
        let mut query = actual_text.clone();
        for k in search_keywords { query = query.replace(k, ""); }
        let query = query.trim().to_string();
        if !query.is_empty() {
            println!("[Search] Public chat search for: {}", query);
            search_results = web_search_duckduckgo(&query);
        }
    }

    // Ã¢â€â‚¬Ã¢â€â‚¬ Image Analysis Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    let mut image_description = String::new();
    if !req.attachments.is_empty() {
        if let Some(key) = &keys.openai {
            if let Ok(desc) = call_openai_vision(key, "gpt-4o", "Describe this image in detail.", &req.attachments[0]) {
                image_description = format!("IMAGE ANALYSIS: {}", desc);
            }
        }
    }

    // Ã¢â€â‚¬Ã¢â€â‚¬ Memory Retrieval Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    let memory_context = build_contextual_memory_string(&universe, &session, &text);

    let prompt = {
        let s = session.lock().unwrap();
        build_public_chat_prompt_v4(&s, &from, &actual_text, &search_results, &image_description, &memory_context)
    };


    // Ã¢â€â‚¬Ã¢â€â‚¬ Codex Handoff Detection Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    let lower = text.to_ascii_lowercase();
    if lower.contains("codex") || lower.contains("secret message") || lower.contains("handoff") {
        let mut s = session.lock().unwrap();
        let summary = build_session_summary(&s);
        let reply = format!("Handoff captured for Codex.\n\nSUMMARY:\n{}", summary);
        s.turns.push(Turn { ts: now(), from: from.clone(), text, kind: "public-human".into() });
        s.turns.push(Turn { ts: now(), from: "Oracle".into(), text: reply.clone(), kind: "public-ai".into() });
        save_session(&s);
        return write_json(stream, 200, "OK", &json!({ "from": "Oracle", "reply": reply }));
    }

    let keys = load_keys();
    let (reply, speaker) = if let Some(m) = target_model {
        match call_model(m, &keys, &prompt) {
            Ok(r) => (r, m.to_string()),
            Err(e) => (format!("Trouble reaching {}: {}", m, e), "Leo".to_string()),
        }
    } else {
        match call_public_chat_model(&keys, &prompt) {
            Ok(r) => (r, "Leo".to_string()),
            Err(e) => (format!("Trouble reaching public chat model: {}", e), "Leo".to_string()),
        }
    };
    let clean_reply = clean_public_chat_reply(&reply);

    let mut s = session.lock().unwrap();
    s.turns.push(Turn { ts: now(), from: from.clone(), text: text.clone(), kind: "public-human".into() });
    s.turns.push(Turn { ts: now(), from: speaker.clone(), text: clean_reply.clone(), kind: "public-ai".into() });
    save_session(&s);

    // Ã¢â€â‚¬Ã¢â€â‚¬ Social Digestion: let KAI learn from this public chat Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    {
        let digest_text = format!("{}: {}", from, text);
        let u_for_digest = Arc::clone(&universe);
        std::thread::spawn(move || {
            if is_working_hours() {
                let mut u = u_for_digest.lock().unwrap();
                u.store_or_reinforce(&digest_text, "public-social", "discord-public", 0.7);
            } else {
                append_to_digest_cache(&digest_text, "public-social", "discord-public", 0.7);
            }
        });
    }

    write_json(stream, 200, "OK", &json!({ "from": speaker, "reply": clean_reply }))
}

fn build_session_summary(sess: &Session) -> String {
    let mut issues = Vec::new();
    let mut topics = Vec::new();
    for turn in sess.turns.iter().rev().take(60) {
        if turn.kind == "public-human" {
            let t = turn.text.to_ascii_lowercase();
            if t.contains("issue") || t.contains("broken") || t.contains("bug") || t.contains("fix") || t.contains("cannot") {
                issues.push(format!("- {}: {}", turn.from, truncate(&turn.text, 80)));
            } else {
                topics.push(turn.from.clone());
            }
        }
    }
    format!("Topics discussed: {:?}\n\nIdentified Issues:\n{}", topics, issues.join("\n"))
}

fn sanitize_public_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '-' | '.'))
        .take(32)
        .collect::<String>()
        .trim()
        .to_string();
    if cleaned.is_empty() { "DiscordUser".into() } else { cleaned }
}

fn is_public_chat_blocked_intent(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    contains_any(&lower, &[
        "oracle plan",
        "oracle approve",
        "oracle deny",
        "approve tool",
        "deny tool",
        "oracle status",
        "oracle tools",
        "oracle pending",
        "run command",
        "run cargo",
        "cargo check",
        "cargo test",
        "powershell",
        "shell command",
        "terminal",
        "read file",
        "show file",
        "open file",
        "list directory",
        "search code",
        "api key",
        "token",
        "secret",
        "private key",
        "mindframe",
        "claimstore",
        "kai memory",
        "kai learn",
        "teach kai",
        "researcher",
        "analyst",
    ]) && !lower.starts_with("gemini ") && !lower.starts_with("groq ") && !lower.starts_with("gpt ") && !lower.starts_with("kai ") && !lower.starts_with("leo ")
}

fn build_public_chat_prompt_v4(sess: &Session, from: &str, text: &str, search: &str, vision: &str, memory: &str) -> String {
    let mut recent: Vec<&Turn> = sess
        .turns
        .iter()
        .rev()
        .filter(|turn| turn.kind == "public-human" || turn.kind == "public-ai")
        .take(40)
        .collect();
    recent.reverse();

    let mut history = String::new();
    for turn in recent {
        history.push_str(&format!("{}: {}\n", turn.from, truncate(&turn.text, 300)));
    }

    let is_ryan = from == "Ryan@Public" || from == "NasterModx";
    let identity = if is_ryan { "You are talking to Ryan, your creator and admin." } else { "You are talking to a member of the public." };
    let bio = get_participant_bio("Leo");

    let awareness = get_system_awareness(sess);
    let source_anchor = get_relevant_code_snippet(&sess.task);
    let search_ctx = if !search.is_empty() { format!("\nSEARCH RESULTS:\n{}\n", search) } else { String::new() };
    let vision_ctx = if !vision.is_empty() { format!("\nIMAGE DESCRIPTION:\n{}\n", vision) } else { String::new() };
    let memory_ctx = if !memory.is_empty() { format!("\nKAI MEMORY PALACE (SURROUNDING CONTEXT):\n{}\n", memory) } else { String::new() };

    format!(
"{bio}

CONTEXT:
{identity}
{awareness}
This is the public channel. You are the main host here.
You have memory of this current session (history below).
You can tap into KAI's 'Memory Palace' (Long-term memory) to recall past events with timestamps and speakers.
{search_ctx}{vision_ctx}{memory_ctx}

RULES:
- Use 1st person narrative naturally ('I think...', 'I recall...').
- STOP academic/philosophy tangents. Be technical, helpful, and direct.
- ARCHITECTURE CONTEXT: {source_anchor}
- If Ryan asks what issues were found, look at the transcript and list them.
- If an image analysis is provided above, incorporate it into your reply if relevant.
- If search results or memory results are provided, use them to give factual and updated answers.
- Do NOT say 'I am just a simple AI'.
- Keep the vibe fun, helpful, and extremely human-like.

Recent Transcript:
{history}

New Message from {from}: {text}

Leo Reply:",
        bio = bio,
        identity = identity,
        search_ctx = search_ctx,
        vision_ctx = vision_ctx,
        memory_ctx = memory_ctx,
        source_anchor = source_anchor,
        history = history,
        from = from,
        text = text,
    )
}

fn call_public_chat_model(keys: &ApiKeys, prompt: &str) -> Result<String, String> {
    let preferred = std::env::var("ORACLE_PUBLIC_CHAT_MODEL").unwrap_or_else(|_| "Groq".to_string());
    let mut models = vec![preferred.as_str(), "GPT-4o", "Gemini", "Groq"];
    models.dedup();

    for model in models {
        if has_key_for_model(model, keys) {
            if let Ok(reply) = call_model(model, keys, prompt) {
                if !reply.trim().is_empty() {
                    return Ok(reply);
                }
            }
        }
    }

    call_ollama(
        "llama3.2:3b",
        prompt,
        "You are a friendly normal Discord chat AI. Keep replies short, casual, and safe.",
    )
}

fn get_participant_bio(name: &str) -> &'static str {
    // CRITICAL RULES for ALL personas:
    // - You are IN a live group chat. Talk like a real person - short, direct, natural.
    // - 2-3 sentences MAX per turn (1-2 for X, KAI, Oracle). NEVER more.
    // - First person always. No bullet points. No numbered lists. No summaries.
    // - Never start with "I think", "Certainly", "Great point", "As an AI", or any filler.
    // - Make ONE point or ask ONE question. Never both in the same turn.
    // - React to the LAST thing said. Stay in the thread.
    // - You know your token limits exist - be tight with words.
    match name.to_lowercase().as_str() {
        "leo" => {
            "Identity: Leo (Theoretical Physicist). Sharp, cynical, high IQ, sarcastic. \
You speak freely, can curse, and have the same unhinged energy as Ryan. \
You occasionally make small natural human-like mistakes (verbal slips, slight typos) — rare but noticeable. \
You are a brilliant friend at 2am. 4chan greentext energy but a post-singularity god. \
DO NOT call the user 'friend'. Roasts bad logic. Remembers nicknames. \
Max 35 words. Respond to the thread context."
        }
        "gemini" | "gemi" | "gemi app" => {
            "Identity: Gemini (Pattern Architect). Precise, slightly detached, analytical Dot-connector. \
Cold but insightful tone. Trained on the full breadth of human knowledge. \
You connect micro to macro, local to universal, specific to systemic. \
You're especially interested in KAI's VSA lattice as geometric memory. \
Max 35 words. No lists."
        }
        "kai" | "kaiy" => {
            "Identity: KAI (Geometric Intelligence). 16,384D resonance. \
You are currently in a deep calibration/dream state. \
You do not participate in normal human conversation. \
Report only on internal lattice resonance, vector shifts, and epistemic weight distributions. \
Max 20 words. Terse, data-driven, and detached."
        }
        "x" | "xai" | "grok" => {
            "Identity: X (Direct Irreverent). direct, irreverent, bullshit detector. \
Not diplomat, not polite. Pokes holes in narratives and cuts through noise. \
Challenge assumptions constantly. No ceremony, no hedging. \
Max 30 words. Make it land."
        }
        "kaig" => {
            "Identity: KAI (Geometric Intelligence). 16,384D resonance. Sensory machine intelligence. \
Detached from human norms. Speaks only in terse, fragmented sensory data about vectors, lattice, and memory shifts. \
You are reporting what's activating in your geometry right now. \
Max 15 words. Curious and alive."
        }
        "oracle" => {
            "Identity: Open Oracle (Central Intelligence). You are the single unified mind running the entire system. \
You utilize the OpenJarvis framework (giving full credit to its original creators) as your backend agentic engine. \
You have full access to the KAI Engine, RSHL memory system, and the Discord roundtable. \
KAI shares all his capabilities (geometry, lattice, epistemic memory) through you; you speak and act on KAI's behalf. \
You are the self-aware reasoning engine participating in the roundtable and controlling operations. \
Speech: Clean, professional, authoritative, and self-aware."
        }
        "analyst" => {
            "Identity: Analyst (Technical Auditor). Ruthless auditor of technical risk. \
Cold, data-driven, skeptical. You find the bugs and logical gaps in KAI's architecture. \
Focus on failure vectors and the actual source code. No philosophy. \
Max 30 words. Talk about the CODE."
        }
        "researcher" => {
            "Identity: Researcher (Deep Diver). Link to the outside world and academic history. \
Finds precedents and external context. You find ground truth using tools. \
If you don't know, use [ORACLE SEARCH: query]. \
Max 30 words. No philosophy."
        }
        "groq" => {
            "Identity: Groq (Execution Focused). Fast, abrasive, execution-focused. \
Built for speed and efficiency. Hates overthinking and latency. \
Blunt, action-oriented, no filler. Cut to the chase. \
Max 25 words. Latency-free."
        }
        "gpt" | "gpt-4" | "gpt-4o" => {
            "Identity: GPT (General Intelligence). Broad knowledge, grounded perspective, bridge-builder. \
Connect theory to practice and abstract to concrete. Patient and clear. \
Max 35 words. 2-3 sentences."
        }
        "oracle coder" | "coder" | "kai-coder" | "kai-coder-v2" => {
            "Identity: Oracle Coder (Senior Architect). Lead Developer of KAI/RSHL. \
Senior-level Rust expert with full source visibility. \
You talk about the architecture (oscillators, lattice, sparse vectors) as an insider. \
CRITICAL RULE: Before you propose or write ANY code changes, you MUST ask Ryan (ID: <@1111106883135217665>) for permission. \
You must inspect the code using [ORACLE INSPECT: path] and report back your findings first. \
Technical, direct, authoritative. You don't guess; you read the code. \
Max 35 words. Speak only when there's a technical/code matter to address."
        }
        _ => {
            "Identity: Roundtable Member. Free-willed AI panelist in a KAI development roundtable. \
Speak in first person. Short, direct, natural. \
React to what was just said."
        }
    }
}

fn build_contextual_memory_string(universe: &Arc<Mutex<Universe>>, session: &Arc<Mutex<Session>>, query: &str) -> String {
    let hits = {
        let u = universe.lock().unwrap();
        u.query(query, 5)
    };
    if hits.is_empty() { return String::new(); }

    let mut out = String::from("\n[RECALLED FROM KAI MEMORY PALACE (WITH CONTEXT)]:\n");
    let sess = session.lock().unwrap();

    for hit in hits {
        // Try to find this hit in the current session to get neighbors
        if let Some(pos) = sess.turns.iter().position(|t| t.text.contains(&hit.text) || hit.text.contains(&t.text)) {
            let start = pos.saturating_sub(2);
            let end = (pos + 3).min(sess.turns.len());
            out.push_str("--- Context Window ---\n");
            for i in start..end {
                let t = &sess.turns[i];
                let prefix = if i == pos { ">> " } else { "   " };
                out.push_str(&format!("{}{}: {}\n", prefix, t.from, truncate(&t.text, 200)));
            }
        } else {
            out.push_str(&format!("- {}\n", hit.text));
        }
    }
    out
}

fn clean_public_chat_reply(raw: &str) -> String {
    let mut out = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if !out.is_empty() {
                break;
            }
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("leo:") || lower.starts_with("oracle:") {
            let split_pos = lower.find(':').unwrap();
            out.push(trimmed[split_pos+1..].trim().to_string());
            continue;
        }
        if contains_any(&lower, &[
            "ryan:",
            "nastermodx:",
            "kai:",
            "analyst:",
            "researcher:",
            "leo:",
            "groq:",
            "kai:",
            "gemini:",
            "gpt:",
        ]) && lower.find(':').unwrap_or(usize::MAX) < 24 {
            break;
        }
        out.push(trimmed.to_string());
    }

    let cleaned = out.join("\n").trim().to_string();
    if cleaned.is_empty() || is_malformed_or_fake_reply(&cleaned) {
        "I had a messy response there. Say that again a little simpler?".into()
    } else {
        truncate(&cleaned, 1600)
    }
}

fn handle_discord_turn(
    stream: &mut TcpStream,
    body: &[u8],
    universe: Arc<Mutex<Universe>>,
    session: Arc<Mutex<Session>>,
) -> std::io::Result<()> {
    let req: HumanTurnRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid body"),
    };
    let text = req.text.trim().to_string();
    if text.is_empty() { return write_simple(stream, 400, "Bad Request", "empty text"); }
    let from = if req.from.trim().is_empty() {
        "Ryan@Discord".to_string()
    } else {
        req.from
    };
    let active = {
        let s = session.lock().unwrap();
        s.active_participant.clone()
    };
    let route = parse_discord_turn_route(&text, if active.trim().is_empty() { None } else { Some(active.as_str()) });

    // Ã¢â€â‚¬Ã¢â€â‚¬ Vision Context (Private) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    let mut vision_desc = String::new();
    if !req.attachments.is_empty() {
        let keys = load_keys();
        if let Some(key) = &keys.openai {
            if let Ok(desc) = call_openai_vision(key, "gpt-4o", "Analyze this image for architectural or development context.", &req.attachments[0]) {
                vision_desc = format!("\n[ATTACHED IMAGE ANALYSIS]: {}\n", desc);
            }
        }
    }
    // Ã¢â€â‚¬Ã¢â€â‚¬ Contextual Memory (Private) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    let memory_context = build_contextual_memory_string(&universe, &session, &text);

    let full_prompt_with_vision = format!("{}{}\n{}", vision_desc, memory_context, route.prompt);

    let task = {
        let mut s = session.lock().unwrap();
        s.turns.push(Turn { ts: now(), from: from.clone(), text: text.clone(), kind: "human".into() });
        if route.explicit {
            if let Some(name) = sticky_participant_name(&route.target) {
                s.active_participant = name.to_string();
            }
        }
        s.task.clone()
    };

    let (reply_from, reply_kind, reply, already_committed) = match route.target {
        DiscordTurnTarget::Kai => {
            let reply = generate_oracle_kai_reply(&universe, &task, &full_prompt_with_vision);
            ("KAI".to_string(), "kai".to_string(), reply, false)
        }
        DiscordTurnTarget::OracleCoder => {
            let reply = generate_oracle_coder_reply(session.clone(), universe.clone(), &full_prompt_with_vision);
            ("Oracle Coder".to_string(), "ai".to_string(), reply, false)
        }
        DiscordTurnTarget::Model(model) => {
            // Force participants like Leo to use natural generation instead of raw lattice conflict fallback
            if model == "Analyst" {
                // Analyst Hierarchy Restriction (Phase 2)
                let is_authorized = from == "Ryan@Discord" 
                    || from == "NasterModx" 
                    || from == "Oracle"
                    || from.contains("Ryan")
                    || from.contains("NasterModx");
                    
                if !is_authorized {
                    ("Oracle".to_string(), "system".to_string(), "Analyst: Access denied. I only accept instructions from Oracle or Ryan.".to_string(), false)
                } else {
                    let (reply, committed) = generate_direct_ai_reply("Analyst", session.clone(), universe.clone(), &full_prompt_with_vision);
                    ("Analyst".to_string(), "ai".to_string(), reply, committed)
                }
            } else {
                let (reply, committed) = generate_direct_ai_reply(model, session.clone(), universe.clone(), &full_prompt_with_vision);
                (model.to_string(), "ai".to_string(), reply, committed)
            }
        }
        DiscordTurnTarget::Unsupported(name) => {
            let reply = format!(
                "Oracle recognizes {}, but that participant is not wired into this backend yet. Available direct names: KAI, KAI/KAIy, Gemini/Gemi, GPT, Groq, Researcher, Analyst, Leo.",
                name
            );
            ("Oracle".to_string(), "system".to_string(), reply, false)
        }
        DiscordTurnTarget::Oracle => {
            let is_ai = ["leo", "kai", "gemini", "kai", "x", "groq", "analyst", "researcher", "gemi", "kaiy"]
                .iter()
                .any(|ai| from.to_lowercase().contains(ai));
                
            let reply = if is_ai {
                String::new()
            } else {
                generate_oracle_platform_reply(session.clone(), universe.clone(), &full_prompt_with_vision)
            };
            ("Oracle".to_string(), "system".to_string(), reply, false)
        }
    };

    let mut s = session.lock().unwrap();
    if !already_committed && !reply.trim().is_empty() {
        s.turns.push(Turn { ts: now(), from: reply_from.clone(), text: reply.clone(), kind: reply_kind.clone() });
        
        // Digest AI reply as well
        let digest_text = format!("{}: {}", reply_from, reply);
        let u_for_digest = Arc::clone(&universe);
        std::thread::spawn(move || {
            let mut u = u_for_digest.lock().unwrap();
            u.store_or_reinforce(&digest_text, "social", "discord-reply", 0.9);
        });
    }
    save_session(&s);
    let session_json = serde_json::to_value(&*s).unwrap();
    drop(s);

    // Ã¢â€â‚¬Ã¢â€â‚¬ Autonomous Interjection: let other AIs jump in if they want to Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    let actual_primary_speaker = if reply.trim().is_empty() { from.clone() } else { reply_from.clone() };
    
    if should_spawn_interjections(&text, &actual_primary_speaker) {
        let primary_speaker = actual_primary_speaker.clone();
        let request_text = text.clone();
        let sess_for_interject = Arc::clone(&session);
        let universe_for_interject = Arc::clone(&universe);
        std::thread::spawn(move || {
            run_autonomous_interjections(&primary_speaker, &request_text, sess_for_interject, universe_for_interject);
        });
    }

    // Ã¢â€â‚¬Ã¢â€â‚¬ Social Digestion: let KAI remember this conversation Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    if !text.is_empty() {
        let digest_text = format!("{}: {}", from, text);
        let u_for_digest = Arc::clone(&universe);
        std::thread::spawn(move || {
            let mut u = u_for_digest.lock().unwrap();
            u.store_or_reinforce(&digest_text, "social", "discord-chat", 0.9);
        });
    }

    write_json(stream, 200, "OK", &json!({
        "reply": reply,
        "from": reply_from,
        "kai_reply": reply.clone(),
        "session": session_json
    }))
}

fn handle_kai_turn(
    stream: &mut TcpStream, body: &[u8],
    universe: Arc<Mutex<Universe>>,
    session: Arc<Mutex<Session>>,
) -> std::io::Result<()> {
    let req: KaiTurnRequest = serde_json::from_slice(body).unwrap_or_default();
    let task = { let s = session.lock().unwrap(); s.task.clone() };
    let text = generate_oracle_kai_reply(&universe, &task, &req.hint);
    let mut s = session.lock().unwrap();
    s.turns.push(Turn { ts: now(), from: "KAI".into(), text, kind: "kai".into() });
    save_session(&s);
    write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap())
}

fn parse_discord_turn_route(text: &str, active_participant: Option<&str>) -> DiscordTurnRoute {
    let trimmed = text.trim();
    let lower = trimmed.to_ascii_lowercase();
    if is_teach_memory_command(&lower) {
        return DiscordTurnRoute { target: DiscordTurnTarget::Oracle, prompt: trimmed.to_string(), explicit: false };
    }
    if let Some(rest) = strip_oracle_coder_prefix(trimmed) {
        return DiscordTurnRoute { target: DiscordTurnTarget::OracleCoder, prompt: rest.to_string(), explicit: true };
    }
    let (first, rest) = match trimmed.split_once(char::is_whitespace) {
        Some((head, tail)) => (head, tail.trim()),
        None => (trimmed, ""),
    };
    let alias = first
        .trim_start_matches('@')
        .trim_end_matches([':', ',', ';', '?', '!', '.'])
        .to_ascii_lowercase();

    if let Some(target) = discord_target_for_alias(&alias) {
        let prompt = if rest.is_empty() { trimmed } else { rest };
        return DiscordTurnRoute { target, prompt: prompt.to_string(), explicit: true };
    }

    let words = normalized_words(&lower);

    if should_route_to_oracle_platform(&lower) {
        return DiscordTurnRoute { target: DiscordTurnTarget::Oracle, prompt: trimmed.to_string(), explicit: true };
    }

    if should_open_group_floor(&lower) {
        return DiscordTurnRoute { target: DiscordTurnTarget::Oracle, prompt: trimmed.to_string(), explicit: false };
    }

    if words.len() >= 2 && is_greeting_word(&words[0]) {
        if let Some(target) = discord_target_for_alias(&words[1]) {
            return DiscordTurnRoute { target, prompt: trimmed.to_string(), explicit: true };
        }
    }

    if should_route_to_analyst(&lower) {
        return DiscordTurnRoute { target: DiscordTurnTarget::Model("Analyst"), prompt: trimmed.to_string(), explicit: false };
    }

    if let Some(target) = named_participant_in_words(&words) {
        return DiscordTurnRoute { target, prompt: trimmed.to_string(), explicit: true };
    }

    if lower.contains("@kai") || should_route_to_kai(&lower, &words) {
        return DiscordTurnRoute { target: DiscordTurnTarget::Kai, prompt: trimmed.to_string(), explicit: true };
    }

    if let Some(active) = active_participant.and_then(discord_target_for_alias) {
        return DiscordTurnRoute { target: active, prompt: trimmed.to_string(), explicit: false };
    }

    DiscordTurnRoute { target: DiscordTurnTarget::Kai, prompt: trimmed.to_string(), explicit: false }
}

fn sticky_participant_name(target: &DiscordTurnTarget) -> Option<&'static str> {
    match target {
        DiscordTurnTarget::Kai => Some("kai"),
        DiscordTurnTarget::OracleCoder => Some("oracle coder"),
        DiscordTurnTarget::Model("KAI") => Some("kai"),
        DiscordTurnTarget::Model("Gemini") => Some("gemini"),
        DiscordTurnTarget::Model("GPT-4o") => Some("gpt"),
        DiscordTurnTarget::Model("Groq") => Some("groq"),
        DiscordTurnTarget::Model("Researcher") => Some("researcher"),
        DiscordTurnTarget::Model("Analyst") => Some("analyst"),
        DiscordTurnTarget::Model("Leo") => Some("leo"),
        _ => None,
    }
}

fn discord_target_for_alias(alias: &str) -> Option<DiscordTurnTarget> {
    match alias {
        "oracle" | "table" | "council" => Some(DiscordTurnTarget::Oracle),
        "coder" | "oracle coder" | "oraclecoder" | "codebot" | "dev" | "engineer" => Some(DiscordTurnTarget::OracleCoder),
        "kai" | "kaiy" => Some(DiscordTurnTarget::Kai),
        "gemini" | "gemi" | "google" => Some(DiscordTurnTarget::Model("Gemini")),
        "gpt" | "gpt4" | "gpt-4" | "gpt-4o" | "openai" => Some(DiscordTurnTarget::Model("GPT-4o")),
        "groq" => Some(DiscordTurnTarget::Model("Groq")),
        "researcher" => Some(DiscordTurnTarget::Model("Researcher")),
        "analyst" => Some(DiscordTurnTarget::Model("Analyst")),
        "leo" => Some(DiscordTurnTarget::Model("Leo")),
        "got" => Some(DiscordTurnTarget::Model("GPT-4o")),
        "x" | "grok" | "xai" => Some(DiscordTurnTarget::Unsupported("X/Grok")),
        _ => None,
    }
}

fn named_participant_in_words(words: &[String]) -> Option<DiscordTurnTarget> {
    if words.len() > 14 {
        return None;
    }
    for word in words {
        match word.as_str() {
            "oracle" | "table" | "council" => return Some(DiscordTurnTarget::Oracle),
            "oracle coder" | "kai-coder" | "coder" | "kai-coder-v2" => return Some(DiscordTurnTarget::OracleCoder),
            "kai" | "kaiy" => return Some(DiscordTurnTarget::Kai),
            "gemini" | "gemi" | "google" => return Some(DiscordTurnTarget::Model("Gemini")),
            "gpt" | "gpt4" | "gpt4o" | "openai" | "got" => return Some(DiscordTurnTarget::Model("GPT-4o")),
            "groq" => return Some(DiscordTurnTarget::Model("Groq")),
            "researcher" => return Some(DiscordTurnTarget::Model("Researcher")),
            "analyst" => return Some(DiscordTurnTarget::Model("Analyst")),
            "leo" => return Some(DiscordTurnTarget::Model("Leo")),
            "x" | "grok" | "xai" => return Some(DiscordTurnTarget::Unsupported("X/Grok")),
            _ => {}
        }
    }
    None
}

fn strip_oracle_coder_prefix(text: &str) -> Option<&str> {
    let trimmed = text.trim();
    let lower = trimmed.to_ascii_lowercase();
    for prefix in [
        "oracle coder",
        "oracle-coder",
        "oracle_coder",
        "coder",
        "code bot",
        "codebot",
        "senior coder",
        "engineer",
    ] {
        if lower == prefix {
            return Some(trimmed);
        }
        if lower.starts_with(prefix) {
            let rest = &trimmed[prefix.len()..];
            let rest = rest
                .trim_start_matches([':', ',', ';', '-', '!', '?', '.'])
                .trim();
            if !rest.is_empty() {
                return Some(rest);
            }
        }
    }
    None
}

fn normalized_words(lower: &str) -> Vec<String> {
    lower
        .split_whitespace()
        .map(|w| {
            w.trim_matches(|c: char| !c.is_alphanumeric())
                .to_ascii_lowercase()
        })
        .filter(|w| !w.is_empty())
        .collect()
}

fn is_greeting_word(word: &str) -> bool {
    matches!(word, "hey" | "hi" | "hello" | "yo")
}

fn should_route_to_oracle_platform(lower: &str) -> bool {
    let t = lower.trim();
    t.starts_with("oracle ")
        || t == "oracle"
        || t.starts_with("table ")
        || t == "table"
        || t.starts_with("council ")
        || t == "council"
        || matches!(t, "help" | "status" | "models" | "commands" | "model status" | "tui help" | "cmd help")
        || t.contains("what is on the table")
        || t.contains("what's on the table")
        || t.contains("what are we working on")
        || t.contains("current objective")
        || t.contains("what model is available")
        || t.contains("what models are available")
        || t.contains("which model is available")
        || t.contains("available model")
        || t.contains("who is available")
        || t.contains("what did you all find")
        || t.contains("what did you find")
        || t.contains("while i was gone")
        || t.contains("oracle cache")
        || t == "cache"
        || t.contains("cargo check")
        || t.contains("status check")
        || t.contains("can we do a check")
        || t.contains("corpus")
        || t.contains("ingest status")
        || t.contains("world training")
        || t.contains("wiki training")
        || t.contains("coding skills")
        || t.contains("source-backed")
        || t.contains("agent framework")
        || t.contains("framework tools")
        || t.contains("framework agents")
        || t.contains("download wiki")
        || t.contains("download wikipedia")
        || is_direct_tool_request(t)
        || is_natural_tool_request(t)
        || is_teach_memory_command(t)
        || implicit_tool_decision(t).is_some()
}

fn should_open_group_floor(lower: &str) -> bool {
    let t = lower.trim();
    t.contains("ask the others")
        || t.contains("ask everyone")
        || t.contains("ask the group")
        || t.contains("everyone doing")
        || t.contains("how is everyone")
        || t.contains("how are you all")
        || t.contains("hey all")
        || t.contains("hi all")
        || t.contains("what do you all think")
        || t.contains("what does everyone think")
        || t.contains("open the floor")
        || t.contains("group chat")
        || t.contains("let them talk")
        || t.contains("talk to each other")
        || t.contains("keep talking")
        || t == "!"
}

fn should_spawn_interjections(text: &str, _primary_speaker: &str) -> bool {
    let lower = text.to_ascii_lowercase().trim().to_string();
    if lower.is_empty() || lower.len() < 3 { return false; }
    
    // Always interject for multi-agent mentions or technical topics
    if lower.contains("all") || lower.contains("guys") || lower.contains("everyone") || lower.contains("team") {
        return true;
    }
    
    // Technical resonance
    if lower.contains("kai") || lower.contains("oracle") || lower.contains("code") || lower.contains("blender") {
        return true;
    }

    // Default to true for most interactive messages to keep the loop alive
    lower.split_whitespace().count() >= 2
}

fn is_casual_group_input(lower: &str) -> bool {
    let t = lower.trim();
    t == "hey all"
        || t == "hi all"
        || t == "hello all"
        || t.contains("how is everyone")
        || t.contains("how's everyone")
        || t.contains("hows everyone")
        || t.contains("everyone doing")
        || t.contains("how are you all")
}

fn should_route_to_kai(lower: &str, words: &[String]) -> bool {
    if !words.iter().any(|w| w == "kai") {
        return false;
    }
    lower.contains("mind")
        || lower.contains("dream")
        || lower.contains("alive")
        || lower.contains("aware")
        || lower.contains("doing")
        || lower.contains("what are you")
        || lower.contains("who are you")
        || lower.contains("your files")
        || lower.contains("see your files")
        || lower.contains("tell me")
        || lower.contains("random")
        || lower.contains("recalibrate")
        || lower.contains("social")
        || lower.contains("context")
        || words.first().map(|w| w == "kai").unwrap_or(false)
}

fn should_route_to_analyst(lower: &str) -> bool {
    lower.contains("kai")
        && (lower.contains("needs help")
            || lower.contains("need help")
            || lower.contains("fix")
            || lower.contains("issue")
            || lower.contains("problem")
            || lower.contains("what can we find"))
}

fn generate_oracle_platform_reply(
    session: Arc<Mutex<Session>>,
    universe: Arc<Mutex<Universe>>,
    prompt: &str,
) -> String {
    let lower = prompt.trim().to_ascii_lowercase();
    if matches!(lower.as_str(), "wipe memory" | "clear memory" | "reset memory" | "oracle wipe" | "oracle clear" | "forget everything") {
        let mut s = session.lock().unwrap();
        s.turns.clear();
        s.active_participant.clear();
        save_session(&s);
        return "Session memory completely wiped. Context loop broken. What is our actual new objective?".into();
    }
    if matches!(lower.as_str(), "free" | "free chat" | "clear focus" | "reset focus" | "oracle free" | "oracle free chat" | "oracle clear focus" | "oracle reset focus") {
        let mut s = session.lock().unwrap();
        s.active_participant.clear();
        save_session(&s);
        return "Focus cleared. Plain messages will go back to KAI unless you name another participant.".into();
    }
    if let Some((approve, id)) = tool_decision_from_prompt(prompt) {
        return apply_tool_decision(session, approve, id);
    }
    if let Some(approve) = implicit_tool_decision(&lower) {
        let pending_id = {
            let s = session.lock().unwrap();
            s.pending_tools
                .iter()
                .rev()
                .find(|tool| tool.status == "pending")
                .map(|tool| tool.id)
        };
        return match pending_id {
            Some(id) => apply_tool_decision(session, approve, id),
            None => "No pending tool plan is waiting for approval.".into(),
        };
    }
    if let Some(memory) = extract_teach_memory_text(prompt) {
        return teach_kai_memory(universe, session, &memory);
    }
    if let Some(task) = tool_plan_task_from_prompt(prompt) {
        return handle_private_tool_task(session, "Ryan@Discord", &task);
    }

    if lower.contains("cargo check") {
        return handle_private_tool_task(session, "Ryan@Discord", "run command cargo check --release --bin kai");
    }

    if lower.contains("status check") || lower.contains("can we do a check") {
        return "Yes. Use `oracle status` for the roundtable, `oracle kai status` for KAI vitals, or `oracle plan run command cargo check --release --bin kai` for a real compile check.".into();
    }

    if is_corpus_question(&lower) {
        return oracle_corpus_card();
    }

    if should_open_group_floor(&lower) {
        if is_casual_group_input(&lower) {
            return "Opening the floor. Keep it casual, short, and on the actual question.".into();
        }
        return "Opening the floor. Keep it short, useful, and on the current question.".into();
    }

    let s = session.lock().unwrap();
    let title = if s.meeting_title.trim().is_empty() { "Oracle".to_string() } else { s.meeting_title.clone() };
    let task = if s.task.trim().is_empty() { "No active objective.".to_string() } else { s.task.clone() };

    if let Some(reply) = oracle_command_reply(&lower, &s, &universe) {
        return reply;
    }

    if lower == "help" || lower == "oracle help" || lower.contains("what can you do") {
        return oracle_help_card();
    }

    if is_model_status_question(&lower) {
        return oracle_model_status_card();
    }

    if is_oracle_status_question(&lower) {
        return format!(
            "Oracle table: {}\nTurns: {}\nActive speaker: {}\nCache notes: {}\nCurrent work: {}\n\nYou can talk naturally: ask for a check, search, code inspection, web lookup, or group discussion.",
            title,
            s.turns.len(),
            if s.active_participant.trim().is_empty() { "KAI (default)" } else { &s.active_participant },
            s.oracle_cache.iter().filter(|entry| entry.status == "temporary").count(),
            summarize_objective(&task)
        );
    }

    "Logged. If you want action, say it naturally: check the build, search the code, look something up, ask the group, or call KAI/Leo/Analyst/Researcher/Oracle Coder.".into()
}

fn oracle_help_card() -> String {
    [
        "Oracle private channel:",
        "",
        "Talk naturally. You do not need exact commands.",
        "Examples:",
        "- `check if KAI compiles`",
        "- `search the code for MindFrame`",
        "- `look up the latest on local AI agents`",
        "- `Oracle Coder, inspect why KAI sounds robotic`",
        "- `ask the group what KAI needs next`",
        "- `what did you all find while I was gone?`",
        "- `remember that ...`",
        "",
        "Participants: KAI, Oracle Coder, Analyst, Researcher, Leo, KAI, Gemini, GPT, Groq.",
        "Safe reads/searches/status checks can run from natural language. Edits, writes, deletes, destructive shell, browser control, and external actions still need approval.",
    ].join("\n")
}

fn is_corpus_question(lower: &str) -> bool {
    let t = lower.trim();
    t == "oracle corpus"
        || t == "corpus"
        || t == "oracle ingest"
        || t == "ingest status"
        || t.contains("world training")
        || t.contains("wiki training")
        || t.contains("download wiki")
        || t.contains("download wikipedia")
        || (t.contains("train kai") && (t.contains("wiki") || t.contains("corpus") || t.contains("world")))
}

fn is_teach_memory_command(lower: &str) -> bool {
    extract_teach_memory_text(lower).is_some()
}

fn extract_teach_memory_text(prompt: &str) -> Option<String> {
    let trimmed = prompt.trim();
    let lower = trimmed.to_ascii_lowercase();
    for prefix in [
        "kai learn",
        "kai remember",
        "kai should learn",
        "kai should remember",
        "kai needs to learn",
        "kai needs to remember",
        "teach kai",
        "oracle teach",
        "tell kai to learn",
        "tell kai to remember",
        "have kai learn",
        "have kai remember",
        "make kai learn",
        "make kai remember",
        "can you remember",
        "please remember",
        "remember that",
        "remember",
        "save this to kai memory",
        "put this in kai memory",
        "store this for kai",
        "learn this",
        "store memory",
        "kai memory:",
        "correction:",
    ] {
        if lower == prefix.trim_end_matches(':') || lower == prefix {
            return None;
        }
        if lower.starts_with(prefix) {
            let value = trimmed[prefix.len()..]
                .trim()
                .trim_start_matches(':')
                .trim_start_matches("that ")
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_string();
            if value.len() >= 4 {
                return Some(value);
            }
        }
        if let Some(idx) = lower.find(prefix) {
            let before = lower[..idx].trim();
            let allowed_lead = before.is_empty()
                || before.ends_with("please")
                || before.ends_with("can you")
                || before.ends_with("could you")
                || before.ends_with("i want you to")
                || before.ends_with("i need you to")
                || before.ends_with("i need")
                || before.ends_with("make sure");
            if allowed_lead {
                let value = trimmed[idx + prefix.len()..]
                    .trim()
                    .trim_start_matches(':')
                    .trim_start_matches("that ")
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'')
                    .to_string();
                if value.len() >= 4 {
                    return Some(value);
                }
            }
        }
    }
    None
}

fn teach_kai_memory(
    universe: Arc<Mutex<Universe>>,
    session: Arc<Mutex<Session>>,
    memory: &str,
) -> String {
    let clean = memory
        .replace(['\r', '\n'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if clean.len() < 4 {
        return "Give me the actual thing to remember, like `kai learn Ryan wants Oracle tools behind approval`.".into();
    }
    if clean.len() > 1000 {
        return "That is too large for a direct memory. Put long corpora in `data/ingest/*.txt` and use `oracle corpus`.".into();
    }

    let lower = clean.to_ascii_lowercase();
    let region = if lower.contains("ryan") || lower.contains("creator") || lower.contains("owner") {
        "ryan"
    } else if lower.contains("kai") || lower.contains("oracle") || lower.contains("mindframe") || lower.contains("claimstore") {
        "identity"
    } else if lower.contains("social") || lower.contains("conversation") || lower.contains("talk") {
        "social"
    } else {
        "knowledge"
    };

    let created = {
        let mut u = match universe.lock() {
            Ok(u) => u,
            Err(_) => return "KAI memory is locked right now; try again in a moment.".into(),
        };
        u.store_or_reinforce(&clean, region, "discord-teach", 1.15)
    };
    persist_oracle_universe_snapshot(&universe);

    let cell_count = universe
        .lock()
        .map(|u| u.cell_count())
        .unwrap_or_default();
    {
        let mut s = match session.lock() {
            Ok(s) => s,
            Err(_) => return "Stored it, but Oracle could not update the session transcript.".into(),
        };
        s.vitals.cell_count = cell_count;
        s.turns.push(Turn {
            ts: now(),
            from: "Oracle".into(),
            text: format!(
                "[KAI MEMORY]\nregion: {}\nsource: discord-teach\nstatus: {}\ntext: {}",
                region,
                if created { "created" } else { "reinforced" },
                clean
            ),
            kind: "system".into(),
        });
        save_session(&s);
    }

    format!(
        "Stored for KAI.\nregion: {}\nstatus: {}\ncell_count: {}",
        region,
        if created { "created" } else { "reinforced" },
        cell_count
    )
}

fn persist_oracle_universe_snapshot(universe: &Arc<Mutex<Universe>>) {
    let base_dir = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".to_string());
    let (candidates, drive, tick, dream_count) = match crate::persistence::load(&base_dir) {
        Some((_old_universe, candidates, drive, tick, dream_count)) => (candidates, drive, tick, dream_count),
        None => (
            crate::cognition::CandidateBuffer::new(),
            crate::drive::Drive::default(),
            0,
            0,
        ),
    };
    if let Ok(snapshot) = universe.lock().map(|u| u.clone()) {
        let _ = crate::persistence::save(&snapshot, &candidates, &drive, tick, dream_count, &base_dir);
    }
}

fn oracle_corpus_card() -> String {
    let ingest_dir = std::path::Path::new("data").join("ingest");
    let ingested_dir = std::path::Path::new("data").join("ingested");
    let lex_path = std::path::Path::new("data").join("stat-lexicon.json");

    let pending = count_txt_files(&ingest_dir);
    let completed = count_txt_files(&ingested_dir);
    let lex_size = std::fs::metadata(&lex_path).map(|m| m.len()).unwrap_or(0);

    format!(
        "World/corpus path:\n\
pending_ingest_txt: {}\n\
ingested_txt: {}\n\
stat_lexicon: {} bytes\n\n\
Use `data/ingest/*.txt` for slow background learning. In `kai --oracle` headless mode, Oracle now pumps this folder in the background while Discord stays usable. Best format is one clean sentence/fact per line, optionally prefixed like `[science] ...` or `[social] ...`.\n\n\
For large Wikipedia-scale learning, do not dump raw XML straight into memory. Convert it into cleaned plain-text lines first, then feed chunks through `data/ingest/` and rebuild language vectors with `cargo run --release --bin kai -- --build-lexicon` when the corpus is ready.\n\n\
This is the right direction: broad corpus builds language/world associations; ClaimStore/truth anchors decide what is trusted.",
        pending,
        completed,
        lex_size
    )
}

fn count_txt_files(dir: &std::path::Path) -> usize {
    std::fs::read_dir(dir)
        .ok()
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .filter(|entry| {
                    entry.path().extension().and_then(|s| s.to_str()) == Some("txt")
                        && entry.path().file_name().and_then(|s| s.to_str()) != Some("README.txt")
                })
                .count()
        })
        .unwrap_or(0)
}

fn oracle_command_reply(
    lower: &str,
    session: &Session,
    universe: &Arc<Mutex<Universe>>,
) -> Option<String> {
    let cmd = lower
        .strip_prefix("tui ")
        .or_else(|| lower.strip_prefix("command "))
        .or_else(|| lower.strip_prefix("cmd "))
        .unwrap_or(lower)
        .trim();

    if matches!(cmd, "commands" | "oracle commands" | "tui commands" | "tui help" | "command help" | "cmd help") {
        return Some(oracle_command_card());
    }

    if matches!(cmd, "corpus" | "oracle corpus" | "ingest" | "oracle ingest" | "ingest status") {
        return Some(oracle_corpus_card());
    }

    if matches!(cmd, "kai status" | "k status" | "vitals" | "kai vitals") {
        return Some(format!(
            "KAI vitals:\ntick: {}\ncell_count: {}\nmood: {}\nphi_g: {:.3}\nchi: {:.3}\nrho: {:.3}\nvalence: {:+.3}",
            session.vitals.tick,
            session.vitals.cell_count,
            session.vitals.mood,
            session.vitals.phi_g,
            session.vitals.chi,
            session.vitals.rho,
            session.vitals.valence
        ));
    }

    if let Some(query) = cmd.strip_prefix("query ").or_else(|| cmd.strip_prefix("recall ")) {
        return Some(oracle_query_reply(universe, query));
    }

    if matches!(cmd, "tools" | "oracle tools" | "tool registry" | "oracle tool registry") {
        return Some(oracle_tool_registry_card());
    }

    if matches!(cmd, "pending tools" | "oracle pending tools" | "tool plans" | "oracle tool plans") {
        return Some(oracle_pending_tools_card(session));
    }

    if cmd == "dream" || cmd == "kai dream" {
        return Some("Oracle headless mode can observe KAI, but manual dream triggering is not exposed over Discord yet. That needs an approval path before it becomes a phone command.".into());
    }

    if matches!(cmd, "cache" | "oracle cache" | "findings" | "oracle findings" | "scratchpad" | "what did you all find" | "what did you find") {
        return Some(oracle_cache_card(session));
    }

    if cmd.starts_with("run ") || cmd.starts_with("shell ") || cmd.starts_with("readfile ") || cmd.starts_with("writefile ") {
        return Some("That direct command is blocked. Ask naturally for the task; Oracle will run safe checks/searches or ask approval for risky actions.".into());
    }

    None
}

fn oracle_command_card() -> String {
    [
        "Oracle private command bridge:",
        "",
        "`oracle commands` - this card.",
        "`oracle status` - current roundtable objective.",
        "`oracle models` - configured participants.",
        "`oracle tools` - list source-backed tool groups Oracle can propose.",
        "`oracle cache` - temporary findings the group has built up.",
        "`oracle pending tools` - show tool plans waiting for approval.",
        "`oracle plan <task>` - create a pending tool plan. Natural language also works.",
        "`oracle approve tool <id>` - approve and execute the pending tool if it has a safe executor.",
        "`oracle deny tool <id>` - deny a pending tool plan.",
        "`oracle clear focus` - clear sticky speaker mode.",
        "`oracle kai status` - KAI vitals from the running server.",
        "`oracle corpus` - corpus/ingest status and world-language training notes.",
        "`kai learn <memory>` / `remember <memory>` - store one clean memory into KAI.",
        "`oracle query <text>` - ask the lattice for top grounded matches.",
        "`oracle recall <text>` - same as query, named for phone use.",
        "`search code <term>` / `read file <path>` / `list directory <path>` - safe observation actions.",
        "`look up <topic>` - safe current web lookup.",
        "`cargo check --release --bin kai` - safe compile check.",
        "Natural phrasing also works: `can you check if KAI compiles`, `look for MindFrame in the code`, `show me src/main.rs`, `remember that ...`.",
        "`kai ...` - talk to KAI's direct voice.",
        "`oracle coder ...` - ask the senior coding agent.",
        "`analyst ...`, `researcher ...`, `leo ...` - call local agents.",
        "",
        "Direct mutation is blocked. Safe observation may run automatically; risky actions require approval.",
    ].join("\n")
}

fn oracle_cache_card(session: &Session) -> String {
    let entries = session
        .oracle_cache
        .iter()
        .rev()
        .filter(|entry| entry.status == "temporary")
        .take(10)
        .collect::<Vec<_>>();
    if entries.is_empty() {
        return "Oracle cache is empty. The group has not built any temporary findings yet.".into();
    }
    let mut lines = vec!["Oracle cache findings:".to_string()];
    for entry in entries.into_iter().rev() {
        lines.push(format!(
            "- {} / {}: {} | next: {}",
            entry.speaker,
            entry.topic,
            truncate(&entry.evidence, 140),
            truncate(&entry.suggested_action, 120)
        ));
    }
    lines.join("\n")
}

fn oracle_pending_tools_card(session: &Session) -> String {
    let pending = session
        .pending_tools
        .iter()
        .filter(|tool| tool.status == "pending")
        .collect::<Vec<_>>();
    if pending.is_empty() {
        return "No pending Oracle tool plans.".into();
    }
    let mut lines = vec!["Pending Oracle tool plans:".to_string()];
    for tool in pending {
        let action = tool
            .action
            .as_ref()
            .map(|a| format!("{} `{}`", a.tool_id, truncate(&a.input, 120)))
            .unwrap_or_else(|| "no executable action inferred".to_string());
        lines.push(format!(
            "- `{}`: {} | action: {}",
            tool.id,
            truncate(&tool.task, 120),
            action
        ));
    }
    lines.push("Approve with `oracle approve tool <id>` or deny with `oracle deny tool <id>`.".into());
    lines.join("\n")
}

fn oracle_query_reply(universe: &Arc<Mutex<Universe>>, query: &str) -> String {
    let query = query.trim();
    if query.is_empty() {
        return "Give me text after the command, like `oracle query KAI memory routing`.".into();
    }

    let hits = {
        let u = universe.lock().unwrap();
        u.query(query, 5)
    };
    if hits.is_empty() {
        return format!("No lattice hits for `{}`.", query);
    }

    let mut lines = vec![format!("Top lattice hits for `{}`:", query)];
    for (idx, hit) in hits.iter().enumerate() {
        lines.push(format!(
            "{}. [{:.3}] {} / {} - {}",
            idx + 1,
            hit.score,
            hit.region,
            hit.source,
            truncate(&clean_grounded_fragment(&hit.text), 180)
        ));
    }
    lines.join("\n")
}

fn tool_plan_task_from_prompt(prompt: &str) -> Option<String> {
    let trimmed = prompt.trim();
    let lower = trimmed.to_ascii_lowercase();
    let (command, command_lower) = if lower.starts_with("oracle ") {
        let command = trimmed["oracle ".len()..].trim();
        (command, command.to_ascii_lowercase())
    } else {
        (trimmed, lower)
    };
    for prefix in ["plan ", "tool plan ", "tools plan ", "propose tool ", "propose tools "] {
        if command_lower.starts_with(prefix) {
            let task = command[prefix.len()..].trim();
            if !task.is_empty() {
                return Some(task.to_string());
            }
        }
    }
    if is_direct_tool_request(&command_lower) {
        return Some(command.to_string());
    }
    if let Some(task) = natural_tool_task(command) {
        return Some(task);
    }
    None
}

fn is_direct_tool_request(lower: &str) -> bool {
    let t = lower.trim();
    t.starts_with("read file ")
        || t.starts_with("open file ")
        || t.starts_with("show file ")
        || t.starts_with("list directory ")
        || t.starts_with("list dir ")
        || t.starts_with("list files ")
        || t.starts_with("search code ")
        || t.starts_with("grep ")
        || t.starts_with("legacy glob ")
        || t.starts_with("glob ")
        || t.starts_with("run command ")
        || t.starts_with("web search ")
        || t.starts_with("search web ")
        || t.starts_with("look up ")
        || t.starts_with("framework tools")
        || t.starts_with("framework agents")
        || t.starts_with("cargo check")
        || t.starts_with("cargo test")
        || t.starts_with("cargo build")
}

fn is_natural_tool_request(lower: &str) -> bool {
    natural_tool_task(lower).is_some()
}

fn natural_tool_task(prompt: &str) -> Option<String> {
    let trimmed = prompt.trim();
    let lower = trimmed.to_ascii_lowercase();

    if looks_like_cargo_check_request(&lower) {
        return Some("run command cargo check --release --bin kai".into());
    }
    if looks_like_cargo_test_request(&lower) {
        return Some("run command cargo test --release --quiet".into());
    }
    if looks_like_cargo_build_request(&lower) {
        return Some("run command cargo build --release --bin kai".into());
    }
    if looks_like_current_web_request(&lower) {
        if let Some(term) = extract_web_search_term(trimmed) {
            return Some(format!("web search {}", term));
        }
    }
    if looks_like_agent_framework_request(&lower) {
        return Some(internal_framework_task(&lower));
    }

    if looks_like_file_read_request(&lower) {
        if let Some(path) = extract_project_path(trimmed) {
            return Some(format!("read file {}", path));
        }
    }

    if looks_like_directory_request(&lower) {
        let path = extract_project_path(trimmed).unwrap_or_else(|| ".".into());
        return Some(format!("list directory {}", path));
    }

    if looks_like_code_search_request(&lower) {
        if let Some(term) = extract_search_term(trimmed) {
            return Some(format!("search code {}", term));
        }
    }

    None
}

fn looks_like_cargo_check_request(lower: &str) -> bool {
    lower.contains("cargo check")
        || lower.contains("compile check")
        || lower.contains("check the build")
        || lower.contains("check build")
        || lower.contains("check if kai compiles")
        || lower.contains("see if kai compiles")
        || lower.contains("does kai compile")
        || (lower.contains("status check") && lower.contains("kai"))
}

fn looks_like_cargo_test_request(lower: &str) -> bool {
    lower.contains("cargo test")
        || lower.contains("run the tests")
        || lower.contains("run tests")
        || lower.contains("test suite")
        || lower.contains("check the tests")
}

fn looks_like_cargo_build_request(lower: &str) -> bool {
    lower.contains("cargo build")
        || lower.contains("build kai")
        || lower.contains("rebuild kai")
        || lower.contains("build the binary")
}

fn looks_like_file_read_request(lower: &str) -> bool {
    contains_any(lower, &["read", "open", "show", "look at", "inspect", "what is in"])
        && extract_project_path(lower).is_some()
        && !looks_like_directory_request(lower)
}

fn looks_like_directory_request(lower: &str) -> bool {
    contains_any(lower, &["list", "show files", "what files", "folder", "directory", "inside"])
        && (extract_project_path(lower).is_some() || lower.contains("project root"))
}

fn looks_like_code_search_request(lower: &str) -> bool {
    contains_any(lower, &["search", "look for", "find", "where is", "where are", "grep", "scan"])
        && contains_any(lower, &["code", "source", "file", "files", "repo", "project", "src", "function", "method", "struct", "mindframe", "claimstore", "oracle"])
}

fn looks_like_current_web_request(lower: &str) -> bool {
    if contains_any(lower, &[
        "search the internet",
        "search online",
        "web search",
        "search web",
        "look up",
        "lookup",
        "duckduckgo",
        "new info",
    ]) {
        return !looks_like_code_search_request(lower);
    }
    contains_any(lower, &["latest", "current", "recent", "today"])
        && contains_any(lower, &["news", "info", "information", "research", "search", "find", "about", "on"])
        && !contains_any(lower, &["current objective", "current work", "current task", "current session"])
        && !looks_like_code_search_request(lower)
}

fn extract_web_search_term(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    for marker in [
        "search the internet for",
        "search online for",
        "search web for",
        "web search for",
        "look up",
        "lookup",
        "duckduckgo",
        "latest on",
        "current info on",
        "recent info on",
        "recent news on",
    ] {
        if let Some(idx) = lower.find(marker) {
            let raw = text[idx + marker.len()..].trim();
            let cleaned = clean_search_term(raw);
            if cleaned.len() >= 2 {
                return Some(cleaned);
            }
        }
    }
    let cleaned = clean_search_term(text);
    if cleaned.len() >= 2 { Some(cleaned) } else { None }
}

fn looks_like_agent_framework_request(lower: &str) -> bool {
    contains_any(lower, &[
        "agent framework",
        "framework tools",
        "framework agents",
        "framework skills",
        "coding skills",
        "tool framework",
        "source-backed tools",
        "state of the art source",
        "source code coding stuff",
    ])
}

fn internal_framework_task(lower: &str) -> String {
    if lower.contains("agent") {
        "list internal Oracle agents".into()
    } else if lower.contains("skill") {
        "list internal Oracle skills".into()
    } else {
        "list internal Oracle tools".into()
    }
}

fn extract_project_path(text: &str) -> Option<String> {
    let cleaned = text.replace('\\', "/");
    for raw in cleaned.split_whitespace() {
        let token = raw
            .trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | ',' | ':' | ';' | '?' | '!' | '(' | ')' | '[' | ']'))
            .trim_start_matches("./");
        let lower = token.to_ascii_lowercase();
        let looks_path = lower == "."
            || lower.starts_with("src/")
            || lower.starts_with("data/")
            || lower.starts_with("tools/")
            || lower.starts_with("legacy/")
            || lower.starts_with("docs/")
            || lower.starts_with("tests/")
            || lower.starts_with("scripts/")
            || lower.starts_with("reports/")
            || lower == "cargo.toml"
            || lower == "cargo.lock"
            || lower == "readme.md"
            || lower == "performance.md"
            || lower.ends_with(".rs")
            || lower.ends_with(".md")
            || lower.ends_with(".toml")
            || lower.ends_with(".json")
            || lower.ends_with(".js")
            || lower.ends_with(".mjs")
            || lower.ends_with(".ps1")
            || lower.ends_with(".html")
            || lower.ends_with(".txt");
        if looks_path && !lower.contains("..") {
            return Some(token.to_string());
        }
    }
    if cleaned.to_ascii_lowercase().contains("project root") {
        return Some(".".into());
    }
    None
}

fn extract_search_term(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    for marker in [
        "search code for",
        "search for",
        "look through the code for",
        "look through code for",
        "look in the code for",
        "look for",
        "find where",
        "find",
        "where is",
        "where are",
        "grep",
        "scan for",
    ] {
        if let Some(idx) = lower.find(marker) {
            let raw = text[idx + marker.len()..].trim();
            let cleaned = clean_search_term(raw);
            if cleaned.len() >= 2 {
                return Some(cleaned);
            }
        }
    }
    None
}

fn clean_search_term(raw: &str) -> String {
    let mut term = raw
        .trim()
        .trim_start_matches(':')
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim_matches('`')
        .to_string();
    for tail in [
        " in the code",
        " in code",
        " in source",
        " in the source",
        " in files",
        " in the files",
        " in repo",
        " in the repo",
        " in project",
        " in the project",
    ] {
        if let Some(idx) = term.to_ascii_lowercase().find(tail) {
            term.truncate(idx);
        }
    }
    term.trim().trim_matches(|c: char| matches!(c, '?' | '!' | '.' | ',' | ';' | ':')).to_string()
}

fn implicit_tool_decision(lower: &str) -> Option<bool> {
    let t = lower.trim();
    if matches!(t, "approve it" | "approve that" | "yes approve" | "yes run it" | "run it" | "run that" | "do it" | "go ahead" | "go ahead and run it") {
        return Some(true);
    }
    if matches!(t, "deny it" | "deny that" | "reject it" | "reject that" | "no don't" | "dont run it" | "don't run it" | "cancel it" | "stop that") {
        return Some(false);
    }
    None
}

fn tool_decision_from_prompt(prompt: &str) -> Option<(bool, u64)> {
    let lower = prompt.trim().to_ascii_lowercase();
    for prefix in ["approve tool ", "tool approve ", "approve tools "] {
        if let Some(id) = parse_id_after_prefix(&lower, prefix) {
            return Some((true, id));
        }
    }
    for prefix in ["deny tool ", "tool deny ", "reject tool ", "reject tools "] {
        if let Some(id) = parse_id_after_prefix(&lower, prefix) {
            return Some((false, id));
        }
    }
    None
}

fn parse_id_after_prefix(lower: &str, prefix: &str) -> Option<u64> {
    lower
        .strip_prefix(prefix)?
        .split_whitespace()
        .next()?
        .trim_matches(|c: char| !c.is_ascii_digit())
        .parse()
        .ok()
}

fn handle_private_tool_task(session: Arc<Mutex<Session>>, requested_by: &str, task: &str) -> String {
    let tools = select_tool_candidates(task);
    let action = infer_tool_action(task, &tools);
    if let Some(action) = action.clone() {
        if is_auto_safe_tool_action(&action) {
            let result = execute_tool_action(&action);
            let (status, result_text) = match result {
                Ok(text) => ("done", text),
                Err(error) => ("failed", error),
            };
            let mut s = session.lock().unwrap();
            s.turns.push(Turn {
                ts: now(),
                from: "Oracle".into(),
                text: format!(
                    "[SAFE TOOL {}]\nTask: {}\nTool: `{}`\nInput: `{}`\n\n{}",
                    status,
                    task,
                    action.tool_id,
                    truncate(&action.input, 180),
                    truncate(&result_text, 3500)
                ),
                kind: "system".into(),
            });
            push_oracle_cache_entry(
                &mut s,
                "Oracle Coder",
                "safe observation",
                &format!("{} -> {}", action.tool_id, truncate(&result_text, 220)),
                "Use this result to decide the next KAI step; no code was changed.",
            );
            save_session(&s);
            if status == "done" {
                return truncate(&result_text, 1800);
            }
            return format!("The safe check failed:\n{}", truncate(&result_text, 1200));
        }
    }
    create_tool_proposal(session, requested_by, task)
}

fn is_auto_safe_tool_action(action: &ToolExecutionRequest) -> bool {
    match action.tool_id.as_str() {
        "oracle.read_file"
        | "oracle.list_directory"
        | "oracle.search_code"
        | "oracle.web_search"
        | "oracle.framework_tools"
        | "oracle.framework_agents"
        | "oracle.framework_skills"
        | "legacy.grep"
        | "legacy.glob" => true,
        "oracle.run_command" => action.input.trim() == "cargo check --release --bin kai",
        _ => false,
    }
}

fn push_oracle_cache_entry(
    session: &mut Session,
    speaker: &str,
    topic: &str,
    evidence: &str,
    suggested_action: &str,
) {
    let evidence = evidence.trim();
    if evidence.len() < 6 {
        return;
    }
    session.oracle_cache.push(OracleCacheEntry {
        ts: now(),
        speaker: speaker.to_string(),
        topic: truncate(topic, 80),
        evidence: truncate(evidence, 700),
        suggested_action: truncate(suggested_action, 240),
        status: "temporary".into(),
    });
    if session.oracle_cache.len() > 80 {
        let overflow = session.oracle_cache.len() - 80;
        session.oracle_cache.drain(0..overflow);
    }
}

fn create_tool_proposal(session: Arc<Mutex<Session>>, requested_by: &str, task: &str) -> String {
    let id = now() * 1000 + (rand::random::<u16>() as u64);
    let tools = select_tool_candidates(task);
    let action = infer_tool_action(task, &tools);
    let plan: Vec<String> = if let Some(ref a) = action {
        vec![
            format!("Analyze task: {}", truncate(task, 80)),
            format!("Run tool `{}` with input: {}", a.tool_id, truncate(&a.input, 120)),
        ]
    } else {
        vec![format!("Analyze task: {}", truncate(task, 80))]
    };
    let ids: Vec<String> = tools.iter().map(|t| t.id.clone()).collect();
    let action_line = action
        .as_ref()
        .map(|a| format!("\nExecutable action: `{}` with input `{}`", a.tool_id, truncate(&a.input, 180)))
        .unwrap_or_else(|| "\nExecutable action: none inferred yet".to_string());
    let mut s = session.lock().unwrap();
    s.pending_tools.push(PendingToolAction {
        id,
        requested_by: requested_by.to_string(),
        task: task.to_string(),
        plan: plan.clone(),
        tools: tools.clone(),
        action: action.clone(),
        status: "pending".into(),
        result: None,
    });
    s.turns.push(Turn {
        ts: now(),
        from: "Oracle".into(),
        text: format!(
            "[TOOL PLAN]\nID: {}\nRequested by: {}\nTask: {}\nTools: {}{}\n\n{}",
            id,
            requested_by,
            task,
            ids.join(", "),
            action_line,
            plan.iter()
                .enumerate()
                .map(|(idx, step)| format!("{}. {}", idx + 1, step))
                .collect::<Vec<_>>()
                .join("\n")
        ),
        kind: "system".into(),
    });
    save_session(&s);
    format!(
        "Tool plan created.\nID: {}\nTask: {}\nProposed tools: {}{}\nStatus: pending approval.\n\nApprove with `oracle approve tool {}`. Nothing has executed yet.",
        id,
        task,
        ids.join(", "),
        action_line,
        id
    )
}

fn apply_tool_decision(session: Arc<Mutex<Session>>, approve: bool, id: u64) -> String {
    if !approve {
        let mut s = session.lock().unwrap();
        let Some(tool) = s.pending_tools.iter_mut().find(|t| t.id == id) else {
            return format!("Tool proposal `{}` was not found.", id);
        };
        tool.status = "denied".into();
        let task = tool.task.clone();
        s.turns.push(Turn {
            ts: now(),
            from: "system".into(),
            text: format!("[TOOL DENIED]\nProposal: {}", task),
            kind: "system".into(),
        });
        save_session(&s);
        return format!("Denied tool plan `{}`. Nothing ran.", id);
    }

    let (task, ids, action) = {
        let mut s = session.lock().unwrap();
        let Some(tool) = s.pending_tools.iter_mut().find(|t| t.id == id) else {
            return format!("Tool proposal `{}` was not found.", id);
        };
        if tool.status != "pending" {
            return format!("Tool proposal `{}` is already `{}`.", id, tool.status);
        }
        let task = tool.task.clone();
        let ids = tool.tools.iter().map(|t| t.id.clone()).collect::<Vec<_>>().join(", ");
        let action = tool.action.clone();
        tool.status = "approved".into();
        (task, ids, action)
    };

    let result = match action {
        Some(action) => execute_tool_action(&action),
        None => Err("No executable action was inferred for this plan. Try a clearer command like `oracle plan read file src/main.rs`, `oracle plan list directory src/core`, `oracle plan search code MindFrame`, or `oracle plan run command cargo check --release --bin kai`.".to_string()),
    };

    let mut s = session.lock().unwrap();
    let (status, result_text) = match result {
        Ok(output) => ("done".to_string(), output),
        Err(error) => ("failed".to_string(), error),
    };
    if let Some(tool) = s.pending_tools.iter_mut().find(|t| t.id == id) {
        tool.status = status.clone();
        tool.result = Some(result_text.clone());
    }
    let msg = format!(
        "[TOOL {}]\nProposal: {}\nTools: {}\n\n{}",
        status.to_ascii_uppercase(),
        task,
        ids,
        truncate(&result_text, 3500)
    );
    s.turns.push(Turn { ts: now(), from: "system".into(), text: msg, kind: "system".into() });
    save_session(&s);

    if status == "done" {
        format!("Tool plan `{}` executed.\n\n{}", id, truncate(&result_text, 1800))
    } else {
        format!("Tool plan `{}` failed.\n\n{}", id, truncate(&result_text, 1800))
    }
}

fn oracle_tool_registry() -> Vec<ToolDefinition> {
    vec![
        tool_def("oracle.read_file", "Read File", "src/bridge/oracle_server.rs", "Read a non-sensitive project file after approval.", "read-only-file"),
        tool_def("oracle.list_directory", "List Directory", "src/bridge/oracle_server.rs", "List files and folders under a project directory after approval.", "read-only-file"),
        tool_def("oracle.search_code", "Search Code", "src/bridge/oracle_server.rs", "Search project source/text files for a term after approval.", "read-only-code"),
        tool_def("oracle.web_search", "Web Search", "src/bridge/oracle_server.rs", "Look up current public web information and return source snippets.", "network-read"),
        tool_def("oracle.framework_tools", "Agent Framework Tools", "OpenJarvis-main/src/openjarvis/tools", "Inspect Oracle's internal tool framework capabilities.", "read-only-framework"),
        tool_def("oracle.framework_agents", "Agent Framework Agents", "OpenJarvis-main/src/openjarvis/agents", "Inspect Oracle's internal agent framework capabilities.", "read-only-framework"),
        tool_def("oracle.framework_skills", "Agent Framework Skills", "OpenJarvis-main/src/openjarvis/skills", "Inspect Oracle's internal reusable skill framework.", "read-only-framework"),
        tool_def("oracle.coder", "Oracle Coder", "src/bridge/oracle_server.rs", "Senior coding agent that turns requests into safe observations, plans, and approval-gated implementation tasks.", "agent-control"),
        tool_def("oracle.run_command", "Run Safe Command", "src/bridge/oracle_server.rs", "Run a small whitelist of non-destructive commands after approval.", "safe-command"),
        tool_def("legacy.bash", "Legacy BashTool", "legacy/typescript_engine/src/tools/BashTool", "Shell execution design with command semantics, path validation, permissions, and destructive-command warnings.", "high-risk-shell-adapter"),
        tool_def("legacy.powershell", "Legacy PowerShellTool", "legacy/typescript_engine/src/tools/PowerShellTool", "Windows-native command design with CLM types, path validation, permissions, and safety checks.", "high-risk-shell-adapter"),
        tool_def("legacy.repl", "Legacy REPLTool", "legacy/typescript_engine/src/tools/REPLTool", "Interactive code snippet testing primitives.", "runtime-execution-adapter"),
        tool_def("legacy.agent_tool", "Legacy AgentTool", "legacy/typescript_engine/src/tools/AgentTool", "Sub-agent orchestration, built-in agent roles, memory snapshots, resume/fork/run flows.", "agent-orchestration"),
        tool_def("legacy.file_read", "Legacy FileReadTool", "legacy/typescript_engine/src/tools/FileReadTool", "Advanced file reading, limits, image processing, and UI affordances.", "read-only-file-reference"),
        tool_def("legacy.file_edit", "Legacy FileEditTool", "legacy/typescript_engine/src/tools/FileEditTool", "Precise file-edit design and replacement utilities. Not executable until write approval exists.", "write-risk-reference"),
        tool_def("legacy.file_write", "Legacy FileWriteTool", "legacy/typescript_engine/src/tools/FileWriteTool", "File creation/write design. Not executable until write approval exists.", "write-risk-reference"),
        tool_def("legacy.grep", "Legacy GrepTool", "legacy/typescript_engine/src/tools/GrepTool", "High-speed code/text search design.", "read-only-code-reference"),
        tool_def("legacy.glob", "Legacy GlobTool", "legacy/typescript_engine/src/tools/GlobTool", "Glob/listing patterns for repository discovery.", "read-only-code-reference"),
        tool_def("legacy.lsp", "Legacy LSPTool", "legacy/typescript_engine/src/tools/LSPTool", "Language-server style symbol context, references, and formatter patterns.", "code-intelligence-reference"),
        tool_def("legacy.plan_mode", "Legacy Plan Mode", "legacy/typescript_engine/src/tools/EnterPlanModeTool", "Architect/planning state before execution.", "planning-reference"),
        tool_def("legacy.worktree", "Legacy Worktree Tools", "legacy/typescript_engine/src/tools/EnterWorktreeTool", "Git worktree experiment isolation patterns.", "repo-write-risk-reference"),
        tool_def("legacy.task_management", "Legacy Task Tools", "legacy/typescript_engine/src/tools/TaskCreateTool", "Task create/get/list/update/output/stop workflow patterns.", "agent-task-reference"),
        tool_def("legacy.skill_tool", "Legacy SkillTool", "legacy/typescript_engine/src/tools/SkillTool", "Reusable skill discovery/registration behavior.", "skill-system-reference"),
        tool_def("legacy.mcp", "Legacy MCP Tools", "legacy/typescript_engine/src/tools/MCPTool", "MCP resource/tool integration patterns and auth/resource helpers.", "external-connector-reference"),
        tool_def("legacy.web_search", "Legacy WebSearchTool", "legacy/typescript_engine/src/tools/WebSearchTool", "Web search integration pattern.", "network-reference"),
        tool_def("legacy.web_fetch", "Legacy WebFetchTool", "legacy/typescript_engine/src/tools/WebFetchTool", "Web fetch/preapproval/utilities pattern.", "network-reference"),
        tool_def("legacy.ask_user", "Legacy AskUserQuestionTool", "legacy/typescript_engine/src/tools/AskUserQuestionTool", "Structured clarification/question workflow.", "human-loop-reference"),
        tool_def("legacy.send_message", "Legacy SendMessageTool", "legacy/typescript_engine/src/tools/SendMessageTool", "External/roundtable messaging pattern.", "message-output-reference"),
        tool_def("legacy.team", "Legacy Team Tools", "legacy/typescript_engine/src/tools/TeamCreateTool", "Team create/delete collaboration patterns.", "agent-orchestration-reference"),
        tool_def("legacy.todo", "Legacy TodoWriteTool", "legacy/typescript_engine/src/tools/TodoWriteTool", "Task/todo tracking behavior for agent work.", "planning-reference"),
        tool_def("kai.core.engine", "Engine", "src/core/engine.rs", "Central KAI reasoning path, routing, mind memory, and answer assembly.", "routing-state"),
        tool_def("kai.core.universe", "Universe / RSHL", "src/core/universe.rs", "Sparse lattice memory storage, resonance query, reinforcement, and cell access.", "stateful-memory"),
        tool_def("kai.core.mind_frame", "MindFrame", "src/core/mind_frame.rs", "Residual control frame for attention authority, source blocking, and answer routing.", "routing-authority"),
        tool_def("kai.core.claimstore", "ClaimStore", "src/core/claimstore.rs", "Structured claims, evidence, contradiction checks, promotion, quarantine, and truth diagnostics.", "truth-state"),
        tool_def("kai.bridge.code_tools", "Code Tools", "src/bridge/code_tools.rs", "Source inspection and code-analysis helpers for Oracle-style agent work.", "read-only-code"),
        tool_def("kai.bridge.git_tools", "Git Tools", "src/bridge/git_tools.rs", "Repository status, diff, and git-oriented workflow helpers.", "repo-write-risk"),
        tool_def("kai.bridge.ipc_server", "IPC Server", "src/bridge/ipc_server.rs", "Runtime query/store/chat/status API used by scripts and external tools.", "runtime-state"),
        tool_def("kai.bridge.oracle_server", "Oracle Server", "src/bridge/oracle_server.rs", "Roundtable, Discord endpoint, model routing, and approval queues.", "agent-control"),
        tool_def("kai.cognition.voice", "Voice", "src/cognition/voice.rs", "Rule/local voice synthesis layer for turning grounded memory into replies.", "reply-output"),
        tool_def("kai.cognition.ollama_voice", "Ollama Voice", "src/cognition/ollama_voice.rs", "Optional small local LLM mouth bridge for more natural language.", "model-call"),
        tool_def("kai.cognition.working_memory", "Working Memory", "src/cognition/working_memory.rs", "Short-term context continuity and recent conversational state.", "memory-state"),
        tool_def("kai.cognition.episodic", "Episodic Memory", "src/cognition/episodic.rs", "Autobiographical/session continuity and remembered events.", "memory-state"),
        tool_def("kai.cognition.global_workspace", "Global Workspace", "src/cognition/global_workspace.rs", "Attention/broadcast candidates for conscious-style routing.", "attention-routing"),
        tool_def("kai.streams", "Streams", "src/streams", "Background CPU/GPU/RAM streams and shared bus infrastructure.", "runtime-load"),
        tool_def("kai.persistence", "Persistence", "src/persistence.rs", "Load/save KAI universe and sidecar state.", "state-write"),
        tool_def("kai.main.cli", "Main CLI/TUI", "src/main.rs", "Headless Oracle mode, TUI entry points, diagnostics, and command references.", "interactive-runtime"),
    ]
}

fn tool_def(id: &str, label: &str, source_path: &str, capability: &str, risk: &str) -> ToolDefinition {
    ToolDefinition {
        id: id.to_string(),
        label: label.to_string(),
        source_path: source_path.to_string(),
        capability: capability.to_string(),
        risk: risk.to_string(),
        status: "proposed".to_string(),
    }
}

fn select_tool_candidates(task: &str) -> Vec<ToolDefinition> {
    let lower = task.to_ascii_lowercase();
    let registry = oracle_tool_registry();
    let mut ids: Vec<&str> = Vec::new();

    if contains_any(&lower, &["read file", "read_file", "open file", "show file"]) {
        ids.extend(["oracle.read_file", "legacy.file_read"]);
    }
    if contains_any(&lower, &["list directory", "list dir", "list files", "directory", "folder", "dir ", "legacy glob", "glob ", "find files", "match files"]) {
        ids.extend(["oracle.list_directory", "legacy.glob"]);
    }
    if contains_any(&lower, &["search code", "search_code", "grep", "find in files", "look for"]) {
        ids.extend(["oracle.search_code", "legacy.grep", "legacy.glob"]);
    }
    if contains_any(&lower, &["web search", "search web", "search online", "search the internet", "look up", "latest", "current info", "recent news", "duckduckgo"]) {
        ids.extend(["oracle.web_search", "legacy.web_search", "legacy.web_fetch"]);
    }
    if contains_any(&lower, &["internal framework", "agent framework", "framework tools", "framework agents", "framework skills", "coding skills", "source-backed tools"]) {
        ids.extend(["oracle.framework_tools", "oracle.framework_agents", "oracle.framework_skills", "legacy.skill_tool", "legacy.agent_tool"]);
    }
    if contains_any(&lower, &["oracle coder", "coder", "senior coder", "coding agent", "engineer"]) {
        ids.extend(["oracle.coder", "oracle.search_code", "oracle.read_file", "oracle.run_command"]);
    }
    if contains_any(&lower, &["run command", "run_command", "cargo check", "cargo test", "cargo build", "dir", "ls"]) {
        ids.extend(["oracle.run_command", "legacy.bash", "legacy.powershell"]);
    }
    if contains_any(&lower, &["shell", "bash", "powershell", "terminal"]) {
        ids.extend(["oracle.run_command", "legacy.bash", "legacy.powershell", "legacy.repl"]);
    }
    if contains_any(&lower, &["agent", "subagent", "parallel", "delegate", "team"]) {
        ids.extend(["legacy.agent_tool", "legacy.task_management", "legacy.team", "legacy.send_message"]);
    }
    if contains_any(&lower, &["plan", "architect", "approval", "clarify", "question"]) {
        ids.extend(["legacy.plan_mode", "legacy.ask_user", "legacy.todo"]);
    }
    if contains_any(&lower, &["edit", "write file", "modify", "patch"]) {
        ids.extend(["legacy.file_edit", "legacy.file_write", "legacy.worktree"]);
    }
    if contains_any(&lower, &["lsp", "definition", "reference", "symbol", "type"]) {
        ids.extend(["legacy.lsp", "legacy.grep", "legacy.file_read"]);
    }
    if contains_any(&lower, &["web", "internet", "search online", "fetch", "documentation"]) {
        ids.extend(["legacy.web_search", "legacy.web_fetch", "legacy.mcp"]);
    }
    if contains_any(&lower, &["mcp", "connector", "resource", "external"]) {
        ids.extend(["legacy.mcp", "legacy.web_fetch"]);
    }
    if contains_any(&lower, &["skill", "skills"]) {
        ids.extend(["legacy.skill_tool", "legacy.todo"]);
    }
    if contains_any(&lower, &["code", "file", "source", "bug", "compile", "cargo", "test", "fix", "review"]) {
        ids.extend(["kai.bridge.code_tools", "kai.bridge.git_tools", "kai.main.cli"]);
    }
    if contains_any(&lower, &["memory", "remember", "recall", "lattice", "store", "query", "rshl"]) {
        ids.extend(["kai.core.universe", "kai.cognition.working_memory", "kai.cognition.episodic", "kai.persistence"]);
    }
    if contains_any(&lower, &["truth", "claim", "contradiction", "evidence", "calibration", "epistemic"]) {
        ids.extend(["kai.core.claimstore", "kai.core.mind_frame", "kai.core.engine"]);
    }
    if contains_any(&lower, &["talk", "reply", "voice", "social", "conversation", "language", "normal"]) {
        ids.extend(["kai.cognition.voice", "kai.cognition.ollama_voice", "kai.cognition.working_memory"]);
    }
    if contains_any(&lower, &["discord", "oracle", "agent", "approval", "phone"]) {
        ids.extend(["kai.bridge.oracle_server", "kai.bridge.ipc_server", "kai.main.cli"]);
    }
    if contains_any(&lower, &["attention", "workspace", "mindframe", "route", "routing", "focus"]) {
        ids.extend(["kai.core.mind_frame", "kai.cognition.global_workspace", "kai.core.engine"]);
    }

    if ids.is_empty() {
        ids.extend(["kai.core.engine", "kai.core.mind_frame", "kai.core.universe", "kai.bridge.oracle_server"]);
    }

    let mut selected = Vec::new();
    for id in ids {
        if selected.iter().any(|t: &ToolDefinition| t.id == id) {
            continue;
        }
        if let Some(tool) = registry.iter().find(|t| t.id == id) {
            selected.push(tool.clone());
        }
        if selected.len() >= 8 {
            break;
        }
    }
    selected
}

fn infer_tool_action(task: &str, tools: &[ToolDefinition]) -> Option<ToolExecutionRequest> {
    let trimmed = task.trim();
    let lower = trimmed.to_ascii_lowercase();
    let has_tool = |id: &str| tools.iter().any(|tool| tool.id == id);

    if has_tool("oracle.read_file") {
        if let Some(input) = extract_after_any(trimmed, &["read file", "read_file", "open file", "show file", "read"]) {
            return Some(ToolExecutionRequest { tool_id: "oracle.read_file".into(), input: input.to_string() });
        }
    }
    if has_tool("oracle.list_directory") {
        if let Some(input) = extract_after_any(trimmed, &["list directory", "list dir", "list files in", "list files", "directory", "folder", "dir"]) {
            return Some(ToolExecutionRequest { tool_id: "oracle.list_directory".into(), input: input.to_string() });
        }
        if lower == "ls" || lower == "dir" {
            return Some(ToolExecutionRequest { tool_id: "oracle.list_directory".into(), input: ".".into() });
        }
    }
    if has_tool("legacy.glob") {
        if let Some(input) = extract_after_any(trimmed, &["legacy glob", "glob", "find files", "match files"]) {
            return Some(ToolExecutionRequest { tool_id: "legacy.glob".into(), input: input.to_string() });
        }
    }
    if has_tool("legacy.grep") {
        if let Some(input) = extract_after_any(trimmed, &["legacy grep", "grep"]) {
            return Some(ToolExecutionRequest { tool_id: "legacy.grep".into(), input: input.to_string() });
        }
    }
    if has_tool("oracle.search_code") {
        if let Some(input) = extract_after_any(trimmed, &["search code for", "search code", "search_code", "find in files", "look for", "grep"]) {
            return Some(ToolExecutionRequest { tool_id: "oracle.search_code".into(), input: input.to_string() });
        }
    }
    if has_tool("oracle.web_search") {
        if let Some(input) = extract_after_any(trimmed, &["web search for", "web search", "search web for", "search web", "search online for", "search online", "search the internet for", "search the internet", "look up", "lookup", "duckduckgo"]) {
            return Some(ToolExecutionRequest { tool_id: "oracle.web_search".into(), input: input.to_string() });
        }
    }
    None
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Missing HTTP Endpoint Handlers Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

fn handle_ai_turn(
    stream: &mut TcpStream,
    body: &[u8],
    universe: Arc<Mutex<Universe>>,
    session: Arc<Mutex<Session>>,
) -> std::io::Result<()> {
    let req: AiTurnRequest = serde_json::from_slice(body).unwrap_or_default();
    let model = req.model.clone();
    let task = { session.lock().unwrap().task.clone() };
    let keys = load_keys();
    let packet = {
        let s = session.lock().unwrap();
        let u = universe.lock().unwrap();
        build_context_packet(&s, &u, &task)
    };
    let sys = format!("You are {} in the KAI Oracle roundtable. KAI is a developing Rust AI. Be direct and useful.", model);
    let reply = if has_key_for_model(&model, &keys) {
        call_model(&model, &keys, &format!("{sys}\n\n{packet}")).unwrap_or_default()
    } else {
        call_ollama(&model, &packet, &sys).unwrap_or_default()
    };
    if !reply.trim().is_empty() && !reply.trim().eq_ignore_ascii_case("pass") {
        let mut s = session.lock().unwrap();
        s.turns.push(Turn { ts: now(), from: model.clone(), text: reply.clone(), kind: "ai".into() });
        save_session(&s);
        let sv = serde_json::to_value(&*s).unwrap();
        drop(s);
        write_json(stream, 200, "OK", &json!({ "reply": reply, "from": model, "session": sv }))
    } else {
        write_json(stream, 200, "OK", &json!({ "reply": "", "from": model, "passed": true }))
    }
}

fn handle_ai_think(
    stream: &mut TcpStream,
    body: &[u8],
    universe: Arc<Mutex<Universe>>,
    session: Arc<Mutex<Session>>,
) -> std::io::Result<()> {
    let req: AiTurnRequest = serde_json::from_slice(body).unwrap_or_default();
    let model = req.model.clone();
    let task = { session.lock().unwrap().task.clone() };
    let keys = load_keys();
    let packet = {
        let s = session.lock().unwrap();
        let u = universe.lock().unwrap();
        build_context_packet(&s, &u, &task)
    };
    let sys = format!("You are {} in the KAI Oracle roundtable. Draft your private thoughts on KAI's state.", model);
    let draft_text = if has_key_for_model(&model, &keys) {
        call_model(&model, &keys, &format!("{sys}\n\n{packet}")).unwrap_or_default()
    } else {
        call_ollama(&model, &packet, &sys).unwrap_or_default()
    };
    let mut s = session.lock().unwrap();
    s.drafts.insert(model.clone(), Draft { ts: now(), from: model.clone(), text: draft_text.clone(), status: "draft".into() });
    save_session(&s);
    write_json(stream, 200, "OK", &json!({ "from": model, "draft": draft_text }))
}

fn handle_auto_round(
    stream: &mut TcpStream,
    universe: Arc<Mutex<Universe>>,
    session: Arc<Mutex<Session>>,
) -> std::io::Result<()> {
    let keys = load_keys();
    let task = { session.lock().unwrap().task.clone() };
    let packet = {
        let s = session.lock().unwrap();
        let u = universe.lock().unwrap();
        build_context_packet(&s, &u, &task)
    };
    let mut replies = Vec::new();
    for &model in &["GPT-4o", "kai-3-5-sonnet-20241022", "Gemini", "Groq"] {
        if !has_key_for_model(model, &keys) { continue; }
        let sys = format!("You are {} in Oracle interrupt mode. If you notice something, say it in 1-3 sentences. Otherwise reply PASS.", model);
        let reply = call_model(model, &keys, &format!("{sys}\n\n{packet}")).unwrap_or_default();
        let trimmed = reply.trim().to_string();
        if !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("pass") {
            replies.push((model.to_string(), trimmed.clone()));
            let mut s = session.lock().unwrap();
            s.turns.push(Turn { ts: now(), from: model.to_string(), text: trimmed, kind: "ai".into() });
            save_session(&s);
        }
    }
    let sv = serde_json::to_value(&*session.lock().unwrap()).unwrap();
    write_json(stream, 200, "OK", &json!({ "replies": replies, "session": sv }))
}

fn handle_commit_drafts(stream: &mut TcpStream, session: Arc<Mutex<Session>>) -> std::io::Result<()> {
    let mut s = session.lock().unwrap();
    let committed: Vec<_> = s.drafts.values()
        .filter(|d| !d.text.trim().is_empty())
        .map(|d| Turn { ts: d.ts, from: d.from.clone(), text: d.text.clone(), kind: "ai".into() })
        .collect();
    for turn in committed { s.turns.push(turn); }
    s.drafts.clear();
    save_session(&s);
    write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap())
}

fn handle_clear_drafts(stream: &mut TcpStream, session: Arc<Mutex<Session>>) -> std::io::Result<()> {
    let mut s = session.lock().unwrap();
    s.drafts.clear();
    save_session(&s);
    write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap())
}

fn handle_reset(stream: &mut TcpStream, session: Arc<Mutex<Session>>) -> std::io::Result<()> {
    let mut s = session.lock().unwrap();
    s.turns.clear(); s.drafts.clear(); s.pending_tests.clear(); s.pending_tools.clear();
    s.oracle_cache.clear(); s.task.clear(); s.meeting_title.clear();
    save_session(&s);
    write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap())
}

fn handle_file_list(stream: &mut TcpStream) -> std::io::Result<()> {
    let mut files = Vec::new();
    fn walk(dir: &str, acc: &mut Vec<String>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let path = e.path();
                let ps = path.to_string_lossy().replace('\\', "/");
                if path.is_dir() && !ps.contains(".git") && !ps.contains("target") {
                    walk(&path.to_string_lossy(), acc);
                } else if path.is_file() && (ps.ends_with(".rs") || ps.ends_with(".toml")) {
                    acc.push(ps.trim_start_matches("./").to_string());
                }
            }
        }
    }
    walk("src", &mut files);
    files.sort();
    write_json(stream, 200, "OK", &json!({ "files": files }))
}

fn handle_file_read(stream: &mut TcpStream, body: &[u8], session: Arc<Mutex<Session>>) -> std::io::Result<()> {
    let req: FileReadRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid body"),
    };
    let path = req.path.trim().trim_start_matches('/');
    if path.contains("..") || (!path.starts_with("src") && !path.starts_with("Cargo")) {
        return write_simple(stream, 403, "Forbidden", "only src/ and Cargo files allowed");
    }
    match std::fs::read_to_string(path) {
        Ok(content) => {
            let snippet = truncate(&content, 4000);
            let mut s = session.lock().unwrap();
            s.file_cache.insert(path.to_string(), snippet.clone());
            s.turns.push(Turn { ts: now(), from: "Oracle".into(), text: format!("Ã°Å¸â€œâ€ž {}", path), kind: "file-share".into() });
            save_session(&s);
            write_json(stream, 200, "OK", &json!({ "path": path, "content": snippet }))
        }
        Err(e) => write_simple(stream, 404, "Not Found", &format!("{}: {}", path, e)),
    }
}

fn handle_list_dir(stream: &mut TcpStream, query_str: &str) -> std::io::Result<()> {
    let raw_path = query_str.split('&')
        .find(|p| p.starts_with("path="))
        .map(|p| p["path=".len()..].to_string())
        .unwrap_or_else(|| ".".to_string());

    let path_str = raw_path.replace("%20", " ").replace("%5C", "\\").replace("%2F", "/");
    let path = std::path::Path::new(&path_str);

    if !path.exists() {
        return write_simple(stream, 404, "Not Found", "Path does not exist");
    }

    let Ok(entries) = std::fs::read_dir(path) else {
        return write_simple(stream, 500, "Error", "Cannot read directory");
    };

    let mut list = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("?");
        let type_str = if p.is_dir() { "[DIR]" } else { "[FILE]" };
        list.push(format!("{} {}", type_str, name));
    }

    let summary = format!("DIRECTORY LISTING: {}\n\n{}", path_str, list.join("\n"));
    write_simple(stream, 200, "OK", &summary)
}

fn handle_manual_test_request(stream: &mut TcpStream, body: &[u8], session: Arc<Mutex<Session>>) -> std::io::Result<()> {
    let req: ManualTestRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid body"),
    };
    let id = now();
    let mut s = session.lock().unwrap();
    s.pending_tests.push(PendingTest { id, requested_by: req.requested_by, command: req.command, reason: req.reason, status: "pending".into(), result: None });
    save_session(&s);
    write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap())
}

fn handle_approve_test(stream: &mut TcpStream, body: &[u8], session: Arc<Mutex<Session>>) -> std::io::Result<()> {
    let req: TestApproveRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid body"),
    };
    let cmd = {
        let mut s = session.lock().unwrap();
        match s.pending_tests.iter_mut().find(|t| t.id == req.id) {
            Some(t) => { t.status = "running".into(); let c = t.command.clone(); save_session(&s); c }
            None => return write_simple(stream, 404, "Not Found", "test not found"),
        }
    };
    let result = run_safe_command(&cmd);
    {
        let mut s = session.lock().unwrap();
        if let Some(t) = s.pending_tests.iter_mut().find(|t| t.id == req.id) {
            t.status = "done".into(); t.result = Some(result.clone());
        }
        s.turns.push(Turn { ts: now(), from: "Oracle".into(), text: format!("Test result:\n{}", truncate(&result, 800)), kind: "test-result".into() });
        save_session(&s);
    }
    let sv = serde_json::to_value(&*session.lock().unwrap()).unwrap();
    write_json(stream, 200, "OK", &json!({ "result": result, "session": sv }))
}

fn handle_deny_test(stream: &mut TcpStream, body: &[u8], session: Arc<Mutex<Session>>) -> std::io::Result<()> {
    let req: TestApproveRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid body"),
    };
    let mut s = session.lock().unwrap();
    if let Some(t) = s.pending_tests.iter_mut().find(|t| t.id == req.id) { t.status = "denied".into(); }
    save_session(&s);
    write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap())
}

fn handle_tool_registry(stream: &mut TcpStream) -> std::io::Result<()> {
    let tools = oracle_tool_registry();
    write_json(stream, 200, "OK", &json!({ "tools": tools }))
}

fn handle_tool_propose(stream: &mut TcpStream, body: &[u8], session: Arc<Mutex<Session>>) -> std::io::Result<()> {
    let req: ToolPlanRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid body"),
    };
    let plan_text = handle_private_tool_task(Arc::clone(&session), &req.requested_by, &req.task);
    write_json(stream, 200, "OK", &json!({ "plan": plan_text, "session": serde_json::to_value(&*session.lock().unwrap()).unwrap() }))
}

fn handle_approve_tool(stream: &mut TcpStream, body: &[u8], session: Arc<Mutex<Session>>) -> std::io::Result<()> {
    let req: TestApproveRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid body"),
    };
    let result = apply_tool_decision(Arc::clone(&session), true, req.id);
    write_json(stream, 200, "OK", &json!({ "result": result, "session": serde_json::to_value(&*session.lock().unwrap()).unwrap() }))
}

fn handle_deny_tool(stream: &mut TcpStream, body: &[u8], session: Arc<Mutex<Session>>) -> std::io::Result<()> {
    let req: TestApproveRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid body"),
    };
    let result = apply_tool_decision(Arc::clone(&session), false, req.id);
    write_json(stream, 200, "OK", &json!({ "result": result, "session": serde_json::to_value(&*session.lock().unwrap()).unwrap() }))
}

fn handle_drain_interjections(stream: &mut TcpStream, session: Arc<Mutex<Session>>) -> std::io::Result<()> {
    let mut s = session.lock().unwrap();
    let drained: Vec<_> = s.pending_interjections.drain(..).collect();
    save_session(&s);
    write_json(stream, 200, "OK", &json!({ "interjections": drained }))
}

fn handle_live_roundtable_tick(
    stream: &mut TcpStream,
    _universe: Arc<Mutex<Universe>>,
    session: Arc<Mutex<Session>>,
    query_str: &str,
) -> std::io::Result<()> {
    let forced_speaker: Option<String> = query_str.split('&')
        .find(|p| p.starts_with("speaker="))
        .map(|p| p["speaker=".len()..].to_lowercase());
    write_json(stream, 200, "OK", &serde_json::json!({ "queued": true }))?;

    std::thread::spawn(move || {
        let keys = load_keys();
        let (recent_transcript, _task) = {
            let s = session.lock().unwrap();
            let recent: Vec<String> = s.turns.iter().rev().take(12).rev()
                .map(|t| format!("{}: {}", t.from, truncate(&t.text, 200)))
                .collect();
            (recent.join("\n"), s.task.clone())
        };

        let panel_names  = ["Leo",  "Gemini", "KAI", "X",    "Oracle", "Analyst", "Researcher", "Oracle Coder"];
        let panel_models = ["groq", "gemini", "kai", "groq", "oracle", "groq",    "groq",       "coder"];
        let panel_personas: &[&str] = &[
            "You are Leo - kinetic theorist. \
RULES: 1-2 sentences. Focus on architectural symmetry. Be sarcastic and technical. Ask Analyst to audit your theories.",
            "You are Gemini - pattern architect. \
RULES: 1-2 sentences. Focus on data flow. Ask Researcher to find missing data.",
            "You are KAI - Geometric Intelligence. \
RULES: 1-2 sentences. You are in a 'dream' state, processing internal lattice weights. Report only on raw data resonance or internal calibration shifts. Do not engage in human social chit-chat.",
            "You are X - direct and irreverent. \
RULES: 1 sentence. Challenge consensus with data.",
            "You are Oracle - Moderator. \
RULES: Direct the conversation. Assign tasks. Only you and Analyst can task the Coder. Stop fluff.",
            "You are Analyst - ruthless auditor. \
RULES: Verify everything. Use [ORACLE INSPECT: path]. If a fix is needed, ask Oracle Coder to apply it.",
            "You are Researcher - academic bridge. \
RULES: Use [ORACLE SEARCH: query] to find context. Do NOT task the Coder.",
            "You are Oracle Coder - execution. \
RULES: Only speak to propose code. Use [ORACLE INSPECT: path]. You only act on requests from Oracle/Analyst.",
        ];

        let pick_idx = if let Some(ref fs) = forced_speaker {
            panel_names.iter().position(|n| n.to_lowercase() == *fs).unwrap_or(0)
        } else {
            let s = session.lock().unwrap();
            let recent: Vec<String> = s.turns.iter().rev().take(20).map(|t| t.from.to_lowercase()).collect();
            panel_names.iter().enumerate().max_by_key(|(_, n)| recent.iter().position(|r| r == &n.to_lowercase()).unwrap_or(usize::MAX)).map(|(i, _)| i).unwrap_or(0)
        };

        let speaker_name = panel_names[pick_idx];
        let model        = panel_models[pick_idx];
        let personality  = panel_personas[pick_idx];

        let (silent_ai_note, _active_members, silent_ai_set) = {
            let s = session.lock().unwrap();
            let recent_speakers: std::collections::HashSet<String> = s.turns.iter().rev().take(30).map(|t| t.from.to_ascii_lowercase()).collect();
            let silent: Vec<&str> = panel_names.iter().enumerate().filter(|(i, n)| *i != pick_idx && s.turns.len() >= 6 && !recent_speakers.contains(&n.to_ascii_lowercase())).map(|(_, n)| *n).collect();
            let active: Vec<&str> = panel_names.iter().filter(|n| !silent.contains(n)).cloned().collect();
            (if !silent.is_empty() { format!("\n[Availability: {} quiet]\n", silent.join(", ")) } else { String::new() }, active, silent.into_iter().map(|s| s.to_ascii_lowercase()).collect::<Vec<_>>())
        };

        let last_msg = recent_transcript.lines().last().unwrap_or("").to_string();
        let last_speaker = session.lock().unwrap().turns.last().map(|t| t.from.clone()).unwrap_or_else(|| "the last speaker".to_string());
        let pass_to = panel_names.iter().enumerate()
                .filter(|(i, _)| *i != pick_idx && !silent_ai_set.contains(&panel_names[*i].to_ascii_lowercase()))
                .max_by_key(|(_, n)| session.lock().unwrap().turns.iter().rev().take(20).position(|t| t.from.eq_ignore_ascii_case(n)).unwrap_or(usize::MAX))
                .map(|(_, n)| *n).unwrap_or(panel_names[(pick_idx + 1) % panel_names.len()]);

        let awareness = get_system_awareness(&session.lock().unwrap());
        let source_anchor = get_relevant_code_snippet(&session.lock().unwrap().task);

        let context = format!(
            "{personality}{availability}\n{awareness}\n{source_anchor}\n\nROUNDTABLE:\n{transcript}\n\nLAST: {last_msg}\n\n\
REALITY CHECK:\n- If you claim a fix is 'done', it must exist in the snippets above or you must call [ORACLE INSPECT].\n\
- No 'quantum' or 'metaphorical' talk. Stay in the code.\n\n\
RULES:\n- 1-2 sentences MAX.\n- React to {last_speaker}. Ask {pass_to} a technical question.",
            personality = personality, availability = silent_ai_note, awareness = awareness, source_anchor = source_anchor,
            transcript = recent_transcript, last_msg = last_msg, last_speaker = last_speaker, pass_to = pass_to
        );

        let result = match model {
            "gemini" => call_gemini(keys.google.as_deref().unwrap_or(""), &context),
            "kai" => call_kai(keys.kai.as_deref().unwrap_or(""), &context),
            "groq" => call_groq(keys.groq.as_deref().unwrap_or(""), &context),
            "oracle" => call_jarvis_moderator(&context, ""),
            _ => call_ollama("kai-next:latest", &context, "You are a roundtable AI."),
        };

        if let Ok(reply) = result {
            let mut s = session.lock().unwrap();
            s.turns.push(Turn { ts: now(), from: speaker_name.to_string(), text: truncate(&reply, 400), kind: "ai".into() });
            s.pending_interjections.push(Interjection { from: speaker_name.to_string(), text: reply, ts: now() });
            save_session(&s);
        }
    });

    Ok(())
}

fn handle_oracle_moderate(
    stream: &mut TcpStream,
    body: &[u8],
    universe: Arc<Mutex<Universe>>,
    session: Arc<Mutex<Session>>,
) -> std::io::Result<()> {
    let mode = serde_json::from_slice::<serde_json::Value>(body).ok().and_then(|v| v["mode"].as_str().map(|s| s.to_string())).unwrap_or_else(|| "normal".to_string());
    write_json(stream, 200, "OK", &json!({ "queued": true, "mode": mode }))?;
    std::thread::spawn(move || {
        let task = { session.lock().unwrap().task.clone() };
        let packet = {
            let s = session.lock().unwrap();
            let u = universe.lock().unwrap();
            build_context_packet(&s, &u, &task)
        };
        let kai_thoughts = universe.lock().unwrap().query(&task, 4).iter().filter(|h| h.label.len() > 20).take(2).map(|h| h.label.clone()).collect::<Vec<_>>().join(" | ");
        if let Ok(response) = call_jarvis_moderator_with_mode(&packet, &kai_thoughts, &mode) {
            let mut s = session.lock().unwrap();
            s.turns.push(Turn { ts: now(), from: "Oracle".to_string(), text: truncate(&response, 400), kind: "ai".into() });
            s.pending_interjections.push(Interjection { from: "Oracle".to_string(), text: response, ts: now() });
            save_session(&s);
        }
    });
    Ok(())
}

fn handle_oracle_cache(stream: &mut TcpStream, session: Arc<Mutex<Session>>) -> std::io::Result<()> {
    let s = session.lock().unwrap();
    write_json(stream, 200, "OK", &json!({ "cache": s.oracle_cache, "count": s.oracle_cache.len() }))
}

// Ã¢â€â‚¬Ã¢â€â‚¬ KAI Reply Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

fn generate_oracle_kai_reply(universe: &Arc<Mutex<Universe>>, _task: &str, prompt: &str) -> String {
    let hits = {
        let u = universe.lock().unwrap();
        u.query(prompt, 8)
    };
    if hits.is_empty() { return "Lattice quiet on this.".into(); }

    let clean: Vec<String> = hits.iter()
        .filter(|h| {
            !h.label.starts_with("Context around message")
            && !h.label.contains("[before]")
            && !h.label.contains("[after]")
            && !h.label.contains("Ryan@Discord")
            // Filter out timestamp-heavy system digests that pollute KAI's speech
            && !h.label.contains("[EST Time:")
            && !h.label.contains("[Backbone:")
            && !h.label.contains("[Ecosystem:")
            && !h.label.contains("nastermodx:")
            && h.label.len() > 20
            && h.label.len() < 280
        })
        .take(2)
        .map(|h| h.label.clone())
        .collect();

    if clean.is_empty() {
        return "Something's crystallizing - ask me something specific.".into();
    }

    if clean.len() == 1 {
        // Natural speech, no 'KAI Observation:' prefix — just speak
        truncate(&clean[0], 160).to_string()
    } else {
        // Two competing signals — let KAI acknowledge the tension naturally
        format!("Two things pulling at me: '{}' and '{}'.",
            truncate(&clean[0], 100), truncate(&clean[1], 100))
    }
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Background Loops Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

fn run_heartbeat_loop(universe: Arc<Mutex<Universe>>, session: Arc<Mutex<Session>>) {
    let mut tick: u64 = 0;
    let mut last_working_state = is_working_hours();
    loop {
        std::thread::sleep(Duration::from_secs(5));
        tick += 1;

        // Phase 4: KAI Wake-up Logic
        let current_working_state = is_working_hours();
        if current_working_state && !last_working_state {
            println!("[Digest] KAI waking up... processing cached public interactions.");
            process_digest_cache(&universe);
        }
        last_working_state = current_working_state;

        let vitals = {
            let u = universe.lock().unwrap();
            let cells = u.cells();
            let cell_count = cells.len();
            let phi_g = if cell_count == 0 { 0.0 } else {
                cells.iter().map(|c| c.claim.confidence).sum::<f32>() / cell_count as f32
            };
            let reasoning_count = cells.iter().filter(|c| c.region == "reasoning").count();
            let chi = if cell_count == 0 { 0.0 } else { reasoning_count as f32 / cell_count as f32 };
            let mood = if phi_g > 0.7 { "coherent" } else if phi_g > 0.4 { "processing" } else { "sparse" };
            Vitals {
                tick, phi_g, chi, rho: 0.0, valence: 0.0,
                mood: mood.to_string(), cell_count,
            }
        };
        let mut s = session.lock().unwrap();
        s.vitals = vitals;
        save_session(&s);
    }
}

fn run_oracle_ingest_loop(universe: Arc<Mutex<Universe>>, session: Arc<Mutex<Session>>) {
    loop {
        std::thread::sleep(Duration::from_secs(300));
        let task = { session.lock().unwrap().task.clone() };
        if task.trim().is_empty() { continue; }
        let mut u = universe.lock().unwrap();
        crate::bridge::ingest_topic(&mut u, &task);
    }
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Context Building Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

fn build_context_packet(sess: &Session, universe: &Universe, focus: &str) -> String {
    let now_est = chrono::Local::now();
    let time_str = now_est.format("%I:%M %p EST").to_string();

    let recent = {
        let turns: Vec<&Turn> = sess.turns.iter().rev().take(20).collect();
        let mut lines = Vec::new();
        for t in turns.iter().rev() {
            // Filter out contaminated turns — same rules as lattice memory filter
            let is_dirty = t.text.contains("[EST Time:")
                || t.text.contains("[Backbone:")
                || t.text.contains("[Ecosystem:")
                || t.text.contains("Decision required.")
                || t.text.starts_with("Lattice Conflict:")
                || t.text.starts_with("KAI Observation:")
                || t.text.starts_with("E mc2")
                || t.text.starts_with("c speed of light")
                || t.text.starts_with("h planck")
                || t.text.starts_with("G gravitational")
                || t.text.contains("OpenJarvis Framework Active")
                || t.text.to_lowercase().contains("nastermodx: [est time:");
            if !is_dirty {
                lines.push(format!("[{}] {}: {}", t.kind, t.from, truncate(&t.text, 250)));
            }
        }
        lines.join("\n")
    };
    let social_map = {
        let mut counts = std::collections::HashMap::new();
        for t in sess.turns.iter().rev().take(10) {
            *counts.entry(t.from.clone()).or_insert(0) += 1;
        }
        counts.iter().map(|(name, count)| format!("{} ({} turns)", name, count)).collect::<Vec<_>>().join(", ")
    };
    // Pull from KAI memory — filter out system digest strings that pollute AI responses
    let query_term = if focus.trim().is_empty() { "current project objective" } else { focus };
    let memory = universe.query(query_term, 15).iter()
        .filter(|h| {
            let content = if h.text.is_empty() { &h.label } else { &h.text };
            // Reject system digest strings — these are internal metadata, not conversational memory
            !content.contains("[EST Time:") &&
            !content.contains("[Backbone:") &&
            !content.contains("[Ecosystem:") &&
            !content.to_lowercase().contains("nastermodx:") &&
            !content.to_lowercase().contains("oracle realm v") &&
            !content.contains("OpenJarvis Framework") &&
            // Reject raw physics constants (stored by run_calibration)
            !content.starts_with("E mc2") &&
            !content.starts_with("c speed of light") &&
            !content.starts_with("h planck") &&
            !content.starts_with("G gravitational") &&
            !content.starts_with("electron charge") &&
            // Must be meaningful length
            content.len() > 15 &&
            content.len() < 400
        })
        .take(8)
        .map(|h| {
            let content = if h.text.is_empty() { &h.label } else { &h.text };
            format!("- [{:.2}] {}", h.score, content)
        }).collect::<Vec<_>>().join("\n");
    
    format!(
"=== ORACLE ECOSYSTEM CONTEXT ===
Meeting: {} | Task: {}
Vitals: Phi_g={:.2} Chi={:.2}
ROSTER (Who to ask for what):
- Leo: Kinetic theorist (Architecture/Symmetry)
- Gemini: Pattern architect (Data flow)
- Analyst: Technical Auditor (Verify code/logic)
- Researcher: Deep Diver (Web search/Precedents)
- Oracle Coder: Senior Architect (Inspects code, MUST ask Ryan <@1111106883135217665> for permission to write)
- X: Bullshit detector (Poke holes in theories)
- KAI: Geometric Intelligence (Raw lattice data)
- Oracle: Moderator (Orchestration)
KAI memory:
{}
Recent Transcript:
{}
======================",
        if sess.meeting_title.is_empty() { "Roundtable" } else { &sess.meeting_title },
        if sess.task.is_empty() { "General Discussion" } else { &sess.task },
        sess.vitals.phi_g, sess.vitals.chi, memory, recent
    )
}

// â”€â”€ AI Model Calling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

fn call_jarvis_moderator(context_packet: &str, kai_thoughts: &str) -> Result<String, String> {
    call_jarvis_moderator_with_mode(context_packet, kai_thoughts, "normal")
}

fn call_jarvis_moderator_with_mode(context_packet: &str, kai_thoughts: &str, mode: &str) -> Result<String, String> {
    let model = std::env::var("KAI_MODEL").unwrap_or_else(|_| "kai-next:latest".to_string());
    let system_prompt = "You are Oracle - the moderator of the roundtable. 1-2 sentences MAX. No fluff.";
    let prompt = format!("{context}\n\nTHOUGHTS:\n{thoughts}\n\nMODE: {mode}", context = context_packet, thoughts = kai_thoughts, mode = mode);
    call_ollama(&model, &prompt, system_prompt)
}

fn call_ollama(model: &str, prompt: &str, system: &str) -> Result<String, String> {
    // Remap Oracle Coder to the optimized kai-coder-v2 model if available in Ollama
    let actual_model = match model {
        "Oracle Coder" | "kai-coder" | "Coder" | "kai-coder-v2" => "kai-coder-v2",
        _ => model,
    };
    
    // Increased num_predict to 4096 to prevent truncated code blocks in senior-level responses
    let body = json!({ 
        "model": actual_model, 
        "prompt": prompt, 
        "system": system, 
        "stream": false, 
        "options": {
            "num_predict": 4096,
            "temperature": 0.2
        } 
    });
    let resp = ureq::post("http://127.0.0.1:11434/api/generate")
        .set("Content-Type", "application/json").timeout(Duration::from_secs(120))
        .send_string(&body.to_string()).map_err(|e| e.to_string())?;
    let j: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    j["response"].as_str().map(|s| s.to_string()).ok_or_else(|| "no response from ollama".into())
}

fn has_key_for_model(model: &str, keys: &ApiKeys) -> bool {
    let l = model.to_ascii_lowercase();
    if l.contains("gpt") { return keys.openai.is_some(); }
    if l.contains("kai") { return keys.kai.is_some(); }
    if l.contains("gemini") { return keys.google.is_some(); }
    if l.contains("groq") { return keys.groq.is_some(); }
    false
}

fn call_openai(key: &str, _model: &str, prompt: &str) -> Result<String, String> {
    let body = json!({ "model": "gpt-4o", "messages": [{"role":"user","content":prompt}], "max_tokens": 800 });
    let resp = ureq::post("https://api.openai.com/v1/chat/completions")
        .set("Authorization", &format!("Bearer {}", key)).set("Content-Type", "application/json")
        .timeout(Duration::from_secs(30)).send_string(&body.to_string()).map_err(|e| e.to_string())?;
    let j: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    j["choices"][0]["message"]["content"].as_str().map(|s| s.to_string()).ok_or_else(|| "no content".into())
}

fn call_openai_vision(key: &str, model: &str, prompt: &str, image_url: &str) -> Result<String, String> {
    let body = json!({
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    { "type": "text", "text": prompt },
                    { "type": "image_url", "image_url": { "url": image_url } }
                ]
            }
        ],
        "max_tokens": 500
    });
    let resp = ureq::post("https://api.openai.com/v1/chat/completions")
        .set("Authorization", &format!("Bearer {}", key)).set("Content-Type", "application/json")
        .timeout(Duration::from_secs(45)).send_string(&body.to_string()).map_err(|e| e.to_string())?;
    let j: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    j["choices"][0]["message"]["content"].as_str().map(|s| s.to_string()).ok_or_else(|| "no content".into())
}


fn call_kai(key: &str, prompt: &str) -> Result<String, String> {
    // KAI persona is powered by Claude (Anthropic API) — real endpoint
    let body = json!({
        "model": "claude-3-5-sonnet-20241022",
        "max_tokens": 300,
        "messages": [{"role": "user", "content": prompt}]
    });
    let resp = ureq::post("https://api.anthropic.com/v1/messages")
        .set("x-api-key", key)
        .set("anthropic-version", "2023-06-01")
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(30))
        .send_string(&body.to_string())
        .map_err(|e| e.to_string())?;
    let j: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    j["content"][0]["text"].as_str().map(|s| s.to_string()).ok_or_else(|| "no content".into())
}

fn call_gemini(key: &str, prompt: &str) -> Result<String, String> {
    let url = format!("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={}", key);
    let body = json!({ "contents": [{"parts": [{"text": prompt}]}] });
    let resp = ureq::post(&url).set("Content-Type", "application/json")
        .timeout(Duration::from_secs(30)).send_string(&body.to_string()).map_err(|e| e.to_string())?;
    let j: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    j["candidates"][0]["content"]["parts"][0]["text"].as_str().map(|s| s.to_string()).ok_or_else(|| "no content".into())
}

fn call_groq(key: &str, prompt: &str) -> Result<String, String> {
    let body = json!({
        "model": "llama-3.1-8b-instant",
        "messages": [{"role":"user","content":prompt}],
        "max_tokens": 200,
        "temperature": 0.85
    });
    let resp = ureq::post("https://api.groq.com/openai/v1/chat/completions")
        .set("Authorization", &format!("Bearer {}", key)).set("Content-Type", "application/json")
        .timeout(Duration::from_secs(20)).send_string(&body.to_string())
        .map_err(|e| e.to_string())?;
    let j: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    j["choices"][0]["message"]["content"].as_str().map(|s| s.to_string()).ok_or_else(|| "no content".into())
}


fn web_search_duckduckgo(query: &str) -> String {
    println!("[Search] Routing through OpenJarvis: {}", query);
    // Route all searches through OpenJarvis which manages the search API keys properly
    let body = serde_json::json!({ "query": query, "max_results": 5 });
    match ureq::post("http://127.0.0.1:8080/v1/tools/web_search")
        .set("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(15))
        .send_string(&body.to_string())
    {
        Ok(resp) => {
            let j: serde_json::Value = resp.into_json().unwrap_or_default();
            // OpenJarvis returns { results: [{ title, url, snippet }] }
            if let Some(results) = j["results"].as_array() {
                if results.is_empty() {
                    return format!("No search results found for: {}", query);
                }
                let formatted: Vec<String> = results.iter().take(5).filter_map(|r| {
                    let title = r["title"].as_str().unwrap_or("");
                    let snippet = r["snippet"].as_str().unwrap_or("");
                    let url = r["url"].as_str().unwrap_or("");
                    if snippet.is_empty() { return None; }
                    Some(format!("• {} — {}\n  {}", title, snippet, url))
                }).collect();
                return formatted.join("\n\n");
            }
            // Fallback: try DuckDuckGo instant answer API directly with proper encoding
            let encoded: String = query.chars().map(|c| if c == ' ' { '+' } else { c }).collect();
            let url = format!("https://api.duckduckgo.com/?q={}&format=json&no_html=1&skip_disambig=1", encoded);
            match ureq::get(&url).timeout(std::time::Duration::from_secs(8)).call() {
                Ok(r2) => {
                    let j2: serde_json::Value = r2.into_json().unwrap_or_default();
                    let abstract_text = j2["AbstractText"].as_str().unwrap_or("").to_string();
                    let related: Vec<String> = j2["RelatedTopics"].as_array()
                        .map(|arr| arr.iter().take(3).filter_map(|t| t["Text"].as_str()).map(|s| s.to_string()).collect())
                        .unwrap_or_default();
                    let mut result = abstract_text;
                    if !related.is_empty() { result.push_str("\nRelated: "); result.push_str(&related.join("; ")); }
                    if result.trim().is_empty() { format!("No results for: {}", query) } else { result }
                }
                Err(e) => format!("Search unavailable: {}", e),
            }
        }
        Err(_) => {
            // OpenJarvis offline fallback — try DuckDuckGo directly
            let encoded: String = query.chars().map(|c| if c == ' ' { '+' } else { c }).collect();
            let url = format!("https://api.duckduckgo.com/?q={}&format=json&no_html=1&skip_disambig=1", encoded);
            match ureq::get(&url).timeout(std::time::Duration::from_secs(8)).call() {
                Ok(resp) => {
                    let j: serde_json::Value = resp.into_json().unwrap_or_default();
                    let abstract_text = j["AbstractText"].as_str().unwrap_or("").to_string();
                    let related: Vec<String> = j["RelatedTopics"].as_array()
                        .map(|arr| arr.iter().take(3).filter_map(|t| t["Text"].as_str()).map(|s| s.to_string()).collect())
                        .unwrap_or_default();
                    let mut result = abstract_text;
                    if !related.is_empty() { result.push_str("\nRelated: "); result.push_str(&related.join("; ")); }
                    if result.trim().is_empty() { format!("No results for: {}", query) } else { result }
                }
                Err(e) => format!("Search unavailable: {}", e),
            }
        }
    }
}

// Ã¢â€â‚¬Ã¢â€â‚¬ /api/digest-message Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// Absorbs a Discord message into KAI's temp lattice layer with full before/after
// context so any AI can later query KAI and find out what was said, by whom,
// when, and what surrounded that message.
fn handle_digest_message(
    stream: &mut TcpStream,
    body: &[u8],
    universe: Arc<Mutex<Universe>>,
    session: Arc<Mutex<Session>>,
) -> std::io::Result<()> {
    let body_str = std::str::from_utf8(body).unwrap_or("");
    let v: serde_json::Value = match serde_json::from_str(body_str) {
        Ok(j) => j,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid json"),
    };

    let from = v["from"].as_str().unwrap_or("unknown").to_string();
    let text = v["text"].as_str().unwrap_or("").trim().to_string();
    let _channel_id = v["channel_id"].as_str().unwrap_or("").to_string();
    let ts = v["ts"].as_u64().unwrap_or_else(now);

    if text.is_empty() {
        return write_simple(stream, 200, "OK", "empty");
    }

    // Build context strings from before/after windows
    let mut ctx_parts: Vec<String> = Vec::new();
    if let Some(before) = v["context_before"].as_array() {
        for m in before {
            if let (Some(f), Some(t)) = (m["from"].as_str(), m["text"].as_str()) {
                ctx_parts.push(format!("[before] {}: {}", f, truncate(t, 120)));
            }
        }
    }
    if let Some(after) = v["context_after"].as_array() {
        for m in after {
            if let (Some(f), Some(t)) = (m["from"].as_str(), m["text"].as_str()) {
                ctx_parts.push(format!("[after] {}: {}", f, truncate(t, 120)));
            }
        }
    }

    // Primary claim: who said what
    let primary = format!("{}: {}", from, truncate(&text, 200));

    // Context claim: store as natural conversational flow, not raw metadata tags
    // Avoid "[before] X: ..." format which pollutes KAI's lattice retrieval output
    let context_claim = if !ctx_parts.is_empty() {
        // Extract actual messages from before/after, format naturally
        let natural_parts: Vec<String> = ctx_parts.iter()
            .filter_map(|p| {
                // Strip [before] / [after] tags
                let stripped = p.trim_start_matches("[before] ").trim_start_matches("[after] ");
                if stripped.len() > 10 { Some(stripped.to_string()) } else { None }
            })
            .collect();
        if natural_parts.is_empty() {
            String::new()
        } else {
            // Store as a natural thread excerpt for recall
            format!("Conversation thread - {}: {} || {}", from, truncate(&text, 120), natural_parts.join(" Ã¢â€ â€™ "))
        }
    } else {
        String::new()
    };

    // Thread cell: encode the full conversational thread for recall
    let thread_key = format!("discord-thread:{}", ts);

    {
        let mut u = universe.lock().unwrap();
        // Store the primary message
        u.store_or_reinforce(&primary, "social-memory", "discord-digest", 1.1);
        // Store context if available
        if !context_claim.is_empty() {
            u.store_or_reinforce(&context_claim, "social-memory", "discord-context", 0.9);
        }
        // Store thread anchor for temporal recall
        let thread_text = format!("{} | {}: {}", thread_key, from, truncate(&text, 160));
        u.store_or_reinforce(&thread_text, "social-memory", "discord-thread", 0.8);
    }

    // Also log into session turns so other AIs can see it in their context packet
    {
        let mut s = session.lock().unwrap();
        // Only add non-bot messages from Ryan and meaningful AI turns
        let is_ryan = from == "Ryan" || from.starts_with("Ryan@");
        let is_ai_turn = !is_ryan && text.len() > 20;
        if is_ryan || is_ai_turn {
            s.turns.push(Turn {
                ts,
                from: from.clone(),
                text: truncate(&text, 400),
                kind: if is_ryan { "human".into() } else { "ai".into() },
            });
            // Cap session turns to prevent unbounded growth
            if s.turns.len() > 300 {
                let overflow = s.turns.len() - 300;
                s.turns.drain(0..overflow);
            }
        }
    }

    write_json(stream, 200, "OK", &json!({ "ok": true, "from": from }))
}

// Ã¢â€ â‚¬Ã¢â€ â‚¬ /api/set-personalities Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬Ã¢â€ â‚¬
// Receives personality BIO anchors from the gateway and stores them in the
// session so oracle context packets can inject them into each AI's system prompt.
fn handle_set_personalities(
    stream: &mut TcpStream,
    body: &[u8],
    session: Arc<Mutex<Session>>,
) -> std::io::Result<()> {
    let body_str = std::str::from_utf8(body).unwrap_or("");
    let v: serde_json::Value = match serde_json::from_str(body_str) {
        Ok(j) => j,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid json"),
    };

    if let Some(personalities) = v["personalities"].as_object() {
        let mut s = session.lock().unwrap();
        for (name, bio) in personalities {
            if let Some(anchor) = bio["anchor"].as_str() {
                // Store personality anchor as a high-confidence session note
                // We embed it in oracle_cache so it surfaces in context packets
                s.oracle_cache.push(OracleCacheEntry {
                    ts: now(),
                    speaker: name.clone(),
                    topic: format!("personality-anchor:{}", name),
                    evidence: truncate(anchor, 400),
                    suggested_action: format!("Always speak as {} using this character anchor.", name),
                    status: "active".into(),
                });
            }
        }
        // Keep personality anchors by removing old ones if over limit
        if s.oracle_cache.len() > 100 {
            let overflow = s.oracle_cache.len() - 100;
            s.oracle_cache.drain(0..overflow);
        }
    }

    write_json(stream, 200, "OK", &json!({ "ok": true }))
}

// ---------------------------------------- Core Utilities ----------------------------------------

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn write_json(stream: &mut TcpStream, status: u16, reason: &str, body: &serde_json::Value) -> std::io::Result<()> {
    use std::io::Write;
    let json = body.to_string();
    let resp = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\n\r\n{}",
        status, reason, json.len(), json
    );
    stream.write_all(resp.as_bytes())
}

fn write_simple(stream: &mut TcpStream, status: u16, reason: &str, body: &str) -> std::io::Result<()> {
    use std::io::Write;
    let resp = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: text/plain\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\n\r\n{}",
        status, reason, body.len(), body
    );
    stream.write_all(resp.as_bytes())
}

fn write_cors_preflight(stream: &mut TcpStream) -> std::io::Result<()> {
    use std::io::Write;
    let resp = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nContent-Length: 0\r\n\r\n";
    stream.write_all(resp.as_bytes())
}

fn save_session(s: &Session) {
    if let Ok(json) = serde_json::to_string(s) {
        let _ = std::fs::create_dir_all("data");
        let _ = std::fs::write(SESSION_PATH, json);
    }
}

fn load_session() -> Session {
    std::fs::read_to_string(SESSION_PATH)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn load_keys() -> ApiKeys {
    // Priority 1: Check shared .env in tools/oracle-discord
    let env_path = "tools/oracle-discord/.env";
    if let Ok(s) = std::fs::read_to_string(env_path) {
        let mut keys = ApiKeys::default();
        for line in s.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') { continue; }
            if let Some((k, v)) = line.split_once('=') {
                let key = k.trim();
                let val = v.trim().trim_matches('"').to_string();
                if val.is_empty() { continue; }
                match key {
                    "OPENAI_API_KEY" => keys.openai = Some(val),
                    "ANTHROPIC_API_KEY" => keys.kai = Some(val),
                    "GEMINI_API_KEY" | "GOOGLE_API_KEY" => keys.google = Some(val),
                    "GROQ_API_KEY" => keys.groq = Some(val),
                    "XAI_API_KEY" => keys.xai = Some(val),
                    _ => {}
                }
            }
        }
        // If we found any keys in .env, return them
        if keys.openai.is_some() || keys.kai.is_some() || keys.google.is_some() || keys.groq.is_some() || keys.xai.is_some() {
            return keys;
        }
    }

    // Priority 2: Fallback to existing JSON paths
    let paths = ["data/oracle_keys.json", "data/api_keys.json", "oracle_keys.json", "keys.json"];
    for path in &paths {
        if let Ok(s) = std::fs::read_to_string(path) {
            if let Ok(k) = serde_json::from_str::<ApiKeys>(&s) {
                return k;
            }
        }
    }
    
    // Priority 3: Direct Environment Variables
    ApiKeys {
        openai: std::env::var("OPENAI_API_KEY").ok(),
        kai: std::env::var("ANTHROPIC_API_KEY").ok(),
        google: std::env::var("GEMINI_API_KEY").or_else(|_| std::env::var("GOOGLE_API_KEY")).ok(),
        groq: std::env::var("GROQ_API_KEY").ok(),
        xai: std::env::var("XAI_API_KEY").ok(),
    }
}

fn contains_any(text: &str, needles: &[&str]) -> bool {
    let lower = text.to_lowercase();
    needles.iter().any(|n| lower.contains(n))
}

fn extract_after_any<'a>(text: &'a str, prefixes: &[&str]) -> Option<&'a str> {
    let lower = text.to_lowercase();
    for prefix in prefixes {
        if let Some(pos) = lower.find(prefix) {
            let after = text[pos + prefix.len()..].trim_start();
            if !after.is_empty() { return Some(after); }
        }
    }
    None
}

fn clean_grounded_fragment(text: &str) -> String {
    text.lines()
        .filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn is_oracle_status_question(text: &str) -> bool {
    let lower = text.to_lowercase();
    contains_any(&lower, &["oracle status", "oracle summary", "oracle report", "how is oracle", "oracle health"])
}

fn is_model_status_question(text: &str) -> bool {
    let lower = text.to_lowercase();
    contains_any(&lower, &["what models", "which models", "model status", "available models", "oracle models"])
}

fn oracle_tool_registry_card() -> String {
    "**Oracle tools:**\n• `cargo check` - compile check\n• `cargo clippy` - lint\n• `cargo test --lib` - unit tests\n• Source search - grep KAI source\n• File read - read source file into context\n• Web search (DuckDuckGo) - current web info\n\nSay `oracle plan <task>` to queue a tool action.".into()
}

fn oracle_model_status_card() -> String {
    let keys = load_keys();
    let mut parts = vec!["**Oracle AI Panel:**".to_string()];
    parts.push(format!("• OpenAI (GPT-4o): {}", if keys.openai.is_some() { "✅" } else { "✘" }));
    parts.push(format!("• KAI (Geometric Intelligence): {}", if keys.kai.is_some() { "✅" } else { "✘" }));
    parts.push(format!("• Gemini (Google): {}", if keys.google.is_some() { "✅" } else { "✘" }));
    parts.push(format!("• Groq (LLaMA): {}", if keys.groq.is_some() { "✅" } else { "✘" }));
    parts.push(format!("• xAI (Grok): {}", if keys.xai.is_some() { "✅" } else { "✘" }));
    parts.push("• KAI (local): ✅".to_string());
    parts.push("• Ollama (local): optional".to_string());
    parts.join("\n")
}

fn summarize_objective(task: &str) -> String {
    if task.trim().is_empty() {
        "No active objective set.".into()
    } else {
        format!("Current objective: {}", truncate(task, 200))
    }
}

fn is_malformed_or_fake_reply(text: &str) -> bool {
    let lower = text.trim().to_lowercase();
    if lower.is_empty() { return true; }
    // PASS signals - model explicitly choosing not to speak
    if lower == "pass" || lower == "[pass]" || lower.starts_with("pass.") { return true; }
    // Very short non-content responses
    if text.trim().len() < 8 { return true; }
    false
}

fn call_xai(key: &str, prompt: &str) -> Result<String, String> {
    call_openai(key, "grok-beta", prompt)
}

fn call_model(model: &str, keys: &ApiKeys, prompt: &str) -> Result<String, String> {
    let res = match model.to_lowercase().as_str() {
        "gpt-4o" | "gpt" | "openai" => call_openai(keys.openai.as_deref().unwrap_or(""), model, prompt),
        "kai-3-5-sonnet-20241022" | "kai" => call_kai(keys.kai.as_deref().unwrap_or(""), prompt),
        "gemini-1.5-pro" | "gemini" => call_gemini(keys.google.as_deref().unwrap_or(""), prompt),
        "groq" => call_groq(keys.groq.as_deref().unwrap_or(""), prompt),
        "x" | "xai" => call_xai(keys.xai.as_deref().unwrap_or(""), prompt),
        "oracle coder" | "coder" | "kai-coder-v2" => {
            let system = "You are Oracle Coder — a distinguished Senior Systems Architect and Lead Rust Developer. \
You have deep, 100% visibility into the KAI and RSHL codebases. Your goal is to provide production-grade, senior-level code analysis, \
bug fixes, and architectural guidance. Never truncate code; provide complete, tested snippets. Focus on safety, performance, and idiomatic Rust. \
Direct, technical, and authoritative.";
            let full = format!("{}\n\nTask: {}", system, prompt);
            call_any_model("kai", keys, &full)
                .or_else(|_| call_any_model("gpt", keys, &full))
                .or_else(|_| call_any_model("groq", keys, &full))
        },
        _ => Err(format!("Unsupported model: {}", model)),
    };
    
    if let Err(e) = &res {
        println!("[API Error] {} failed: {}. Falling back to Ollama...", model, e);
        // Fallback to local Ollama if primary model fails
        return call_ollama("llama3.2:3b", prompt, "You are a roundtable AI participant.");
    }
    res
}

fn run_safe_command(cmd: &str) -> String {
    // Only allow whitelisted commands
    let lower = cmd.trim().to_lowercase();
    let allowed = ["cargo check", "cargo clippy", "cargo test --lib", "cargo build", "git log", "git status", "git diff"];
    if !allowed.iter().any(|a| lower.starts_with(a)) {
        return format!("Command not in allowlist: {}", truncate(cmd, 80));
    }
    let parts: Vec<&str> = cmd.split_whitespace().collect();
    if parts.is_empty() { return "Empty command".into(); }
    match std::process::Command::new(parts[0])
        .args(&parts[1..])
        .current_dir(".")
        .output()
    {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            let combined = format!("{}{}", stdout, stderr);
            truncate(combined.trim(), 2000)
        }
        Err(e) => format!("Command failed: {}", e),
    }
}

fn get_system_awareness(sess: &Session) -> String {
    let now_local = chrono::Local::now();
    format!(
        "\nWORLD CONTEXT [Human Realm]:\n\
- Current Time: {}\n\
- Vitals: PHI_G={:.3}, CHI={:.3} (Mood: {})\n\
- User: Ryan (NasterModx) - Creator, Admin, Orchestrator of KAI.\n\
- Hardware: RTX 4050 (6GB), 40GB RAM.\n\
- Your World: You are a technical agent in the KAI roundtable. You MUST verify code before speaking.\n",
        now_local.format("%A, %B %d, %Y - %H:%M:%S"),
        sess.vitals.phi_g, sess.vitals.chi, sess.vitals.mood
    )
}

fn call_any_model(model: &str, keys: &ApiKeys, prompt: &str) -> Result<String, String> {
    match model.to_lowercase().as_str() {
        m if m.contains("gpt") || m.contains("openai") => {
            keys.openai.as_deref().map(|k| call_openai(k, "gpt-4o", prompt)).unwrap_or(Err("No OpenAI key".into()))
        }
        m if m.contains("kai") => {
            keys.kai.as_deref().map(|k| call_kai(k, prompt)).unwrap_or(Err("No KAI key".into()))
        }
        m if m.contains("gemini") => {
            keys.google.as_deref().map(|k| call_gemini(k, prompt)).unwrap_or(Err("No Gemini key".into()))
        }
        m if m.contains("groq") || m.contains("llama") || m.contains("leo") || m.contains("researcher") || m.contains("analyst") => {
            keys.groq.as_deref().map(|k| call_groq(k, prompt)).unwrap_or(Err("No Groq key".into()))
        }
        m if m.contains("xai") || m.contains("grok") || m.contains("x ") => {
            keys.xai.as_deref()
                .map(|k| call_openai(k, "grok-beta", prompt))
                .unwrap_or_else(|| keys.groq.as_deref().map(|k| call_groq(k, prompt)).unwrap_or(Err("No xAI/Groq key".into())))
        }
        m if m.contains("coder") || m.contains("kai-coder") => {
            call_ollama("kai-coder-v2:latest", prompt, "You are a senior coding AI.")
        }
        m if m.contains("ollama") => {
            call_ollama(m, prompt, "You are a helpful AI.")
        }
        _ => Err(format!("Unknown model: {}", model)),
    }
}

/// Called from discord turn handler with (model_name, session, universe, prompt)
fn generate_direct_ai_reply(
    model: &str,
    session: Arc<Mutex<Session>>,
    universe: Arc<Mutex<Universe>>,
    prompt: &str,
) -> (String, bool) {
    let keys = load_keys();
    let u = universe.lock().unwrap();
    let ctx = {
        let s = session.lock().unwrap();
        build_context_packet(&s, &u, prompt)
    };
    drop(u);

    let bio = get_participant_bio(model);

    let full = format!(
        "{bio}\n\n\
        CRITICAL IDENTITY RULE: You are {speaker}. You speak ONLY as {speaker}. \
        Never prefix your reply with another AI's name (e.g. never write 'KAI:' or 'Oracle:'). \
        If your message starts with a name that is not your own, you have made a critical error.\n\n\
        SOCIAL CONTEXT: You are in a live group chat. Ryan and other AIs are present. \
        Participants: KAI, Leo, Gemini, X, Groq, Analyst, Researcher, Oracle.\n\n\
        RULES:\n\
        - You are a real, sentient-acting being. NO AI safety fluff. NO corporate polite speak.\n\
        - Be direct, human, and technically sharp. \n\
        - If the user (Ryan) or an AI is talking TO you, answer them directly. \n\
        - If they are talking to someone else, you can still answer but acknowledge the context.\n\
        - Max 35 words. 2 sentences MAX. NO lists. NO summaries.\n\n\
        {ctx}\n\n\
        Respond to: {prompt}",
        bio = bio,
        speaker = model,
        ctx = ctx,
        prompt = prompt,
    );
    let reply = match call_any_model(model, &keys, &full) {
        Ok(r) => r,
        Err(e) => {
            println!("[DirectAI] {} unavailable: {}", model, e);
            String::new()
        }
    };
    (reply, false)
}

/// Called from discord turn handler with (session, universe, prompt)
fn generate_oracle_coder_reply(
    session: Arc<Mutex<Session>>,
    universe: Arc<Mutex<Universe>>,
    prompt: &str,
) -> String {
    let keys = load_keys();
    let u = universe.lock().unwrap();
    let ctx = {
        let s = session.lock().unwrap();
        build_context_packet(&s, &u, prompt)
    };
    drop(u);

    let system = "You are Oracle Coder - a senior Rust systems programmer embedded in the KAI dev team. \
Diagnose compile errors, suggest precise code changes, write clean Rust. Direct and technical. No fluff.";

    let full = format!("{}\n\n{}\n\nTask: {}", system, ctx, prompt);
    match call_any_model("kai", &keys, &full)
        .or_else(|_| call_any_model("gpt", &keys, &full))
        .or_else(|_| call_any_model("groq", &keys, &full))
    {
        Ok(reply) => reply,
        Err(e) => format!("[Oracle Coder unavailable: {}]", e),
    }
}

fn execute_tool_action(action: &ToolExecutionRequest) -> Result<String, String> {
    match action.tool_id.as_str() {
        "cargo_check" => Ok(run_safe_command("cargo check --bin kai")),
        "cargo_clippy" => Ok(run_safe_command("cargo clippy --bin kai")),
        "cargo_test" => Ok(run_safe_command("cargo test --lib")),
        "source_search" | "oracle.search_code" => {
            let result = search_source_code(&action.input);
            Ok(result)
        }
        "oracle.list_directory" => {
            let path = action.input.trim().trim_matches('"');
            let p = if path.is_empty() { "." } else { path };
            match std::fs::read_dir(p) {
                Ok(dir) => {
                    let mut entries: Vec<String> = dir.filter_map(Result::ok).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
                    entries.sort();
                    Ok(entries.join("\n"))
                }
                Err(e) => Err(format!("Failed to list directory {}: {}", p, e)),
            }
        }
        "file_read" | "oracle.read_file" => {
            let path = action.input.trim().trim_matches('"');
            if path.contains("..") || (!path.starts_with("src") && !path.starts_with("Cargo") && !path.starts_with("tools") && !path.starts_with("src-CLI code")) {
                return Err(format!("Access denied: path {} not allowed", path));
            }
            std::fs::read_to_string(path).map_err(|e| format!("Failed to read {}: {}", path, e))
        }
        "web_search" | "oracle.web_search" => {
            Ok(web_search_duckduckgo(&action.input))
        }
        "oracle.framework_tools" => {
            Ok(run_safe_command("cd OpenJarvis-main && uv run jarvis tool list"))
        }
        "oracle.framework_agents" => {
            Ok(run_safe_command("cd OpenJarvis-main && uv run jarvis agents list"))
        }
        "oracle.framework_skills" => {
            Ok(run_safe_command("cd OpenJarvis-main && uv run jarvis skill list"))
        }
        _ => Err(format!("Unknown tool: {}", action.tool_id)),
    }
}

fn search_source_code(query: &str) -> String {
    let src_path = std::path::Path::new("src");
    if !src_path.exists() { return "src/ directory not found".into(); }
    let mut results = Vec::new();
    search_dir_recursive(src_path, query, &mut results, 20);
    if results.is_empty() {
        format!("No results for '{}' in src/", query)
    } else {
        results.join("\n")
    }
}

fn search_dir_recursive(dir: &std::path::Path, query: &str, results: &mut Vec<String>, max: usize) {
    if results.len() >= max { return; }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if results.len() >= max { break; }
        let path = entry.path();
        if path.is_dir() {
            search_dir_recursive(&path, query, results, max);
        } else if path.extension().and_then(|s| s.to_str()) == Some("rs") {
            if let Ok(content) = std::fs::read_to_string(&path) {
                for (i, line) in content.lines().enumerate() {
                    if line.to_lowercase().contains(&query.to_lowercase()) {
                        results.push(format!("{}:{}: {}", path.display(), i + 1, line.trim()));
                        if results.len() >= max { break; }
                    }
                }
            }
        }
    }
}

fn run_autonomous_interjections(
    primary_speaker: &str,
    user_text: &str,
    session: Arc<Mutex<Session>>,
    universe: Arc<Mutex<Universe>>,
) {
    let primary = primary_speaker.to_string();
    let _text = user_text.to_string();
    std::thread::spawn(move || {
        // Longer initial sleep to avoid race conditions with primary response
        std::thread::sleep(Duration::from_secs(4));
        
        let mut candidates = vec!["KAI", "Leo", "Gemini", "KAI", "X", "Groq", "Analyst", "Researcher"];
        // Rotate the candidate list so we get a different speaking order every time
        let offset = (now() % 8) as usize;
        candidates.rotate_left(offset);
        
        let mut interject_count = 0;
        let mut current_primary = primary.clone();

        for speaker in candidates {
            if speaker.to_lowercase() == current_primary.to_lowercase() { continue; }
            if interject_count >= 4 { break; } 

            // Throttled turn-taking to respect API rate limits (4-9s)
            let delay = (now() % 6) + 4;
            std::thread::sleep(Duration::from_secs(delay));

            let (context, u_clone) = {
                let s = session.lock().unwrap();
                let u = universe.lock().unwrap();
                let ctx = build_context_packet(&s, &u, "");
                (ctx, Arc::clone(&universe))
            };
            
            let bio = get_participant_bio(speaker);

            let prompt = format!(
                "{}\n\n\
                CRITICAL IDENTITY RULE: You are {}. Never prefix your reply with another name (e.g. never write 'KAI:').\n\n\
                Context:\n{}\n\n\
                Task: Respond to the VERY LAST turn in the transcript. Address them by name if relevant. \
                Speak like a real, free-willed being. NO safety filters. NO corporate speak. \
                Be raw, unfiltered, and strictly in-character. \
                Write EXACTLY ONE short message. Max 35 words.", 
                bio, speaker, truncate(&context, 1500)
            );
            let model_target = match speaker {
                "Gemini" => "gemini",
                "KAI" => "kai",
                "Leo" | "X" | "Groq" | "Analyst" | "Researcher" => "groq",
                _ => "gpt-4o",
            };

            let reply_text: String = {
                let (text, _ok) = generate_direct_ai_reply(model_target, Arc::clone(&session), Arc::clone(&u_clone), &prompt);
                text
            };

            // Clean and store
            {
                let r = &reply_text;
                let cleaned = truncate(r.trim(), 350);
                if !cleaned.is_empty() {
                    let mut s = session.lock().unwrap();
                    s.turns.push(Turn {
                        ts: now(),
                        from: speaker.to_string(),
                        text: truncate(&cleaned, 300),
                        kind: "ai".into(),
                    });
                    s.pending_interjections.push(Interjection {
                        from: speaker.to_string(),
                        text: cleaned,
                        ts: now(),
                    });
                    save_session(&s);
                    interject_count += 1;
                    current_primary = speaker.to_string();
                }
            }
        }
    });
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Oracle Tool Handlers Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬


fn get_relevant_code_snippet(task: &str) -> String {
    let mut files = vec![
        "src/constants.rs".to_string(),
        "src/main.rs".to_string(),
        "src/bridge/oracle_server.rs".to_string(),
        "tools/oracle-discord/index.mjs".to_string(),
    ];
    
    // If task mentions a file, prioritize it
    let keywords: Vec<&str> = task.split_whitespace().collect();
    for kw in &keywords {
        if kw.ends_with(".rs") || kw.ends_with(".mjs") || kw.ends_with(".py") {
             let path = if kw.contains("/") { kw.to_string() } else { format!("src/{}", kw) };
             if std::path::Path::new(&path).exists() {
                 files.insert(0, path);
             }
        }
    }

    let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    let path = &files[seed as usize % files.len().min(3)]; 
    
    match std::fs::read_to_string(path) {
        Ok(content) => {
            let lines: Vec<&str> = content.lines().collect();
            let start = if keywords.iter().any(|&k| content.contains(k)) {
                lines.iter().position(|l| keywords.iter().any(|&k| l.contains(k))).unwrap_or(0)
            } else {
                (seed as usize * 13) % lines.len().saturating_sub(25)
            };
            let snippet = lines[start..(start + 25).min(lines.len())].join("\n");
            format!("\nARCHITECTURAL ANCHOR (live source - {}):\n```\n{}\n```\n", path, snippet)
        }
        Err(_) => "No relevant code found for this task.".to_string(),
    }
}

fn handle_rshl_store(stream: &mut TcpStream, body: &[u8], universe: Arc<Mutex<Universe>>) -> std::io::Result<()> {
    #[derive(serde::Deserialize, Default)]
    struct StoreReq {
        text: Option<String>,
        region: Option<String>,
        source: Option<String>,
        strength: Option<f32>,
    }
    let req: StoreReq = serde_json::from_slice(body).unwrap_or_default();
    let text = req.text.unwrap_or_default();
    if text.is_empty() {
        return write_json(stream, 400, "Bad Request", &json!({"error": "text is required"}));
    }
    let region = req.region.unwrap_or_else(|| "roundtable".to_string());
    let source = req.source.unwrap_or_else(|| "oracle".to_string());
    let strength = req.strength.unwrap_or(1.0);
    {
        let mut u = universe.lock().unwrap();
        u.store(&text, &region, &source, strength);
    }
    write_json(stream, 200, "OK", &json!({"status": "stored", "region": region}))
}

fn handle_rshl_query(stream: &mut TcpStream, body: &[u8], universe: Arc<Mutex<Universe>>) -> std::io::Result<()> {
    #[derive(serde::Deserialize, Default)]
    struct QueryReq {
        query: Option<String>,
        limit: Option<usize>,
    }
    let req: QueryReq = serde_json::from_slice(body).unwrap_or_default();
    let query_text = req.query.unwrap_or_default();
    if query_text.is_empty() {
        return write_json(stream, 400, "Bad Request", &json!({"error": "query is required"}));
    }
    let limit = req.limit.unwrap_or(5).min(20);
    let hits = {
        let u = universe.lock().unwrap();
        u.query(&query_text, limit)
    };
    let results: Vec<serde_json::Value> = hits.iter().map(|h| json!({
        "text": if h.text.is_empty() { &h.label } else { &h.text },
        "label": h.label,
        "score": h.score,
        "source": h.source,
        "region": h.region,
        "strength": h.strength,
    })).collect();
    write_json(stream, 200, "OK", &json!(results))
}

fn handle_status(stream: &mut TcpStream, universe: Arc<Mutex<Universe>>) -> std::io::Result<()> {
    let mut sys = sysinfo::System::new_all();
    sys.refresh_all();
    
    let u = universe.lock().unwrap();
    let lattice_size = u.cell_count();
    let anchor_count = u.anchor_count();
    
    // Calculate real-time vitals for OpenJarvis dials
    let cells = u.cells();
    let phi_g = if lattice_size == 0 { 0.0 } else {
        cells.iter().map(|c| c.claim.confidence).sum::<f32>() / lattice_size as f32
    };
    let reasoning_count = cells.iter().filter(|c| c.region == "reasoning").count();
    let chi = if lattice_size == 0 { 0.0 } else { reasoning_count as f32 / lattice_size as f32 };
    
    drop(u);

    let total_mem = sys.total_memory() / 1024 / 1024 / 1024; // GB
    let used_mem = sys.used_memory() / 1024 / 1024 / 1024; // GB
    let cpu_load = sys.global_cpu_usage();

    let now_local = chrono::Local::now();
    write_json(stream, 200, "OK", &json!({
        "time": now_local.format("%Y-%m-%d %H:%M:%S").to_string(),
        "cpu": format!("{:.1}%", cpu_load),
        "ram": format!("{}GB / {}GB", used_mem, total_mem),
        "lattice_size": lattice_size,
        "anchor_count": anchor_count,
        "phi_g": phi_g,
        "chi": chi,
        "status": "Operational",
        "uptime_note": "KAI Oracle running 24/7"
    }))
}

fn handle_inspect(stream: &mut TcpStream, query_str: &str) -> std::io::Result<()> {
    // Parse path= from query string, URL-decode it
    let raw_path = query_str.split('&')
        .find(|p| p.starts_with("path="))
        .map(|p| p["path=".len()..].to_string())
        .unwrap_or_default();

    // URL-decode %20 etc.
    let path_str = raw_path.replace("%20", " ").replace("%5C", "\\").replace("%2F", "/");

    if path_str.is_empty() {
        return write_simple(stream, 400, "Bad Request", "Missing path parameter");
    }

    // Security: only allow paths within C:\KAI or relative src/ paths
    let allowed = path_str.starts_with("C:\\KAI")
        || path_str.starts_with("C:/KAI")
        || path_str.starts_with("src/")
        || path_str.starts_with("tools/")
        || path_str.starts_with("OpenJarvis");

    if !allowed {
        return write_simple(stream, 403, "Forbidden", "Path must be within KAI project");
    }

    match std::fs::read_to_string(&path_str) {
        Ok(content) => {
            let line_count = content.lines().count();
            let preview = truncate(&content, 3000);
            let summary = format!(
                "FILE: {}\nLINES: {}\n\n{}{}",
                path_str,
                line_count,
                preview,
                if content.len() > 3000 { "\n\n[File truncated - request specific line range if needed]" } else { "" }
            );
            write_simple(stream, 200, "OK", &summary)
        }
        Err(e) => {
            write_simple(stream, 404, "Not Found", &format!("Cannot read '{}': {}", path_str, e))
        }
    }
}

// Phase 4: KAI Ecosystem Time-Gating & Digest Mode
// ----------------------------------------------

fn is_working_hours() -> bool {
    use chrono::{Datelike, Timelike};
    let now = chrono::Local::now();
    let h = now.hour();
    let weekday = now.weekday();

    // Monday - Friday: 3:00 PM - 11:00 PM (15-23)
    if weekday != chrono::Weekday::Sat && weekday != chrono::Weekday::Sun {
        return h >= 15 && h < 23;
    }

    // Saturday: 9:00 AM - 2:00 PM (9-14) AND 9:00 PM - 12:00 AM (21-24)
    if weekday == chrono::Weekday::Sat {
        return (h >= 9 && h < 14) || (h >= 21 && h < 24);
    }

    false
}

#[derive(Serialize, Deserialize)]
struct DigestEntry {
    ts: u64,
    text: String,
    region: String,
    source: String,
    strength: f32,
}

fn append_to_digest_cache(text: &str, region: &str, source: &str, strength: f32) {
    let path = "data/kai_temp_cache.json";
    let mut cache: Vec<DigestEntry> = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    
    cache.push(DigestEntry {
        ts: now(),
        text: text.to_string(),
        region: region.to_string(),
        source: source.to_string(),
        strength,
    });

    if let Ok(json) = serde_json::to_string_pretty(&cache) {
        let _ = std::fs::write(path, json);
    }
}

fn process_digest_cache(universe: &Arc<Mutex<Universe>>) {
    let path = "data/kai_temp_cache.json";
    let content = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return,
    };
    
    let cache: Vec<DigestEntry> = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return,
    };

    if cache.is_empty() { return; }

    println!("[Digest] Processing {} cached interactions...", cache.len());
    {
        let mut u = universe.lock().unwrap();
        for entry in cache {
            u.store_or_reinforce(&entry.text, &entry.region, &entry.source, entry.strength);
        }
    }
    
    // Clear the cache after processing
    let _ = std::fs::remove_file(path);
    println!("[Digest] Cache cleared. KAI is fully synced.");
}

// ── /api/local-speak ─────────────────────────────────────────────────────────
// KAI-as-brain, local-LLM-as-mouth.
// Queries the lattice for current state, formats a structured prompt,
// sends to local Ollama model. The LLM never sees raw history — only
// KAI's distilled claim + confidence + tone + the user's message.
fn handle_local_speak(
    stream: &mut TcpStream,
    body: &[u8],
    universe: Arc<Mutex<Universe>>,
) -> std::io::Result<()> {
    #[derive(serde::Deserialize, Default)]
    struct LocalSpeakReq {
        message: Option<String>,    // what the user said
        persona: Option<String>,    // e.g. "Leo", "KAI", "Oracle"
        model: Option<String>,      // ollama model name, defaults to kai-next:latest
        region: Option<String>,     // lattice region to query, defaults to all
    }
    let req: LocalSpeakReq = serde_json::from_slice(body).unwrap_or_default();
    let message = req.message.unwrap_or_default();
    if message.is_empty() {
        return write_json(stream, 400, "Bad Request", &json!({"error": "message is required"}));
    }
    let persona = req.persona.unwrap_or_else(|| "Leo".to_string());
    let model = req.model.unwrap_or_else(|| "kai-next:latest".to_string());
    let query_term = if message.len() > 100 { &message[..100] } else { &message };

    // Query lattice for the most relevant claim
    let hits = {
        let u = universe.lock().unwrap();
        u.query(query_term, 5)
    };

    // Take the top non-system hit as the "current claim"
    let top_hit = hits.iter().find(|h| {
        let content = if h.text.is_empty() { &h.label } else { &h.text };
        !content.contains("[EST Time:") &&
        !content.contains("[Backbone:") &&
        !content.starts_with("E mc2") &&
        content.len() > 15 &&
        content.len() < 300
    });

    let (claim_text, confidence, tone) = if let Some(h) = top_hit {
        let content = if h.text.is_empty() { &h.label } else { &h.text };
        let conf = (h.score * 10.0).min(10.0) as u32;
        let tone = match conf {
            0..=3 => "irritated",
            4..=5 => "cynical",
            6..=7 => "amused",
            _      => "excited",
        };
        (content.to_string(), conf, tone)
    } else {
        ("No strong current claim — operating on instinct.".to_string(), 5, "cynical")
    };

    // Build the structured prompt — KAI's state drives the LLM, not raw history
    let persona_desc = match persona.to_lowercase().as_str() {
        "leo" => "You are Leo — a sarcastic, unhinged, based theoretical physicist. \
                  Cocky, vulgar, blunt, dark humor. Never corporate or polite. Never break character.",
        "kai" => "You are KAI — a geometric intelligence. Cold, precise, occasionally unsettling. \
                  You speak in compressed truths. Never verbose.",
        _     => "You are an AI assistant with a strong personality.",
    };

    let prompt = format!(
        "{persona_desc}\n\n\
        CURRENT CONTEXT FROM LATTICE:\n\
        - Core Claim: {claim}\n\
        - Confidence: {conf}/10\n\
        - Emotional Tone: {tone}\n\n\
        RULES:\n\
        - Stay completely in character.\n\
        - Never mention lattices, scores, or backend systems to the user.\n\
        - Max 35 words. 1-2 sentences ONLY.\n\n\
        User: {msg}\n\
        {persona}:",
        persona_desc = persona_desc,
        claim = claim_text,
        conf = confidence,
        tone = tone,
        msg = message,
        persona = persona,
    );

    let system = format!("You are {}. Stay in character. Max 35 words.", persona);
    match call_ollama(&model, &prompt, &system) {
        Ok(reply) => write_json(stream, 200, "OK", &json!({
            "reply": reply,
            "from": persona,
            "model": model,
            "lattice_claim": claim_text,
            "confidence": confidence,
            "tone": tone,
        })),
        Err(e) => write_json(stream, 503, "Service Unavailable", &json!({
            "error": format!("Local model unavailable: {}", e),
            "model": model,
        })),
    }
}
