// oracle_server.rs — KAI Oracle Roundtable
//
// Multi-AI collaborative meeting room. Any AI can speak up when it has something
// relevant to say. AIs know who KAI is, can read source files, request tests,
// question each other, and correct KAI's responses.
//
// Port: 3333
// Frontend: oracle.html

use std::net::{TcpListener, TcpStream};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH, Duration};
use serde::{Serialize, Deserialize};
use serde_json::json;
use crate::core::universe::{Universe, QueryHit};
use crate::core::field_state::FieldState;
use crate::drive::Drive;

const SESSION_PATH: &str = "data/oracle_session.json";

// ── Data Structures ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKeys {
    pub openai: Option<String>,
    pub claude: Option<String>,
    pub google: Option<String>,
    pub groq: Option<String>,
    pub xai: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Session {
    /// Short title for the meeting — set by Ryan on startup.
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
    /// Files shared into the meeting (path → content snippet).
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

// ── Request Bodies ───────────────────────────────────────────────────────────

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

// ── Server Entry Point ───────────────────────────────────────────────────────

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

// ── Request Router ───────────────────────────────────────────────────────────

fn handle_client(
    stream: &mut TcpStream,
    universe: Arc<Mutex<Universe>>,
    session: Arc<Mutex<Session>>,
) -> std::io::Result<()> {
    let mut buf = [0u8; 65536];
    let n = stream.read(&mut buf)?;
    if n == 0 { return Ok(()); }
    let req = String::from_utf8_lossy(&buf[..n]);
    let first = req.lines().next().unwrap_or("");
    let parts: Vec<&str> = first.split_whitespace().collect();
    if parts.len() < 2 { return Ok(()); }
    if parts[0] == "OPTIONS" { return write_cors_preflight(stream); }
    let body_start = req.find("\r\n\r\n").map(|i| i + 4).unwrap_or(n);
    let body = &buf[body_start..n];
    let path = parts[1].split('?').next().unwrap_or(parts[1]);

    match path {
        "/api/session"       => { let s = session.lock().unwrap(); write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap()) }
        "/api/task"          => handle_set_task(stream, body, session),
        "/api/turn"          => handle_human_turn(stream, body, session),
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
        _ => write_simple(stream, 404, "Not Found", "endpoint not found"),
    }
}

// ── Handlers ─────────────────────────────────────────────────────────────────

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

fn handle_kai_turn(
    stream: &mut TcpStream, body: &[u8],
    universe: Arc<Mutex<Universe>>,
    session: Arc<Mutex<Session>>,
) -> std::io::Result<()> {
    let req: KaiTurnRequest = serde_json::from_slice(body).unwrap_or_default();
    let task = { let s = session.lock().unwrap(); s.task.clone() };
    let hits = { let u = universe.lock().unwrap(); u.query(&format!("{} {}", task, req.hint), 5) };
    let text = synthesize_kai_voice(&task, &hits);
    let mut s = session.lock().unwrap();
    s.turns.push(Turn { ts: now(), from: "KAI".into(), text, kind: "kai".into() });
    save_session(&s);
    write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap())
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
    let models = ["GPT-4", "Gemini", "Claude", "Groq", "Researcher", "Analyst"];
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
            text: "Auto-round complete — all AIs passed, no new contributions.".into(),
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
    scan_dir_recursive("src", &mut files);
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
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid body"),
    };
    let id = now();
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
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid body"),
    };
    let (command, reason, requested_by) = {
        let mut s = session.lock().unwrap();
        match s.pending_tests.iter_mut().find(|t| t.id == req.id) {
            Some(t) => { t.status = "running".into(); (t.command.clone(), t.reason.clone(), t.requested_by.clone()) }
            None => return write_simple(stream, 404, "Not Found", "test not found"),
        }
    };
    let result = run_safe_command(&command);
    let mut s = session.lock().unwrap();
    if let Some(t) = s.pending_tests.iter_mut().find(|t| t.id == req.id) {
        t.status = "done".into();
        t.result = Some(result.clone());
    }
    let msg = format!(
        "[TEST RESULT — approved by Ryan]\nCommand: `{}`\nRequested by: {} | Reason: {}\n\n```\n{}\n```",
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
        let msg = format!("[TEST DENIED by Ryan] Command: `{}` — {}", t.command, t.reason);
        t.status = "denied".into();
        s.turns.push(Turn { ts: now(), from: "system".into(), text: msg, kind: "system".into() });
    }
    save_session(&s);
    write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap())
}

// ── Prompt Builder ───────────────────────────────────────────────────────────

fn build_meeting_prompt(sess: &Session, model: &str, vitals: &Vitals, interrupt_mode: bool) -> String {
    let title = if sess.meeting_title.is_empty() { "KAI Development Session".into() } else { sess.meeting_title.clone() };

    let mut p = format!(
"╔══ ORACLE MEETING: {title} ══╗
MISSION: {task}

╔══ WHO IS KAI ══╗
KAI is a custom Rust AI using VSA (Vector Symbolic Architecture) with 16,384-dimensional
sparse ternary vectors. His memory is a 'lattice' of cells — each cell has text, a sparse
vector, a region (memory / reasoning / established-physics / etc), a strength, and a
convergence score. KAI has NO pre-trained weights. Every response is composed from lattice
resonance. KAI learns exclusively through conversation with Ryan (his creator/admin).
He is actively under development — treat his responses as a developing system, not a finished AI.

╔══ KAI'S CURRENT STATE ══╗
  Φg Resonance : {phi:.3}
  χ  Friction  : {chi:.3}
  ρ  Density   : {rho:.3}
  Mood         : {mood}
  Lattice cells: {cells}

╔══ YOUR ROLE AS {model} ══╗
You are a collaborative technical member of this roundtable. Your responsibilities:
  1. Diagnose issues in KAI's architecture, responses, or training
  2. Question other AIs if you disagree — use '@Name: ...' to address them directly
  3. Correct KAI's responses if you spot factual errors or bad reasoning
  4. Request test runs when you need evidence (Ryan will approve or deny)
  5. Request source files when you need to see code

╔══ HOW TO USE TOOLS ══╗
  To request a test:   [TEST REQUEST]: <cargo command> :: REASON: <why>
    Example: [TEST REQUEST]: cargo check --release --bin kai :: REASON: verify epistemic scan compiles
  To request a file:   [READ FILE]: src/path/to/file.rs
    Example: [READ FILE]: src/bridge/mod.rs
  To address an AI:    @Claude: your reasoning on line 3 is wrong because...
  To correct KAI:      CORRECTION: KAI said X but the lattice shows Y

╔══ AVAILABLE TEST COMMANDS (Ryan approves) ══╗
  cargo check --release --bin kai
  cargo clippy --bin kai 2>&1 | head -60
  cargo test [test_name] -- --nocapture 2>&1 | head -100

╔══ TRANSCRIPT ══╗
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
"\n╔══ INSTRUCTION FOR {model} ══╗
This is an AUTONOMOUS ROUND. Read the transcript above carefully.
- If you have a new, specific, actionable insight — speak now.
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
        p.push_str(&format!("\nYour contribution as {model} — be specific and direct:\n", model = model));
    }

    p
}

// ── AI Response Processor ─────────────────────────────────────────────────────

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

    // Handle test requests — add to pending queue
    for (command, reason) in test_requests {
        let id = now();
        let msg = format!("[TEST REQUEST from {}]\nCommand: `{}`\nReason: {}", model, command, reason);
        s.turns.push(Turn { ts, from: model.to_string(), text: msg, kind: "test-request".into() });
        s.pending_tests.push(PendingTest {
            id, requested_by: model.to_string(), command, reason,
            status: "pending".into(), result: None,
        });
    }

    // Handle file read requests — read and share into transcript
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

fn classify_turn_kind(text: &str) -> String {
    let lower = text.to_lowercase();
    if lower.contains("correction:") || lower.starts_with("correction") { return "correction".into(); }
    if lower.starts_with('@') || lower.contains("\n@") { return "question".into(); }
    "ai".into()
}

// ── Model Dispatch ───────────────────────────────────────────────────────────

fn call_model(model: &str, keys: &ApiKeys, prompt: &str) -> Result<String, String> {
    match model {
        "GPT-4" | "GPT-4o"  => call_openai(keys, prompt, "gpt-4o-mini", 600),
        "Gemini"             => call_gemini(keys, prompt),
        "Claude"             => call_claude(keys, prompt),
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
        "Claude"            => call_claude(keys, prompt),
        _                   => call_model(model, keys, prompt),
    }
}

fn has_key_for_model(model: &str, keys: &ApiKeys) -> bool {
    match model {
        "GPT-4" | "GPT-4o" => keys.openai.is_some(),
        "Gemini"            => keys.google.is_some(),
        "Claude"            => keys.claude.is_some(),
        "Groq"              => keys.groq.is_some(),
        _                   => true, // local Ollama models
    }
}

// ── API Callers ───────────────────────────────────────────────────────────────

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

fn call_claude(keys: &ApiKeys, prompt: &str) -> Result<String, String> {
    let key = keys.claude.as_ref().ok_or("Claude key missing")?;
    let resp = ureq::post("https://api.anthropic.com/v1/messages")
        .set("x-api-key", key)
        .set("anthropic-version", "2023-06-01")
        .timeout(Duration::from_secs(45))
        .send_json(json!({
            "model": "claude-3-5-sonnet-20241022",
            "max_tokens": 1024,
            "messages": [{"role": "user", "content": prompt}]
        }))
        .map_err(|e| format!("Claude error: {:?}", e))?;
    let json: serde_json::Value = resp.into_json().map_err(|e| format!("{:?}", e))?;
    Ok(json["content"][0]["text"].as_str().unwrap_or("").to_string())
}

fn call_gemini(keys: &ApiKeys, prompt: &str) -> Result<String, String> {
    let key = keys.google.as_ref().ok_or("Google key missing")?;
    let url = format!(
        "https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key={}",
        key
    );
    let resp = ureq::post(&url)
        .timeout(Duration::from_secs(30))
        .send_json(json!({ "contents": [{"parts": [{"text": prompt}]}] }))
        .map_err(|e| format!("Gemini error: {:?}", e))?;
    let json: serde_json::Value = resp.into_json().map_err(|e| format!("{:?}", e))?;
    Ok(json["candidates"][0]["content"]["parts"][0]["text"].as_str().unwrap_or("").to_string())
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

// ── KAI Voice ────────────────────────────────────────────────────────────────

fn synthesize_kai_voice(task: &str, hits: &[QueryHit]) -> String {
    if hits.is_empty() {
        return "Lattice is quiet — no resonance found for this topic.".into();
    }
    let fragments: Vec<&str> = hits.iter().take(3).map(|h| h.text.as_str()).collect();
    format!("On '{}': {}", task, fragments.join(" | "))
}

// ── File System ──────────────────────────────────────────────────────────────

fn scan_dir_recursive(dir: &str, out: &mut Vec<String>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                scan_dir_recursive(&path.to_string_lossy().into_owned(), out);
            } else if let Some(ext) = path.extension() {
                if matches!(ext.to_str(), Some("rs") | Some("toml") | Some("md")) {
                    out.push(path.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
}

fn read_project_file(path: &str) -> Result<String, String> {
    // Safety: no directory traversal, only allow project-relative paths
    let p = path.replace('\\', "/");
    if p.contains("..") || p.starts_with('/') {
        return Err("path traversal not allowed".into());
    }
    let allowed = ["src/", "Cargo.toml", "Cargo.lock", "README", "CHANGELOG", "COGNITION"];
    let ok = allowed.iter().any(|prefix| p.starts_with(prefix) || p == *prefix);
    if !ok {
        return Err(format!("'{}' is outside allowed directories (src/, Cargo.toml)", path));
    }
    std::fs::read_to_string(&p).map_err(|e| e.to_string())
}

// ── Test Runner ───────────────────────────────────────────────────────────────

fn run_safe_command(command: &str) -> String {
    let allowed = ["cargo check", "cargo clippy", "cargo test", "cargo build"];
    let cmd = command.trim();
    if !allowed.iter().any(|p| cmd.starts_with(p)) {
        return format!("BLOCKED: '{}' is not in the approved command list.", cmd);
    }
    let parts: Vec<&str> = cmd.split_whitespace().collect();
    if parts.is_empty() { return "empty command".into(); }
    match std::process::Command::new(parts[0]).args(&parts[1..]).output() {
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

// ── Utilities ─────────────────────────────────────────────────────────────────

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
    ApiKeys { openai: None, claude: None, google: None, groq: None, xai: None }
}

fn load_session() -> Session {
    std::fs::read_to_string(SESSION_PATH)
        .and_then(|s| serde_json::from_str(&s).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)))
        .unwrap_or_default()
}

fn save_session(s: &Session) {
    if let Ok(json) = serde_json::to_string_pretty(s) {
        let _ = std::fs::create_dir_all("data");
        let _ = std::fs::write(SESSION_PATH, json);
    }
}

fn cors_headers() -> String {
    "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\n".into()
}

fn write_cors_preflight(stream: &mut TcpStream) -> std::io::Result<()> {
    stream.write_all(format!("HTTP/1.1 204 No Content\r\n{}Content-Length: 0\r\n\r\n", cors_headers()).as_bytes())
}

fn write_json(stream: &mut TcpStream, status: u16, reason: &str, val: &serde_json::Value) -> std::io::Result<()> {
    let body = val.to_string();
    stream.write_all(format!(
        "HTTP/1.1 {} {}\r\n{}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        status, reason, cors_headers(), body.len(), body
    ).as_bytes())
}

fn write_simple(stream: &mut TcpStream, status: u16, reason: &str, msg: &str) -> std::io::Result<()> {
    let body = json!({"ok": false, "error": msg}).to_string();
    stream.write_all(format!(
        "HTTP/1.1 {} {}\r\n{}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        status, reason, cors_headers(), body.len(), body
    ).as_bytes())
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn run_heartbeat_loop(u: Arc<Mutex<Universe>>, s: Arc<Mutex<Session>>) {
    let mut drive = Drive::default();
    loop {
        std::thread::sleep(Duration::from_secs(5));
        let (phi, chi, rho, mood, valence, cells) = {
            let u = u.lock().unwrap();
            let f = FieldState::compute(&u);
            drive.update(&f);
            (f.phi_g, f.chi, f.rho, drive.mood.to_string(), drive.valence, u.cell_count())
        };
        if let Ok(mut s) = s.lock() {
            s.vitals = Vitals { tick: s.vitals.tick + 1, phi_g: phi, chi, rho, valence, mood, cell_count: cells };
            save_session(&s);
        }
    }
}

// KAI v6.0.0
