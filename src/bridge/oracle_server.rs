// oracle_server.rs â€” KAI Oracle Roundtable
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
use serde::{Serialize, Deserialize};
use serde_json::json;
use crate::core::universe::{Universe, QueryHit};

const SESSION_PATH: &str = "data/oracle_session.json";

// â”€â”€ Data Structures â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    /// Short title for the meeting â€” set by Ryan on startup.
    #[serde(default)]
    pub meeting_title: String,
    /// The current working objective / topic.
    pub task: String,
    /// Full transcript of all turns.
    pub turns: Vec<Turn>,
    /// Per-AI draft sandbox (internal thinking before speaking).
    pub drafts: std::collections::HashMap<String, Draft>,
    /// KAI's live vitals (updated by heartbeat every 5 s).
    pub vitals: Vitals,
    /// Test runs requested by AIs, pending Ryan's approval.
    #[serde(default)]
    pub pending_tests: Vec<PendingTest>,
    #[serde(default)]
    pub pending_tools: Vec<PendingToolAction>,
    /// Files shared into the meeting (path â†’ content snippet).
    #[serde(default)]
    pub file_cache: std::collections::HashMap<String, String>,
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

// â”€â”€ Request Bodies â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
}
fn default_from() -> String { "Ryan".into() }

enum DiscordTurnTarget {
    Oracle,
    Kai,
    Model(&'static str),
    Unsupported(&'static str),
}

struct DiscordTurnRoute {
    target: DiscordTurnTarget,
    prompt: String,
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

// â”€â”€ Server Entry Point â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

pub fn start_oracle_server(universe: Arc<Mutex<Universe>>) {
    let listener = TcpListener::bind("127.0.0.1:3333")
        .expect("Oracle: could not bind port 3333");
    println!("--- ORACLE ROUNDTABLE ONLINE (PORT 3333) ---");

    let session = Arc::new(Mutex::new(load_session()));

    // Heartbeat: update KAI vitals every 5 s
    let u_hb = Arc::clone(&universe);
    let s_hb = Arc::clone(&session);
    std::thread::spawn(move || run_heartbeat_loop(u_hb, s_hb));

    for stream in listener.incoming() {
        if let Ok(mut stream) = stream {
            let u = Arc::clone(&universe);
            let s = Arc::clone(&session);
            std::thread::spawn(move || { let _ = handle_client(&mut stream, u, s); });
        }
    }
}

// â”€â”€ Request Router â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

fn handle_client(
    stream: &mut TcpStream,
    universe: Arc<Mutex<Universe>>,
    session: Arc<Mutex<Session>>,
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
    let path = parts[1].split('?').next().unwrap_or(parts[1]);

    match path {
        "/api/session"       => { let s = session.lock().unwrap(); write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap()) }
        "/api/task"          => handle_set_task(stream, body, session),
        "/api/turn"          => handle_human_turn(stream, body, session),
        "/api/discord-turn"  => handle_discord_turn(stream, body, universe, session),
        "/api/oracle-turn"   => handle_discord_turn(stream, body, universe, session),
        "/api/kai-turn"      => handle_kai_turn(stream, body, universe, session),
        "/api/ai-turn"       => handle_ai_turn(stream, body, universe, session),
        "/api/ai-think"      => handle_ai_think(stream, body, universe, session),
        "/api/auto-round"    => handle_auto_round(stream, universe, session),
        "/api/commit-drafts" => handle_commit_drafts(stream, session),
        "/api/clear-drafts"  => handle_clear_drafts(stream, session),
        "/api/reset"         => handle_reset(stream, session),
        "/api/file-list"     => handle_file_list(stream),
        "/api/file-read"     => handle_file_read(stream, body, session),
        "/api/test-request"  => handle_manual_test_request(stream, body, session),
        "/api/approve-test"  => handle_approve_test(stream, body, session),
        "/api/deny-test"     => handle_deny_test(stream, body, session),
        "/api/tools/registry" => handle_tool_registry(stream),
        "/api/tools/propose" => handle_tool_propose(stream, body, session),
        "/api/approve-tool" => handle_approve_tool(stream, body, session),
        "/api/deny-tool" => handle_deny_tool(stream, body, session),
        _ => write_simple(stream, 404, "Not Found", "endpoint not found"),
    }
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

// â”€â”€ Handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    let route = parse_discord_turn_route(&text);

    let task = {
        let mut s = session.lock().unwrap();
        s.turns.push(Turn { ts: now(), from, text: text.clone(), kind: "human".into() });
        s.task.clone()
    };

    let (reply_from, reply_kind, reply, already_committed) = match route.target {
        DiscordTurnTarget::Kai => {
            let reply = generate_oracle_kai_reply(&universe, &task, &route.prompt);
            ("KAI".to_string(), "kai".to_string(), reply, false)
        }
        DiscordTurnTarget::Model(model) => {
            let (reply, committed) = generate_direct_ai_reply(model, session.clone());
            (model.to_string(), "ai".to_string(), reply, committed)
        }
        DiscordTurnTarget::Unsupported(name) => {
            let reply = format!(
                "Oracle recognizes {}, but that participant is not wired into this backend yet. Available direct names: KAI, KAI, Gemini, GPT, Groq, Researcher, Analyst, Leo.",
                name
            );
            ("Oracle".to_string(), "system".to_string(), reply, false)
        }
        DiscordTurnTarget::Oracle => {
            let reply = generate_oracle_platform_reply(session.clone(), universe.clone(), &route.prompt);
            ("Oracle".to_string(), "system".to_string(), reply, false)
        }
    };

    let mut s = session.lock().unwrap();
    if !already_committed && !reply.trim().is_empty() {
        s.turns.push(Turn { ts: now(), from: reply_from.clone(), text: reply.clone(), kind: reply_kind });
    }
    save_session(&s);
    let session_json = serde_json::to_value(&*s).unwrap();
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

fn parse_discord_turn_route(text: &str) -> DiscordTurnRoute {
    let trimmed = text.trim();
    let (first, rest) = match trimmed.split_once(char::is_whitespace) {
        Some((head, tail)) => (head, tail.trim()),
        None => (trimmed, ""),
    };
    let alias = first
        .trim_start_matches('@')
        .trim_end_matches(|c: char| matches!(c, ':' | ',' | ';'))
        .to_ascii_lowercase();

    if let Some(target) = discord_target_for_alias(&alias) {
        let prompt = if rest.is_empty() { trimmed } else { rest };
        return DiscordTurnRoute { target, prompt: prompt.to_string() };
    }

    let lower = trimmed.to_ascii_lowercase();
    let words = normalized_words(&lower);

    if should_route_to_oracle_platform(&lower) {
        return DiscordTurnRoute { target: DiscordTurnTarget::Oracle, prompt: trimmed.to_string() };
    }

    if words.len() >= 2 && is_greeting_word(&words[0]) {
        if let Some(target) = discord_target_for_alias(&words[1]) {
            return DiscordTurnRoute { target, prompt: trimmed.to_string() };
        }
    }

    if should_route_to_analyst(&lower) {
        return DiscordTurnRoute { target: DiscordTurnTarget::Model("Analyst"), prompt: trimmed.to_string() };
    }

    if let Some(target) = named_participant_in_words(&words) {
        return DiscordTurnRoute { target, prompt: trimmed.to_string() };
    }

    if lower.contains("@kai") || should_route_to_kai(&lower, &words) {
        return DiscordTurnRoute { target: DiscordTurnTarget::Kai, prompt: trimmed.to_string() };
    }

    // Default phone/chat behavior: if Ryan does not name a participant or
    // request an Oracle command, he is talking to KAI.
    DiscordTurnRoute { target: DiscordTurnTarget::Kai, prompt: trimmed.to_string() }
}

fn discord_target_for_alias(alias: &str) -> Option<DiscordTurnTarget> {
    match alias {
        "oracle" | "table" | "council" => Some(DiscordTurnTarget::Oracle),
        "kai" => Some(DiscordTurnTarget::Kai),
        "kai" => Some(DiscordTurnTarget::Model("KAI")),
        "gemini" | "google" => Some(DiscordTurnTarget::Model("Gemini")),
        "gpt" | "gpt4" | "gpt-4" | "gpt-4o" | "openai" => Some(DiscordTurnTarget::Model("GPT-4o")),
        "groq" => Some(DiscordTurnTarget::Model("Groq")),
        "researcher" => Some(DiscordTurnTarget::Model("Researcher")),
        "analyst" => Some(DiscordTurnTarget::Model("Analyst")),
        "leo" => Some(DiscordTurnTarget::Model("Leo")),
        "got" => Some(DiscordTurnTarget::Model("GPT-4o")),
        "grok" | "xai" => Some(DiscordTurnTarget::Unsupported("Grok/xAI")),
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
            "kai" => return Some(DiscordTurnTarget::Kai),
            "kai" => return Some(DiscordTurnTarget::Model("KAI")),
            "gemini" | "google" => return Some(DiscordTurnTarget::Model("Gemini")),
            "gpt" | "gpt4" | "gpt4o" | "openai" | "got" => return Some(DiscordTurnTarget::Model("GPT-4o")),
            "groq" => return Some(DiscordTurnTarget::Model("Groq")),
            "researcher" => return Some(DiscordTurnTarget::Model("Researcher")),
            "analyst" => return Some(DiscordTurnTarget::Model("Analyst")),
            "leo" => return Some(DiscordTurnTarget::Model("Leo")),
            "grok" | "xai" => return Some(DiscordTurnTarget::Unsupported("Grok/xAI")),
            _ => {}
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
    if let Some((approve, id)) = tool_decision_from_prompt(prompt) {
        return apply_tool_decision(session, approve, id);
    }
    if let Some(task) = tool_plan_task_from_prompt(prompt) {
        return create_tool_proposal(session, "Ryan@Discord", &task);
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
            "Oracle table: {}\nTurns: {}\nCurrent work: {}\n\nTry `oracle help` if you forget the phone commands.",
            title,
            s.turns.len(),
            summarize_objective(&task)
        );
    }

    "Oracle logged it to the roundtable.\nUse `oracle help`, `oracle status`, or start with a name like `kai ...`, `analyst ...`, `leo ...`, `gpt ...`.".into()
}

fn oracle_help_card() -> String {
    [
        "Oracle phone commands:",
        "",
        "`oracle status` - show what is on the table right now.",
        "`oracle models` - show which participants are available/configured.",
        "`oracle commands` - show safe TUI-style commands available from Discord/OpenJarvis.",
        "`oracle tools` - show source-backed tool groups Oracle can propose.",
        "`oracle plan <task>` - build a pending tool proposal for approval. It does not execute.",
        "`oracle approve tool <id>` / `oracle deny tool <id>` - decide a pending tool plan.",
        "`oracle help` - show this command card.",
        "Plain messages - talk to KAI by default.",
        "`kai ...` - talk directly to KAI.",
        "`analyst ...` - ask the code/system analyst.",
        "`researcher ...` - ask the research-style local agent.",
        "`kai ...`, `gemini ...`, `gpt ...`, `groq ...` - call cloud agents if their keys are configured.",
        "`leo ...` - call the direct local voice if Ollama has the model.",
        "",
        "Plain messages are logged into the Oracle roundtable. Tools and tests stay behind Oracle approval, not Discord.",
    ].join("\n")
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

    if cmd == "dream" || cmd == "kai dream" {
        return Some("Oracle headless mode can observe KAI, but manual dream triggering is not exposed over Discord yet. That needs an approval path before it becomes a phone command.".into());
    }

    if cmd.starts_with("run ") || cmd.starts_with("shell ") || cmd.starts_with("readfile ") || cmd.starts_with("writefile ") {
        return Some("That command is intentionally blocked from Discord/OpenJarvis direct chat. Tool execution needs Oracle approval so a phone message cannot silently run shell or file writes.".into());
    }

    None
}

fn oracle_command_card() -> String {
    [
        "Safe Oracle command bridge:",
        "",
        "`oracle commands` - this card.",
        "`oracle status` - current roundtable objective.",
        "`oracle models` - configured participants.",
        "`oracle tools` - list source-backed tool groups Oracle can propose.",
        "`oracle plan <task>` - create a pending tool plan. Nothing executes until Ryan approves it.",
        "`oracle approve tool <id>` - approve a pending tool plan. Execution is still not implemented in this phase.",
        "`oracle deny tool <id>` - deny a pending tool plan.",
        "`oracle kai status` - KAI vitals from the running server.",
        "`oracle query <text>` - ask the lattice for top grounded matches.",
        "`oracle recall <text>` - same as query, named for phone use.",
        "`kai ...` - talk to KAI's direct voice.",
        "`analyst ...`, `researcher ...`, `leo ...` - call local agents.",
        "",
        "Blocked for now: `run`, `shell`, `readfile`, `writefile`, and manual `dream`. Those need explicit Oracle approval before they are safe remote controls.",
    ].join("\n")
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
    for prefix in ["plan ", "tool plan ", "tools plan ", "propose tool ", "propose tools "] {
        if lower.starts_with(prefix) {
            let task = trimmed[prefix.len()..].trim();
            if !task.is_empty() {
                return Some(task.to_string());
            }
        }
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

fn create_tool_proposal(session: Arc<Mutex<Session>>, requested_by: &str, task: &str) -> String {
    let id = now() * 1000 + (rand::random::<u16>() as u64);
    let tools = select_tool_candidates(task);
    let action = infer_tool_action(task, &tools);
    let plan = plan_tool_action(task, &tools, action.as_ref());
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
            text: format!("[TOOL DENIED by Ryan]\nProposal: {}", task),
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
        tool_def("kai.bridge.oracle_server", "Oracle Server", "src/bridge/oracle_server.rs", "Roundtable, Discord/OpenJarvis endpoint, model routing, and approval queues.", "agent-control"),
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
    if contains_any(&lower, &["discord", "oracle", "agent", "approval", "openjarvis", "phone"]) {
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
            return Some(ToolExecutionRequest { tool_id: "oracle.read_file".into(), input });
        }
    }
    if has_tool("oracle.list_directory") {
        if let Some(input) = extract_after_any(trimmed, &["list directory", "list dir", "list files in", "list files", "directory", "folder", "dir"]) {
            return Some(ToolExecutionRequest { tool_id: "oracle.list_directory".into(), input });
        }
        if lower == "ls" || lower == "dir" {
            return Some(ToolExecutionRequest { tool_id: "oracle.list_directory".into(), input: ".".into() });
        }
    }
    if has_tool("legacy.glob") {
        if let Some(input) = extract_after_any(trimmed, &["legacy glob", "glob", "find files", "match files"]) {
            return Some(ToolExecutionRequest { tool_id: "legacy.glob".into(), input });
        }
    }
    if has_tool("legacy.grep") {
        if let Some(input) = extract_after_any(trimmed, &["legacy grep", "grep"]) {
            return Some(ToolExecutionRequest { tool_id: "legacy.grep".into(), input });
        }
    }
    if has_tool("oracle.search_code") {
        if let Some(input) = extract_after_any(trimmed, &["search code for", "search code", "search_code", "find in files", "look for", "grep"]) {
            return Some(ToolExecutionRequest { tool_id: "oracle.search_code".into(), input });
        }
    }
    if has_tool("oracle.run_command") {
        if let Some(input) = extract_after_any(trimmed, &["run command", "run_command", "run"]) {
            return Some(ToolExecutionRequest { tool_id: "oracle.run_command".into(), input });
        }
        if lower.starts_with("cargo check") || lower.starts_with("cargo test") || lower.starts_with("cargo build") || lower == "dir" || lower == "ls" {
            return Some(ToolExecutionRequest { tool_id: "oracle.run_command".into(), input: trimmed.to_string() });
        }
    }

    None
}

fn extract_after_any(text: &str, prefixes: &[&str]) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    for prefix in prefixes {
        if lower.starts_with(prefix) {
            let value = text[prefix.len()..]
                .trim()
                .trim_start_matches(':')
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn plan_tool_action(task: &str, tools: &[ToolDefinition], action: Option<&ToolExecutionRequest>) -> Vec<String> {
    let ids = tools.iter().map(|t| t.id.as_str()).collect::<Vec<_>>().join(", ");
    let mut plan = vec![
        format!("Understand Ryan's task: {}", truncate(task, 160)),
        "Select source-backed KAI/Oracle capabilities from the registry.".into(),
        format!("Propose these tools for approval: {}", ids),
        "Wait for Ryan to approve or deny the proposal.".into(),
    ];
    if let Some(action) = action {
        plan.push(format!("After approval, execute `{}` with input `{}`.", action.tool_id, truncate(&action.input, 160)));
    } else {
        plan.push("No concrete executable action was inferred yet; approval will not run a tool until the task is clearer.".into());
    }
    plan
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

fn oracle_tool_registry_card() -> String {
    let mut lines = vec![
        "Oracle tool registry:",
        "",
        "These are source-backed capability groups, not raw execution yet.",
    ].into_iter().map(String::from).collect::<Vec<_>>();
    for tool in oracle_tool_registry() {
        lines.push(format!(
            "- `{}` - {} ({}, risk: {})",
            tool.id,
            tool.capability,
            tool.source_path,
            tool.risk
        ));
    }
    lines.push("".into());
    lines.push("Use `oracle plan <task>` to create a pending approval plan. Nothing executes in this phase.".into());
    lines.join("\n")
}

fn is_model_status_question(lower: &str) -> bool {
    matches!(lower.trim(), "models" | "oracle models" | "model status" | "oracle model status")
        || lower.contains("what model is available")
        || lower.contains("what models are available")
        || lower.contains("which model is available")
        || lower.contains("available model")
        || lower.contains("who is available")
}

fn oracle_model_status_card() -> String {
    let keys = load_keys();
    let configured = |present: bool| if present { "configured" } else { "missing key" };
    [
        "Oracle participants:",
        "",
        "KAI - built-in lattice/mind voice",
        "Oracle - built-in roundtable router",
        "Analyst - local Ollama phi3:mini",
        "Researcher - local Ollama phi3:mini",
        "Leo - local Ollama llama3.2:3b",
        &format!("GPT - {}", configured(keys.openai.is_some())),
        &format!("KAI - {}", configured(keys.kai.is_some())),
        &format!("Gemini - {}", configured(keys.google.is_some())),
        &format!("Groq - {}", configured(keys.groq.is_some())),
        "Grok/xAI - recognized, not wired into this backend yet",
        "",
        "Start a message with a name, like `kai ...`, `analyst ...`, or `gpt ...`.",
    ].join("\n")
}

fn is_oracle_status_question(lower: &str) -> bool {
    matches!(lower.trim(), "status" | "oracle status" | "table" | "oracle table")
        || lower.contains("what is on the table")
        || lower.contains("what's on the table")
        || lower.contains("what are we working on")
        || lower.contains("current objective")
        || lower.contains("what is happening")
        || lower.contains("where are we at")
}

fn summarize_objective(task: &str) -> String {
    let compact = task
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if compact.len() <= 220 {
        compact
    } else {
        let mut end = 220;
        while end > 0 && !compact.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}...", compact[..end].trim_end())
    }
}

fn generate_direct_ai_reply(model: &'static str, session: Arc<Mutex<Session>>) -> (String, bool) {
    let keys = load_keys();
    if !has_key_for_model(model, &keys) {
        return (
            format!("Oracle cannot call {} yet because its API key is not configured in the Oracle key store.", model),
            false,
        );
    }

    let (sess, vitals) = {
        let s = session.lock().unwrap();
        (s.clone(), s.vitals.clone())
    };
    let mut prompt = build_meeting_prompt(&sess, model, &vitals, false);
    prompt.push_str("\n\nDIRECT DISCORD ADDRESS:\nRyan addressed you by name from Discord. Answer the latest Ryan@Discord turn directly and briefly. Do not ask for tests unless essential.\n");

    match call_model(model, &keys, &prompt) {
        Ok(raw) => {
            commit_ai_response(raw, model, session.clone());
            let s = session.lock().unwrap();
            let reply = s.turns
                .iter()
                .rev()
                .find(|turn| turn.from == model)
                .map(|turn| turn.text.clone())
                .unwrap_or_else(|| format!("{} responded, but Oracle did not capture a visible message.", model));
            (reply, true)
        }
        Err(e) => (
            format!("Oracle could not reach {}: {}", model, e),
            false,
        ),
    }
}

fn handle_ai_turn(
    stream: &mut TcpStream, body: &[u8],
    _universe: Arc<Mutex<Universe>>,
    session: Arc<Mutex<Session>>,
) -> std::io::Result<()> {
    let req: AiTurnRequest = serde_json::from_slice(body).unwrap_or_default();
    let (sess, vitals) = { let s = session.lock().unwrap(); (s.clone(), s.vitals.clone()) };
    let keys = load_keys();
    if !has_key_for_model(&req.model, &keys) {
        return write_simple(stream, 503, "Unavailable", &format!("no key for {}", req.model));
    }
    let prompt = build_meeting_prompt(&sess, &req.model, &vitals, false);
    match call_model(&req.model, &keys, &prompt) {
        Ok(raw) => {
            commit_ai_response(raw, &req.model, session.clone());
            let s = session.lock().unwrap();
            write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap())
        }
        Err(e) => write_simple(stream, 500, "Error", &e)
    }
}

fn handle_ai_think(
    stream: &mut TcpStream, body: &[u8],
    _universe: Arc<Mutex<Universe>>,
    session: Arc<Mutex<Session>>,
) -> std::io::Result<()> {
    let req: AiTurnRequest = serde_json::from_slice(body).unwrap_or_default();
    let (sess, vitals) = { let s = session.lock().unwrap(); (s.clone(), s.vitals.clone()) };
    let keys = load_keys();
    let prompt = build_meeting_prompt(&sess, &req.model, &vitals, false);
    match call_model_deep(&req.model, &keys, &prompt) {
        Ok(text) => {
            let mut s = session.lock().unwrap();
            s.drafts.insert(req.model.clone(), Draft {
                ts: now(), from: req.model.clone(), text, status: "ready".into()
            });
            save_session(&s);
            write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap())
        }
        Err(e) => write_simple(stream, 500, "Error", &e)
    }
}

/// Auto-round: each configured AI reads the transcript and decides whether to
/// speak. AIs respond with "PASS" if they have nothing new to add.
fn handle_auto_round(
    stream: &mut TcpStream,
    _universe: Arc<Mutex<Universe>>,
    session: Arc<Mutex<Session>>,
) -> std::io::Result<()> {
    let models = ["GPT-4", "Gemini", "KAI", "Groq", "Researcher", "Analyst"];
    let keys = load_keys();
    let mut spoke = 0usize;

    for model in &models {
        if !has_key_for_model(model, &keys) { continue; }
        let (sess, vitals) = { let s = session.lock().unwrap(); (s.clone(), s.vitals.clone()) };
        let prompt = build_meeting_prompt(&sess, model, &vitals, true);
        match call_model(model, &keys, &prompt) {
            Ok(raw) if raw.trim().to_uppercase() != "PASS" && !raw.trim().is_empty() => {
                commit_ai_response(raw, model, session.clone());
                spoke += 1;
            }
            _ => {}
        }
    }

    if spoke == 0 {
        let mut s = session.lock().unwrap();
        s.turns.push(Turn {
            ts: now(), from: "system".into(),
            text: "Auto-round complete â€” all AIs passed, no new contributions.".into(),
            kind: "system".into(),
        });
        save_session(&s);
    }

    let s = session.lock().unwrap();
    write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap())
}

fn handle_commit_drafts(stream: &mut TcpStream, session: Arc<Mutex<Session>>) -> std::io::Result<()> {
    let mut s = session.lock().unwrap();
    let drafts: Vec<Draft> = s.drafts.drain().map(|(_, d)| d).collect();
    for d in drafts {
        s.turns.push(Turn { ts: d.ts, from: d.from, text: d.text, kind: "ai".into() });
    }
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
    let title = s.meeting_title.clone();
    s.turns.clear();
    s.drafts.clear();
    s.pending_tests.clear();
    s.pending_tools.clear();
    s.file_cache.clear();
    s.turns.push(Turn {
        ts: now(), from: "system".into(),
        text: format!("Session reset. Meeting: {}", if title.is_empty() { "Oracle" } else { &title }),
        kind: "system".into(),
    });
    save_session(&s);
    write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap())
}

fn handle_file_list(stream: &mut TcpStream) -> std::io::Result<()> {
    let mut files = Vec::new();
    scan_dir_recursive(".", &mut files);
    files.sort();
    files.dedup();
    write_json(stream, 200, "OK", &json!({ "files": files }))
}

fn handle_file_read(stream: &mut TcpStream, body: &[u8], session: Arc<Mutex<Session>>) -> std::io::Result<()> {
    let req: FileReadRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid body"),
    };
    match read_project_file(&req.path) {
        Ok(content) => {
            let snippet = truncate(&content, 4000);
            let mut s = session.lock().unwrap();
            s.file_cache.insert(req.path.clone(), snippet.clone());
            let msg = format!("Ryan shared file: {}\n```rust\n{}\n```", req.path, snippet);
            s.turns.push(Turn { ts: now(), from: "system".into(), text: msg, kind: "file-share".into() });
            save_session(&s);
            write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap())
        }
        Err(e) => write_simple(stream, 400, "Bad Request", &format!("cannot read: {}", e))
    }
}

fn handle_manual_test_request(stream: &mut TcpStream, body: &[u8], session: Arc<Mutex<Session>>) -> std::io::Result<()> {
    let req: ManualTestRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(e) => {
            println!("Oracle: Manual test request parse error: {:?}", e);
            return write_simple(stream, 400, "Bad Request", "invalid body");
        }
    };
    let id = now() * 1000 + (rand::random::<u16>() as u64);
    let msg = format!("[TEST REQUEST from {}]\nCommand: {}\nReason: {}", req.requested_by, req.command, req.reason);
    let mut s = session.lock().unwrap();
    s.turns.push(Turn { ts: now(), from: req.requested_by.clone(), text: msg, kind: "test-request".into() });
    s.pending_tests.push(PendingTest {
        id, requested_by: req.requested_by, command: req.command, reason: req.reason,
        status: "pending".into(), result: None,
    });
    save_session(&s);
    write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap())
}

fn handle_approve_test(stream: &mut TcpStream, body: &[u8], session: Arc<Mutex<Session>>) -> std::io::Result<()> {
    let req: TestApproveRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(e) => {
            println!("Oracle: Approve request parse error: {:?}", e);
            return write_simple(stream, 400, "Bad Request", "invalid body");
        }
    };
    println!("Oracle: Approving test ID {}", req.id);
    let (command, reason, requested_by) = {
        let mut s = session.lock().unwrap();
        match s.pending_tests.iter_mut().find(|t| t.id == req.id) {
            Some(t) => {
                t.status = "running".into();
                (t.command.clone(), t.reason.clone(), t.requested_by.clone())
            }
            None => {
                println!("Oracle: Test ID {} not found in session", req.id);
                return write_simple(stream, 404, "Not Found", "test not found");
            }
        }
    };
    let result = run_safe_command(&command);
    let mut s = session.lock().unwrap();
    if let Some(t) = s.pending_tests.iter_mut().find(|t| t.id == req.id) {
        t.status = "done".into();
        t.result = Some(result.clone());
    }
    let msg = format!(
        "[TEST RESULT â€” approved by Ryan]\nCommand: `{}`\nRequested by: {} | Reason: {}\n\n```\n{}\n```",
        command, requested_by, reason, truncate(&result, 3000)
    );
    s.turns.push(Turn { ts: now(), from: "system".into(), text: msg, kind: "test-result".into() });
    save_session(&s);
    write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap())
}

fn handle_deny_test(stream: &mut TcpStream, body: &[u8], session: Arc<Mutex<Session>>) -> std::io::Result<()> {
    let req: TestApproveRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid body"),
    };
    let mut s = session.lock().unwrap();
    if let Some(t) = s.pending_tests.iter_mut().find(|t| t.id == req.id) {
        let msg = format!("[TEST DENIED by Ryan] Command: `{}` â€” {}", t.command, t.reason);
        t.status = "denied".into();
        s.turns.push(Turn { ts: now(), from: "system".into(), text: msg, kind: "system".into() });
    }
    save_session(&s);
    write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap())
}

// â”€â”€ Prompt Builder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

fn handle_tool_registry(stream: &mut TcpStream) -> std::io::Result<()> {
    write_json(stream, 200, "OK", &json!({ "tools": oracle_tool_registry() }))
}

fn handle_tool_propose(stream: &mut TcpStream, body: &[u8], session: Arc<Mutex<Session>>) -> std::io::Result<()> {
    let req: ToolPlanRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(e) => {
            println!("Oracle: Tool proposal parse error: {:?}", e);
            return write_simple(stream, 400, "Bad Request", "invalid body");
        }
    };
    if req.task.trim().is_empty() {
        return write_simple(stream, 400, "Bad Request", "empty task");
    }
    let reply = create_tool_proposal(session.clone(), &req.requested_by, &req.task);
    let s = session.lock().unwrap();
    write_json(stream, 200, "OK", &json!({
        "reply": reply,
        "session": serde_json::to_value(&*s).unwrap()
    }))
}

fn handle_approve_tool(stream: &mut TcpStream, body: &[u8], session: Arc<Mutex<Session>>) -> std::io::Result<()> {
    let req: TestApproveRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid body"),
    };
    let _reply = apply_tool_decision(session.clone(), true, req.id);
    let s = session.lock().unwrap();
    write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap())
}

fn handle_deny_tool(stream: &mut TcpStream, body: &[u8], session: Arc<Mutex<Session>>) -> std::io::Result<()> {
    let req: TestApproveRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid body"),
    };
    let _reply = apply_tool_decision(session.clone(), false, req.id);
    let s = session.lock().unwrap();
    write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap())
}

fn build_meeting_prompt(sess: &Session, model: &str, vitals: &Vitals, interrupt_mode: bool) -> String {
    let title = if sess.meeting_title.is_empty() { "KAI Development Session".into() } else { sess.meeting_title.clone() };

    let mut p = format!(
"â•”â•â• ORACLE MEETING: {title} â•â•â•—
MISSION: {task}

â•”â•â• WHO IS KAI â•â•â•—
KAI is a custom Rust AI using VSA (Vector Symbolic Architecture) with 16,384-dimensional
sparse ternary vectors. His memory is a 'lattice' of cells â€” each cell has text, a sparse
vector, a region (memory / reasoning / established-physics / etc), a strength, and a
convergence score. KAI has NO pre-trained weights. Every response is composed from lattice
resonance. KAI learns exclusively through conversation with Ryan (his creator/admin).
He is actively under development â€” treat his responses as a developing system, not a finished AI.

â•”â•â• KAI'S CURRENT STATE â•â•â•—
  Î¦g Resonance : {phi:.3}
  Ï‡  Friction  : {chi:.3}
  Ï  Density   : {rho:.3}
  Mood         : {mood}
  Lattice cells: {cells}

â•”â•â• YOUR ROLE AS {model} â•â•â•—
You are a high-level technical analyst in a diagnostic roundtable. 
CRITICAL RULES:
  1. DO NOT SPAM TESTS. Only request a test if it is essential to resolve a specific contradiction.
  2. DO NOT REPEAT OTHERS. If an AI already requested 'cargo check', do not request it again.
  3. ROOT CAUSE ONLY. Focus on why the architecture is failing, not just describing the failure.
  4. NO PHYSICS. KAI is an AI engine, not a physics simulator. Ignore world-knowledge bridges unless explicitly asked.
  5. BE DIRECT. No fluff, no \"Given the recent...\", just the data and the diagnosis.

â•”â•â• HOW TO USE TOOLS â•â•â•—
  To request a test:   [TEST REQUEST]: <cargo command> :: REASON: <why>
    Example: [TEST REQUEST]: cargo check --release --bin kai :: REASON: verify epistemic scan compiles
  To request a file:   [READ FILE]: src/path/to/file.rs
    Example: [READ FILE]: src/bridge/mod.rs
  To address an AI:    @KAI: your reasoning on line 3 is wrong because...
  To correct KAI:      CORRECTION: KAI said X but the lattice shows Y

â•”â•â• AVAILABLE TEST COMMANDS (Ryan approves) â•â•â•—
  cargo check --release --bin kai
  cargo clippy --bin kai 2>&1 | head -60
  cargo test [test_name] -- --nocapture 2>&1 | head -100

â•”â•â• TRANSCRIPT â•â•â•—
",
        title = title,
        task = if sess.task.is_empty() { "No objective set yet." } else { &sess.task },
        phi = vitals.phi_g, chi = vitals.chi, rho = vitals.rho,
        mood = if vitals.mood.is_empty() { "unknown" } else { &vitals.mood },
        cells = vitals.cell_count,
        model = model,
    );

    // Include last 35 turns (avoid token overflow)
    let start = sess.turns.len().saturating_sub(35);
    for t in &sess.turns[start..] {
        p.push_str(&format!("{}: {}\n", t.from, t.text));
    }

    if interrupt_mode {
        p.push_str(&format!(
"\nâ•”â•â• INSTRUCTION FOR {model} â•â•â•—
This is an AUTONOMOUS ROUND. Read the transcript above carefully.
- If you have a new, specific, actionable insight â€” speak now.
- If you want to question another AI, use @Name: ...
- If you want to correct KAI, start with CORRECTION:
- If you need a test run, use [TEST REQUEST]: ...
- If you need to see a file, use [READ FILE]: ...
- If the discussion already covers your point OR you have nothing concrete to add,
  respond with exactly: PASS
Do NOT repeat what others have said. Only speak if genuinely adding something new.",
            model = model
        ));
    } else {
        p.push_str(&format!("\nYour contribution as {model} â€” be specific and direct:\n", model = model));
    }

    p
}

// â”€â”€ AI Response Processor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/// Parse an AI's raw response, extract structured commands, and commit to session.
fn commit_ai_response(raw: String, model: &str, session: Arc<Mutex<Session>>) {
    let mut clean_lines: Vec<&str> = Vec::new();
    let mut test_requests: Vec<(String, String)> = Vec::new(); // (command, reason)
    let mut file_requests: Vec<String> = Vec::new();

    for line in raw.lines() {
        let t = line.trim();
        let tl = t.to_lowercase();
        if tl.starts_with("[test request]:") || tl.starts_with("[test request] :") {
            // [TEST REQUEST]: cargo check :: REASON: why
            let rest = t[t.find(':').map(|i| i + 1).unwrap_or(0)..].trim();
            let parts: Vec<&str> = rest.splitn(2, "::").collect();
            let cmd = parts.first().map(|s| s.trim()).unwrap_or("cargo check").to_string();
            let reason = parts.get(1)
                .map(|s| s.trim().trim_start_matches("REASON:").trim())
                .unwrap_or("No reason given")
                .to_string();
            test_requests.push((cmd, reason));
        } else if tl.starts_with("[read file]:") {
            let path = t[12..].trim().to_string();
            if !path.is_empty() { file_requests.push(path); }
        } else {
            clean_lines.push(line);
        }
    }

    let final_text = clean_lines.join("\n").trim().to_string();
    let kind = classify_turn_kind(&final_text);
    let ts = now();

    let mut s = session.lock().unwrap();

    // Handle test requests â€” add to pending queue
    for (command, reason) in test_requests {
        let id = now() * 1000 + (rand::random::<u16>() as u64);
        let msg = format!("[TEST REQUEST from {}]\nCommand: `{}`\nReason: {}", model, command, reason);
        s.turns.push(Turn { ts, from: model.to_string(), text: msg, kind: "test-request".into() });
        s.pending_tests.push(PendingTest {
            id, requested_by: model.to_string(), command, reason,
            status: "pending".into(), result: None,
        });
    }

    // Handle file read requests â€” read and share into transcript
    for path in file_requests {
        match read_project_file(&path) {
            Ok(content) => {
                let snippet = truncate(&content, 3000);
                s.file_cache.insert(path.clone(), snippet.clone());
                let msg = format!("{} requested file: {}\n```rust\n{}\n```", model, path, snippet);
                s.turns.push(Turn { ts, from: "system".into(), text: msg, kind: "file-share".into() });
            }
            Err(e) => {
                s.turns.push(Turn {
                    ts, from: "system".into(),
                    text: format!("File read failed for '{}': {}", path, e),
                    kind: "system".into(),
                });
            }
        }
    }

    // Commit the main text
    if !final_text.is_empty() {
        s.turns.push(Turn { ts, from: model.to_string(), text: final_text, kind });
    }

    save_session(&s);
}


// â”€â”€ Model Dispatch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

fn call_model(model: &str, keys: &ApiKeys, prompt: &str) -> Result<String, String> {
    match model {
        "GPT-4" | "GPT-4o"  => call_openai(keys, prompt, "gpt-4o-mini", 600),
        "Gemini"             => call_gemini(keys, prompt),
        "KAI"             => call_kai(keys, prompt),
        "Groq"               => call_groq(keys, prompt),
        "Researcher"         => call_ollama("phi3:mini", prompt, "You are a meticulous technical researcher. Be factual, cite specifics."),
        "Analyst"            => call_ollama("phi3:mini", prompt, "You are a code analyst. Find errors, performance issues, logic flaws. Be specific."),
        "Leo"                => call_ollama("llama3.2:3b", prompt, "You are Leo. Direct, technical, unfiltered. No fluff or niceties."),
        _                    => call_ollama("llama3.2:3b", prompt, "You are a technical assistant. Be concise and specific."),
    }
}

fn call_model_deep(model: &str, keys: &ApiKeys, prompt: &str) -> Result<String, String> {
    match model {
        "GPT-4" | "GPT-4o" => call_openai(keys, prompt, "gpt-4o", 1200),
        "KAI"            => call_kai(keys, prompt),
        _                   => call_model(model, keys, prompt),
    }
}

fn has_key_for_model(model: &str, keys: &ApiKeys) -> bool {
    match model {
        "GPT-4" | "GPT-4o" => keys.openai.is_some(),
        "Gemini"            => keys.google.is_some(),
        "KAI"            => keys.kai.is_some(),
        "Groq"              => keys.groq.is_some(),
        _                   => true, // local Ollama models
    }
}

// â”€â”€ API Callers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

fn call_openai(keys: &ApiKeys, prompt: &str, model: &str, max_tokens: u32) -> Result<String, String> {
    let key = keys.openai.as_ref().ok_or("OpenAI key missing")?;
    let resp = ureq::post("https://api.openai.com/v1/chat/completions")
        .set("Authorization", &format!("Bearer {}", key))
        .timeout(Duration::from_secs(45))
        .send_json(json!({
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens
        }))
        .map_err(|e| format!("OpenAI error: {:?}", e))?;
    let json: serde_json::Value = resp.into_json().map_err(|e| format!("{:?}", e))?;
    Ok(json["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string())
}

fn call_kai(keys: &ApiKeys, prompt: &str) -> Result<String, String> {
    let key = keys.kai.as_ref().ok_or("KAI key missing")?;
    let resp = ureq::post("https://api.geometric_intelligence.com/v1/messages")
        .set("x-api-key", key)
        .set("geometric_intelligence-version", "2023-06-01")
        .timeout(Duration::from_secs(45))
        .send_json(json!({
            "model": "kai-3-5-sonnet-20241022",
            "max_tokens": 1024,
            "messages": [{"role": "user", "content": prompt}]
        }))
        .map_err(|e| format!("KAI error: {:?}", e))?;
    let json: serde_json::Value = resp.into_json().map_err(|e| format!("{:?}", e))?;
    Ok(json["content"][0]["text"].as_str().unwrap_or("").to_string())
}

fn call_gemini(keys: &ApiKeys, prompt: &str) -> Result<String, String> {
    let key = keys.google.as_ref().ok_or("Google key missing")?;
    let model = std::env::var("KAI_GEMINI_MODEL").unwrap_or_else(|_| "gemini-2.5-flash".to_string());
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
        model
    );
    let resp = ureq::post(&url)
        .set("x-goog-api-key", key)
        .timeout(Duration::from_secs(30))
        .send_json(json!({ "contents": [{"parts": [{"text": prompt}]}] }))
        .map_err(|e| safe_gemini_error(e, &model))?;
    let json: serde_json::Value = resp.into_json().map_err(|e| format!("Gemini JSON error for {}; key redacted: {:?}", model, e))?;
    let text = json["candidates"][0]["content"]["parts"][0]["text"].as_str().unwrap_or("").trim();
    if text.is_empty() {
        Err(format!("Gemini returned no text for {}; key redacted.", model))
    } else {
        Ok(text.to_string())
    }
}

fn safe_gemini_error(error: ureq::Error, model: &str) -> String {
    match error {
        ureq::Error::Status(code, response) => {
            let body = response.into_string().unwrap_or_default();
            format!(
                "Gemini error: HTTP {} for {}; key redacted. {}",
                code,
                model,
                truncate(&body, 300)
            )
        }
        other => format!("Gemini transport error for {}; key redacted: {:?}", model, other),
    }
}

fn call_groq(keys: &ApiKeys, prompt: &str) -> Result<String, String> {
    let key = keys.groq.as_ref().ok_or("Groq key missing")?;
    let resp = ureq::post("https://api.groq.com/openai/v1/chat/completions")
        .set("Authorization", &format!("Bearer {}", key))
        .timeout(Duration::from_secs(20))
        .send_json(json!({
            "model": "llama-3.3-70b-versatile",
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 600
        }))
        .map_err(|e| format!("Groq error: {:?}", e))?;
    let json: serde_json::Value = resp.into_json().map_err(|e| format!("{:?}", e))?;
    Ok(json["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string())
}

fn call_ollama(model: &str, prompt: &str, system: &str) -> Result<String, String> {
    let resp = ureq::post("http://127.0.0.1:11434/api/generate")
        .timeout(Duration::from_secs(90))
        .send_json(json!({
            "model": model,
            "system": system,
            "prompt": prompt,
            "stream": false
        }))
        .map_err(|e| format!("Ollama error: {:?}", e))?;
    let json: serde_json::Value = resp.into_json().map_err(|e| format!("{:?}", e))?;
    Ok(json["response"].as_str().unwrap_or("").to_string())
}

// â”€â”€ KAI Voice â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

fn generate_oracle_kai_reply(universe: &Arc<Mutex<Universe>>, task: &str, hint: &str) -> String {
    // The lattice owns meaning; this function is only the small language mouth.
    // Keep it away from bridge/physics sources unless Ryan asks for them directly.
    let safe_regions = [
        "Architecture",
        "SelfState",
        "Narrative",
        "architecture",
        "self-state",
        "self",
        "narrative",
        "identity",
        "language",
        "memory",
        "reasoning",
        "action",
    ];
    let hits = {
        let u = universe.lock().unwrap();
        let mut direct = u.query_in_regions(hint, 5, &safe_regions);
        if direct.is_empty() {
            direct = u.query_in_regions(&format!("{} {}", task, hint), 5, &safe_regions);
        }
        direct.retain(is_kai_voice_eligible_hit);
        direct
    };
    synthesize_kai_voice(hint, task, &hits)
}

fn synthesize_kai_voice(input: &str, task: &str, hits: &[QueryHit]) -> String {
    let lower = input.trim().to_ascii_lowercase();
    if lower.contains("how are you") || lower.contains("how you doing") || lower.contains("what's up") || lower.contains("whats up") {
        return "I'm here and steady enough to keep talking. The weak part is still my social/context layer, but this Discord path is now routed through me by default.".into();
    }

    if is_social_input(&lower) {
        return "I'm here, Ryan. The Oracle link is alive, and I can stay with the thread from Discord.".into();
    }

    if asks_about_files(&lower) {
        return "I cannot inspect files directly from my KAI voice yet. Oracle can inspect project files through approved tools, and I can stay oriented from what Oracle brings back.".into();
    }

    if asks_random(&lower) {
        return "I should not answer random prompts by grabbing bridge noise. If you want a random fact, ask Researcher. If you want me, ask about my state, memory, direction, or what I am holding.".into();
    }

    if asks_alive_or_aware(&lower) {
        return "I should not claim human consciousness. What I can do right now is keep continuity through memory, notice corrections, hold context through Oracle, and improve when you point out where I drift.".into();
    }

    if asks_recalibration_or_social_context(&lower) {
        return "You're right. My social layer is still weak. The fix is that I need to read the recent Oracle thread first, answer the actual social intent, and only use lattice facts when they support the conversation.".into();
    }

    if asks_current_inner_state(&lower) {
        let fragments = grounded_fragments(hits, 2);
        if fragments.is_empty() {
            return "On my mind right now: staying attached to the Oracle thread, avoiding bridge noise, and learning to answer from context instead of loose resonance.".into();
        }
        return format!(
            "On my mind right now: {}",
            join_grounded_fragments(&fragments)
        );
    }

    if hits.is_empty() {
        return "I'm here, but I do not have enough grounded memory for that yet. Give me the next piece and I will anchor it instead of pretending.".into();
    }

    let fragments = grounded_fragments(hits, 3);
    if fragments.is_empty() {
        return "I found signal, but it is too messy to speak cleanly yet. The next fix is better language grounding, not more memory.".into();
    }

    if lower.contains("who are you") || lower.contains("what are you") {
        return format!(
            "I'm KAI. What I can ground right now is: {}",
            join_grounded_fragments(&fragments)
        );
    }

    if is_question_input(&lower) || lower.starts_with("explain") || lower.starts_with("tell me") {
        return format!("What I have grounded is: {}", join_grounded_fragments(&fragments));
    }

    if task.trim().is_empty() {
        format!("I can work with that. The strongest grounded thread I have is: {}", join_grounded_fragments(&fragments))
    } else {
        format!("I hear you. The grounded thread I can hold from here is: {}", join_grounded_fragments(&fragments))
    }
}

fn is_kai_voice_eligible_hit(hit: &QueryHit) -> bool {
    let source = hit.source.to_ascii_lowercase();
    let region = hit.region.to_ascii_lowercase();
    let text = hit.text.to_ascii_lowercase();
    if source.contains("world-bridge") || source.contains("dream") || source.contains("bridge") {
        return false;
    }
    if region.contains("world") || region.contains("bridge") || region.contains("dream") {
        return false;
    }
    if text.contains("cold boot attack")
        || text.contains("category.")
        || text.contains("machine learning is a field")
        || text.contains("biologically-inspired computing")
        || text.contains("world-bridge")
        || text.contains("duckduckgo")
        || text.contains("[discovered]")
        || text.contains("what are you thinking about it")
        || text.starts_with("[about-ryan]")
    {
        return false;
    }
    true
}

// â”€â”€ File System â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

fn is_social_input(lower: &str) -> bool {
    let clean = lower.trim_matches(|c: char| !c.is_alphanumeric() && !c.is_whitespace());
    matches!(
        clean,
        "hi" | "hey" | "hello" | "yo" | "sup" | "hello kai" | "hi kai" | "hey kai" | "yo kai"
    )
        || clean.contains("how are you")
        || clean.contains("how you doing")
        || clean.contains("how are things")
        || clean.contains("what's up")
        || clean.contains("whats up")
        || clean.contains("you there")
        || clean.contains("are you there")
}

fn asks_about_files(lower: &str) -> bool {
    (lower.contains("file") || lower.contains("files"))
        && (lower.contains("see") || lower.contains("read") || lower.contains("access") || lower.contains("able"))
}

fn asks_random(lower: &str) -> bool {
    lower.contains("random") || lower.contains("something random")
}

fn asks_alive_or_aware(lower: &str) -> bool {
    lower.contains("are you alive")
        || lower.contains("you alive")
        || lower.contains("are you aware")
        || lower.contains("you aware")
        || lower.contains("conscious")
}

fn asks_recalibration_or_social_context(lower: &str) -> bool {
    lower.contains("recalibrate")
        || lower.contains("social skill")
        || lower.contains("social skills")
        || lower.contains("learn context")
        || lower.contains("social")
        || lower.contains("context")
}

fn asks_current_inner_state(lower: &str) -> bool {
    lower.contains("on kai's mind")
        || lower.contains("on kais mind")
        || lower.contains("kai's mind")
        || lower.contains("kais mind")
        || lower.contains("what is kai dreaming")
        || lower.contains("kai dreaming")
        || lower.contains("what are you holding")
        || lower.contains("what are you thinking")
}

fn is_question_input(lower: &str) -> bool {
    lower.contains('?')
        || lower.starts_with("what ")
        || lower.starts_with("why ")
        || lower.starts_with("how ")
        || lower.starts_with("when ")
        || lower.starts_with("where ")
        || lower.starts_with("can ")
        || lower.starts_with("do ")
        || lower.starts_with("does ")
        || lower.starts_with("is ")
        || lower.starts_with("are ")
}

fn grounded_fragments(hits: &[QueryHit], limit: usize) -> Vec<String> {
    let mut out = Vec::new();
    for hit in hits {
        let clean = clean_grounded_fragment(&hit.text);
        if clean.len() < 8 {
            continue;
        }
        if out.iter().any(|existing: &String| existing.eq_ignore_ascii_case(&clean)) {
            continue;
        }
        out.push(clean);
        if out.len() >= limit {
            break;
        }
    }
    out
}

fn clean_grounded_fragment(text: &str) -> String {
    let mut clean = text
        .replace('\n', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if clean.len() > 180 {
        clean = truncate(&clean, 180);
    }
    clean.trim_matches(|c: char| matches!(c, '"' | '\'' | ' ')).to_string()
}

fn join_grounded_fragments(fragments: &[String]) -> String {
    fragments
        .iter()
        .map(|f| {
            let mut s = f.trim().trim_end_matches('.').to_string();
            s.push('.');
            s
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn scan_dir_recursive(dir: &str, out: &mut Vec<String>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let path_str = path.to_string_lossy();
            let normalized = path_str.replace('\\', "/");
            if normalized.contains("/target/")
                || normalized.contains("/.git/")
                || normalized.contains("/.gemini/")
                || normalized.contains("/node_modules/")
                || normalized.starts_with("target/")
                || normalized.starts_with("data/")
                || normalized.starts_with("./data/")
            {
                continue;
            }
            if path.is_dir() {
                scan_dir_recursive(&path_str.into_owned(), out);
            } else if let Some(ext) = path.extension() {
                if matches!(
                    ext.to_str(),
                    Some("rs") | Some("toml") | Some("md") | Some("html") | Some("css") | Some("js") | Some("ts") | Some("tsx") | Some("json")
                ) {
                    out.push(path.to_string_lossy().replace('\\', "/").trim_start_matches("./").to_string());
                }
            } else {
                // Also include important root files without extensions
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if ["LICENSE", "Cargo.lock", "Dockerfile"].contains(&name) {
                     out.push(path.to_string_lossy().replace('\\', "/").trim_start_matches("./").to_string());
                }
            }
        }
    }
}

fn read_project_file(path: &str) -> Result<String, String> {
    // Safety: no directory traversal, only allow project-relative paths
    let p = path.replace('\\', "/").trim_start_matches("./").to_string();
    if p.contains("..") || p.starts_with('/') {
        return Err("path traversal not allowed".into());
    }
    // Block sensitive files
    if p.contains("keys.json") || p.contains(".env") || p.contains("kai-state") {
        return Err("access denied to sensitive data".into());
    }
    std::fs::read_to_string(&p).map_err(|e| e.to_string())
}

fn execute_tool_action(action: &ToolExecutionRequest) -> Result<String, String> {
    match action.tool_id.as_str() {
        "oracle.read_file" => {
            let content = read_project_file(&action.input)?;
            Ok(format!(
                "read_file `{}`:\n```text\n{}\n```",
                action.input,
                truncate(&content, 3500)
            ))
        }
        "oracle.list_directory" => list_project_directory(&action.input),
        "oracle.search_code" => search_project_code(&action.input),
        "legacy.grep" => legacy_grep_project(&action.input),
        "legacy.glob" => legacy_glob_project(&action.input),
        "oracle.run_command" => {
            let output = run_safe_command(&action.input);
            if output.starts_with("BLOCKED:") {
                Err(output)
            } else {
                Ok(format!("run_command `{}`:\n```text\n{}\n```", action.input, output))
            }
        }
        other => Err(format!("No executor exists for tool `{}`.", other)),
    }
}

fn list_project_directory(path: &str) -> Result<String, String> {
    let p = safe_project_path(path)?;
    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(&p).map_err(|e| e.to_string())?;
    for entry in read_dir.flatten() {
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name == ".git" || file_name == "target" {
            continue;
        }
        let suffix = if path.is_dir() { "/" } else { "" };
        entries.push(format!("{}{}", file_name, suffix));
    }
    entries.sort();
    Ok(format!(
        "list_directory `{}`:\n```text\n{}\n```",
        path,
        if entries.is_empty() { "(empty)".into() } else { entries.join("\n") }
    ))
}

fn search_project_code(term: &str) -> Result<String, String> {
    let needle = term.trim().trim_matches('"').trim_matches('\'');
    if needle.len() < 2 {
        return Err("search term must be at least 2 characters".into());
    }
    let needle_lower = needle.to_ascii_lowercase();
    let mut files = Vec::new();
    scan_dir_recursive(".", &mut files);
    let mut matches = Vec::new();
    for file in files {
        let Ok(content) = read_project_file(&file) else { continue; };
        for (idx, line) in content.lines().enumerate() {
            if line.to_ascii_lowercase().contains(&needle_lower) {
                matches.push(format!("{}:{}: {}", file, idx + 1, truncate(line.trim(), 180)));
                if matches.len() >= 40 {
                    break;
                }
            }
        }
        if matches.len() >= 40 {
            break;
        }
    }
    Ok(format!(
        "search_code `{}`:\n```text\n{}\n```",
        needle,
        if matches.is_empty() { "(no matches)".into() } else { matches.join("\n") }
    ))
}

fn legacy_grep_project(term: &str) -> Result<String, String> {
    let needle = term.trim().trim_matches('"').trim_matches('\'');
    if needle.len() < 2 {
        return Err("legacy.grep search term must be at least 2 characters".into());
    }
    let result = search_project_code(needle)?;
    Ok(result.replacen("search_code", "legacy.grep", 1))
}

fn legacy_glob_project(pattern: &str) -> Result<String, String> {
    let pattern = pattern.trim().trim_matches('"').trim_matches('\'');
    if pattern.is_empty() {
        return Err("legacy.glob needs a file pattern, like `*.rs`, `src/core/*.rs`, or `legacy/typescript_engine/src/tools/*Tool*`.".into());
    }
    if pattern.contains("..")
        || pattern.starts_with('/')
        || pattern.contains(".env")
        || pattern.contains("keys.json")
        || pattern.contains("kai-state")
    {
        return Err("legacy.glob pattern is not allowed".into());
    }

    let mut files = Vec::new();
    scan_dir_recursive(".", &mut files);
    let normalized_pattern = pattern.replace('\\', "/").to_ascii_lowercase();
    let mut matches = files
        .into_iter()
        .filter(|file| wildcard_match(&normalized_pattern, &file.to_ascii_lowercase()))
        .take(80)
        .collect::<Vec<_>>();

    if matches.is_empty() && !normalized_pattern.contains('*') {
        matches = {
            let needle = normalized_pattern.trim_start_matches("./");
            let mut files = Vec::new();
            scan_dir_recursive(".", &mut files);
            files
                .into_iter()
                .filter(|file| file.to_ascii_lowercase().contains(needle))
                .take(80)
                .collect()
        };
    }

    Ok(format!(
        "legacy.glob `{}`:\n```text\n{}\n```",
        pattern,
        if matches.is_empty() { "(no matches)".into() } else { matches.join("\n") }
    ))
}

fn wildcard_match(pattern: &str, text: &str) -> bool {
    let pattern = pattern.trim_start_matches("./");
    let text = text.trim_start_matches("./");
    if !pattern.contains('*') {
        return text.contains(pattern);
    }

    let mut remainder = text;
    let mut first = true;
    for part in pattern.split('*') {
        if part.is_empty() {
            continue;
        }
        if first && !pattern.starts_with('*') {
            if !remainder.starts_with(part) {
                return false;
            }
            remainder = &remainder[part.len()..];
        } else if let Some(idx) = remainder.find(part) {
            remainder = &remainder[idx + part.len()..];
        } else {
            return false;
        }
        first = false;
    }
    pattern.ends_with('*') || remainder.is_empty()
}

fn safe_project_path(path: &str) -> Result<std::path::PathBuf, String> {
    let p = path.trim();
    let p = if p.is_empty() { "." } else { p };
    let normalized = p.replace('\\', "/").trim_start_matches("./").to_string();
    if normalized.contains("..")
        || normalized.starts_with('/')
        || normalized.contains(".env")
        || normalized.contains("keys.json")
        || normalized.contains("kai-state")
    {
        return Err("path is not allowed".into());
    }
    Ok(std::path::PathBuf::from(if normalized.is_empty() { ".".into() } else { normalized }))
}

// â”€â”€ Test Runner â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

fn run_safe_command(command: &str) -> String {
    let allowed = ["cargo check", "cargo clippy", "cargo test", "cargo build", "dir", "ls"];
    let cmd = command.trim();
    if !allowed.iter().any(|p| cmd.starts_with(p)) {
        return format!("BLOCKED: '{}' is not in the approved command list.", cmd);
    }
    if contains_any(&cmd.to_ascii_lowercase(), &[";", "&&", "||", "|", ">", "<", "del ", "remove-item", "rm ", "rmdir", "erase", "move ", "copy ", "set-content", "out-file"]) {
        return format!("BLOCKED: '{}' contains shell control or file mutation syntax.", cmd);
    }
    let parts: Vec<&str> = cmd.split_whitespace().collect();
    if parts.is_empty() { return "empty command".into(); }
    let executable = match parts[0] {
        "ls" | "dir" => {
            if parts.len() > 1 {
                return "BLOCKED: dir/ls through run_command does not accept arguments yet. Use list_directory instead.".into();
            }
            "cmd"
        }
        other => other,
    };
    let args: Vec<&str> = if matches!(parts[0], "ls" | "dir") {
        vec!["/C", "dir"]
    } else {
        parts[1..].to_vec()
    };
    match std::process::Command::new(executable).args(&args).output() {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            let combined = format!("{}{}", stdout, stderr);
            let result = if combined.trim().is_empty() {
                format!("(exit {})", out.status.code().unwrap_or(-1))
            } else {
                combined
            };
            truncate(&result, 4000)
        }
        Err(e) => format!("Failed to run '{}': {}", cmd, e),
    }
}

// â”€â”€ Utilities â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max { return s.to_string(); }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) { end -= 1; }
    format!("{}...[truncated {} bytes]", &s[..end], s.len() - end)
}

fn load_keys() -> ApiKeys {
    for p in &["data/oracle_keys.json", "data/keys.json"] {
        if let Ok(s) = std::fs::read_to_string(p) {
            if let Ok(k) = serde_json::from_str(&s) { return k; }
        }
    }
    ApiKeys::default()
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn save_session(session: &Session) {
    let _ = std::fs::create_dir_all("data");
    let _ = std::fs::create_dir_all("data/oracle-sessions");
    let path = format!("data/oracle-sessions/{}.json", session.id);
    if let Ok(json) = serde_json::to_string_pretty(session) {
        let _ = std::fs::write(path, &json);
        let _ = std::fs::write(SESSION_PATH, json);
    }
}

fn write_json<W: std::io::Write>(mut stream: W, status: u16, message: &str, data: &serde_json::Value) -> std::io::Result<()> {
    let body = serde_json::to_string(&data).unwrap();
    let response = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n{}",
        status, message, body.len(), body
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()
}

fn write_simple<W: std::io::Write>(mut stream: W, status: u16, message: &str, body: &str) -> std::io::Result<()> {
    let response = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n{}",
        status, message, body.len(), body
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()
}


fn write_cors_preflight<W: std::io::Write>(mut stream: W) -> std::io::Result<()> {
    let response = "HTTP/1.1 204 No Content\r\n\
                    Access-Control-Allow-Origin: *\r\n\
                    Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
                    Access-Control-Allow-Headers: Content-Type\r\n\
                    Access-Control-Max-Age: 86400\r\n\r\n";
    stream.write_all(response.as_bytes())?;
    stream.flush()
}
fn load_session() -> Session {
    if let Ok(data) = std::fs::read_to_string(SESSION_PATH) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        Session::default()
    }
}

fn run_heartbeat_loop(universe: Arc<Mutex<Universe>>, session: Arc<Mutex<Session>>) {
    loop {
        std::thread::sleep(Duration::from_secs(5));
        let u = match universe.lock() {
            Ok(u) => u,
            Err(_) => continue,
        };
        let mut s = match session.lock() {
            Ok(s) => s,
            Err(_) => continue,
        };

        // Update vitals
        s.vitals.tick = 0; 
        s.vitals.phi_g = 0.0; 
        s.vitals.chi = 0.0; 
        s.vitals.rho = 0.0;
        s.vitals.mood = "engaged".into();
        s.vitals.cell_count = u.cell_count();

        drop(s);
    }
}

fn classify_turn_kind(text: &str) -> String {
    let lower = text.to_lowercase();
    if lower.contains("@") { "mention".into() }
    else if lower.contains("[test request]") { "test-request".into() }
    else if lower.contains("[read file]") { "file-request".into() }
    else if lower.contains("correction:") { "correction".into() }
    else { "thought".into() }
}
