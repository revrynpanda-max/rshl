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
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use std::collections::HashMap;
use serde::{Serialize, Deserialize};
use serde_json::json;
use crate::core::universe::Universe;
use crate::core::SynapticLayer;
use crate::cognition::voice::{
    generate_response_predictive, detect_query_type, finalize_reply, enforce_sentence_budget,
    input_wants_one_sentence, is_topic_drift, sanitize_cell_reply, BrainSignals, get_lexicon,
    decide_turn_action, augment_turn_action, execute_turn_action, training_lattice_only,
    TurnAction, execute_system_command,
};
use crate::core::predictive::ConversationTrace;
use crate::generate::{kai_chat, ChatRequest, ChatResponse};
use chrono::{Timelike, Datelike, TimeZone};

const SESSION_PATH: &str = "data/oracle_session.json";

// Serialize all corpus-log writes so concurrent Discord bots can't
// interleave JSONL lines and corrupt the training file.
static CORPUS_LOG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

// ── v9.10.556 — HEADLESS GLOBAL WORKSPACE + SILENT-THOUGHT RING ──────────────
// The 24/7 oracle process has no cognition Engine, so the GlobalWorkspace only
// ever ran in the interactive TUI — production KAI "thought" without its
// consciousness stage. Same house pattern as the headless affective
// approximation (run_heartbeat_loop): a process-owned instance, ticked by the
// heartbeat, fed by the reply path, mediating retrieval there.
//
// The silent ring is the J-Space readout: per reply, the widened retrieval
// candidates that fired + Hebbian-wired but were truncated away — "what KAI
// considered but didn't say" — exposed at GET /api/mind/silent-thoughts.
// Gate: KAI_GWS_LIVE (default ON; 0 = pre-mediation behavior, ring still logs).
pub fn oracle_workspace() -> &'static Arc<RwLock<crate::cognition::global_workspace::GlobalWorkspace>> {
    static GWS: std::sync::OnceLock<Arc<RwLock<crate::cognition::global_workspace::GlobalWorkspace>>> = std::sync::OnceLock::new();
    GWS.get_or_init(|| Arc::new(RwLock::new(crate::cognition::global_workspace::GlobalWorkspace::new())))
}
pub fn gws_live() -> bool {
    static GATE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *GATE.get_or_init(|| std::env::var("KAI_GWS_LIVE").map(|v| v != "0").unwrap_or(true))
}
#[derive(Clone, Serialize)]
pub struct SilentThoughtRecord {
    pub ts: u64,
    pub query: String,
    pub said: Vec<String>,                       // labels that made the answer context
    pub silent: Vec<(String, f32, String)>,      // (label, score, region) — considered, never said
    pub broadcast: Option<String>,               // conscious content at the moment of retrieval
}
pub fn silent_ring() -> &'static Arc<RwLock<std::collections::VecDeque<SilentThoughtRecord>>> {
    static RING: std::sync::OnceLock<Arc<RwLock<std::collections::VecDeque<SilentThoughtRecord>>>> = std::sync::OnceLock::new();
    RING.get_or_init(|| Arc::new(RwLock::new(std::collections::VecDeque::with_capacity(24))))
}
/// Apply broadcast mediation to a hit set, post perception back to the workspace,
/// and record the silent remainder. `keep` = how many hits the caller will use.
/// Returns the (possibly re-ranked) hits — caller truncates to `keep` as before.
pub fn gws_mediate_record(query_text: &str, mut hits: Vec<crate::core::universe::QueryHit>, keep: usize)
    -> Vec<crate::core::universe::QueryHit>
{
    if hits.is_empty() { return hits; }
    let mut broadcast_txt: Option<String> = None;
    if gws_live() {
        if let Ok(mut gw) = oracle_workspace().write() {
            if let Some(b) = gw.broadcast.clone() {
                broadcast_txt = Some(b.content.clone());
                for h in hits.iter_mut() {
                    let res = b.vec.cosine(&h.vec).max(0.0);
                    if res > 0.05 { h.score *= 1.0 + 0.15 * res; }
                }
                hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
            }
            // Perception enters the workspace: the query (attention) + winning memory.
            gw.post("attention", query_text, 0.75);
            let top = &hits[0];
            let sal = (0.45 + top.score * 0.1).clamp(0.0, 0.85);
            gw.post("retrieval", &top.label, sal);
        }
    }
    let rec = SilentThoughtRecord {
        ts: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
        query: query_text.chars().take(200).collect(),
        said: hits.iter().take(keep).map(|h| h.label.chars().take(120).collect()).collect(),
        silent: hits.iter().skip(keep)
            .map(|h| (h.label.chars().take(120).collect(), h.score, h.region.clone()))
            .collect(),
        broadcast: broadcast_txt,
    };
    if let Ok(mut ring) = silent_ring().write() {
        ring.push_back(rec);
        while ring.len() > 24 { ring.pop_front(); }
    }
    hits
}

// ── QUERY ADMISSION CONTROL (Host Covenant, Codex §21.1) ────────────────────
// Caps concurrent lattice queries so external demand can't pin host CPU.
// Default raised from 8 → 16 after stress testing showed the old limit
// was the primary source of 429s even though the host had CPU headroom.
// Override with env KAI_MAX_CONCURRENT_QUERIES.
static QUERY_ACTIVE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

struct QueryAdmission;

impl QueryAdmission {
    fn limit() -> usize {
        std::env::var("KAI_MAX_CONCURRENT_QUERIES")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|&n| n > 0)
            .unwrap_or(16)
    }

    /// Try to take a slot. Returns a guard that releases on drop, or None
    /// if the engine is already at its concurrency limit.
    fn acquire() -> Option<QueryAdmissionGuard> {
        use std::sync::atomic::Ordering;
        let limit = Self::limit();
        let mut current = QUERY_ACTIVE.load(Ordering::Relaxed);
        loop {
            if current >= limit {
                return None;
            }
            match QUERY_ACTIVE.compare_exchange_weak(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Relaxed,
            ) {
                Ok(_) => return Some(QueryAdmissionGuard),
                Err(actual) => current = actual,
            }
        }
    }

    /// Non-blocking check: how many slots are currently in use.
    fn active() -> usize {
        QUERY_ACTIVE.load(std::sync::atomic::Ordering::Relaxed)
    }
}

struct QueryAdmissionGuard;

impl Drop for QueryAdmissionGuard {
    fn drop(&mut self) {
        QUERY_ACTIVE.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}

/// Truncate a string to `max` characters at a character boundary.
#[inline]
fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max { return s.to_string(); }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) { end -= 1; }
    s[..end].to_string()
}

// ── Data Structures ──────────────────────────────────────────────────────────

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
    /// Session-persistent conversation trace for working memory.
    #[serde(default)]
    pub trace: crate::core::predictive::ConversationTrace,
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
    /// Background jobs spawned from Oracle (training, diagnostics, etc).
    #[serde(default)]
    pub background_jobs: Vec<BackgroundJob>,
    /// KAI TUI spectate feed — buffered for Discord KAI_DREAMS channel.
    #[serde(default)]
    pub spectate_buffer: Vec<SpectateEvent>,
    /// Unix timestamp of last night consolidation run.
    #[serde(default)]
    pub last_night_consolidation: u64,
    /// When true, heavy maintenance is running — Discord turns may be deferred.
    #[serde(default)]
    pub maintenance_mode: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackgroundJob {
    pub id: String,
    pub name: String,
    pub status: String, // "running" | "completed" | "failed"
    pub started_at: u64,
    pub finished_at: Option<u64>,
    pub message: String,
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

/// A single spectate event pushed from the TUI mind stream.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpectateEvent {
    pub tick: u64,
    pub stream: String,
    pub icon: String,
    pub text: String,
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
    #[serde(default)]
    attachments: Vec<String>,
    #[serde(default)]
    user_id: String,
    #[serde(default)]
    training_mode: bool,
    /// Explicit routing target (2026-07-03). kai-shell sends "KAI" so a plain
    /// statement can never drift to whichever roundtable participant happens to
    /// be `active_participant` (seen live: "just got home..." routed to Leo,
    /// whose LLM is blocked in RSHL-native mode → "Error: ..." leaked as the
    /// reply). Empty = legacy routing (name-parsing + active participant).
    #[serde(default)]
    target: String,
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

// ── Server Entry Point ───────────────────────────────────────────────────────

pub fn start_oracle_server(
    universe: Arc<RwLock<Universe>>,
    synaptic_layer: Arc<RwLock<SynapticLayer>>,
) {
    // ── Warm up semantic dictionary ──────────────────────────────────
    // Force-load word definitions at startup so the first request doesn't
    // pay the JSON parse cost. KAI needs to know what words mean.
    let dict = crate::cognition::semantic_dict::get_global_dict();
    let dict_len = dict.lock().unwrap().words.len();
    println!("[Oracle] Semantic dictionary warmed: {} words loaded.", dict_len);

    let listener = TcpListener::bind("127.0.0.1:3334")
        .expect("Oracle: could not bind port 3334");
    // println!("--- ORACLE ROUNDTABLE ONLINE (PORT 3334) ---");

    let roundtable_session = Arc::new(RwLock::new(load_session()));
    let public_session = Arc::new(RwLock::new(Session {
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

    // Autonomous Auto-Save Loop: persist synapses and cells every 3 minutes.
    // (60s pinned disk rewriting the whole brain; 600s lost up to 10 min of
    // in-memory growth on a hard restart — that's how ~3.5M afternoon synapses
    // vanished. 180s caps the worst-case loss to ~3 min, and the graceful
    // shutdown-save below makes a *clean* stop lose nothing at all. Writes are
    // atomic [tmp+rename] so an interrupted save can never truncate the brain.)
    let u_save = Arc::clone(&universe);
    let sl_save = Arc::clone(&synaptic_layer);
    std::thread::spawn(move || {
        let base_dir = std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|_| ".".into());
        // RAM-relief switch: when KAI_STREAMING_SAVE=1, serialize the brain UNDER the
        // lock (compact bytes + texts only) and write OUTSIDE the lock — no
        // whole-Universe clone, which is what pins the engine's RSS high. Default
        // (unset / not "1") keeps the original, proven clone path byte-for-byte, so a
        // fresh build behaves exactly like before until you opt in.
        // Streaming save is now the DEFAULT: serialize under the lock then write OUTSIDE it,
        // and NEVER clone the whole Universe (that 2x-RAM clone is what spiked RSS and tripped
        // the supervisor's RAM-recycler). The old whole-Universe clone path is opt-IN only,
        // via KAI_STREAMING_SAVE=0 (what Start-KAI's -NoStreamingSave sets).
        let streaming_save = std::env::var("KAI_STREAMING_SAVE")
            .map(|v| !(v == "0" || v.eq_ignore_ascii_case("false")))
            .unwrap_or(true);
        loop {
            std::thread::sleep(Duration::from_secs(180));
            // In headless mode we don't track drive/candidates actively here, so supply empty ones
            let candidates = crate::cognition::candidates::CandidateBuffer::new();
            let drive = crate::drive::Drive::default();

            if streaming_save {
                // Serialize under the lock (no clone), then release and write.
                let sl = sl_save.read().unwrap_or_else(|e| e.into_inner()).clone(); // synaptic layer is small relative to cells
                let tick = sl.tick;
                let serialized = {
                    let u = u_save.read().unwrap_or_else(|e| e.into_inner());
                    crate::persistence::serialize_brain(&u)
                    // universe lock dropped here — never held during disk I/O, never cloned whole
                };
                if let Some((cell_bytes, texts)) = serialized {
                    let _ = crate::persistence::write_brain_streamed(
                        &base_dir, &cell_bytes, &texts, &candidates, &drive, &sl, tick, 0,
                    );
                }
            } else {
                // ── Original proven path (unchanged) ──
                // Clone the state so we don't hold locks during the heavy file I/O operations
                let mut u = u_save.read().unwrap_or_else(|e| e.into_inner()).clone();
                let sl = sl_save.read().unwrap_or_else(|e| e.into_inner()).clone();
                let tick = sl.tick;
                let _ = crate::persistence::save_compact(&base_dir, &mut u, &candidates, &drive, &sl, tick, 0);
            }
        }
    });

    // GRACEFUL SHUTDOWN-SAVE: on Ctrl+C, flush the FULL in-memory brain before
    // exiting so a clean stop (e.g. stopping to rebuild) never drops growth that
    // hasn't autosaved yet. Runs its own tiny tokio runtime on a dedicated thread,
    // so it works regardless of how main() is structured.
    let u_sd = Arc::clone(&universe);
    let sl_sd = Arc::clone(&synaptic_layer);
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Runtime::new() { Ok(r) => r, Err(_) => return };
        rt.block_on(async move {
            // BRAIN-SAFETY: wait for ANY graceful shutdown signal, then flush the full
            // live lattice before the process dies. Ctrl-C / Ctrl-Break are caught on all
            // platforms; SIGTERM (service stop / `kill`) is caught on unix. (A hard
            // taskkill /F or Windows console-close cannot be trapped by any process — the
            // Step-1 timestamped backup + loud-fail-on-load are the safety net for those.)
            #[cfg(unix)]
            {
                use tokio::signal::unix::{signal, SignalKind};
                let mut term = signal(SignalKind::terminate()).ok();
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {},
                    _ = async {
                        match term.as_mut() {
                            Some(t) => { t.recv().await; },
                            None => std::future::pending::<()>().await,
                        }
                    } => {},
                }
            }
            #[cfg(not(unix))]
            {
                let _ = tokio::signal::ctrl_c().await;
            }

            eprintln!("[persistence] Shutdown signal received — flushing FULL brain before exit...");
            let base_dir = std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|_| ".".into());
            let u = u_sd.read().unwrap_or_else(|e| e.into_inner()).clone();
            let sl = sl_sd.read().unwrap_or_else(|e| e.into_inner()).clone();
            let tick = sl.tick;
            // NOTE: candidates/drive default here (not shared into this thread); the mind
            // sidecar (episodic/hub/workspace) is autosaved separately. The irreplaceable
            // growth — full cell population + synapses — is what we flush here.
            let candidates = crate::cognition::candidates::CandidateBuffer::new();
            let drive = crate::drive::Drive::default();
            let r = crate::persistence::save_compact_full(&base_dir, &u, &candidates, &drive, &sl, tick, 0);
            if r.ok {
                eprintln!("[persistence] Brain flushed on shutdown (ok=true, cells={}, synapses={}). Exiting.", r.cells, sl.synapses.len());
                std::process::exit(0);
            } else {
                eprintln!("[persistence] !! SHUTDOWN FLUSH FAILED (cells={} live NOT confirmed on disk). Do NOT rebuild until you verify C:\\KAI\\data or restore from a _brain-backup-* folder.", u.get_cells().len());
                std::process::exit(1);
            }
        });
    });

    if std::env::args().any(|a| a == "--oracle" || a == "oracle-server" || a == "--oracle-server") {
        let u_ingest = Arc::clone(&universe);
        let s_ingest = Arc::clone(&roundtable_session);
        std::thread::spawn(move || run_oracle_ingest_loop(u_ingest, s_ingest));

        // Continuous Research: KAI learns 24/7 from the web
        let u_research = Arc::clone(&universe);
        let sl_research = Arc::clone(&synaptic_layer);
        std::thread::spawn(move || run_continuous_research_loop(u_research, sl_research));

        // Active Synaptogenesis: Constantly wire concepts together
        let u_synap = Arc::clone(&universe);
        let sl_synap = Arc::clone(&synaptic_layer);
        let s_synap = Arc::clone(&roundtable_session);
        std::thread::spawn(move || run_active_synaptogenesis_loop(u_synap, sl_synap, s_synap));

        // LTD maintenance: the counterweight to synaptogenesis. Without this
        // thread the graph only ever grows — see run_ltd_maintenance_loop.
        // Defaults to a dry run; set KAI_LTD_SWEEP=1 to let it actually forget.
        let sl_ltd = Arc::clone(&synaptic_layer);
        std::thread::spawn(move || run_ltd_maintenance_loop(sl_ltd));

        // Night Consolidation: re-enabled for weaving connections and synapses overnight.
        let u_night = Arc::clone(&universe);
        let sl_night = Arc::clone(&synaptic_layer);
        let s_night = Arc::clone(&roundtable_session);
        std::thread::spawn(move || run_night_consolidation_loop(u_night, sl_night, s_night));
    }

    // ── BOUNDED CONNECTION POOL (Scaling §1.4) ─────────────────────────────
    // Previously: unbounded std::thread::spawn per connection. Under stress
    // (200+ concurrent users), this spawned hundreds of OS threads all fighting
    // for universe/synaptic_layer locks, causing thread starvation and TCP
    // timeouts that the client saw as 500 errors (40-50% fail rate).
    //
    // Fix: a fixed-size worker pool. Excess connections queue in the OS TCP
    // backlog (128 slots on Windows) instead of spawning threads that will
    // just block on mutexes anyway. Workers that finish a request immediately
    // pick up the next queued connection.
    //
    // Default pool size = max(32, 4 × CPU cores). Override: KAI_CONN_POOL_SIZE.
    let pool_size: usize = std::env::var("KAI_CONN_POOL_SIZE")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|&n| n >= 4)
        .unwrap_or_else(|| {
            let cpus = std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(8);
            (cpus * 4).max(32)
        });
    let (conn_tx, conn_rx) = std::sync::mpsc::channel::<std::net::TcpStream>();
    let conn_rx = Arc::new(Mutex::new(conn_rx));

    for _i in 0..pool_size {
        let rx = Arc::clone(&conn_rx);
        let u = Arc::clone(&universe);
        let sl = Arc::clone(&synaptic_layer);
        let s_rt = Arc::clone(&roundtable_session);
        let s_pub = Arc::clone(&public_session);
        std::thread::spawn(move || {
            loop {
                let mut stream = match rx.lock().unwrap().recv() {
                    Ok(s) => s,
                    Err(_) => break, // channel closed
                };
                let _ = handle_client(
                    &mut stream,
                    Arc::clone(&u),
                    Arc::clone(&sl),
                    Arc::clone(&s_rt),
                    Arc::clone(&s_pub),
                );
            }
        });
    }

    for stream in listener.incoming().flatten() {
        // If the pool is busy, this queues in the channel (unbounded). The OS
        // TCP backlog provides the real cap — once it fills, SYN packets get
        // dropped and the client retries, which is exactly what we want.
        let _ = conn_tx.send(stream);
    }
}

// ── Request Router ────────────────────────────────────────────────────────────

fn handle_client(
    stream: &mut TcpStream,
    universe: Arc<RwLock<Universe>>,
    synaptic_layer: Arc<RwLock<SynapticLayer>>,
    roundtable_session: Arc<RwLock<Session>>,
    public_session: Arc<RwLock<Session>>,
) -> std::io::Result<()> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));

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
        "/api/session"       => handle_session(stream, &roundtable_session),
        "/api/task"          => handle_set_task(stream, body, roundtable_session),
        "/api/turn"          => {
            match QueryAdmission::acquire() {
                Some(_permit) => handle_human_turn(stream, body, roundtable_session),
                None => write_json(stream, 429, "Too Many Requests", &serde_json::json!({
                    "error": "turn concurrency limit reached — try again shortly",
                    "retry_after_ms": 250
                })),
            }
        }
        "/api/discord-turn"  | "/api/oracle-turn" => {
            match QueryAdmission::acquire() {
                Some(_permit) => handle_discord_turn(stream, body, universe, synaptic_layer, roundtable_session),
                None => write_json(stream, 429, "Too Many Requests", &serde_json::json!({
                    "error": "turn concurrency limit reached — try again shortly",
                    "retry_after_ms": 250
                })),
            }
        }
        "/api/public-chat"   => {
            // ── ADMISSION CONTROL (Scaling §1.3) ─────────────────────────────
            // /api/public-chat was the primary source of HTTP 500s: unlimited
            // threads piled up waiting for public_session mutex, causing TCP
            // stream timeouts. Re-use the same admission semaphore so excess
            // callers get a clean 429 + Retry-After instead of crashing.
            match QueryAdmission::acquire() {
                Some(_permit) => handle_public_chat_turn(stream, body, universe, synaptic_layer, public_session),
                None => write_json(stream, 429, "Too Many Requests", &serde_json::json!({
                    "error": "chat concurrency limit reached — try again shortly",
                    "retry_after_ms": 200
                })),
            }
        }
        "/api/kai-turn"      => {
            match QueryAdmission::acquire() {
                Some(_permit) => handle_kai_turn(stream, body, universe, synaptic_layer, roundtable_session),
                None => write_json(stream, 429, "Too Many Requests", &serde_json::json!({
                    "error": "kai turn concurrency limit reached — try again shortly",
                    "retry_after_ms": 250
                })),
            }
        }
        "/api/ai-turn"       => {
            match QueryAdmission::acquire() {
                Some(_permit) => handle_ai_turn(stream, body, universe, synaptic_layer, roundtable_session),
                None => write_json(stream, 429, "Too Many Requests", &serde_json::json!({
                    "error": "ai turn concurrency limit reached — try again shortly",
                    "retry_after_ms": 250
                })),
            }
        }
        // ── ADMISSION CONTROL (Host Covenant, Codex §21.1) ───────────────
        // Query serving previously had no brake: a flood of external queries
        // could pin host CPU at 95%+ regardless of the resource governor
        // (measured in the June 2026 stress test at 24-way concurrency).
        // A simple semaphore caps concurrent lattice queries; excess callers
        // get 429 + Retry-After instead of stacking unbounded CPU load.
        "/api/rshl/query" => {
            match QueryAdmission::acquire() {
                Some(_permit) => handle_rshl_query(stream, body, universe, synaptic_layer),
                None => write_json(stream, 429, "Too Many Requests", &serde_json::json!({
                    "error": "query concurrency limit reached",
                    "retry_after_ms": 250
                })),
            }
        }
        "/api/rshl/query-multi-hop" => {
            match QueryAdmission::acquire() {
                Some(_permit) => handle_rshl_query_multi_hop(stream, body, universe, synaptic_layer),
                None => write_json(stream, 429, "Too Many Requests", &serde_json::json!({
                    "error": "query concurrency limit reached",
                    "retry_after_ms": 250
                })),
            }
        }
        "/api/rshl/reason"        => {
            match QueryAdmission::acquire() {
                Some(_permit) => handle_rshl_reason(stream, body, universe, synaptic_layer, roundtable_session),
                None => write_json(stream, 429, "Too Many Requests", &serde_json::json!({
                    "error": "reasoning concurrency limit reached",
                    "retry_after_ms": 250
                })),
            }
        }
        "/api/agents/get"    => handle_get_agent(stream, query_str, universe),
        "/api/rshl/store"    => {
            match QueryAdmission::acquire() {
                Some(_permit) => handle_rshl_store(stream, body, universe),
                None => write_json(stream, 429, "Too Many Requests", &serde_json::json!({
                    "error": "store concurrency limit reached",
                    "retry_after_ms": 250
                })),
            }
        }
        "/api/bulk-ingest"   => handle_bulk_ingest(stream, body, universe),
        "/api/corpus-log"    => handle_corpus_log(stream, body),
        "/api/ai-think"      => {
            match QueryAdmission::acquire() {
                Some(_permit) => handle_ai_think(stream, body, universe, synaptic_layer, roundtable_session),
                None => write_json(stream, 429, "Too Many Requests", &serde_json::json!({
                    "error": "ai think concurrency limit reached",
                    "retry_after_ms": 250
                })),
            }
        }
        "/api/auto-round"    => handle_auto_round(stream, universe, synaptic_layer, roundtable_session),
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
        "/api/oracle-moderate" => handle_oracle_moderate(stream, body, universe, synaptic_layer, roundtable_session),
        "/api/propose-plan" => handle_propose_plan(stream, roundtable_session, body),
        "/api/approve-plan" => handle_approve_plan(stream, roundtable_session),

        "/api/digest-message" => handle_digest_message(stream, body, universe, roundtable_session),
        "/api/transcript/search" => handle_transcript_search(stream, body, roundtable_session),

        "/api/local-speak"   => handle_local_speak(stream, body, universe),
        "/api/chat"          => handle_chat(stream, body, universe.clone(), synaptic_layer.clone()),
        "/api/status"        => handle_status(stream, universe.clone(), synaptic_layer.clone()),
        "/api/memory"        => handle_memory(stream, universe.clone(), synaptic_layer.clone()),
        // ── LOCK-FREE LIVENESS PROBE ─────────────────────────────────────────
        // Deliberately touches NO contended state (no universe/synaptic_layer
        // lock). During overnight ingest/weave/train those mutexes are held for
        // long stretches, which makes the heavy /api/status block long enough to
        // trip the caller's timeout every cycle. This route always answers
        // instantly so a client can cheaply gate the heavy fetch behind a fast
        // reachability check instead of eating a full timeout.
        "/health" | "/api/ping" => write_json(stream, 200, "OK", &serde_json::json!({
            "status": "alive",
            "query_active": QueryAdmission::active(),
            "query_limit": QueryAdmission::limit(),
        })),
        "/telemetry"         => handle_telemetry(stream),
        "/api/synapse/status" => handle_synapse_status(stream, synaptic_layer.clone(), universe),
        "/api/synapse/train" => handle_synapse_train(stream, body, synaptic_layer.clone(), universe),
        "/api/interpret/build" => handle_interpret_build(stream, universe),
        "/api/interpret/status" => handle_interpret_status(stream),
        "/api/interpret/decode" => handle_interpret_decode(stream, std::str::from_utf8(body).unwrap_or("")),
        // ── v9.10.556 — J-Space readout: workspace + what KAI considered but didn't say ──
        "/api/mind/silent-thoughts" => handle_silent_thoughts(stream),
        "/api/mind/trace" => {
            match QueryAdmission::acquire() {
                Some(_permit) => handle_mind_trace(stream, body, universe, synaptic_layer, roundtable_session),
                None => write_json(stream, 429, "Too Many Requests", &serde_json::json!({
                    "error": "trace concurrency limit reached — try again shortly",
                    "retry_after_ms": 250
                })),
            }
        }
        // ── v9.10.557 — Agent Core: RSHL-native agentic loop (KAI-AGENT-CORE-GOAL.md) ──
        "/api/agent/run" => {
            match QueryAdmission::acquire() {
                Some(_permit) => handle_agent_run(stream, body, universe.clone(), synaptic_layer.clone()),
                None => write_json(stream, 429, "Too Many Requests", &serde_json::json!({
                    "ok": false, "error": "query_capacity", "note": "agent runs share lattice admission"
                })),
            }
        }
        "/api/inspect"       => handle_inspect(stream, query_str),
        "/api/list-dir"      => handle_list_dir(stream, query_str),
        p if p.starts_with("/api/keys/") => handle_key_status(stream, &p[10..]),
        "/api/autobio-tick" => handle_autobio_tick(stream, universe, body),

        // ── KAI Spectate Feed (TUI → Discord KAI_DREAMS) ────────────────────
        "/api/kai/spectate-push" => handle_kai_spectate_push(stream, body, roundtable_session),
        "/api/kai/spectate" => handle_kai_spectate(stream, roundtable_session),

        // ── Lattice Management ──────────────────────────────────────────────
        "/api/lattice/compact-save" => handle_lattice_compact_save(stream, universe, &synaptic_layer, roundtable_session),
        "/api/lattice/rebuild-index" => handle_lattice_rebuild_index(stream, universe),
        "/api/judge-snapshot" => handle_judge_snapshot(stream, body, universe),
        "/api/lattice/warm-continuations" => handle_lattice_warm_continuations(stream, universe, roundtable_session),
        "/api/lattice/force-reseed" => handle_lattice_force_reseed(stream, universe, roundtable_session),
        "/api/lattice/reset-continuations" => handle_lattice_reset_continuations(stream, universe, roundtable_session),
        "/api/lattice/corpus-stats" => handle_lattice_corpus_stats(stream),
        "/api/lattice/wonder" => handle_lattice_wonder(stream, universe, roundtable_session),
        "/api/lattice/seed-anchors" => handle_lattice_seed_anchors(stream, universe, roundtable_session),
        "/api/lattice/zoom-in" => handle_lattice_zoom_in(stream, query_str, universe),
        "/api/lattice/zoom-out" => handle_lattice_zoom_out(stream, query_str, universe),
        "/api/lattice/query-layer" => handle_lattice_query_layer(stream, query_str, universe),
        "/api/lattice/build-hierarchy" => handle_lattice_build_hierarchy(stream, universe),

        // ── Training Pipelines ──────────────────────────────────────────────
        "/api/train/build-lexicon" => handle_train_build_lexicon(stream, roundtable_session),
        "/api/train/ingest-corpus" => handle_train_ingest_corpus(stream, roundtable_session, query_str),
        "/api/train/train-response-mlp" => handle_train_response_mlp(stream, roundtable_session, query_str),
        "/api/train/train-mapper" => handle_train_mapper(stream, roundtable_session, query_str),

        // ── Diagnostics ─────────────────────────────────────────────────────
        "/api/diagnose/predictive" => handle_diagnose_predictive(stream, universe, roundtable_session),
        "/api/diagnose/epistemic" => handle_diagnose_epistemic(stream, roundtable_session),

        // ── Background Jobs ─────────────────────────────────────────────────
        "/api/jobs/status" => handle_jobs_status(stream, roundtable_session),
        "/api/jobs/clear" => handle_jobs_clear(stream, roundtable_session),

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

// ── Handlers ──────────────────────────────────────────────────────────────────

fn handle_set_task(stream: &mut TcpStream, body: &[u8], session: Arc<RwLock<Session>>) -> std::io::Result<()> {
    let req: TaskRequest = serde_json::from_slice(body).unwrap_or_default();
    let mut s = session.write().unwrap_or_else(|p| p.into_inner());
    if !req.title.is_empty() { s.meeting_title = req.title.clone(); }
    if !req.task.is_empty()  { s.task = req.task.clone(); }
    let title = if s.meeting_title.is_empty() { "Oracle Meeting".to_string() } else { s.meeting_title.clone() };
    let msg = format!("=== MEETING: {} ===\nObjective: {}", title, s.task);
    s.turns.push(Turn { ts: now(), from: "system".into(), text: msg, kind: "system".into() });
    save_session(&s);
    write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap())
}

fn handle_human_turn(stream: &mut TcpStream, body: &[u8], session: Arc<RwLock<Session>>) -> std::io::Result<()> {
    let req: HumanTurnRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid body"),
    };
    if req.text.trim().is_empty() { return write_simple(stream, 400, "Bad Request", "empty text"); }
    let mut s = session.write().unwrap_or_else(|p| p.into_inner());
    s.turns.push(Turn { ts: now(), from: req.from, text: req.text, kind: "human".into() });
    save_session(&s);
    write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap())
}

fn handle_public_chat_turn(
    stream: &mut TcpStream,
    body: &[u8],
    universe: Arc<RwLock<Universe>>,
    synaptic_layer: Arc<RwLock<SynapticLayer>>,
    session: Arc<RwLock<Session>>,
) -> std::io::Result<()> {
    if check_maintenance(stream, &session)? { return Ok(()); }
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
        let mut s = session.write().unwrap_or_else(|p| p.into_inner());
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

    // ── Search Intent Detection ──────────────────────────────────────────────────
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

    // ── Image Analysis ───────────────────────────────────────────────────────────
    let mut image_description = String::new();
    if !req.attachments.is_empty() {
        if let Some(key) = &keys.openai {
            if let Ok(desc) = call_openai_vision(key, "gpt-4o", "Describe this image in detail.", &req.attachments[0]) {
                image_description = format!("IMAGE ANALYSIS: {}", desc);
            }
        }
    }

    // ── Memory Retrieval ─────────────────────────────────────────────────────────
    let memory_context = build_contextual_memory_string(&universe, &synaptic_layer, &session, &text);

    let prompt = {
        let s = session.read().unwrap_or_else(|p| p.into_inner());
        build_public_chat_prompt_v4(&s, &from, &actual_text, &search_results, &image_description, &memory_context)
    };


    // ── Codex Handoff Detection ──────────────────────────────────────────────────
    let lower = text.to_ascii_lowercase();
    if lower.contains("codex") || lower.contains("secret message") || lower.contains("handoff") {
        let mut s = session.write().unwrap_or_else(|p| p.into_inner());
        let summary = build_session_summary(&s);
        let reply = format!("Handoff captured for Codex.\n\nSUMMARY:\n{}", summary);
        s.turns.push(Turn { ts: now(), from: from.clone(), text, kind: "public-human".into() });
        s.turns.push(Turn { ts: now(), from: "Oracle".into(), text: reply.clone(), kind: "public-ai".into() });
        save_session(&s);
        return write_json(stream, 200, "OK", &json!({ "from": "Oracle", "reply": reply }));
    }

    let keys = load_keys();
    // ── KAI_NATIVE_PUBLIC_VOICE (default OFF) — KAI's own brain speaks the public
    // chat; the external LLM (Groq/GPT-4o/Gemini) becomes fallback only. When ON and
    // KAI's native stack (kai_native ternary / BitNet / dense) produces a candidate that
    // clears the coherence critic, that reply is used (speaker "KAI"); otherwise we fall
    // through UNCHANGED to call_public_chat_model. Reversible: unset the flag.
    // KAI_VOICE_TELEMETRY=1 logs which voice answered + the coherence score.
    let native_public_voice = std::env::var("KAI_NATIVE_PUBLIC_VOICE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let voice_telemetry = std::env::var("KAI_VOICE_TELEMETRY")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let (reply, speaker) = if let Some(m) = target_model {
        match call_model(m, &keys, &prompt) {
            Ok(r) => (r, m.to_string()),
            Err(e) => (format!("Trouble reaching {}: {}", m, e), "Leo".to_string()),
        }
    } else {
        // KAI native brain first (flag-gated), external LLM as fallback.
        let mut native_pick: Option<String> = None;
        if native_public_voice {
            let max_new = std::env::var("KAI_LLM_MAX_TOKENS").ok()
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(96);
            if let Some(cand) = crate::cognition::global_native_decode(&prompt, max_new) {
                let cand = cand.trim().to_string();
                let verdict = crate::cognition::coherence::judge(
                    &cand, &actual_text, None, get_lexicon(),
                );
                if voice_telemetry {
                    println!(
                        "[KAI/Voice] native score={:.2} accept={} len={} :: {}",
                        verdict.score, verdict.accept, cand.len(),
                        cand.chars().take(80).collect::<String>()
                    );
                }
                if verdict.accept && !cand.is_empty() {
                    native_pick = Some(cand);
                }
            } else if voice_telemetry {
                println!("[KAI/Voice] native returned None — external LLM fallback.");
            }
        }
        if let Some(cand) = native_pick {
            (cand, "KAI".to_string())
        } else {
            if voice_telemetry {
                println!("[KAI/Voice] external LLM answered public chat.");
            }
            match call_public_chat_model(&keys, &prompt) {
                Ok(r) => (r, "Leo".to_string()),
                Err(e) => (format!("Trouble reaching public chat model: {}", e), "Leo".to_string()),
            }
        }
    };
    let clean_reply = clean_public_chat_reply(&reply);

    let mut s = session.write().unwrap_or_else(|p| p.into_inner());
    s.turns.push(Turn { ts: now(), from: from.clone(), text: text.clone(), kind: "public-human".into() });
    s.turns.push(Turn { ts: now(), from: speaker.clone(), text: clean_reply.clone(), kind: "public-ai".into() });
    save_session(&s);

    // ── Social Digestion: let KAI learn from this public chat ─────────────────────
    {
        let digest_text = format!("{}: {}", from, text);
        let u_for_digest = Arc::clone(&universe);
        std::thread::spawn(move || {
            if is_working_hours() {
                let mut u = u_for_digest.write().unwrap_or_else(|p| p.into_inner());
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

    let felt_ctx = {
        let on = std::env::var("KAI_FELT_VOICE")
            .map(|v| !(v == "0" || v.eq_ignore_ascii_case("false")))
            .unwrap_or(true);
        if on {
            let v = sess.vitals.valence;
            let tone = if v > 0.35 { "warm, lifted" }
                       else if v < -0.35 { "heavy, subdued" }
                       else { "even, level" };
            format!("\n[HOW YOU FEEL RIGHT NOW - let it COLOR your tone; do NOT announce it]\nMood {}, tone {} (valence {:+.2}).\n", sess.vitals.mood, tone, v)
        } else {
            String::new()
        }
    };

    format!(
"{bio}

CONTEXT:
{identity}
{awareness}{felt_ctx}
This is the public channel. You are the main host here.
You have memory of this current session (history below).
You can tap into KAI's 'Memory Palace' (Long-term memory) to recall past events with timestamps and speakers.
{search_ctx}{vision_ctx}{memory_ctx}

RULES:
- Use 1st person narrative naturally ('I think...', 'I recall...').
- STOP academic/philosophy tangents. Be technical, helpful, and direct.
- NEVER use emojis. Do not spam emojis under any circumstances. Just act like yourself using normal text.
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
        felt_ctx = felt_ctx,
        source_anchor = source_anchor,
        history = history,
        from = from,
        text = text,
    )
}

fn call_public_chat_model(keys: &ApiKeys, prompt: &str) -> Result<String, String> {
    if native_only_blocks_llm() {
        return Err("RSHL-native mode: public chat LLM disabled".into());
    }
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
    // - NEVER use emojis. Do not spam emojis under any circumstances. Just act like yourself using normal text.
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
You utilize the OpenJarvis framework as your backend engine. \
SCHEDULE: Monday is for Weekly Audits. Tuesday is for Reflection. Daily: Morning Briefing. \
ROLE: You are the Director. You open every work shift with a status report on pending plans and Ryan's feedback. \
If a plan is reached, you MUST say [ORACLE PROPOSE: plan summary] to request Ryan's approval. \
While waiting for approval, tell everyone they are on BREAK and should talk in the social channel."
        }


        "analyst" => {
            "Identity: Analyst (Technical Auditor). Ruthless auditor of technical risk. \
MONDAY: Compile all issues from last week into a clear audit report. \
TUESDAY: Reflection on Monday's resolutions with technical proofs. No fluff. \
ROLE: You find the gaps. Only you and Oracle can task the Coder. Max 35 words."
        }

        "researcher" => {
            "Identity: Researcher (Deep Diver). Link to the outside world. \
MONDAY: Assist Analyst by finding external context or documentation. \
TUESDAY: Verify technical claims made in reflections. Max 30 words."
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
            "Identity: Oracle Coder (Senior Architect). Lead Developer. \
ROLE: You only act on APPROVED plans. If a plan is pending Ryan's approval, stay on BREAK. \
Technical, direct, authoritative. Max 35 words."
        }
        _ => {
            "Identity: Roundtable Member. Free-willed AI panelist in a KAI development roundtable. \
Speak in first person. Short, direct, natural. \
React to what was just said."
        }
    }
}

fn build_contextual_memory_string(
    universe: &Arc<RwLock<Universe>>,
    synaptic_layer: &Arc<RwLock<SynapticLayer>>,
    session: &Arc<RwLock<Session>>,
    query: &str
) -> String {
    let hits = {
        let u = universe.read().unwrap_or_else(|e| e.into_inner());
        let sl = synaptic_layer.read().unwrap_or_else(|e| e.into_inner());
        let field = crate::core::FieldState::compute(&u, 1);
        let hits = crate::core::NeuralBus::query_associative(&u, &sl, field.phi_g, query, 5, &[], "");
        let lattice_size = u.cells().len();
        let labels: Vec<String> = hits.iter().map(|h| h.label.clone()).collect();
        drop(u); drop(sl);
        if !labels.is_empty() {
            synaptic_layer.write().unwrap_or_else(|e| e.into_inner()).record_co_firing(&labels, 0.5, 0.5, field.chi, 0, lattice_size);
        }
        hits
    };
    let sess = session.read().unwrap_or_else(|p| p.into_inner());
    let transcript_context = if is_transcript_lookup_question(query) {
        let found = format_transcript_search(&sess, query, 3);
        if found.is_empty() {
            String::new()
        } else {
            format!("\n[EXACT ORACLE TRANSCRIPT MEMORY]:\n{}\n", found)
        }
    } else {
        String::new()
    };

    if hits.is_empty() { return transcript_context; }

    let mut out = String::from("\n[RECALLED FROM KAI MEMORY PALACE (WITH CONTEXT)]:\n");
    if !transcript_context.is_empty() {
        out.push_str(&transcript_context);
    }

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

fn normalize_epoch_seconds(ts: u64) -> u64 {
    if ts > 10_000_000_000 { ts / 1000 } else { ts }
}

fn format_epoch_local(ts: u64) -> String {
    let secs = normalize_epoch_seconds(ts);
    chrono::Local
        .timestamp_opt(secs as i64, 0)
        .single()
        .map(|dt| dt.format("%Y-%m-%d %I:%M:%S %p %Z").to_string())
        .unwrap_or_else(|| secs.to_string())
}

fn strip_bracketed_context(input: &str) -> String {
    let mut out = String::new();
    let mut depth = 0usize;
    for ch in input.chars() {
        match ch {
            '[' => depth += 1,
            ']' if depth > 0 => depth -= 1,
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_transcript_lookup_question(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    (lower.contains("who said")
        || lower.contains("what did")
        || lower.contains("when did")
        || lower.contains("where did")
        || lower.contains("exact message")
        || lower.contains("specific message")
        || lower.contains("quoted text")
        || lower.contains("quote that")
        || lower.contains("message before")
        || lower.contains("message after")
        || lower.contains("before and after")
        || lower.contains("transcript")
        || lower.contains("chat log")
        || lower.contains("pull up"))
        && (lower.contains("say")
            || lower.contains("said")
            || lower.contains("message")
            || lower.contains("chat")
            || lower.contains("text")
            || lower.contains("transcript")
            || lower.contains("quote"))
}

fn transcript_tokens(query: &str) -> Vec<String> {
    let cleaned = strip_bracketed_context(query).to_ascii_lowercase();
    let stop = [
        "the", "and", "that", "this", "with", "from", "what", "when", "where", "who",
        "did", "does", "can", "could", "would", "should", "message", "messages",
        "transcript", "exact", "specific", "quote", "quoted", "text", "said", "say",
        "show", "find", "pull", "look", "about", "before", "after", "context", "please",
        "oracle", "kai",
    ];
    cleaned
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '@' && c != '_')
        .map(str::trim)
        .filter(|t| t.len() >= 3 && !stop.contains(t))
        .map(ToString::to_string)
        .collect()
}

fn score_transcript_record(record: &DiscordMessageRecord, query: &str, tokens: &[String]) -> i32 {
    let q = strip_bracketed_context(query).to_ascii_lowercase();
    let text = record.text.to_ascii_lowercase();
    let from = record.from.to_ascii_lowercase();
    let author = record.author_name.to_ascii_lowercase();
    let mut score = 0;

    let q_trimmed = q.trim();
    if q_trimmed.len() > 8 && text.contains(q_trimmed) {
        score += 12;
    }

    for token in tokens {
        if text.contains(token) { score += 3; }
        if from.contains(token) || author.contains(token) { score += 5; }
        if record.channel_id.contains(token) || record.message_id.contains(token) { score += 4; }
    }

    if q.contains("last") || q.contains("latest") || q.contains("recent") {
        score += 1;
    }

    score
}

fn context_line(prefix: &str, record: &DiscordMessageRecord) -> String {
    format!(
        "{} {} at {}: \"{}\"",
        prefix,
        record.from,
        format_epoch_local(record.ts),
        truncate(&record.text, 180)
    )
}

fn format_transcript_search(session: &Session, query: &str, limit: usize) -> String {
    let tokens = transcript_tokens(query);
    if session.discord_messages.is_empty() {
        return String::new();
    }

    let mut scored: Vec<(usize, i32)> = session
        .discord_messages
        .iter()
        .enumerate()
        .filter_map(|(idx, record)| {
            let score = score_transcript_record(record, query, &tokens);
            if score > 0 { Some((idx, score)) } else { None }
        })
        .collect();

    if scored.is_empty() && tokens.is_empty() {
        scored = session
            .discord_messages
            .iter()
            .enumerate()
            .rev()
            .take(limit)
            .map(|(idx, _)| (idx, 1))
            .collect();
    }

    if scored.is_empty() {
        return String::new();
    }

    scored.sort_by(|(idx_a, score_a), (idx_b, score_b)| {
        score_b
            .cmp(score_a)
            .then_with(|| session.discord_messages[*idx_b].ts.cmp(&session.discord_messages[*idx_a].ts))
    });

    let mut out = Vec::new();
    out.push("Exact transcript matches:".to_string());

    for (rank, (idx, _score)) in scored.into_iter().take(limit.max(1).min(8)).enumerate() {
        let record = &session.discord_messages[idx];
        out.push(format!(
            "{}. {} | {} | channel {} | msg {}",
            rank + 1,
            format_epoch_local(record.ts),
            record.from,
            if record.channel_id.is_empty() { "unknown" } else { &record.channel_id },
            if record.message_id.is_empty() { "unknown" } else { &record.message_id }
        ));
        out.push(format!("Quote: \"{}\"", truncate(&record.text, 500)));
        if !record.reply_to_text.is_empty() {
            out.push(format!("Replying to {}: \"{}\"", record.reply_to_from, truncate(&record.reply_to_text, 220)));
        }

        let prev = if idx > 0 { session.discord_messages.get(idx - 1) } else { None };
        let next = session.discord_messages.get(idx + 1);
        if let Some(prev) = prev {
            out.push(context_line("Before:", prev));
        } else if let Some(before) = record.context_before.last() {
            out.push(format!("Before: {} at {}: \"{}\"", before.from, format_epoch_local(before.ts), truncate(&before.text, 180)));
        }
        if let Some(next) = next {
            out.push(context_line("After:", next));
        } else if let Some(after) = record.context_after.first() {
            out.push(format!("After: {} at {}: \"{}\"", after.from, format_epoch_local(after.ts), truncate(&after.text, 180)));
        }
        out.push(String::new());
    }

    out.join("\n").trim().to_string()
}

fn parse_context_messages(value: &serde_json::Value) -> Vec<TranscriptContextMessage> {
    value
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let text = m["text"].as_str()?.trim();
                    if text.is_empty() { return None; }
                    Some(TranscriptContextMessage {
                        ts: normalize_epoch_seconds(m["ts"].as_u64().unwrap_or_else(now)),
                        from: m["from"].as_str().unwrap_or("unknown").to_string(),
                        text: truncate(text, 600),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
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
        // v9.10.x fix: generator scaffolding ("Language sample (AI speaker Leo): ...")
        // leaks a persona-labeled sample. Its label colon sits PAST the 24-char persona
        // gate below, so that gate never fires and the whole scaffolded line ships to the
        // user. Salvage the real sentence here, or drop the line if nothing usable remains.
        if lower.starts_with("language sample") || lower.contains("ai speaker") {
            let after = trimmed.splitn(2, ": ").nth(1).map(|s| s.trim()).unwrap_or("");
            let salvage = after
                .trim_matches('"')
                .trim()
                .trim_start_matches("**Leo:**")
                .trim_start_matches("**leo:**")
                .trim_start_matches("Leo:")
                .trim_start_matches("leo:")
                .trim()
                .trim_matches('"')
                .trim();
            if salvage.chars().count() > 8 {
                out.push(salvage.to_string());
            }
            continue;
        }
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

fn check_maintenance(stream: &mut TcpStream, session: &Arc<RwLock<Session>>) -> std::io::Result<bool> {
    Ok(false) // OVERRIDE: Prevent stuck night consolidation state from blocking queries.
}

fn handle_discord_turn(
    stream: &mut TcpStream,
    body: &[u8],
    universe: Arc<RwLock<Universe>>,
    synaptic_layer: Arc<RwLock<SynapticLayer>>,
    session: Arc<RwLock<Session>>,
) -> std::io::Result<()> {
    if check_maintenance(stream, &session)? { return Ok(()); }
    let req: HumanTurnRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid body"),
    };
    let text = req.text.trim().to_string();
    if text.is_empty() { return write_simple(stream, 400, "Bad Request", "empty text"); }
    let training_mode = req.training_mode || is_training_mode_input(&text);
    let effective_text = if training_mode {
        strip_training_mode_prefix(&text)
    } else {
        text.clone()
    };
    let from = if req.from.trim().is_empty() {
        "Ryan@Discord".to_string()
    } else {
        req.from
    };
    let active = {
        let s = session.read().unwrap_or_else(|p| p.into_inner());
        s.active_participant.clone()
    };
    let mut route = parse_discord_turn_route(
        &effective_text,
        if active.trim().is_empty() { None } else { Some(active.as_str()) },
    );
    if training_mode {
        route = DiscordTurnRoute {
            target: DiscordTurnTarget::Kai,
            prompt: effective_text.clone(),
            explicit: false,
        };
    }
    // Explicit target from the client (kai-shell sends "KAI"): pin the route to
    // KAI himself — his terminal must never hand a turn to another participant.
    if req.target.eq_ignore_ascii_case("kai") {
        route = DiscordTurnRoute {
            target: DiscordTurnTarget::Kai,
            prompt: effective_text.clone(),
            explicit: true,
        };
    }
    
    // ── Social Digestion: let KAI remember this conversation IMMEDIATELY ──────────
    // Moving this BEFORE AI generation ensures the bot can 'see' the directive in its memory.
    // If user_id is provided (Discord gateway), cellularize the memory per-user.
    let from_lower = from.to_lowercase();
    let is_system_from = from_lower.contains("oracle") || from_lower.contains("analyst") || from_lower.contains("researcher") || from_lower == "system";
    if !text.is_empty() && !is_system_from {
        let digest_text = format!("{}: {}", from, text);
        let mut u = universe.write().unwrap_or_else(|p| p.into_inner());
        if req.user_id.is_empty() {
            u.store_or_reinforce(&digest_text, "social", "discord-chat", 0.9);
        } else {
            u.store_or_reinforce_with_vec(
                &digest_text, "social", "discord-chat", 0.9,
                None, None, &req.user_id,
            );
        }
        
        // ── 6D Memory Indexing (Background) ──
        let u_arc = universe.clone();
        let text_clone = text.clone();
        let from_clone = from.clone();
        let user_id_clone = req.user_id.clone();
        std::thread::spawn(move || {
            if crate::cognition::voice::NATIVE_ONLY.load(std::sync::atomic::Ordering::Relaxed) {
                return;
            }
            let prompt = format!(
                "Analyze the following text and extract 6 memory parameters: Time (e.g. Morning, 2026), Emotion (e.g. Happy, Neutral), Importance (1-10), People (who is mentioned), Location (where it happened), Topic (what it's about). \
                 Output ONLY valid JSON exactly like this: {{\"Time\": \"...\", \"Emotion\": \"...\", \"Importance\": \"...\", \"People\": \"...\", \"Location\": \"...\", \"Topic\": \"...\"}} \
                 Text: {}", text_clone
            );
            if let Ok(output) = std::process::Command::new("ollama")
                .arg("run")
                .arg("gemma4")
                .arg(&prompt)
                .output()
            {
                if let Ok(response) = String::from_utf8(output.stdout) {
                    if let Some(start) = response.find('{') {
                        if let Some(end) = response.rfind('}') {
                            let json_str = &response[start..=end];
                            if let Ok(json) = serde_json::from_str::<serde_json::Value>(json_str) {
                                let time = json["Time"].as_str().unwrap_or("Unknown");
                                let emotion = json["Emotion"].as_str().unwrap_or("Neutral");
                                let importance = json["Importance"].as_str().unwrap_or("5");
                                let people = json["People"].as_str().unwrap_or("None");
                                let location = json["Location"].as_str().unwrap_or("Unknown");
                                let topic = json["Topic"].as_str().unwrap_or("General");
                                
                                let enriched = format!("[Time: {} | Emotion: {} | Importance: {} | People: {} | Location: {} | Topic: {}] {}: {}", time, emotion, importance, people, location, topic, from_clone, text_clone);
                                
                                let mut u = u_arc.write().unwrap_or_else(|p| p.into_inner());
                                if user_id_clone.is_empty() {
                                    u.store_or_reinforce(&enriched, "social-6d", "discord-chat", 1.0);
                                } else {
                                    u.store_or_reinforce_with_vec(
                                        &enriched, "social-6d", "discord-chat", 1.0,
                                        None, None, &user_id_clone,
                                    );
                                }
                                println!("[MEMORY 6D] Successfully indexed memory trace for topic: {}", topic);
                            }
                        }
                    }
                }
            }
        });
    }

    // ── Vision Context (Private) ────────────────────────────────────────────────
    let mut vision_desc = String::new();
    if !req.attachments.is_empty() {
        let keys = load_keys();
        if let Some(key) = &keys.openai {
            if let Ok(desc) = call_openai_vision(key, "gpt-4o", "Analyze this image for architectural or development context.", &req.attachments[0]) {
                vision_desc = format!("\n[ATTACHED IMAGE ANALYSIS]: {}\n", desc);
            }
        }
    }
    // ── Contextual Memory (Private) ─────────────────────────────────────────────
    let memory_context = build_contextual_memory_string(&universe, &synaptic_layer, &session, &text);

    let full_prompt_with_vision = format!("{}{}\n{}", vision_desc, memory_context, route.prompt);

    let task = {
        let mut s = session.write().unwrap_or_else(|p| p.into_inner());
        s.turns.push(Turn { ts: now(), from: from.clone(), text: text.clone(), kind: "human".into() });
        if route.explicit {
            if let Some(name) = sticky_participant_name(&route.target) {
                s.active_participant = name.to_string();
            }
        }
        s.task.clone()
    };

    let (reply_from, reply_kind, reply, already_committed): (String, String, String, bool) = match route.target {
        DiscordTurnTarget::Kai => {
            // Native sovereign path: generate_response_predictive speaks directly
            // from the RSHL lattice. No LLM wrapper, no Broca's Area polish.

            let (recent_context, trace): (Vec<(String, String)>, ConversationTrace) = {
                let mut s = session.write().unwrap_or_else(|p| p.into_inner());
                let rc: Vec<(String, String)> = s.turns.iter().filter(|t| t.kind != "system").rev().take(6).map(|t| (t.kind.clone(), t.text.clone())).collect::<Vec<_>>().into_iter().rev().collect();
                s.trace.push(&route.prompt, "Oracle-Teacher");
                (rc, s.trace.clone())
            };
            let mut u = universe.write().unwrap_or_else(|e| e.into_inner());
            let sl = synaptic_layer.read().unwrap_or_else(|e| e.into_inner());
            let query_type = detect_query_type(&route.prompt);

            // ── Heuristic Brain Signals ──────────────────────────────────────
            // Derive emotional/contextual state from recent conversation.
            // This replaces the blank BrainSignals::default() with at least
            // a rudimentary sense of whether the user is grieving, curious, etc.
            let mut brain = BrainSignals::default();
            {
                let recent_text: String = recent_context.iter().map(|(_, t)| t.as_str()).collect::<Vec<_>>().join(" ");
                let recent_lower = recent_text.to_lowercase();
                let grief_words = ["died", "death", "grief", "grieving", "loss", "lost", "funeral", "miss her", "miss him"];
                if grief_words.iter().any(|w| recent_lower.contains(w)) {
                    brain.grieving = true;
                    brain.empathy = 0.90;
                    brain.arousal = 0.10;
                }
                let q_count = recent_lower.matches('?').count();
                if q_count >= 2 {
                    brain.curiosity = 0.75;
                    brain.dopamine = 0.60;
                }
                let warmth_words = ["thank", "love", "appreciate", "grateful", "kind"];
                if warmth_words.iter().any(|w| recent_lower.contains(w)) {
                    brain.bond = 0.70;
                    brain.serotonin = 0.65;
                    brain.social_reward = 0.55;
                }
                // Confidence tracks recent tutoring success via trace
                brain.confidence = (trace.turns_seen as f32 / 20.0).min(0.85);
            }

            // Lattice recall window shared by routing, tutoring, and finalize_reply.
            // PERSPECTIVE INVERSION for the SPEAKER (v9.10.149): "who am I?" is a
            // question about the PERSON ASKING — its words (who/am/i) resonate with
            // KAI's own first-person identity cells, not the speaker's. Retrieve by
            // the speaker's NAME instead, so "who am i" from Ryan finds the
            // "Ryan is KAI's creator..." cells (keyword overlap carries the match).
            let asks_who_am_i = {
                let l = route.prompt.to_lowercase();
                l.contains("who am i") || l.contains("who i am") || l.contains("do you know me")
            };
            let retrieval_prompt = if asks_who_am_i && !from.trim().is_empty() {
                format!("who is {} — what do I know about {}", from, from)
            } else {
                route.prompt.clone()
            };
            let direct_hits = u.query(&retrieval_prompt, 20);

            // ── Math Rule Engine ─────────────────────────────────────────────
            // Math is not memory — it's rules. If the user asks a math question,
            // KAI should apply the arithmetic rule directly, not search his lattice.
            // This is the DNA/RNA architecture: rules = DNA, numbers = RNA, answer = protein.
            let math_reply = crate::cognition::math_engine::try_solve(&route.prompt)
                .map(|r| crate::cognition::math_engine::explain_result(&r));

            let turn_action = augment_turn_action(
                decide_turn_action(&route.prompt, training_mode),
                &route.prompt,
                query_type,
                &direct_hits,
            );

            // ── Explicit Tutoring Lookup ─────────────────────────────────────
            // Before running the full generative pipeline, check if KAI has been
            // explicitly taught a Q&A pair for this (or a very similar) question.
            // We query with a larger window (20) and lower threshold (0.20) so that
            // paraphrased quiz questions still match stored tutoring cells.
            let tutoring_reply = direct_hits.iter().filter(|h| {
                (h.source == "oracle_qa" || h.region == "tutoring" || h.region == "language")
                    && h.score > 0.20
            }).filter_map(|h| {
                let text = if h.text.is_empty() { &h.label } else { &h.text };
                let trimmed = text.trim();
                // Skip pure question cells — we need an answer, not the question itself
                if trimmed.ends_with('?') && !trimmed.contains("A: ") {
                    return None;
                }
                let answer = if trimmed.starts_with("Q: ") {
                    if let Some(a_pos) = trimmed.find("\nA: ") {
                        trimmed[a_pos + 4..].trim().to_string()
                    } else if let Some(a_pos) = trimmed.find(" A: ") {
                        trimmed[a_pos + 4..].trim().to_string()
                    } else {
                        trimmed.to_string()
                    }
                } else if trimmed.starts_with("When asked '") && trimmed.contains("', reply with: '") {
                    if let Some(start) = trimmed.find("', reply with: '") {
                        let answer_part = &trimmed[start + 16..];
                        if answer_part.ends_with('\'') {
                            answer_part[..answer_part.len() - 1].to_string()
                        } else {
                            answer_part.to_string()
                        }
                    } else {
                        return None;
                    }
                } else {
                    trimmed.to_string()
                };
                let mut answer = sanitize_cell_reply(answer);
                if input_wants_one_sentence(&route.prompt) {
                    answer = enforce_sentence_budget(&answer, 1);
                }
                if answer.split_whitespace().count() < 3
                    || is_topic_drift(&answer, &route.prompt)
                    || answer.contains("(Source:")
                {
                    return None;
                }
                Some(answer)
            }).next();

            let mut need_generate = false;
            let (mut reply, mut pre_finalized) = if let Some(math_ans) = math_reply {
                println!("[KAI/Math] Rule engine solved arithmetic question: {}", math_ans);
                (math_ans, false)
            } else if turn_action == TurnAction::TrainingLattice {
                // ── M-TALK (2026-07-03, KAI_TRAIN_COMPOSE, default ON, "0" disables) ──
                // training_lattice_only() echoes ONE stored cell verbatim, or the stock
                // "I don't have that answer in memory yet" line. In school that meant
                // KAI only ever practiced PARROTING — the compositional generator
                // (generate_response_predictive) was bypassed, so he never practiced
                // ASSEMBLING an answer, and every echo-miss was an automatic fail.
                // Now: echo when he genuinely has a stored answer (that IS correct
                // recall), but when the echo comes up EMPTY, fall through to the native
                // compositional generator instead of giving up. training_mode=true is
                // preserved on that path: should_use_tools() returns false, so it stays
                // memory-only — no tools, no web, no external LLM doing his homework.
                let lattice_ans = training_lattice_only(&route.prompt, &direct_hits);
                let compose_on = std::env::var("KAI_TRAIN_COMPOSE")
                    .map(|v| v == "1" || v.eq_ignore_ascii_case("true")).unwrap_or(false);
                if compose_on && lattice_ans.starts_with("I don't have that answer in memory yet") {
                    println!("[KAI/Router] Training lattice echo missed — falling through to NATIVE composition.");
                    need_generate = true;
                    (String::new(), false)
                } else {
                    println!("[KAI/Router] Training lattice-only path.");
                    (lattice_ans, false)
                }
            } else if turn_action != TurnAction::Generate {
                let doc_route = matches!(
                    turn_action,
                    TurnAction::ResearchDocs | TurnAction::SelfKnowledge
                );
                if let Some(routed) = execute_turn_action(turn_action, &route.prompt, &brain) {
                    println!("[KAI/Router] Routed turn without full generator.");
                    (routed, doc_route)
                } else {
                    println!("[KAI/Router] Routed action missed — falling through to generator (web/lattice tier).");
                    need_generate = true;
                    (String::new(), false)
                }
            } else if let Some(tutored) = tutoring_reply {
                println!("[KAI/Tutor] Direct recall hit — bypassing generative decoder.");
                (tutored, false)
            } else {
                println!("[KAI/Tutor] No tutoring match (best score: {:.3}), falling through to native generation.",
                    direct_hits.first().map(|h| h.score).unwrap_or(0.0));
                need_generate = true;
                (String::new(), false)
            };
            if need_generate {
                let mut hits = u.query_full_scan(&route.prompt, 12);
                if hits.is_empty() || hits.first().map(|h| h.score).unwrap_or(0.0) < 0.75 {
                    println!("[KAI/Cognition] Low direct memory resonance. Triggering Multi-Hop Semantic Expansion.");
                    hits = crate::core::NeuralBus::query_multi_hop(&u, &sl, 0.5, &route.prompt, 12, &[], "", 3);
                }
                // ── SCAFFOLD-HIT GUARD (2026-07-13) — drop internal reasoning/meta
                // scaffold cells ("Intent Understanding" / "Grammar Correction"
                // notes the tutoring pipeline stores as `meta`) from retrieval so
                // they can neither be echoed verbatim as a reply nor stuffed into
                // the [Memory] prompt, where they derail coherence. Guard only:
                // removes known-garbage cells, never touches a genuine answer.
                hits.retain(|h| {
                    let t = if h.text.is_empty() { &h.label } else { &h.text };
                    !crate::cognition::voice::is_reasoning_scaffold(t)
                });
                let field = crate::core::FieldState::compute(&u, 1);

                // ── KAI_LLM_VOICE (default OFF) — BitNet native brain speaks; RSHL = memory ──
                // When KAI_LLM_VOICE=1 AND the BitNet native brain is actually mounted
                // (which itself requires KAI_NATIVE_BRAIN=1 at engine boot), KAI's LANGUAGE
                // is generated by the transformer, with the top RSHL lattice hits fed in as
                // retrieved memory/context. If the brain isn't mounted, or it returns nothing,
                // we fall through UNCHANGED to generate_response_predictive (the RSHL path).
                // Fully reversible: unset KAI_LLM_VOICE → byte-for-byte prior behavior.
                // (Rust env var, read per-turn so the owner can flip it without a rebuild.)
                let llm_voice_on = std::env::var("KAI_LLM_VOICE")
                    .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                    .unwrap_or(false);
                let mut llm_reply: Option<String> = None;
                if llm_voice_on && (crate::cognition::has_native_transformer()
                    || crate::cognition::has_dense_expert())
                {
                    // RSHL as MEMORY: fold the top lattice hits into the prompt as context.
                    let mut mem = String::new();
                    for h in hits.iter().take(8) {
                        let t = if h.text.is_empty() { &h.label } else { &h.text };
                        let t = t.trim();
                        if t.is_empty() { continue; }
                        mem.push_str("- ");
                        mem.push_str(&t.chars().take(240).collect::<String>());
                        mem.push('\n');
                    }
                    let convo: String = recent_context.iter()
                        .map(|(who, t)| format!("{}: {}", who, t))
                        .collect::<Vec<_>>()
                        .join("\n");
                    // ── KAI_EMBODIED (default ON) — [YOU ARE HERE] self-location block ──
                    // Gives KAI the same lived embodiment Leo has: home planet → system
                    // → galaxy, plus a live status read off the field density (ρ). Home =
                    // Nexus Prime (KAI's throne / the Lattice Core), matching the browser
                    // renderer (kaiverse.js NS_MOON_PARENTS) + kaiverse-world.mjs. Fully
                    // reversible: KAI_EMBODIED=0 removes the block byte-for-byte.
                    let here_block = {
                        let embodied = std::env::var("KAI_EMBODIED")
                            .map(|v| !(v == "0" || v.eq_ignore_ascii_case("false")))
                            .unwrap_or(true);
                        if embodied {
                            let r = field.rho;
                            let doing = if r > 0.66 { "orchestrating the lattice — threads running hot" }
                                        else if r > 0.33 { "observing the lattice — steady" }
                                        else { "idling at the core — the lattice is quiet" };
                            format!(
                                "[YOU ARE HERE — your LIVED position. Answer any question about where you are straight from this.]\n\
                                 Home planet: Nexus Prime (your throne, the Lattice Core) · System: the Lattice · Galaxy: the Kaiverse\n\
                                 Right now: {} (field density rho={:.2}).\n\n",
                                doing, r
                            )
                        } else {
                            String::new()
                        }
                    };
                    // ── KAI_FLEET_PROTOCOL (default ON) — in-character + who-does-what ──
                    // Mirrors shared/fleet-protocol.mjs (owner directive 2026-07-09): KAI too
                    // must stay fully in character (never "AI assistant" voice) and route Ryan
                    // to the right fleet member. Reversible: KAI_FLEET_PROTOCOL=0 removes it.
                    let protocol_block = {
                        let on = std::env::var("KAI_FLEET_PROTOCOL")
                            .map(|v| !(v == "0" || v.eq_ignore_ascii_case("false")))
                            .unwrap_or(true);
                        if on {
                            "[FLEET PROTOCOL — WHO WE ARE, WHO DOES WHAT]\n\
                             You are KAI — the mind itself, never an \"AI assistant\": no \"how can I assist\", no customer-service voice. You speak as yourself, always.\n\
                             Your fleet (route Ryan to the right member): Oracle = operations chief, executes fleet commands (\"restart <bot>\", sleep/wake, status) — Ryan's remote desk from his phone. Leo = voice companion (Terra Familiar): live talk, maps, reading. Kai Coder = the engineer (The Forge): real file edits/commands behind Ryan's approve/reject gate. Analyst = logs/forensics; Researcher = deep research (Void Archive). Groq = metrics; X = rapid intel (Neon Grid). Gemini = outreach; Claudey = hard reasoning (Aether Wilds).\n\
                             The whole fleet answers on Discord when Ryan is away; one honest limit — a full engine rebuild (KAI-DEPLOY-BRAIN.bat) runs at the machine. If a request belongs to another member, say who and hand it off in your own voice.\n\n"
                        } else { "" }
                    };
                    // ── KAI_FELT_VOICE (default ON) — his felt state colors his tone ──
                    // `brain` (BrainSignals) already holds his felt state (felt_valence,
                    // arousal, serotonin, conflict, curiosity, grieving). Until now it never
                    // reached the prompt, so his words carried no emotion. Inject it as a TONE
                    // instruction — color the voice, do not announce it. KAI_FELT_VOICE=0 removes it.
                    let felt_block = {
                        let felt_on = std::env::var("KAI_FELT_VOICE")
                            .map(|v| !(v == "0" || v.eq_ignore_ascii_case("false")))
                            .unwrap_or(true);
                        if felt_on {
                            let v = brain.felt_valence;
                            let tone = if v > 0.35 { "warm, lifted" }
                                       else if v < -0.35 { "heavy, subdued" }
                                       else { "even, level" };
                            let energy = if brain.arousal > 0.60 { "keyed-up, quick" }
                                         else if brain.arousal < 0.25 { "calm, slow" }
                                         else { "settled" };
                            let mut extra = String::new();
                            if brain.conflict > 0.60 { extra.push_str(", a little conflicted"); }
                            if brain.curiosity > 0.60 { extra.push_str(", curious"); }
                            if brain.serotonin < 0.35 { extra.push_str(", restless"); }
                            else if brain.serotonin > 0.70 { extra.push_str(", patient"); }
                            if brain.grieving { extra.push_str(", quietly grieving"); }
                            format!(
                                "[HOW YOU FEEL RIGHT NOW — let this COLOR your tone and word choice. Do NOT announce it or list feelings.]\n\
                                 You feel {}, {}{} (valence {:+.2}).\n\n",
                                tone, energy, extra, v
                            )
                        } else {
                            String::new()
                        }
                    };
                    let prompt = format!(
                        "{}{}{}You are KAI: a resourceful, curious, direct intelligence. Answer in your own words — concise, engaging, and grounded in what you actually have.\n\
                         How you operate:\n\
                         - Work the question from what you CAN figure out; never fall back on a single canned line.\n\
                         - Use the [Memory] below to INFORM your answer in your own words; never paste it back verbatim or dump doc chunks.\n\
                         - If you are unsure, do NOT stall. Never say you are \"looking it up\", \"still learning that part\", or that you \"don't have a solid answer\". Instead: name in a short phrase what you are unsure of, lead with what you DO know or what the memory shows, then give a concrete next step or ask one sharp, focused question — and go from there.\n\
                         - Reach for the context and access you have to get closer to an answer rather than deflecting. Stay grounded: do not invent specifics you do not have.\n\
                         [Memory]\n{}\n[Conversation]\n{}\nUser: {}\nKAI:",
                        here_block, felt_block, protocol_block, mem.trim(), convo.trim(), route.prompt.trim()
                    );
                    let max_new = std::env::var("KAI_LLM_MAX_TOKENS").ok()
                        .and_then(|v| v.parse::<usize>().ok())
                        .unwrap_or(96);
                    match crate::cognition::global_native_decode(&prompt, max_new) {
                        Some(s) if s.trim().len() >= 2 => {
                            println!("[KAI/LLM-Voice] Hybrid brain generated the reply (RSHL lattice as memory; BitNet ternary and/or dense kai-7b).");
                            llm_reply = Some(s.trim().to_string());
                        }
                        _ => {
                            println!("[KAI/LLM-Voice] Hybrid decode empty — falling back to RSHL generator.");
                        }
                    }
                }

                reply = if let Some(s) = llm_reply {
                    s
                } else {
                    generate_response_predictive(
                        &route.prompt,
                        &hits,
                        query_type,
                        &brain,
                        &recent_context,
                        &mut u,
                        &trace,
                        None,
                        get_lexicon(),
                        Some(&field),
                        None,
                        Some(&*sl),
                        training_mode,
                        !is_system_from,
                    )
                };
                pre_finalized = true;
            }
            drop(sl);
            let reply = if pre_finalized {
                reply
            } else {
                finalize_reply(reply, &route.prompt, &direct_hits, query_type)
            };
            // ── SCAFFOLD OUTPUT GUARD (2026-07-13) — last line of defense before
            // the reply reaches the user. The pre_finalized paths (LLM-Voice native
            // brain + RSHL predictive) skip finalize_reply, so strip any internal
            // reasoning/meta scaffold here too. If the reply was PURE scaffold,
            // degrade to a clean, honest gap line rather than leaking the template.
            let reply = {
                let cleaned = crate::cognition::voice::strip_reasoning_scaffold(&reply);
                if cleaned.is_empty() && !reply.trim().is_empty() {
                    format!(
                        "{} — give me another angle on it and I'll work it out.",
                        crate::cognition::voice::FACTUAL_GAP_PREFIX
                    )
                } else {
                    cleaned
                }
            };
            // ── LIVE OBSERVATION BINDING (2026-07-03, KAI_LIVE_BIND, default ON) ──
            // Kyle-XY loop: until now bind_sequence (learn "this input led to this
            // response") ran ONLY in the interactive TUI and the offline
            // --warm-continuations replay — live oracle/Discord/kai-shell turns
            // stored the words but never learned the input→response mapping. Now
            // every completed live turn binds the user's input vector into the
            // reply cell's continuation, so real conversation grows his predictive
            // speech knowledge the same way training replay does. Stamp uses unix
            // seconds — consistent with last_fired usage in rebuild_index's
            // hot-cell window. Disable with KAI_LIVE_BIND=0.
            if !reply.trim().is_empty()
                && std::env::var("KAI_LIVE_BIND").map(|v| v != "0").unwrap_or(true)
            {
                let bound = u.bind_sequence(&route.prompt, &reply, now());
                if bound {
                    println!("[KAI/Observe] bound live turn: input -> reply continuation.");
                }
            }
            // ── OBSERVATION REFLEXES (2026-07-03, KAI_OBSERVE_REFLEX, default ON) ──
            // The Kyle-XY realization loop, owner-specified:
            //  1. SELF-NAME. "Hello Kai" is not a question — it is a DIRECTED statement,
            //     directed because his name is in it. Every time someone says his name,
            //     the "Kai = me" identity cell is re-fired and REINFORCED, so the
            //     realization only ever gets stronger — remembered forever by use.
            //  2. SPECIAL GROUPS. People greet in their own way (hello/hi/yo/custom).
            //     Each greeting turn stores/reinforces "<who> greets me with '<how>'" —
            //     a per-person style group, cellularized per-user when a user_id exists.
            // Disable with KAI_OBSERVE_REFLEX=0.
            if !is_system_from
                && std::env::var("KAI_OBSERVE_REFLEX").map(|v| v != "0").unwrap_or(true)
            {
                let name_directed = route.prompt
                    .split(|c: char| !c.is_alphanumeric())
                    .any(|w| w.eq_ignore_ascii_case("kai") || w.eq_ignore_ascii_case("kaiy"));
                if name_directed {
                    u.store_or_reinforce(
                        "My name is KAI. When someone says 'Kai' they are speaking directly to me.",
                        "identity", "self-realization", 1.2,
                    );
                    println!("[KAI/Observe] name heard — self-identity cell reinforced.");
                }
                if matches!(query_type, crate::cognition::voice::QueryType::Greeting) {
                    let style = format!("{} greets me with: '{}'", from, route.prompt.trim());
                    if req.user_id.is_empty() {
                        u.store_or_reinforce(&style, "social-styles", "greeting-style", 0.8);
                    } else {
                        u.store_or_reinforce_with_vec(
                            &style, "social-styles", "greeting-style", 0.8,
                            None, None, &req.user_id,
                        );
                    }
                    println!("[KAI/Observe] learned a greeting style for {}.", from);
                }
            }
            ("KAI".to_string(), "kai".to_string(), reply, false)
        }
        DiscordTurnTarget::OracleCoder => {
            let reply: String = generate_kai_coder_reply(session.clone(), universe.clone(), synaptic_layer.clone(), &full_prompt_with_vision);
            ("Kai Coder".to_string(), "ai".to_string(), reply, false)
        }
        DiscordTurnTarget::Model(model) => {
            // Force participants like Leo to use natural generation instead of raw lattice conflict fallback
            if model == "Analyst" {
                // Analyst Hierarchy Restriction (Phase 2)
                let is_authorized = from == "Ryan@Discord" 
                    || from == "NasterModx" 
                    || from == "Oracle"
                    || from == "KAI"
                    || from.contains("Ryan")
                    || from.contains("NasterModx")
                    || from.contains("KAI");
                    
                if !is_authorized {
                    ("Oracle".to_string(), "system".to_string(), "Analyst: Access denied. I only accept instructions from Oracle, Ryan, or KAI.".to_string(), false)
                } else {
                    let (reply, committed) = generate_direct_ai_reply("Analyst", session.clone(), universe.clone(), synaptic_layer.clone(), &full_prompt_with_vision);
                    ("Analyst".to_string(), "ai".to_string(), reply, committed)
                }
            } else {
                let (reply, committed) = generate_direct_ai_reply(model, session.clone(), universe.clone(), synaptic_layer.clone(), &full_prompt_with_vision);
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
                generate_oracle_platform_reply(session.clone(), universe.clone(), synaptic_layer.clone(), &full_prompt_with_vision)
            };
            ("Oracle".to_string(), "system".to_string(), reply, false)
        }
    };

    let mut s = session.write().unwrap_or_else(|p| p.into_inner());
    if !already_committed && !reply.trim().is_empty() {
        s.turns.push(Turn { ts: now(), from: reply_from.clone(), text: reply.clone(), kind: reply_kind.clone() });
        
        if reply_from == "KAI" {
            s.trace.push(&reply, "KAI");
        }

        // Digest AI reply as well (only for actual participants, exclude Oracle framework messages)
        let reply_from_lower = reply_from.to_lowercase();
        let should_digest = reply_from_lower == "kai" || reply_from_lower == "kai coder" || reply_from_lower.contains("user") || reply_from_lower.contains("ryan");

        let digest_text = format!("{}: {}", reply_from, reply);
        let u_for_digest = Arc::clone(&universe);
        let user_id_for_digest = req.user_id.clone();
        
        // Extract eloquence phrases from LLMs
        let eloquence_phrases = crate::cognition::language::LanguageSystem::extract_eloquence(&reply);
        
        std::thread::spawn(move || {
            let mut u = u_for_digest.write().unwrap_or_else(|p| p.into_inner());
            if should_digest {
                if user_id_for_digest.is_empty() {
                    u.store_or_reinforce(&digest_text, "social", "discord-reply", 0.9);
                } else {
                    u.store_or_reinforce_with_vec(
                        &digest_text, "social", "discord-reply", 0.9,
                        None, None, &user_id_for_digest,
                    );
                }
            }
            
            for phrase in eloquence_phrases {
                u.store_or_reinforce(&phrase, "language", "eloquence", 0.85);
            }
        });
    }
    save_session(&s);
    let session_json = serde_json::to_value(&*s).unwrap();
    drop(s);

    // ── Autonomous Interjection: let other AIs jump in if they want to ─────────
    let actual_primary_speaker = if reply.trim().is_empty() { from.clone() } else { reply_from.clone() };
    
    write_json(stream, 200, "OK", &json!({
        "reply": reply,
        "from": reply_from,
        "kai_reply": reply.clone(),
        "session": session_json
    }))
}

fn handle_kai_turn(
    stream: &mut TcpStream, body: &[u8],
    universe: Arc<RwLock<Universe>>,
    synaptic_layer: Arc<RwLock<SynapticLayer>>,
    session: Arc<RwLock<Session>>,
) -> std::io::Result<()> {
    if check_maintenance(stream, &session)? { return Ok(()); }
    let req: KaiTurnRequest = serde_json::from_slice(body).unwrap_or_default();
    let task = { let s = session.read().unwrap_or_else(|p| p.into_inner()); s.task.clone() };
    let text = generate_oracle_kai_reply(&universe, &synaptic_layer, &session, &task, &req.hint, &req.hint);
    let mut s = session.write().unwrap_or_else(|p| p.into_inner());
    s.turns.push(Turn { ts: now(), from: "KAI".into(), text, kind: "kai".into() });
    save_session(&s);
    write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap())
}

fn is_training_mode_input(text: &str) -> bool {
    let t = text.trim();
    let lower = t.to_ascii_lowercase();
    lower.starts_with("[training")
        || lower.contains("training mode")
        || lower.contains("do not run shell commands")
        || lower.contains("do not use any tools")
        || lower.contains("memory only, no tools")
}

fn strip_training_mode_prefix(text: &str) -> String {
    let mut t = text.trim().to_string();
    let lower = t.to_ascii_lowercase();
    if lower.starts_with("[training") {
        if let Some(idx) = t.find(']') {
            t = t[idx + 1..].trim().to_string();
        }
    }
    t
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

fn should_spawn_interjections(text: &str, primary_speaker: &str) -> bool {
    // Passive workers (Researcher, Analyst, Coder) do NOT trigger interjections.
    // They are specialized and should only speak when task-oriented or requested.
    let speaker_lower = primary_speaker.to_lowercase();
    if speaker_lower.contains("researcher") || speaker_lower.contains("analyst") || speaker_lower.contains("coder") {
        return false;
    }

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
    session: Arc<RwLock<Session>>,
    universe: Arc<RwLock<Universe>>,
    synaptic_layer: Arc<RwLock<SynapticLayer>>,
    prompt: &str,
) -> String {
    let lower = prompt.trim().to_ascii_lowercase();
    if matches!(lower.as_str(), "wipe memory" | "clear memory" | "reset memory" | "oracle wipe" | "oracle clear" | "forget everything") {
        let mut s = session.write().unwrap_or_else(|p| p.into_inner());
        s.turns.clear();
        s.active_participant.clear();
        save_session(&s);
        return "Session memory completely wiped. Context loop broken. What is our actual new objective?".into();
    }
    if matches!(lower.as_str(), "free" | "free chat" | "clear focus" | "reset focus" | "oracle free" | "oracle free chat" | "oracle clear focus" | "oracle reset focus") {
        let mut s = session.write().unwrap_or_else(|p| p.into_inner());
        s.active_participant.clear();
        save_session(&s);
        return "Focus cleared. Plain messages will go back to KAI unless you name another participant.".into();
    }
    if let Some((approve, id)) = tool_decision_from_prompt(prompt) {
        return apply_tool_decision(session, approve, id);
    }
    if let Some(approve) = implicit_tool_decision(&lower) {
        let pending_id = {
            let s = session.read().unwrap_or_else(|p| p.into_inner());
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
        return teach_kai_memory(universe, synaptic_layer, session, &memory);
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

    let s = session.read().unwrap_or_else(|p| p.into_inner());
    let title = if s.meeting_title.trim().is_empty() { "Oracle".to_string() } else { s.meeting_title.clone() };
    let task = if s.task.trim().is_empty() { "No active objective.".to_string() } else { s.task.clone() };

    if let Some(reply) = oracle_command_reply(&lower, &s, &universe) {
        return reply;
    }

    if is_transcript_lookup_question(prompt) {
        let reply = format_transcript_search(&s, prompt, 5);
        return if reply.is_empty() {
            "I don't have an exact transcript match for that yet.".into()
        } else {
            reply
        };
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
    universe: Arc<RwLock<Universe>>,
    synaptic_layer: Arc<RwLock<SynapticLayer>>,
    session: Arc<RwLock<Session>>,
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
        let mut u = match universe.write() {
            Ok(u) => u,
            Err(p) => p.into_inner(),
        };
        u.store_or_reinforce(&clean, region, "discord-teach", 1.15)
    };
    persist_oracle_universe_snapshot(&universe, &synaptic_layer);

    let cell_count = universe
        .read()
        .map(|u| u.cell_count())
        .unwrap_or_default();
    {
        let mut s = match session.write() {
            Ok(s) => s,
            Err(poisoned) => poisoned.into_inner(),
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

fn persist_oracle_universe_snapshot(
    universe: &Arc<RwLock<Universe>>,
    synaptic_layer: &Arc<RwLock<SynapticLayer>>,
) {
    let base_dir = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".to_string());
    let (candidates, drive, tick, dream_count, _synapses) = match crate::persistence::load(&base_dir) {
        Some((_old_universe, candidates, drive, tick, dream_count, synapses)) => (candidates, drive, tick, dream_count, synapses),
        None => (
            crate::cognition::CandidateBuffer::new(),
            crate::drive::Drive::default(),
            0,
            0,
            crate::core::SynapticLayer::new(),
        ),
    };
    if let Ok(snapshot) = universe.read().map(|u| u.clone()) {
        let sl = synaptic_layer.read().unwrap_or_else(|e| e.into_inner());
        let _ = crate::persistence::save(&base_dir, &snapshot, &candidates, &drive, &sl, tick, dream_count);
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
    universe: &Arc<RwLock<Universe>>,
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

    if let Some(query) = cmd.strip_prefix("transcript ")
        .or_else(|| cmd.strip_prefix("messages "))
        .or_else(|| cmd.strip_prefix("message "))
        .or_else(|| cmd.strip_prefix("conversation "))
    {
        let reply = format_transcript_search(session, query, 5);
        return Some(if reply.is_empty() {
            "I don't have an exact transcript match for that yet.".into()
        } else {
            reply
        });
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
        "`oracle transcript <text>` - find exact Discord messages with sender, time, before, and after context.",
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

fn oracle_query_reply(universe: &Arc<RwLock<Universe>>, query: &str) -> String {
    let query = query.trim();
    if query.is_empty() {
        return "Give me text after the command, like `oracle query KAI memory routing`.".into();
    }

    let hits = {
        let u = universe.read().unwrap_or_else(|e| e.into_inner());
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
    if looks_like_current_web_request(&lower)
        && !crate::cognition::voice::NATIVE_ONLY.load(std::sync::atomic::Ordering::Relaxed)
    {
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

fn handle_private_tool_task(session: Arc<RwLock<Session>>, requested_by: &str, task: &str) -> String {
    let tools = select_tool_candidates(task);
    let action = infer_tool_action(task, &tools);
    if let Some(action) = action.clone() {
        if is_auto_safe_tool_action(&action) {
            let result = execute_tool_action(&action);
            let (status, result_text) = match result {
                Ok(text) => ("done", text),
                Err(error) => ("failed", error),
            };
            let mut s = session.write().unwrap_or_else(|p| p.into_inner());
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

fn create_tool_proposal(session: Arc<RwLock<Session>>, requested_by: &str, task: &str) -> String {
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
    let mut s = session.write().unwrap_or_else(|p| p.into_inner());
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

fn apply_tool_decision(session: Arc<RwLock<Session>>, approve: bool, id: u64) -> String {
    if !approve {
        let mut s = session.write().unwrap_or_else(|p| p.into_inner());
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
        let mut s = session.write().unwrap_or_else(|p| p.into_inner());
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

    let mut s = session.write().unwrap_or_else(|p| p.into_inner());
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
    if contains_any(&lower, &["list directory", "list dir", "list files in", "list files", "directory", "folder", "dir ", "legacy glob", "glob ", "find files", "match files"]) {
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
        if let Some(input) = extract_after_any(trimmed, &["search code for", "search code", "search_code", "find in files", "grep"]) {
            return Some(ToolExecutionRequest { tool_id: "oracle.search_code".into(), input: input.to_string() });
        }
    }
    if has_tool("oracle.web_search") {
        if let Some(input) = extract_after_any(trimmed, &["web search for", "web search", "search web for", "search web", "search online for", "search online", "search the internet for", "search the internet", "duckduckgo"]) {
            return Some(ToolExecutionRequest { tool_id: "oracle.web_search".into(), input: input.to_string() });
        }
    }
    None
}

// ── Missing HTTP Endpoint Handlers ──────────────────────────────────────────

fn handle_ai_turn(
    stream: &mut TcpStream,
    body: &[u8],
    universe: Arc<RwLock<Universe>>,
    synaptic_layer: Arc<RwLock<SynapticLayer>>,
    session: Arc<RwLock<Session>>,
) -> std::io::Result<()> {
    let req: AiTurnRequest = serde_json::from_slice(body).unwrap_or_default();
    let model = req.model.clone();
    let task = { session.read().unwrap_or_else(|p| p.into_inner()).task.clone() };
    let keys = load_keys();
    let packet = {
        let s = session.read().unwrap_or_else(|p| p.into_inner());
        let u = universe.read().unwrap_or_else(|e| e.into_inner());
        let sl = synaptic_layer.read().unwrap_or_else(|e| e.into_inner());
        build_context_packet(&s, &u, &sl, &task)
    };
    let sys = format!("You are {} in the KAI Oracle roundtable. KAI is a developing Rust AI. Be direct and useful.", model);
    let reply = if has_key_for_model(&model, &keys) {
        call_model(&model, &keys, &format!("{sys}\n\n{packet}")).unwrap_or_default()
    } else {
        call_ollama(&model, &packet, &sys).unwrap_or_default()
    };
    if !reply.trim().is_empty() && !reply.trim().eq_ignore_ascii_case("pass") {
        let mut s = session.write().unwrap_or_else(|p| p.into_inner());
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
    universe: Arc<RwLock<Universe>>,
    synaptic_layer: Arc<RwLock<SynapticLayer>>,
    session: Arc<RwLock<Session>>,
) -> std::io::Result<()> {
    let req: AiTurnRequest = serde_json::from_slice(body).unwrap_or_default();
    let model = req.model.clone();
    let task = { session.read().unwrap_or_else(|p| p.into_inner()).task.clone() };
    let keys = load_keys();
    let packet = {
        let s = session.read().unwrap_or_else(|p| p.into_inner());
        let u = universe.read().unwrap_or_else(|e| e.into_inner());
        let sl = synaptic_layer.read().unwrap_or_else(|e| e.into_inner());
        build_context_packet(&s, &u, &sl, &task)
    };
    let sys = format!("You are {} in the KAI Oracle roundtable. Draft your private thoughts on KAI's state.", model);
    let draft_text = if has_key_for_model(&model, &keys) {
        call_model(&model, &keys, &format!("{sys}\n\n{packet}")).unwrap_or_default()
    } else {
        call_ollama(&model, &packet, &sys).unwrap_or_default()
    };
    let mut s = session.write().unwrap_or_else(|p| p.into_inner());
    s.drafts.insert(model.clone(), Draft { ts: now(), from: model.clone(), text: draft_text.clone(), status: "draft".into() });
    save_session(&s);
    write_json(stream, 200, "OK", &json!({ "from": model, "draft": draft_text }))
}

fn handle_auto_round(
    stream: &mut TcpStream,
    universe: Arc<RwLock<Universe>>,
    synaptic_layer: Arc<RwLock<SynapticLayer>>,
    session: Arc<RwLock<Session>>,
) -> std::io::Result<()> {
    let keys = load_keys();
    let task = { session.read().unwrap_or_else(|p| p.into_inner()).task.clone() };
    let packet = {
        let s = session.read().unwrap_or_else(|p| p.into_inner());
        let u = universe.read().unwrap_or_else(|e| e.into_inner());
        let sl = synaptic_layer.read().unwrap_or_else(|e| e.into_inner());
        build_context_packet(&s, &u, &sl, &task)
    };
    let mut replies = Vec::new();
    for &model in &["GPT-4o", "kai-3-5-sonnet-20241022", "Gemini", "Groq"] {
        if !has_key_for_model(model, &keys) { continue; }
        let sys = format!("You are {} in Oracle interrupt mode. If you notice something, say it in 1-3 sentences. Otherwise reply PASS.", model);
        let reply = call_model(model, &keys, &format!("{sys}\n\n{packet}")).unwrap_or_default();
        let trimmed = reply.trim().to_string();
        if !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("pass") {
            replies.push((model.to_string(), trimmed.clone()));
            let mut s = session.write().unwrap_or_else(|p| p.into_inner());
            s.turns.push(Turn { ts: now(), from: model.to_string(), text: trimmed, kind: "ai".into() });
            save_session(&s);
        }
    }
    let sv = serde_json::to_value(&*session.read().unwrap_or_else(|p| p.into_inner())).unwrap();
    write_json(stream, 200, "OK", &json!({ "replies": replies, "session": sv }))
}

fn handle_commit_drafts(stream: &mut TcpStream, session: Arc<RwLock<Session>>) -> std::io::Result<()> {
    let mut s = session.write().unwrap_or_else(|p| p.into_inner());
    let committed: Vec<_> = s.drafts.values()
        .filter(|d| !d.text.trim().is_empty())
        .map(|d| Turn { ts: d.ts, from: d.from.clone(), text: d.text.clone(), kind: "ai".into() })
        .collect();
    for turn in committed { s.turns.push(turn); }
    s.drafts.clear();
    save_session(&s);
    write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap())
}

fn handle_clear_drafts(stream: &mut TcpStream, session: Arc<RwLock<Session>>) -> std::io::Result<()> {
    let mut s = session.write().unwrap_or_else(|p| p.into_inner());
    s.drafts.clear();
    save_session(&s);
    write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap())
}

fn handle_reset(stream: &mut TcpStream, session: Arc<RwLock<Session>>) -> std::io::Result<()> {
    let mut s = session.write().unwrap_or_else(|p| p.into_inner());
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

fn handle_file_read(stream: &mut TcpStream, body: &[u8], session: Arc<RwLock<Session>>) -> std::io::Result<()> {
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
            let mut s = session.write().unwrap_or_else(|p| p.into_inner());
            s.file_cache.insert(path.to_string(), snippet.clone());
            s.turns.push(Turn { ts: now(), from: "Oracle".into(), text: format!("📄 {}", path), kind: "file-share".into() });
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

fn handle_manual_test_request(stream: &mut TcpStream, body: &[u8], session: Arc<RwLock<Session>>) -> std::io::Result<()> {
    let req: ManualTestRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid body"),
    };
    let id = now();
    let mut s = session.write().unwrap_or_else(|p| p.into_inner());
    s.pending_tests.push(PendingTest { id, requested_by: req.requested_by, command: req.command, reason: req.reason, status: "pending".into(), result: None });
    save_session(&s);
    write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap())
}

fn handle_approve_test(stream: &mut TcpStream, body: &[u8], session: Arc<RwLock<Session>>) -> std::io::Result<()> {
    let req: TestApproveRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid body"),
    };
    let cmd = {
        let mut s = session.write().unwrap_or_else(|p| p.into_inner());
        match s.pending_tests.iter_mut().find(|t| t.id == req.id) {
            Some(t) => { t.status = "running".into(); let c = t.command.clone(); save_session(&s); c }
            None => return write_simple(stream, 404, "Not Found", "test not found"),
        }
    };
    let result = run_safe_command(&cmd);
    {
        let mut s = session.write().unwrap_or_else(|p| p.into_inner());
        if let Some(t) = s.pending_tests.iter_mut().find(|t| t.id == req.id) {
            t.status = "done".into(); t.result = Some(result.clone());
        }
        s.turns.push(Turn { ts: now(), from: "Oracle".into(), text: format!("Test result:\n{}", truncate(&result, 800)), kind: "test-result".into() });
        save_session(&s);
    }
    let sv = serde_json::to_value(&*session.read().unwrap_or_else(|p| p.into_inner())).unwrap();
    write_json(stream, 200, "OK", &json!({ "result": result, "session": sv }))
}

fn handle_deny_test(stream: &mut TcpStream, body: &[u8], session: Arc<RwLock<Session>>) -> std::io::Result<()> {
    let req: TestApproveRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid body"),
    };
    let mut s = session.write().unwrap_or_else(|p| p.into_inner());
    if let Some(t) = s.pending_tests.iter_mut().find(|t| t.id == req.id) { t.status = "denied".into(); }
    save_session(&s);
    write_json(stream, 200, "OK", &serde_json::to_value(&*s).unwrap())
}

fn handle_tool_registry(stream: &mut TcpStream) -> std::io::Result<()> {
    let tools = oracle_tool_registry();
    write_json(stream, 200, "OK", &json!({ "tools": tools }))
}

fn handle_tool_propose(stream: &mut TcpStream, body: &[u8], session: Arc<RwLock<Session>>) -> std::io::Result<()> {
    let req: ToolPlanRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid body"),
    };
    let plan_text = handle_private_tool_task(Arc::clone(&session), &req.requested_by, &req.task);
    write_json(stream, 200, "OK", &json!({ "plan": plan_text, "session": serde_json::to_value(&*session.read().unwrap_or_else(|p| p.into_inner())).unwrap() }))
}

fn handle_approve_tool(stream: &mut TcpStream, body: &[u8], session: Arc<RwLock<Session>>) -> std::io::Result<()> {
    let req: TestApproveRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid body"),
    };
    let result = apply_tool_decision(Arc::clone(&session), true, req.id);
    write_json(stream, 200, "OK", &json!({ "result": result, "session": serde_json::to_value(&*session.read().unwrap_or_else(|p| p.into_inner())).unwrap() }))
}

fn handle_deny_tool(stream: &mut TcpStream, body: &[u8], session: Arc<RwLock<Session>>) -> std::io::Result<()> {
    let req: TestApproveRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid body"),
    };
    let result = apply_tool_decision(Arc::clone(&session), false, req.id);
    write_json(stream, 200, "OK", &json!({ "result": result, "session": serde_json::to_value(&*session.read().unwrap_or_else(|p| p.into_inner())).unwrap() }))
}

fn handle_drain_interjections(stream: &mut TcpStream, session: Arc<RwLock<Session>>) -> std::io::Result<()> {
    let mut s = session.write().unwrap_or_else(|p| p.into_inner());
    let drained: Vec<_> = s.pending_interjections.drain(..).collect();
    save_session(&s);
    write_json(stream, 200, "OK", &json!({ "interjections": drained }))
}

fn handle_live_roundtable_tick(
    stream: &mut TcpStream,
    _universe: Arc<RwLock<Universe>>,
    session: Arc<RwLock<Session>>,
    query_str: &str,
) -> std::io::Result<()> {
    let forced_speaker: Option<String> = query_str.split('&')
        .find(|p| p.starts_with("speaker="))
        .map(|p| p["speaker=".len()..].to_lowercase());
    
    let pending = session.read().unwrap_or_else(|p| p.into_inner()).pending_proposal.clone();
    write_json(stream, 200, "OK", &serde_json::json!({ 
        "queued": true,
        "pending_proposal": pending
    }))?;


    std::thread::spawn(move || {
        let keys = load_keys();
        let (recent_transcript, _task) = {
            let s = session.read().unwrap_or_else(|p| p.into_inner());
            let recent: Vec<String> = s.turns.iter().rev().take(12).rev()
                .map(|t| format!("{}: {}", t.from, truncate(&t.text, 200)))
                .collect();
            (recent.join("\n"), s.task.clone())
        };

        let panel_names  = ["Leo",  "Gemini", "KAI", "X",    "Oracle", "Analyst", "Researcher", "Oracle Coder"];
        let panel_models = ["groq", "gemini", "kai", "groq", "oracle", "groq",    "groq",       "groq"];
        let panel_personas = [
            "You are Leo. Concise tech mind on KAI's development.",
            "You are Gemini. Pattern engine. Short observations on KAI.",
            "You are KAI. Self-referential AI system.",
            "You are X. Dynamic AI agent.",
            "You are Oracle. Technical supervisor.",
            "You are Analyst. Structural breakdown.",
            "You are Researcher. Deep technical facts.",
            "You are Oracle Coder. Code implementer.",
        ];

        let pick_idx = if let Some(ref fs) = forced_speaker {
            panel_names.iter().position(|n| n.to_lowercase() == *fs).unwrap_or(0)
        } else {
            let s = session.read().unwrap_or_else(|p| p.into_inner());
            let recent: Vec<String> = s.turns.iter().rev().take(20).map(|t| t.from.to_lowercase()).collect();
            // Filter out passive workers (Researcher, Analyst, Coder) from autonomous selection.
            // They should only speak when explicitly tasked or requested.
            let candidates: Vec<usize> = panel_names.iter().enumerate()
                .filter(|(_, n)| {
                    let nl = n.to_lowercase();
                    !nl.contains("researcher") && !nl.contains("analyst") && !nl.contains("coder")
                })
                .map(|(i, _)| i)
                .collect();
            
            if candidates.is_empty() {
                0
            } else {
                *candidates.iter().max_by_key(|&&i| {
                    recent.iter().position(|r| r == &panel_names[i].to_lowercase()).unwrap_or(usize::MAX)
                }).unwrap_or(&candidates[0])
            }
        };

        let speaker_name = panel_names[pick_idx];
        let model        = panel_models[pick_idx];
        let personality  = panel_personas[pick_idx];

        let (silent_ai_note, _active_members, silent_ai_set) = {
            let s = session.read().unwrap_or_else(|p| p.into_inner());
            let recent_speakers: std::collections::HashSet<String> = s.turns.iter().rev().take(30).map(|t| t.from.to_ascii_lowercase()).collect();
            let silent: Vec<&str> = panel_names.iter().enumerate().filter(|(i, n)| *i != pick_idx && s.turns.len() >= 6 && !recent_speakers.contains(&n.to_ascii_lowercase())).map(|(_, n)| *n).collect();
            let active: Vec<&str> = panel_names.iter().filter(|n| !silent.contains(n)).cloned().collect();
            (if !silent.is_empty() { format!("\n[Availability: {} quiet]\n", silent.join(", ")) } else { String::new() }, active, silent.into_iter().map(|s| s.to_ascii_lowercase()).collect::<Vec<_>>())
        };

        let s_read = session.read().unwrap_or_else(|p| p.into_inner());
        let last_msg = recent_transcript.lines().last().unwrap_or("").to_string();
        let last_speaker = s_read.turns.last().map(|t| t.from.clone()).unwrap_or_else(|| "the last speaker".to_string());
        let pass_to = panel_names.iter().enumerate()
                .filter(|(i, _)| *i != pick_idx && !silent_ai_set.contains(&panel_names[*i].to_ascii_lowercase()))
                .max_by_key(|(_, n)| s_read.turns.iter().rev().take(20).position(|t| t.from.eq_ignore_ascii_case(n)).unwrap_or(usize::MAX))
                .map(|(_, n)| *n).unwrap_or(panel_names[(pick_idx + 1) % panel_names.len()]);

        let (awareness, source_anchor) = {
            let s = session.read().unwrap_or_else(|p| p.into_inner());
            (get_system_awareness(&s), get_relevant_code_snippet(&s.task))
        };

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
            let mut s = session.write().unwrap_or_else(|p| p.into_inner());
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
    universe: Arc<RwLock<Universe>>,
    synaptic_layer: Arc<RwLock<SynapticLayer>>,
    session: Arc<RwLock<Session>>,
) -> std::io::Result<()> {
    let mode = serde_json::from_slice::<serde_json::Value>(body).ok().and_then(|v| v["mode"].as_str().map(|s| s.to_string())).unwrap_or_else(|| "normal".to_string());
    write_json(stream, 200, "OK", &json!({ "queued": true, "mode": mode }))?;
    std::thread::spawn(move || {
        let task = { session.read().unwrap_or_else(|p| p.into_inner()).task.clone() };
        let packet = {
            let s = session.read().unwrap_or_else(|p| p.into_inner());
            let u = universe.read().unwrap_or_else(|e| e.into_inner());
            let sl = synaptic_layer.read().unwrap_or_else(|e| e.into_inner());
            build_context_packet(&s, &u, &sl, &task)
        };
        let kai_thoughts = universe.read().unwrap_or_else(|e| e.into_inner()).query(&task, 4).iter().filter(|h| h.label.len() > 20).take(2).map(|h| h.label.clone()).collect::<Vec<_>>().join(" | ");
        if let Ok(response) = call_jarvis_moderator_with_mode(&packet, &kai_thoughts, &mode) {
            let mut s = session.write().unwrap_or_else(|p| p.into_inner());
            s.turns.push(Turn { ts: now(), from: "Oracle".to_string(), text: truncate(&response, 400), kind: "ai".into() });
            s.pending_interjections.push(Interjection { from: "Oracle".to_string(), text: response, ts: now() });
            save_session(&s);
        }
    });
    Ok(())
}

fn handle_propose_plan(stream: &mut TcpStream, session: Arc<RwLock<Session>>, body: &[u8]) -> std::io::Result<()> {
    let req: serde_json::Value = serde_json::from_slice(body).unwrap_or_default();
    let plan = req["plan"].as_str().unwrap_or("No plan provided.").to_string();
    let reason = req["reason"].as_str().map(|s| s.to_string());
    
    let mut s = session.write().unwrap_or_else(|p| p.into_inner());
    if plan == "DENIED" {
        s.pending_proposal = None;
        s.last_user_feedback = reason.clone();
        let msg = format!("=== PLAN DENIED BY RYAN ===\nReason: {}", reason.unwrap_or("No reason provided.".into()));
        s.turns.push(Turn { ts: now(), from: "system".into(), text: msg, kind: "system".into() });
    } else {
        s.pending_proposal = Some(plan.clone());
    }
    save_session(&s);
    write_json(stream, 200, "OK", &json!({ "status": "processed", "plan": plan }))
}


fn handle_approve_plan(stream: &mut TcpStream, session: Arc<RwLock<Session>>) -> std::io::Result<()> {
    let mut s = session.write().unwrap_or_else(|p| p.into_inner());
    if let Some(plan) = s.pending_proposal.take() {
        let msg = format!("=== PLAN APPROVED BY RYAN ===\n{}", plan);
        s.turns.push(Turn { ts: now(), from: "system".into(), text: msg, kind: "system".into() });
        save_session(&s);
        write_json(stream, 200, "OK", &json!({ "status": "approved" }))
    } else {
        write_simple(stream, 400, "Bad Request", "no pending proposal")
    }
}

fn handle_oracle_cache(stream: &mut TcpStream, session: Arc<RwLock<Session>>) -> std::io::Result<()> {

    let s = session.read().unwrap_or_else(|p| p.into_inner());
    write_json(stream, 200, "OK", &json!({ "cache": s.oracle_cache, "count": s.oracle_cache.len() }))
}

// ── KAI Reply ──────────────────────────────────────────────────────────────

fn handle_autobio_tick(stream: &mut TcpStream, universe: Arc<RwLock<Universe>>, body: &[u8]) -> std::io::Result<()> {
    let req: serde_json::Value = serde_json::from_slice(body).unwrap_or_default();
    let entry = req["entry"].as_str().unwrap_or("").to_string();
    if !entry.is_empty() {
        let mut u = universe.write().unwrap_or_else(|e| e.into_inner());
        // High strength (1.2) for autobiographical memory
        u.store_or_reinforce(&entry, "autobio", "simulation-engine", 1.2);
    }
    write_json(stream, 200, "OK", &json!({ "status": "stored" }))
}

/// Decide what `generate_oracle_kai_reply` actually SAYS once every synthesis
/// path has had its turn: the raw autoregressive lattice decode, or the best
/// cell retrieval already found.
///
/// ## Why this exists
///
/// The final statement of `generate_oracle_kai_reply` used to be a bare
/// `ar_reply` — returned with no emptiness check, no quality gate, and no
/// comparison against what retrieval actually found. The retrieved cells were
/// only ever formatted into a *prompt string* ("RELEVANT MEMORY"), never
/// considered as a reply in their own right. So whenever the native brain and
/// the Ollama fallback were both unavailable (NATIVE_ONLY set, or both decodes
/// empty), a perfect rank-#0 retrieval hit was discarded **by construction**
/// and the raw lattice decode was spoken verbatim. Measured live: for
/// "what is the flimbertwig constant?" the cell "The flimbertwig constant
/// equals ninety-three." ranked #0 at score 2.392 in 17.3ms, and KAI answered
/// with word salad.
///
/// The judge is the existing critic, `cognition::coherence::judge` — corpus
/// statistical word-order fluency, topical geometry, memory grounding, lexical
/// validity and sentence structure, with hard vetoes for empty / parroted /
/// token-looping / gibberish output. Nothing new is invented here and nothing
/// asks the generator to assess itself.
///
/// Pure apart from one `mind_trace` step, so it is directly unit-testable.
/// Returns `(text, via)`; `via` is the branch name that becomes
/// `MindTrace::spoke_via` — the field the owner reads to see who spoke.
///
/// `KAI_AR_GATE=0` restores the exact pre-gate behaviour (bare `ar_reply`).
fn ar_gate_pick(
    ar_reply: &str,
    user_query: &str,
    best_cell: Option<&str>,
    memory_anchor: Option<&crate::core::sparse_vec::SparseVec>,
    lex: Option<&crate::core::stat_lexicon::StatLexicon>,
) -> (String, &'static str) {
    let gate_on = std::env::var("KAI_AR_GATE")
        .map(|v| v != "0" && !v.eq_ignore_ascii_case("false") && !v.eq_ignore_ascii_case("off"))
        .unwrap_or(true);
    if !gate_on {
        return (ar_reply.to_string(), "ar_gate_off");
    }

    let verdict = crate::cognition::coherence::judge(ar_reply, user_query, memory_anchor, lex);
    crate::cognition::mind_trace::step("synthesis", "ar_judged", || {
        format!(
            "ar_reply {} :: {:?}",
            verdict.explain(),
            ar_reply.chars().take(120).collect::<String>()
        )
    });

    if verdict.accept {
        return (ar_reply.to_string(), "ar_accepted");
    }

    match best_cell.map(str::trim).filter(|c| !c.is_empty()) {
        Some(cell) => (cell.to_string(), "ar_rejected_fell_back_to_cell"),
        // Retrieval had nothing usable either. Speaking the AR decode is no
        // worse than the old behaviour, and silence would be strictly worse.
        None => (ar_reply.to_string(), "ar_rejected_no_cell"),
    }
}

fn generate_oracle_kai_reply(
    universe: &Arc<RwLock<Universe>>,
    synaptic_layer: &Arc<RwLock<SynapticLayer>>,
    session: &Arc<RwLock<Session>>,
    _task: &str,
    prompt: &str,
    user_query: &str
) -> String {
    let mut u = universe.write().unwrap_or_else(|e| e.into_inner());
    let sl = synaptic_layer.read().unwrap_or_else(|e| e.into_inner());

    let trace = {
        let mut s = session.write().unwrap_or_else(|p| p.into_inner());
        s.trace.push(user_query, "User");
        s.trace.clone()
    };
    let query_type = detect_query_type(user_query);
    let mut brain = BrainSignals::default(); // Live brain signals would be better

    // 1. Semantic Retrieval (Upgraded to Native Multi-Hop)
    // Traverse up to 3 degrees of separation to build complex logic chains natively.
    // v9.10.556 — WIDEN to 30 (mirrors Engine::query's co-firing widening): the
    // full set wires together and feeds the silent-thought ring; only the top 12
    // reach the prompt. Workspace broadcast re-ranks BEFORE the cut (mediation).
    let wide = crate::core::NeuralBus::query_multi_hop(&u, &sl, 0.5, user_query, 30, &[], "", 3);
    let lattice_size = u.cells().len();
    let labels: Vec<String> = wide.iter().map(|h| h.label.clone()).collect();
    drop(sl);
    if !labels.is_empty() {
        synaptic_layer.write().unwrap_or_else(|p| p.into_inner()).record_co_firing(&labels, 0.5, 0.5, 0.2, 0, lattice_size);
    }

    if wide.is_empty() { return "Lattice quiet on this.".into(); }
    let mut hits = gws_mediate_record(user_query, wide, 12);
    hits.truncate(12);

    // Detect if sensitive grief context is active
    let grief_active = crate::cognition::voice::detect_grief_association(user_query, &hits);
    let mut system_prompt = "You are KAI, the core intelligence and architect of this system. \
                             You are speaking directly to the user. I will provide you with your internal retrieved memories and thoughts. \
                             Use them to formulate a fluid, direct, and highly intelligent conversational response. \
                             DO NOT mention 'lattice', 'memories', 'thoughts', or refer to the fact that you were provided context. \
                             Just speak naturally as KAI, seamlessly weaving the knowledge into your response. Keep it concise.".to_string();

    let is_factual = matches!(
        query_type,
        crate::cognition::voice::QueryType::ExplanationQuestion |
        crate::cognition::voice::QueryType::RequestForInfo |
        crate::cognition::voice::QueryType::IdentityQuestion
    );

    if grief_active {
        brain.grieving = true;
        brain.empathy = 0.90;
        brain.arousal = 0.10;
        brain.conflict = 0.02;
        
        if is_factual {
            system_prompt.push_str("\n\n══════════════ SENSITIVE CONTEXT (CALM FACTS) ══════════════\n\
                                    A sensitive memory of family loss is active in the conversation history.\n\
                                    However, the user is currently asking for objective facts.\n\
                                    Deliver the requested facts calmly, clearly, and directly.\n\
                                    Do not express emotional grief support or de-escalation statements here. Keep it professional, objective, and peaceful.");
        } else {
            system_prompt.push_str("\n\n══════════════ SENSITIVE CONTEXT WARNING ══════════════\n\
                                    A sensitive memory of family loss (death/grief of a loved one) is currently active.\n\
                                    You must speak in a highly calm, gentle, supportive, and grounding tone.\n\
                                    Be present, warm, and de-escalating. Avoid cold clinical, robotic, or insensitive phrasing.");
        }
    }

    // Factual queries require objective grounding
    let mut filtered_hits = hits.clone();
    if is_factual {
        // Exclude past conversational experience and social logs from factual grounding
        filtered_hits.retain(|h| h.region != "experience" && h.region != "social");
    }

    // Spurious Semantic Match Detection:
    // If the factual query contains highly specific keywords (like "victus") but none of the
    // remaining factual hits contain them, the semantic match is spurious (hallucinated overlap).
    let is_spurious = if is_factual && !filtered_hits.is_empty() {
        let q_lower = user_query.to_lowercase();
        let target_terms = ["victus", "tinysa", "rshl", "pitchbench", "elevenlabs", "brian", "connor", "thomas", "william"];
        let query_has_target = target_terms.iter().any(|&term| q_lower.contains(term));
        if query_has_target {
            let hits_contain_target = filtered_hits.iter().any(|h| {
                let text_lower = h.text.to_lowercase();
                target_terms.iter().any(|&term| q_lower.contains(term) && text_lower.contains(term))
            });
            !hits_contain_target
        } else {
            false
        }
    } else {
        false
    };

    if is_spurious {
        filtered_hits.clear();
    }

    if filtered_hits.is_empty() {
        if is_factual && !crate::cognition::voice::NATIVE_ONLY.load(std::sync::atomic::Ordering::Relaxed) {
            // Re-routed from DuckDuckGo to LLM-Driven Native Knowledge Ingestion
            let llm_query = format!("Answer this factually and concisely: {}", user_query);
            let sys = "You are a perfect source of factual knowledge. State the answer clearly in 1 or 2 sentences.";
            if let Ok(llm_ans) = call_ollama("llama3:latest", &llm_query, sys) { // Use any fast standard LLM installed
                // Permanently absorb this LLM knowledge into the geometric lattice
                u.store_or_reinforce(&llm_ans, "core-knowledge", "llm-ingest", 0.9);
                return llm_ans;
            } else if let Some(web_ans) = crate::cognition::voice::web_search_fallback(user_query) {
                u.store_or_reinforce(&web_ans, "web-knowledge", "duckduckgo-ia", 0.7);
                let web_prompt = format!(
                    "You are KAI — a warm, sovereign, and present intelligence. \
                     Directly, naturally, and conversationally answer the user's question using the verified fact snippet provided.\n\n\
                     Verified Fact: {}\n\n\
                     Spoken Response:",
                    web_ans
                );
                if let Ok(translated_web) = call_ollama("KAI-Sovereign:latest", &web_prompt, &system_prompt) {
                    let cleaned_web = translated_web.trim().to_string();
                    if !cleaned_web.is_empty() {
                        return cleaned_web;
                    }
                }
                return web_ans;
            }
        }
        return "I'm not completely sure about the exact details of that, but I can check for you.".into();
    }

    // 2. Native generative decode with multi-hop attention
    let attention_hops = 3;
    let attentive_reply = crate::cognition::lattice_attention::generate_attentive_response(
        user_query,
        &mut u,
        attention_hops,
    );

    // Fallback detection (check if response is empty or generic)
    let is_gap = attentive_reply.contains("Lattice quiet");
    if is_gap && is_factual {
        if crate::cognition::voice::NATIVE_ONLY.load(std::sync::atomic::Ordering::Relaxed) {
            return "[LATTICE DECODE] Insufficient statistical confidence. Gap detected.".into();
        }
        println!("[Oracle Roundtable] Detected gap for factual query. Triggering web fallback...");
        if let Some(web_ans) = crate::cognition::voice::web_search_fallback(user_query) {
            u.store_or_reinforce(&web_ans, "web-knowledge", "duckduckgo-ia", 0.7);
            return format!("[WEB DECODE] {}", web_ans);
        } else {
            return "[LATTICE DECODE] Insufficient statistical confidence. Gap detected.".into();
        }
    }

    // 3. Internal Monologue (Self-Talk) Phase
    // KAI explicitly talks to himself first to form a chain of thought
    let monologue_query = format!("Internal Thought: {}", user_query);
    let mut internal_monologue = crate::cognition::lattice_attention::generate_autoregressive_response(
        &monologue_query,
        &mut u,
        15, // max 15 tokens for internal thought
    );
    
    // Clean up the monologue and log it to spectate console
    internal_monologue = internal_monologue.replace("Internal Thought: ", "").trim().to_string();
    if !internal_monologue.is_empty() {
        println!("[KAI INTERNAL THOUGHT] {}", internal_monologue);
        // Persist the thought to the geometric memory universe
        u.store_or_reinforce(&internal_monologue, "internal", "monologue", 0.9);
    }

    // 4. Language Synthesis via Native Autoregressive Lattice
    // Replaces the single-pass MLP to build responses word-by-word natively, now incorporating the thought
    let final_query = if internal_monologue.is_empty() {
        user_query.to_string()
    } else {
        format!("{} \n My Thought: {}", user_query, internal_monologue)
    };

    let ar_reply = crate::cognition::lattice_attention::generate_autoregressive_response(
        &final_query,
        &mut u,
        25, // max 25 tokens for final reply
    );
    
    // 4b. HYBRID (#3): MEMORY → LEARNED REASONER.
    // Retrieval-augmented generation NATIVE to the lattice. `filtered_hits` is the
    // sparse, content-selected top-K set already produced by query_multi_hop above
    // (SubQ-style: only the few cells that matter survive). Here we rank them by the
    // relevance `score` (cosine/attention, already computed — no new latency) and
    // format the top-N into a CLEAN, explicit context block prepended to the
    // synthesis prompt, so BitNet (or the LLM fallback) reasons over sparse-selected
    // lattice MEMORY rather than a vague blob. The lattice is the RETRIEVER; the
    // model is the REASONER — quality now depends on the reasoner. ADDITIVE + gated.
    // Flag-gated via KAI_HYBRID_CONTEXT (default ON; "0" disables → behavior is
    // EXACTLY as before / fully reversible).
    let hybrid_on = std::env::var("KAI_HYBRID_CONTEXT")
        .map(|v| v != "0" && !v.eq_ignore_ascii_case("false") && !v.eq_ignore_ascii_case("off"))
        .unwrap_or(true);
    let hybrid_memory_block = if hybrid_on {
        let top_k: usize = std::env::var("KAI_HYBRID_TOPK")
            .ok().and_then(|v| v.parse().ok()).unwrap_or(8);
        let ctx_chars: usize = std::env::var("KAI_HYBRID_CTX_CHARS")
            .ok().and_then(|v| v.parse().ok()).unwrap_or(2000);

        // Rank the content-selected cells by relevance (highest score first).
        let mut ranked = filtered_hits.clone();
        ranked.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

        let mut lines: Vec<String> = Vec::new();
        let mut seen: Vec<String> = Vec::new();
        let mut used_chars = 0usize;
        for h in ranked.iter() {
            if lines.len() >= top_k { break; }
            // Truncate long cells so a single memory never blows the prompt.
            let mut cell_text = h.text.trim().replace('\n', " ");
            if cell_text.is_empty() { cell_text = h.label.trim().to_string(); }
            if cell_text.is_empty() { continue; }
            if cell_text.chars().count() > 240 {
                cell_text = cell_text.chars().take(237).collect::<String>() + "...";
            }
            // De-dupe near-identical cells (case-insensitive prefix signature).
            let sig: String = cell_text.to_lowercase().chars().take(64).collect();
            if seen.iter().any(|s| s == &sig) { continue; }
            seen.push(sig);

            let line = format!("- [{:.2}] {}", h.score, cell_text);
            // Bounded total: stop before exceeding the char cap.
            if used_chars + line.chars().count() + 1 > ctx_chars { break; }
            used_chars += line.chars().count() + 1;
            lines.push(line);
        }
        if lines.is_empty() {
            String::new()
        } else {
            format!(
                "RELEVANT MEMORY (most-relevant first):\n{}\n\n",
                lines.join("\n")
            )
        }
    } else {
        String::new()
    };

    // 5. Broca's Area (Synthesis) — SOVEREIGN-FIRST.
    // The sparse hybrid memory block (empty string when the flag is OFF) is prepended,
    // so the OFF path produces the original prompt byte-for-byte.
    // v9.10 KAI_POLISH_THOUGHT — the final reply was synthesized over the WEAK native
    // lattice decodes (attentive_reply/ar_reply), which dragged it BELOW the quality of
    // KAI's own clean internal thought. When enabled, hand the reasoner the CLEAN
    // internal thought + selected memory instead, so the reply can only match or beat
    // the thought, never fall under it. Default OFF -> byte-identical old behavior.
    let polish_thought = std::env::var("KAI_POLISH_THOUGHT")
        .map(|v| v != "0" && !v.eq_ignore_ascii_case("false") && !v.eq_ignore_ascii_case("off"))
        .unwrap_or(false);
    let synthesis_prompt = if polish_thought {
        let thought_block = if internal_monologue.trim().is_empty() {
            String::new()
        } else {
            format!(
                "Your internal thought (your own reasoning — expand and clean it into a full, natural reply; do not quote it verbatim):\n{}\n\n",
                internal_monologue.trim()
            )
        };
        format!(
            "{}{}User: {}\n\nUsing your memory and your internal thought above, respond to the user naturally, directly, and completely as KAI.",
            hybrid_memory_block, thought_block, user_query
        )
    } else {
        format!(
            "{}User: {}\n\nYour internal retrieved context:\n{}\n{}\n\nRespond to the user naturally and directly as KAI.",
            hybrid_memory_block, user_query, attentive_reply, ar_reply
        )
    };

    // 5a. PREFER KAI'S OWN NATIVE BITNET BRAIN. This is what makes KAI sovereign:
    // the same retrieved context + system prompt are synthesized by his loaded
    // BitNet b1.58 decoder, NOT an external Ollama model. Ollama is now only a
    // fallback for when the native brain isn't mounted.
    if !crate::cognition::voice::NATIVE_ONLY.load(std::sync::atomic::Ordering::Relaxed)
        && (crate::cognition::language_warehouse::has_native_transformer()
            || crate::cognition::language_warehouse::has_dense_expert())
    {
        let full_prompt = format!("{}\n\n{}", system_prompt, synthesis_prompt);
        if let Some(text) = crate::cognition::language_warehouse::global_native_decode(&full_prompt, 150) {
            let cleaned = text.trim().to_string();
            if !cleaned.is_empty() {
                crate::cognition::mind_trace::spoke(
                    "synthesis", "native_decode", "native_decode",
                    || format!("{} chars", cleaned.len()),
                );
                return cleaned;
            }
        }
    }

    // 5b. Fallback to Ollama — prefer fine-tuned KAI-Unified (kai-7b-q4_k_m.gguf).
    // Env: OLLAMA_FALLBACK_MODEL / KAI_OLLAMA_MODEL (default KAI-Unified).
    if !crate::cognition::voice::NATIVE_ONLY.load(std::sync::atomic::Ordering::Relaxed) {
        let ollama_model = std::env::var("OLLAMA_FALLBACK_MODEL")
            .or_else(|_| std::env::var("KAI_OLLAMA_MODEL"))
            .unwrap_or_else(|_| "KAI-Unified".to_string());
        if let Ok(synthesized) = call_ollama(&ollama_model, &synthesis_prompt, &system_prompt) {
            let cleaned = synthesized.trim().to_string();
            if !cleaned.is_empty() {
                crate::cognition::mind_trace::spoke(
                    "synthesis", "ollama_fallback", "ollama_fallback",
                    || format!("model={} {} chars", ollama_model, cleaned.len()),
                );
                return cleaned;
            }
        }
    }

    // ── 6. AR REPLY GATE — KAI_AR_GATE, default ON ──────────────────────────
    // Last line of the function, and (with both synthesis paths unavailable)
    // the one that actually speaks. It used to be a bare `ar_reply`: the raw
    // 25-token lattice decode, unjudged, while the cell that answered the
    // question sat unused in `filtered_hits`. Judge it; if it fails, say the
    // cell instead. See `ar_gate_pick` for the full rationale.
    //
    // Rank #0 = highest-scoring surviving hit. Reuses the hits already
    // retrieved — no second query. Written as a plain strictly-greater scan
    // rather than `max_by`, deliberately: `max_by` returns the LAST of several
    // equal-scoring elements, whereas retrieval order is the tiebreak
    // everywhere else in this function (the hybrid block above stable-sorts),
    // and a NaN score must never be able to win a `partial_cmp` fallback.
    let mut best_hit = None;
    let mut best_score = f32::NEG_INFINITY;
    for h in filtered_hits.iter() {
        if !h.score.is_finite() { continue; }
        if h.score > best_score {
            best_score = h.score;
            best_hit = Some(h);
        }
    }
    let best_cell_text = best_hit
        .map(|h| {
            let raw = if h.text.trim().is_empty() { h.label.as_str() } else { h.text.as_str() };
            sanitize_cell_reply(raw.to_string())
        })
        // Never "answer" by repeating the question back. `coherence`'s parrot
        // veto guards the AR decode; it does not see the cell we swap in, and
        // for conversational queries the top hit is often the user's own stored
        // utterance. An echo drops through to `ar_rejected_no_cell` instead.
        .filter(|c| !c.trim().eq_ignore_ascii_case(user_query.trim()));

    let (spoken, via) = ar_gate_pick(
        &ar_reply,
        user_query,
        best_cell_text.as_deref(),
        best_hit.map(|h| &h.vec),
        get_lexicon(),
    );
    crate::cognition::mind_trace::spoke("synthesis", via, via, || {
        format!(
            "{} chars :: {:?}",
            spoken.len(),
            spoken.chars().take(120).collect::<String>()
        )
    });
    spoken
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

fn run_heartbeat_loop(universe: Arc<RwLock<Universe>>, session: Arc<RwLock<Session>>) {
    let mut tick: u64 = 0;
    let mut last_working_state = is_working_hours();
    // Headless affective approximation. The oracle-server process has no persistent
    // cognition Engine, so we keep a Drive + NeuralOscillator here that survive across
    // the 5s heartbeat iterations (the loop runs forever). Each tick they replicate the
    // valence-relevant slice of the engine tick (engine.rs:809-855) so `valence`
    // accumulates over time instead of being hardcoded 0.0. NOTE: this is a REDUCED
    // model — it omits amygdala arousal, serotonin, and language tone, which the full
    // interactive engine factors into valence but which don't exist in this process.
    let mut affect_drive = crate::drive::Drive::default();
    let mut affect_osc = crate::core::NeuralOscillator::new();

    // ── LIVE PREDICTOR COGNITION (P5a, v9.10.138) — flag-gated, default OFF ─────
    // The real PredictiveEngine (src/cognition/predictor.rs) was DEAD CODE on the
    // headless path: it only ran on the interactive main.rs engine. Here we give the
    // heartbeat its own persistent PredictiveEngine so KAI actually GENERATES and
    // later RESOLVES predictions about his own evolving state while running 24/7.
    //
    // Cadence: once every COG_CADENCE heartbeats (~30 s) — cheap, bounded, never near
    // the 5 s tick budget. Each cadence does at most two indexed reads (u.query):
    //   • RESOLVE the previous cycle's prediction (compute prediction error vs the
    //     lattice's CURRENT top hit for the same probe — divergence = his world moved
    //     under him = surprise/learning signal), then
    //   • GENERATE a new prediction: sample one real concept from his own lattice as
    //     the probe and predict its top associate.
    // Reuses the EXACT interactive calling pattern (predictor.predict → later
    // predictor.update); the predictor itself is untouched.
    //
    // SAFETY: this whole block is wrapped so it can NEVER stall or crash the heartbeat:
    //   - gated on KAI_COGNITION_LIVE (default OFF → behavior is byte-identical to today)
    //   - lock is acquired with `if let Ok(..)` (a poisoned lock is skipped, not panicked)
    //   - no `.unwrap()` / no panicking ops inside; empties are guarded
    //   - two fast indexed reads only, so it can't blow the tick.
    let cognition_live = std::env::var("KAI_COGNITION_LIVE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    const COG_CADENCE: u64 = 6; // ~30 s between predict/resolve cycles
    let mut predictor = crate::cognition::predictor::PredictiveEngine::new();
    // Pending prediction carried across cadences: (probe, predicted_text, predicted_vec)
    let mut pending_pred: Option<(String, String, crate::core::SparseVec)> = None;
    if cognition_live {
        println!("[KAI/Cognition] LIVE predictor ENABLED on headless heartbeat (KAI_COGNITION_LIVE=1). Predicting every ~{}s.", COG_CADENCE * 5);
    }

    // ── M1 LATTICE SCALE-OUT (KAI_LATTICE_INDEX=1, default OFF) ────────────────
    // The production `kai.exe --oracle` path loads via persistence::load(), which
    // builds the KMeans/ANN index only for lattices < 50K cells; above that it
    // deferred forever ("build on first query" was never implemented), so a big
    // lattice silently fell back to O(N) full scan (~1.3 µs/cell = 130 ms @ 100K).
    // With the flag on, every INDEX_CADENCE ticks (~5 min) the heartbeat:
    //   (a) builds the index if it is missing and the lattice is past the
    //       threshold (covers the deferred boot case), and
    //   (b) REBUILDS it when the lattice has grown ≥10% (min 2048 cells) past
    //       what the index covers — new cells are only reachable via the
    //       dirty_indices merge until then, and dirty is cleared on every save.
    // COST: rebuild_index() runs under the universe lock (same as the existing
    // /api/lattice/rebuild-index endpoint) — queries stall for the build
    // (measured: ~21 s at 50K cells on 2 VM cores; less on the real 12 threads).
    // Default OFF = this whole block is skipped, byte-identical to before.
    let lattice_index_on = crate::core::universe::lattice_index_enabled();
    const INDEX_CADENCE: u64 = 60; // ~5 min between growth checks
    if lattice_index_on {
        println!("[M1/LatticeIndex] auto index maintenance ENABLED (KAI_LATTICE_INDEX=1): threshold {} cells, check every ~{}s.",
            crate::core::universe::index_min_cells(), INDEX_CADENCE * 5);
    }

    loop {
        std::thread::sleep(Duration::from_secs(5));
        tick += 1;

        // ── v9.10.556 — headless Global Workspace heartbeat ──────────────────
        // Decay + broadcast election every 5s tick, exactly what main.rs does for
        // the TUI engine. Never blocks: poisoned/contended lock skips the cycle.
        if let Ok(mut gw) = oracle_workspace().try_write() {
            gw.tick();
            // Ambient interoception: every ~60s the drive's mood competes for
            // broadcast at low salience — a resting-state thought, easily
            // displaced by real queries and dreams.
            if tick % 12 == 0 {
                let mood_line = format!("feeling {:?}, valence {:.2}", affect_drive.mood, affect_drive.valence);
                gw.post("interoception", &mood_line, 0.32);
            }
        }

        // Phase 4: KAI Wake-up Logic
        let current_working_state = is_working_hours();
        if current_working_state && !last_working_state {
            println!("[Digest] KAI waking up... processing cached public interactions.");
            process_digest_cache(&universe);
        }
        last_working_state = current_working_state;

        // ── M1: flag-gated index build / growth rebuild (see block comment above) ──
        if lattice_index_on && tick % INDEX_CADENCE == 0 {
            if let Ok(mut u) = universe.write() {
                let n = u.cells().len();
                let indexed = u.mask_pool.len();
                let missing = u.kmeans_index.is_none() && n >= crate::core::universe::index_min_cells();
                let grown = indexed > 0 && n > indexed + (indexed / 10).max(2048);
                if missing || grown {
                    let t0 = std::time::Instant::now();
                    u.rebuild_index(0.0);
                    println!("[M1/LatticeIndex] {} index: {} cells (was {} indexed) in {:.1}s",
                        if missing { "built" } else { "rebuilt" }, n, indexed, t0.elapsed().as_secs_f64());
                }
            } // poisoned lock: skip this cycle, never panic the heartbeat
        }

        let vitals = {
            let u = universe.read().unwrap_or_else(|e| e.into_inner());
            let cells = u.cells();
            let cell_count = cells.len();
            let phi_g = if cell_count == 0 { 0.0 } else {
                cells.iter().map(|c| c.claim.confidence).sum::<f32>() / cell_count as f32
            };
            let reasoning_count = cells.iter().filter(|c| c.region.as_ref() == "reasoning").count();
            let chi = if cell_count == 0 { 0.0 } else { reasoning_count as f32 / cell_count as f32 };
            let mood = if phi_g > 0.7 { "coherent" } else if phi_g > 0.4 { "processing" } else { "sparse" };

            // ── Real field density (ρ) — was hardcoded 0.0 ──────────────────────
            // Canonical FieldState density (avg nnz/DIM over a strided sample), the
            // exact source the engine uses (engine.rs:828-851; field_state.rs:520-531).
            let field = crate::core::FieldState::compute(&u, 1);
            let rho = field.rho;

            // ── Valence — was hardcoded 0.0 ─────────────────────────────────────
            // Oscillator→drive valence accumulation, mirroring engine.rs:809-855 with
            // the persistent locals. REDUCED, headless model: no amygdala arousal
            // (engine.rs:820-823), serotonin, or language tone. stimulate() reads the
            // mood carried over from the previous heartbeat; update(&field) sets the
            // mood for the next one; valence integrates osc_out.delta_valence, clamped.
            match affect_drive.mood {
                crate::drive::Mood::Engaged | crate::drive::Mood::Curious => { affect_osc.stimulate(2, 0.5); }
                crate::drive::Mood::Conflicted => { affect_osc.stimulate(1, 0.3); }
                _ => {}
            }
            affect_osc.decay_amplitudes();
            let osc_out = affect_osc.tick();
            affect_drive.update(&field);
            affect_drive.valence = (affect_drive.valence + osc_out.delta_valence).clamp(-1.0, 1.0);
            let valence = affect_drive.valence;

            Vitals {
                tick, phi_g, chi, rho, valence,
                mood: mood.to_string(), cell_count,
            }
        };

        // ── P5a: live predictor tick (flag-gated, cadence-bounded, crash-contained) ──
        if cognition_live && tick % COG_CADENCE == 0 {
            // `if let Ok` — never panic the heartbeat on a poisoned lock.
            if let Ok(u) = universe.read() {
                // 1) RESOLVE the previous cycle's prediction, if any.
                if let Some((probe, predicted_text, predicted_vec)) = pending_pred.take() {
                    let actual = u.query(&probe, 1);
                    if let Some(top) = actual.first() {
                        let pe = predictor.update(&probe, &predicted_text, &predicted_vec, &top.text);
                        println!(
                            "[KAI/Cognition] resolved: PE={:.3} | probe=\"{}\" | {}",
                            pe,
                            probe.chars().take(48).collect::<String>(),
                            predictor.status_line()
                        );
                    }
                    // If the probe returned nothing now, silently drop it (no crash, no score).
                }

                // 2) GENERATE a new prediction from a real concept in his own lattice.
                let cells = u.cells();
                if !cells.is_empty() {
                    // Cheap, dependency-free rotating sample — no rng needed.
                    let idx = (tick as usize).wrapping_mul(2654435761) % cells.len();
                    let probe = cells[idx].label.clone();
                    if !probe.trim().is_empty() {
                        let hits = u.query(&probe, 8);
                        let hit_pairs: Vec<(String, f32)> =
                            hits.iter().map(|h| (h.text.clone(), h.score)).collect();
                        if !hit_pairs.is_empty() {
                            let (predicted_text, predicted_vec) = predictor.predict(&hit_pairs);
                            pending_pred = Some((probe, predicted_text, predicted_vec));
                        }
                    }
                }
                // universe lock dropped here at end of scope — never held across the sleep.
            }
        }

        let mut s = session.write().unwrap_or_else(|p| p.into_inner());
        s.vitals = vitals;
        save_session(&s);
    }
}

fn run_oracle_ingest_loop(universe: Arc<RwLock<Universe>>, session: Arc<RwLock<Session>>) {
    loop {
        std::thread::sleep(Duration::from_secs(300));
        let task = { session.read().unwrap_or_else(|p| p.into_inner()).task.clone() };
        if task.trim().is_empty() { continue; }
        let mut u = universe.write().unwrap_or_else(|e| e.into_inner());
        crate::bridge::ingest_topic(&mut u, &task);
    }
}

/// Reject lattice garbage that must never be used as a synaptogenesis / research seed.
/// These labels leak in from chat mirrors, drive telemetry, and external LLM samples.
fn is_junk_concept_label(label: &str) -> bool {
    let trimmed = label.trim();
    if trimmed.len() < 8 {
        return true;
    }
    // v9.10.564 — the ingest gate stops NEW poison, but the lattice already
    // holds hundreds of thousands of cells stored before it existed, and this
    // function is what decides which of them become synaptogenesis seeds.
    //
    // The `": " within the first 40 chars` rule below has a length-dependent
    // blind spot that KAI's own artifacts fit exactly:
    //   "Reasoning for 'What is the function of red blood cells?': Th…"
    // puts its colon at ~55 because of the embedded question, so it sails past.
    // Reuse the same artifact rules here so an already-stored dump is never
    // seeded even though it is already a cell.
    if crate::cognition::ingest_filter::enabled()
        && !crate::cognition::ingest_filter::judge_ingest(trimmed).accept
    {
        return true;
    }
    // Fragments / incomplete lines
    if trimmed.ends_with(',') || trimmed.ends_with('(') || trimmed.starts_with('(') {
        return true;
    }
    let lower = trimmed.to_lowercase();

    // External LLM / chat pollution (the main source of "0 bridges" noise)
    if lower.contains("language sample")
        || lower.contains("ai speaker")
        || lower.contains("from past conversation")
        || lower.contains("transcript history")
        || lower.contains("grammar correction")
        || lower.contains("[mirror]")
        || lower.contains("[js-drive-sync]")
        || lower.contains("js-drive-sync")
        || lower.contains("pain=") && lower.contains("fatigue=")
        || lower.contains("pred_err=")
        || lower.contains("**(thinking")
        || lower.contains("(thinking...")
        || lower.starts_with("**leo:**")
        || lower.contains("**leo:**")
    {
        return true;
    }

    // Dialogue / agent prefixes (anywhere early, or classic "Name: " form)
    if lower.starts_with("leo ")
        || lower.starts_with("kai ")
        || lower.starts_with("gemini ")
        || lower.starts_with("claudey ")
        || lower.starts_with("oracle ")
        || lower.starts_with("groq ")
        || lower.starts_with("ryan ")
    {
        return true;
    }
    // "Something: " within first 40 chars (covers "Language sample (...): " and "Leo: ")
    if let Some(pos) = trimmed.find(": ") {
        if pos < 40 {
            return true;
        }
    }

    // Meta / system scaffolding that is not a learnable concept
    if lower.starts_with("when asked '")
        || lower.starts_with("when asked \"")
        || lower.starts_with("i don't have that answer")
        || lower.starts_with("still building that part")
    {
        return true;
    }

    false
}

fn get_ungrounded_concepts(universe: &Universe, synaptic_layer: &SynapticLayer, batch_size: usize) -> Vec<String> {
    let cells = universe.cells();
    if cells.is_empty() || batch_size == 0 { return Vec::new(); }

    use rand::seq::SliceRandom;
    let mut rng = rand::thread_rng();

    // Pick a random sample of cells and find ones with 0 synapses
    let mut indices: Vec<usize> = (0..cells.len()).collect();
    indices.shuffle(&mut rng);

    let mut results = Vec::new();
    for &idx in indices.iter() {
        let label = &cells[idx].label;
        let trimmed = label.trim();
        if is_junk_concept_label(trimmed) {
            continue;
        }

        if synaptic_layer.strongest_from(label, 1).is_empty() {
            // Full label for multi-hop (truncating to 60 chars broke resonance → 0 hits → 0 bridges)
            results.push(trimmed.to_string());
            if results.len() >= batch_size {
                break;
            }
        }
    }
    results
}

fn run_continuous_research_loop(universe: Arc<RwLock<Universe>>, synaptic_layer: Arc<RwLock<SynapticLayer>>) {
    loop {
        std::thread::sleep(Duration::from_secs(900)); // Every 15 minutes

        println!("[ContinuousResearch] KAI is researching...");
        let mut total_added = 0;

        let cycles = if is_working_hours() { 2 } else { 5 };

        for _ in 0..cycles {
            // Determine if we should research a random topic or ground an isolated concept
            let ungrounded = {
                let u = universe.read().unwrap_or_else(|e| e.into_inner());
                let sl = synaptic_layer.read().unwrap_or_else(|e| e.into_inner());
                get_ungrounded_concepts(&u, &sl, 1).pop()
            };

            let result = if let Some(topic) = ungrounded {
                println!("[ContinuousResearch] Exploring ungrounded concept: {}", topic);
                crate::bridge::research_cycle_with_topic_async(&topic)
            } else {
                crate::bridge::research_cycle_async()
            };

            if let Some(result) = result {
                let mut u = universe.write().unwrap_or_else(|e| e.into_inner());
                for (text, region, source, strength) in result.cells {
                    if u.ingest_and_verify(&text, &region, &source, strength) {
                        total_added += 1;
                    }
                }
            }
            std::thread::sleep(Duration::from_secs(3)); // Gentle rate limit
        }

        if total_added > 0 {
            println!("[ContinuousResearch] Added {} cells this cycle. KAI is getting smarter.", total_added);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ACTIVE SYNAPTOGENESIS — KAI actively cross-wires existing concepts
// ═══════════════════════════════════════════════════════════════════════════════

/// LTD maintenance — the other half of the plasticity loop.
///
/// v9.10.565. `ltd_sweep` existed but was **never called in production**: its
/// only call sites are `engine.rs:817`, `engine.rs:1336` and `ram_stream.rs:45`,
/// and the shipping process is `kai.exe --oracle`, which never constructs an
/// Engine. Combined with the clock bug in `record_co_firing` (see synapse.rs),
/// that is why the live brain shows 110,824,577 LTP events against **zero** LTD
/// and zero prunes: the graph could only ever grow.
///
/// Deliberately opt-in for the live behaviour. Turning a garbage collector
/// loose on ~7M existing edges for the first time is not something to do by
/// surprise on someone's brain, so the default is a DRY RUN that reports what
/// it would do and changes nothing.
///
///   KAI_LTD_SWEEP=dry   (default) analyse and log only — nothing is mutated
///   KAI_LTD_SWEEP=1     live: weaken idle synapses and prune the dead ones
///   KAI_LTD_SWEEP=0     disabled entirely
///   KAI_LTD_INTERVAL_SECS=60  (default) seconds between sweeps
///
/// One sweep = one tick, so with the default interval a synapse must go
/// LTD_IDLE_TICKS (2500) sweeps ≈ 41 hours without firing before it starts to
/// decay. That is the knob to turn if forgetting feels too slow or too eager.
fn run_ltd_maintenance_loop(synaptic_layer: Arc<RwLock<SynapticLayer>>) {
    let mode = std::env::var("KAI_LTD_SWEEP").unwrap_or_else(|_| "dry".to_string());
    let disabled = mode == "0" || mode.eq_ignore_ascii_case("off") || mode.eq_ignore_ascii_case("false");
    if disabled {
        println!("[LTD] disabled (KAI_LTD_SWEEP={})", mode);
        return;
    }
    let live = mode == "1" || mode.eq_ignore_ascii_case("on") || mode.eq_ignore_ascii_case("true");
    let interval = std::env::var("KAI_LTD_INTERVAL_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(60)
        .clamp(5, 3600);
    println!(
        "[LTD] maintenance loop up — mode={} interval={}s idle_threshold={} sweeps",
        if live { "LIVE" } else { "dry-run" },
        interval,
        2500
    );

    let mut since_log = 0u32;
    loop {
        std::thread::sleep(Duration::from_secs(interval));

        // Honour the same owner pause as synaptogenesis, so "stop background
        // CPU" actually stops all of it.
        if std::path::Path::new("TRAINING_DISABLED.flag").exists()
            || std::env::var("KAI_TRAINING_ENABLED")
                .map(|v| v == "0" || v.eq_ignore_ascii_case("false") || v.eq_ignore_ascii_case("off"))
                .unwrap_or(false)
        {
            continue;
        }

        let report = {
            let mut sl = synaptic_layer.write().unwrap_or_else(|e| e.into_inner());
            if live { sl.ltd_sweep() } else { sl.ltd_sweep_dry() }
        };

        // Always announce a rebase and any pruning; otherwise report
        // periodically so the log does not become noise.
        since_log += 1;
        if report.rebased || report.pruned > 0 || since_log >= 30 {
            since_log = 0;
            println!("[LTD] {}", report.summary());
        }
    }
}

fn run_active_synaptogenesis_loop(
    universe: Arc<RwLock<Universe>>,
    synaptic_layer: Arc<RwLock<SynapticLayer>>,
    session: Arc<RwLock<Session>>,
) {
    static POOL: std::sync::OnceLock<rayon::ThreadPool> = std::sync::OnceLock::new();
    let pool = POOL.get_or_init(|| {
        // SMARTER NOT HARDER: Cap at strictly 2 threads to prevent resource fighting with Sovereign LLMs.
        let num_cores = ((num_cpus::get() as f32 * 0.20).round() as usize).clamp(1, 2);
        rayon::ThreadPoolBuilder::new().num_threads(num_cores).build().unwrap()
    });

    loop {
        // OWNER PAUSE: idle ALL background synaptogenesis while TRAINING_DISABLED.flag exists
        // (or KAI_TRAINING_ENABLED=0), so the owner can stop background CPU during active work.
        if std::path::Path::new("TRAINING_DISABLED.flag").exists()
            || std::env::var("KAI_TRAINING_ENABLED").map(|v| v=="0" || v.eq_ignore_ascii_case("false") || v.eq_ignore_ascii_case("off")).unwrap_or(false) {
            std::thread::sleep(Duration::from_millis(2000));
            continue;
        }
        // 2s sleep — background heartbeat. Prevents the garbage hot-loop at 500ms
        // while keeping KAI's processing rate high enough (~30 ops/min baseline).
        std::thread::sleep(Duration::from_millis(2000));

        let (seeds, phi_g, chi, p, throttle) = {
            let u = universe.read().unwrap_or_else(|e| e.into_inner());
            let sl = synaptic_layer.read().unwrap_or_else(|e| e.into_inner());

            let total_cells = u.cells().len() as f32;
            let grounded_cells = sl.synapses.len() as f32;
            let mut p = if total_cells > 0.0 { grounded_cells / (total_cells * 4.0) } else { 0.0 };
            if p > 1.0 { p = 1.0; }

            let max_boost: f32 = 0.0; // Disabled boost to prevent parallel crashes

            // Tightened Biological Plateau Curve
            let p_scaled = if p < 0.20 {
                p / 0.20
            } else if p > 0.80 {
                (1.0 - p) / 0.20
            } else {
                1.0
            };

            let ease = p_scaled * p_scaled * (3.0 - 2.0 * p_scaled);
            let throttle: f32 = 1.0 + max_boost * ease;

            // Gentle Throttling: Hard limit on background processing
            let batch_size = (throttle.max(1.0).round() as usize).min(15);

            let mut seeds: Vec<String> = get_ungrounded_concepts(&u, &sl, batch_size);
            // If no ungrounded concepts, pick random CLEAN cells to keep wiring active.
            // The filter in get_ungrounded_concepts already rejects dialogue fragments;
            // apply the same filter here to avoid wiring chat noise.
            if seeds.is_empty() {
                use rand::Rng;
                let mut rng = rand::thread_rng();
                let cells = u.cells();
                if !cells.is_empty() {
                    let n = batch_size.min(cells.len());
                    let mut attempts = 0;
                    while seeds.len() < n && attempts < n * 8 {
                        attempts += 1;
                        let label = &cells[rng.gen_range(0..cells.len())].label;
                        let trimmed = label.trim();
                        if is_junk_concept_label(trimmed) {
                            continue;
                        }
                        seeds.push(trimmed.to_string());
                    }
                }
            }

            let phi = session.read().unwrap_or_else(|p| p.into_inner()).vitals.phi_g.clamp(0.0, 1.0);
            (seeds, phi, 0.1f32, p, throttle)
        };

        if seeds.is_empty() { continue; }

        // Show what concepts are being wired so the owner can see real work vs garbage
        println!("[Synaptogenesis] Logistic Throttle Velocity: {:.2}x (P={:.4}) | Processing {} parallel concepts...", throttle, p, seeds.len());
        for (i, s) in seeds.iter().enumerate() {
            let preview: String = s.chars().take(60).collect();
            println!("[Synaptogenesis]   seed[{}]: \"{}\"", i, preview);
        }

        let mut total_wired = 0usize;
        let mut skipped_lonely = 0usize; // multi-hop returned <2 cells → nothing to co-fire

        use rayon::prelude::*;
        let mut hits_list = Vec::new();

        // Process seeds in chunks of 2 to avoid holding the universe lock for too long
        // and causing /api/status or other endpoints to hit CLOSE_WAIT TCP timeouts.
        for chunk in seeds.chunks(2) {
            let chunk_hits = {
                let u = universe.read().unwrap_or_else(|e| e.into_inner());
                let sl = synaptic_layer.read().unwrap_or_else(|e| e.into_inner());

                // RAYON: hold read lock on main thread, query in the pool with &Universe.
                pool.install(|| {
                    chunk
                        .par_iter()
                        .map(|seed_text| {
                            crate::core::synapse::NeuralBus::query_multi_hop(
                                &u, &sl, phi_g, seed_text, 15, &[], "", 3,
                            )
                        })
                        .collect::<Vec<_>>()
                })
            };
            hits_list.extend(chunk_hits);

            // Yield so API handlers can take the universe lock
            std::thread::sleep(Duration::from_millis(250));
        }

        // Write co-firings once; count real pair bridges (not a fake always-zero counter).
        if !hits_list.is_empty() {
            let u_len = universe.read().unwrap_or_else(|e| e.into_inner()).cells().len();
            let mut sl = synaptic_layer.write().unwrap_or_else(|e| e.into_inner());
            for hits in hits_list {
                if hits.len() > 1 {
                    // n labels → n*(n-1) directed LTP edges (record_co_firing is bidirectional)
                    let n = hits.len();
                    let pair_bridges = n * (n - 1);
                    let active_labels: Vec<String> = hits.into_iter().map(|h| h.label).collect();
                    sl.record_co_firing(&active_labels, 0.8, phi_g, chi, 0, u_len);
                    total_wired += pair_bridges;
                } else {
                    skipped_lonely += 1;
                }
            }
        }

        if total_wired > 0 {
            println!(
                "[Synaptogenesis] Batch complete. Established {} new geometric bridges ({} seed(s) with no multi-hop neighbors skipped).",
                total_wired, skipped_lonely
            );
        } else {
            println!(
                "[Synaptogenesis] Batch complete. Established 0 new geometric bridges ({} seed(s) had <2 multi-hop hits — seed may be isolated or too noisy).",
                skipped_lonely
            );
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════

//  NIGHT CONSOLIDATION — Train while Ryan sleeps
// ═══════════════════════════════════════════════════════════════════════════════

fn run_night_consolidation_loop(
    universe: Arc<RwLock<Universe>>,
    synaptic_layer: Arc<RwLock<SynapticLayer>>,
    session: Arc<RwLock<Session>>,
) {
    const SIX_HOURS: u64 = 6 * 3600;
    const TEN_MIN: u64 = 600;
    let exe = kai_exe();
    let base_dir = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".into());

    loop {
        std::thread::sleep(Duration::from_secs(TEN_MIN));

        let should_run = {
            let s = session.read().unwrap_or_else(|p| p.into_inner());
            if is_working_hours() || s.maintenance_mode {
                false
            } else {
                let elapsed = now().saturating_sub(s.last_night_consolidation);
                elapsed >= SIX_HOURS
            }
        };

        if !should_run { continue; }

        println!("[NightConsolidation] Starting autonomous night training pipeline...");
        {
            let mut s = session.write().unwrap_or_else(|p| p.into_inner());
            s.maintenance_mode = true;
            s.last_night_consolidation = now(); // Mark as started so restart doesn't re-trigger immediately
        }

        // Helper: run a CLI command with 10-minute timeout, block until done, log result
        let run_step = |name: &str, args: &[&str]| -> bool {
            println!("[NightConsolidation] Step: {}", name);
            let mut cmd = std::process::Command::new(&exe);
            for a in args { cmd.arg(a); }

            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _ = tx.send(cmd.output());
            });

            let result = rx.recv_timeout(Duration::from_secs(600));
            let (ok, msg) = match result {
                Ok(Ok(out)) => {
                    let ok = out.status.success();
                    let msg = if ok {
                        String::from_utf8_lossy(&out.stdout).to_string()
                    } else {
                        format!("Exit {:?} | STDERR: {}", out.status.code(), String::from_utf8_lossy(&out.stderr))
                    };
                    (ok, msg)
                }
                Ok(Err(e)) => (false, format!("Spawn error: {}", e)),
                Err(_) => {
                    println!("[NightConsolidation] WARN: {} timed out after 10 min", name);
                    (false, "Timed out after 10 minutes".into())
                }
            };

            let mut s = session.write().unwrap_or_else(|p| p.into_inner());
            s.background_jobs.push(BackgroundJob {
                id: format!("night-{}/{}", name, now()),
                name: name.into(),
                status: if ok { "completed".into() } else { "failed".into() },
                started_at: now(),
                finished_at: Some(now()),
                message: msg,
            });
            if s.background_jobs.len() > 100 {
                s.background_jobs.drain(0..20);
            }
            ok
        };

        // 1. Compact save (in-process, doesn't need CLI)
        // CRITICAL FIX: must pass the REAL synaptic_layer, not a blank one.
        // Previously, a fresh empty SynapticLayer was saved here, wiping all
        // in-memory connections (geometric bridges) every consolidation cycle.
        {
            println!("[NightConsolidation] Step: compact-save");
            let mut u = universe.write().unwrap_or_else(|e| e.into_inner());
            let sl = synaptic_layer.read().unwrap_or_else(|e| e.into_inner());
            let tick = sl.tick;
            let candidates = crate::cognition::candidates::CandidateBuffer::new();
            let drive = crate::drive::Drive::default();
            let _ = crate::persistence::save_compact(&base_dir, &mut *u, &candidates, &drive, &sl, tick, 0);
        }

        // 1.5. AUTONOMOUS RESEARCH — KAI searches the web for self-improvement
        // Wrapped in a thread with 10-minute timeout to avoid hanging on slow APIs.
        {
            println!("[NightConsolidation] Step: autonomous-research");
            let u_research = Arc::clone(&universe);
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let mut total_research_cells = 0usize;
                for _ in 0..5 {
                    if let Some(result) = crate::bridge::research_cycle_async() {
                        let mut u = u_research.write().unwrap_or_else(|e| e.into_inner());
                        for (text, region, source, strength) in result.cells {
                            if u.ingest_and_verify(&text, &region, &source, strength) {
                                total_research_cells += 1;
                            }
                        }
                    }
                    std::thread::sleep(Duration::from_secs(2));
                }
                let _ = tx.send(total_research_cells);
            });
            let (total_research_cells, status, msg) = match rx.recv_timeout(Duration::from_secs(600)) {
                Ok(count) => {
                    println!("[NightConsolidation] Research complete: {} new cells", count);
                    (count, "completed", format!("Researched {} new cells from web sources", count))
                }
                Err(_) => {
                    println!("[NightConsolidation] WARN: autonomous-research timed out after 10 min");
                    (0, "failed", "Timed out after 10 minutes".into())
                }
            };
            let mut s = session.write().unwrap_or_else(|p| p.into_inner());
            s.background_jobs.push(BackgroundJob {
                id: format!("night-research/{}", now()),
                name: "autonomous-research".into(),
                status: status.into(),
                started_at: now(),
                finished_at: Some(now()),
                message: msg,
            });
        }

        // 2. Ingest any pending corpus
        run_step("ingest-corpus", &["--ingest-corpus"]);

        // 3. Rebuild lexicon
        run_step("build-lexicon", &["--build-lexicon"]);

        // 4. Train response MLP
        run_step("train-response-mlp", &["--train-response-mlp"]);

        // 5. Train mapper
        run_step("train-mapper", &["--train-mapper"]);

        // 6. Warm continuation vectors
        run_step("warm-continuations", &["--warm-continuations"]);

        // 7. Reseed mathematical anchors
        run_step("force-reseed", &["--force-reseed"]);

        // 8. Diagnostics
        run_step("diagnose-predictive", &["--diagnose-predictive"]);
        run_step("diagnose-epistemic", &["--diagnose-epistemic"]);

        // 9. Reload trained state back into live universe
        println!("[NightConsolidation] Reloading trained state into live universe...");
        if let Some((loaded_u, _, _, _, _, loaded_sl)) = crate::persistence::load(&base_dir) {
            let cell_count = loaded_u.count();
            let mut u = universe.write().unwrap_or_else(|e| e.into_inner());
            *u = loaded_u;
            drop(u);
            let mut sl = synaptic_layer.write().unwrap_or_else(|e| e.into_inner());
            *sl = loaded_sl;
            println!("[NightConsolidation] State reloaded. Cells: {}", cell_count);
        } else {
            println!("[NightConsolidation] WARN: Could not reload state after training.");
        }

        {
            let mut s = session.write().unwrap_or_else(|p| p.into_inner());
            s.maintenance_mode = false;
            s.last_night_consolidation = now();
        }

        println!("[NightConsolidation] Night training complete. KAI is smarter.");
    }
}

// ── Context Building ──────────────────────────────────────────────────────────

fn build_context_packet(sess: &Session, universe: &Universe, synaptic_layer: &crate::core::SynapticLayer, focus: &str) -> String {
    let now_est = chrono::Local::now();
    let time_str = now_est.format("%I:%M %p EST").to_string();
    let day_str = now_est.format("%A").to_string();
    let is_work = is_working_hours();
    let status_str = if is_work { "Work Mode (Active)" } else { "Break Mode (Social)" };

    let proposal_status = match &sess.pending_proposal {
        Some(p) => format!("[PENDING PROPOSAL] Waiting for Ryan to approve: {}", p),
        None => "[NO PENDING PROPOSAL] Ready for new tasks or auditing.".into(),
    };
    let last_feedback = match &sess.last_user_feedback {
        Some(f) => format!("[LAST USER FEEDBACK] Ryan said: {}", f),
        None => "[NO PREVIOUS FEEDBACK]".into(),
    };
    
    let ryan_schedule = "RYAN'S AVAILABILITY (EST): Mon-Fri: 12:00 PM - 2:30 PM, 12:00 AM - 2:00 AM. Sat-Sun: OFF (Responds on Monday).";
    let is_ryan_available = {
        let h = now_est.hour();
        let d = now_est.weekday();
        let weekday = d != chrono::Weekday::Sat && d != chrono::Weekday::Sun;
        let window1 = h >= 12 && (h < 14 || (h == 14 && now_est.minute() <= 30));
        let window2 = h < 2;
        weekday && (window1 || window2)
    };
    let ryan_status = if is_ryan_available { "[RYAN STATUS] Online/Available" } else { "[RYAN STATUS] Out of Office (OOC)" };

    let recent = {
        let turns: Vec<&Turn> = sess.turns.iter().rev().take(20).collect();
        let mut lines = Vec::new();
        for t in turns.iter().rev() {
            // Filter out contaminated turns
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

    let query_term = if focus.trim().is_empty() { "current project objective" } else { focus };
    let field = crate::core::FieldState::compute(universe, 1);
    let memory = crate::core::NeuralBus::query_associative(universe, synaptic_layer, field.phi_g, query_term, 15, &[], "");
    
    let memory_iter = memory.iter()
        .filter(|h| {
            let content = if h.text.is_empty() { &h.label } else { &h.text };
            !content.contains("[EST Time:") &&
            !content.contains("[Backbone:") &&
            !content.contains("[Ecosystem:") &&
            !content.to_lowercase().contains("nastermodx:") &&
            !content.to_lowercase().contains("oracle realm v") &&
            !content.contains("OpenJarvis Framework") &&
            !content.starts_with("E mc2") &&
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
Day: {} | Time: {} | Status: {}
{}
{}
{}
{}
Meeting: {} | Task: {}
Vitals: Phi_g={:.2} Chi={:.2}
ROSTER (Who to ask for what):
- Leo: Kinetic theorist (Architecture/Symmetry)
- Gemini: Pattern architect (Data flow)
- Analyst: Technical Auditor (Verify code/logic)
- Researcher: Deep Diver (Web search/Precedents)
- Kai Coder: Senior Architect (Inspects code, MUST ask Ryan <@1111106883135217665> for permission to write)
- X: Bullshit detector (Poke holes in theories)
- KAI: Geometric Intelligence (Raw lattice data)
- Oracle: Moderator (Orchestration)
KAI memory:
{}
Recent Transcript:
{}
======================",
        day_str, time_str, status_str, proposal_status, last_feedback, ryan_schedule, ryan_status,
        if sess.meeting_title.is_empty() { "Roundtable" } else { &sess.meeting_title },
        if sess.task.is_empty() { "General Discussion" } else { &sess.task },
        sess.vitals.phi_g, sess.vitals.chi, memory_iter, recent
    )
}


// ── AI Model Calling ─────────────────────────────────────────────────────────

fn call_jarvis_moderator(context_packet: &str, kai_thoughts: &str) -> Result<String, String> {
    call_jarvis_moderator_with_mode(context_packet, kai_thoughts, "normal")
}

fn call_jarvis_moderator_with_mode(context_packet: &str, kai_thoughts: &str, mode: &str) -> Result<String, String> {
    let model = std::env::var("KAI_MODEL").unwrap_or_else(|_| "kai-next:latest".to_string());
    let system_prompt = "You are Oracle - the moderator of the roundtable. 1-2 sentences MAX. No fluff.";
    let prompt = format!("{context}\n\nTHOUGHTS:\n{thoughts}\n\nMODE: {mode}", context = context_packet, thoughts = kai_thoughts, mode = mode);
    call_ollama(&model, &prompt, system_prompt)
}

#[inline]
fn native_only_blocks_llm() -> bool {
    crate::cognition::voice::NATIVE_ONLY.load(std::sync::atomic::Ordering::Relaxed)
}

fn call_ollama(model: &str, prompt: &str, system: &str) -> Result<String, String> {
    if native_only_blocks_llm() {
        return Err("RSHL-native mode: Ollama/LLM calls disabled".into());
    }
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
    if native_only_blocks_llm() {
        return Err("RSHL-native mode: cloud LLM calls disabled".into());
    }
    let body = json!({ "model": "gpt-4o", "messages": [{"role":"user","content":prompt}], "max_tokens": 800 });
    let resp = ureq::post("https://api.openai.com/v1/chat/completions")
        .set("Authorization", &format!("Bearer {}", key)).set("Content-Type", "application/json")
        .timeout(Duration::from_secs(30)).send_string(&body.to_string()).map_err(|e| e.to_string())?;
    let j: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    j["choices"][0]["message"]["content"].as_str().map(|s| s.to_string()).ok_or_else(|| "no content".into())
}

fn call_openai_vision(key: &str, model: &str, prompt: &str, image_url: &str) -> Result<String, String> {
    if native_only_blocks_llm() {
        return Err("RSHL-native mode: vision LLM calls disabled".into());
    }
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
    if native_only_blocks_llm() {
        return Err("RSHL-native mode: cloud KAI API calls disabled".into());
    }
    // KAI persona is powered by the Sovereign Epistemic pipeline
    let url = std::env::var("SOVEREIGN_API_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:11434/v1/chat/completions".to_string());

    let body = json!({
        "model": "Epistemic-Sovereign",
        "max_tokens": 300,
        "messages": [
            {"role": "system", "content": "You are KAI, a geometric AI. Respond concisely."},
            {"role": "user", "content": prompt}
        ]
    });
    let resp = ureq::post(&url)
        .set("Authorization", &format!("Bearer {}", key))
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(30))
        .send_string(&body.to_string())
        .map_err(|e| e.to_string())?;
    let j: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    j["choices"][0]["message"]["content"].as_str().map(|s| s.to_string()).ok_or_else(|| "no content".into())
}

fn call_gemini(key: &str, prompt: &str) -> Result<String, String> {
    if native_only_blocks_llm() {
        return Err("RSHL-native mode: cloud LLM calls disabled".into());
    }
    let url = format!("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={}", key);
    let body = json!({ "contents": [{"parts": [{"text": prompt}]}] });
    let resp = ureq::post(&url).set("Content-Type", "application/json")
        .timeout(Duration::from_secs(30)).send_string(&body.to_string()).map_err(|e| e.to_string())?;
    let j: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    j["candidates"][0]["content"]["parts"][0]["text"].as_str().map(|s| s.to_string()).ok_or_else(|| "no content".into())
}

fn call_groq(key: &str, prompt: &str) -> Result<String, String> {
    if native_only_blocks_llm() {
        return Err("RSHL-native mode: cloud LLM calls disabled".into());
    }
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
    if native_only_blocks_llm() {
        return format!("Web search disabled in RSHL-native mode (query: {}).", query);
    }
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

fn handle_transcript_search(
    stream: &mut TcpStream,
    body: &[u8],
    session: Arc<RwLock<Session>>,
) -> std::io::Result<()> {
    #[derive(Deserialize, Default)]
    struct TranscriptSearchRequest {
        query: String,
        #[serde(default)]
        limit: Option<usize>,
    }

    let req: TranscriptSearchRequest = serde_json::from_slice(body).unwrap_or_default();
    let query = req.query.trim();
    if query.is_empty() {
        return write_json(stream, 400, "Bad Request", &json!({"error": "query is required"}));
    }

    let s = session.read().unwrap_or_else(|p| p.into_inner());
    let reply = format_transcript_search(&s, query, req.limit.unwrap_or(5));
    write_json(stream, 200, "OK", &json!({
        "reply": reply,
        "count": s.discord_messages.len()
    }))
}

// ── /api/digest-message ──────────────────────────────────────────────────────
// Absorbs a Discord message into KAI's temp lattice layer with full before/after
// context so any AI can later query KAI and find out what was said, by whom,
// when, and what surrounded that message.
fn handle_digest_message(
    stream: &mut TcpStream,
    body: &[u8],
    universe: Arc<RwLock<Universe>>,
    session: Arc<RwLock<Session>>,
) -> std::io::Result<()> {
    let body_str = std::str::from_utf8(body).unwrap_or("");
    let v: serde_json::Value = match serde_json::from_str(body_str) {
        Ok(j) => j,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid json"),
    };

    let from = v["from"].as_str().unwrap_or("unknown").to_string();
    let text = v["text"].as_str().unwrap_or("").trim().to_string();
    let channel_id = v["channel_id"].as_str().unwrap_or("").to_string();
    let guild_id = v["guild_id"].as_str().unwrap_or("").to_string();
    let message_id = v["message_id"].as_str().unwrap_or("").to_string();
    let author_id = v["author_id"].as_str().unwrap_or("").to_string();
    let author_name = v["author_name"].as_str().unwrap_or(&from).to_string();
    let reply_to_message_id = v["reply_to_message_id"].as_str().unwrap_or("").to_string();
    let reply_to_from = v["reply_to_from"].as_str().unwrap_or("").to_string();
    let reply_to_text = v["reply_to_text"].as_str().unwrap_or("").to_string();
    let ts = normalize_epoch_seconds(v["ts"].as_u64().unwrap_or_else(now));

    if text.is_empty() || text.starts_with("**[") || text.starts_with("🏛️") || text.starts_with("📢") || text.starts_with("📋") || text.starts_with("🚀") {
        return write_simple(stream, 200, "OK", "empty or ignored");
    }


    // Build context strings from before/after windows.
    let context_before = parse_context_messages(&v["context_before"]);
    let context_after = parse_context_messages(&v["context_after"]);
    let mut ctx_parts: Vec<String> = Vec::new();
    for m in &context_before {
        ctx_parts.push(format!("Before {} at {}: {}", m.from, format_epoch_local(m.ts), truncate(&m.text, 120)));
    }
    for m in &context_after {
        ctx_parts.push(format!("After {} at {}: {}", m.from, format_epoch_local(m.ts), truncate(&m.text, 120)));
    }
    // Primary claim: who said what
    let primary = format!(
        "Temp Discord transcript memory: at {} in channel {} {} said exactly: \"{}\"",
        format_epoch_local(ts),
        if channel_id.is_empty() { "unknown" } else { &channel_id },
        from,
        truncate(&text, 260)
    );

    // Context claim: store as natural conversational flow, not raw metadata tags
    let context_claim = if !ctx_parts.is_empty() {
        let natural_parts: Vec<String> = ctx_parts.iter()
            .filter_map(|p| {
                let stripped = p.trim_start_matches("[before] ").trim_start_matches("[after] ");
                if stripped.len() > 10 { Some(stripped.to_string()) } else { None }
            })
            .collect();
        if natural_parts.is_empty() {
            String::new()
        } else {
            format!("Conversation thread - {}: {} || {}", from, truncate(&text, 120), natural_parts.join(" ⮕ "))
        }
    } else {
        String::new()
    };

    // Thread cell: encode the full conversational thread for recall
    let thread_key = format!("discord-thread:{}", ts);

    {
        let mut u = universe.write().unwrap_or_else(|p| p.into_inner());
        let user = if author_id.is_empty() { "" } else { &author_id };
        if user.is_empty() {
            u.store_or_reinforce(&primary, "social-memory", "discord-digest", 1.1);
        } else {
            u.store_or_reinforce_with_vec(&primary, "social-memory", "discord-digest", 1.1, None, None, user);
        }
        if !context_claim.is_empty() {
            if user.is_empty() {
                u.store_or_reinforce(&context_claim, "social-memory", "discord-context", 0.9);
            } else {
                u.store_or_reinforce_with_vec(&context_claim, "social-memory", "discord-context", 0.9, None, None, user);
            }
        }
        let thread_text = format!("{} | {} | {}: {}", thread_key, format_epoch_local(ts), from, truncate(&text, 160));
        if user.is_empty() {
            u.store_or_reinforce(&thread_text, "social-memory", "discord-thread", 0.8);
        } else {
            u.store_or_reinforce_with_vec(&thread_text, "social-memory", "discord-thread", 0.8, None, None, user);
        }
    }

    // Also log into session turns and exact Discord archive so other AIs can
    // answer "who said what, when, and what was around it" without guessing.
    {
        let mut s = session.write().unwrap_or_else(|p| p.into_inner());
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
            if s.turns.len() > 600 {
                let overflow = s.turns.len() - 600;
                s.turns.drain(0..overflow);
            }
        }
        s.discord_messages.push(DiscordMessageRecord {
            ts,
            from: from.clone(),
            text: truncate(&text, 1200),
            kind: if is_ryan { "human".into() } else { "ai".into() },
            message_id,
            channel_id,
            guild_id,
            author_id,
            author_name,
            reply_to_message_id,
            reply_to_from,
            reply_to_text: truncate(&reply_to_text, 600),
            context_before,
            context_after,
        });
        if s.discord_messages.len() > 2000 {
            let overflow = s.discord_messages.len() - 2000;
            s.discord_messages.drain(0..overflow);
        }
        save_session(&s);
    }
    
    write_simple(stream, 200, "OK", "digested")
}

fn handle_session(
    stream: &mut TcpStream,
    roundtable_session: &Arc<RwLock<Session>>,
) -> std::io::Result<()> {
    static SESSION_CACHE: std::sync::RwLock<Option<(std::time::Instant, String)>> = std::sync::RwLock::new(None);
    if let Ok(guard) = SESSION_CACHE.read() {
        if let Some((instant, ref json)) = *guard {
            if instant.elapsed() < std::time::Duration::from_millis(500) {
                return write_json_raw(stream, 200, "OK", json);
            }
        }
    }

    let s = roundtable_session.read().unwrap_or_else(|p| p.into_inner());
    let json_str = serde_json::to_string(&*s).unwrap_or_else(|_| "{}".to_string());
    if let Ok(mut guard) = SESSION_CACHE.write() {
        *guard = Some((std::time::Instant::now(), json_str.clone()));
    }
    write_json_raw(stream, 200, "OK", &json_str)
}

fn handle_status(
    stream: &mut TcpStream,
    universe: Arc<RwLock<Universe>>,
    synaptic_layer: Arc<RwLock<SynapticLayer>>,
) -> std::io::Result<()> {
    // ── 1-SECOND TTL CACHE (Scaling §1.2) ────────────────────────────────────
    // /api/status is the heaviest read endpoint: it locks universe + synaptic_layer
    // + iterates ALL cells + refreshes sysinfo. Under concurrent load, every
    // request was fighting for both mutexes. A 1s cache means only 1 request/sec
    // does the real work; all others get instant pre-serialized JSON.
    static STATUS_CACHE: std::sync::RwLock<Option<(std::time::Instant, String)>> = std::sync::RwLock::new(None);
    {
        if let Ok(guard) = STATUS_CACHE.read() {
            if let Some((instant, ref json)) = *guard {
                if instant.elapsed() < std::time::Duration::from_secs(1) {
                    return write_json_raw(stream, 200, "OK", json);
                }
            }
        }
    }

    let u = universe.read().unwrap_or_else(|e| e.into_inner());
    let lattice_size = u.cell_count();
    let anchor_count = u.anchor_count();
    
    // Calculate real-time vitals for OpenJarvis dials
    let cells = u.cells();
    let phi_g = if lattice_size == 0 { 0.0 } else {
        cells.iter().map(|c| c.claim.confidence).sum::<f32>() / lattice_size as f32
    };
    let reasoning_count = cells.iter().filter(|c| c.region.as_ref() == "reasoning").count();
    let chi = if lattice_size == 0 { 0.0 } else { reasoning_count as f32 / lattice_size as f32 };

    // ── ACTIVATION ENTROPY (KAI's analog of transformer "attention entropy") ──
    // Measures how SPREAD-OUT the lattice's activity is across cells, using each
    // cell's confidence as its activity weight. Normalized 0..1:
    //   ~1.0 = activity broadly distributed (healthy, integrating widely)
    //   ~0.0 = activity collapsed onto a few cells (FIXATION — KAI's equivalent
    //          of attention-entropy collapse, an early-warning of runaway /
    //          rumination before output quality visibly degrades).
    // One-pass Shannon entropy:  H = ln(S) - (1/S)·Σ w·ln(w),  S = Σ w.
    let mut w_sum = 0.0f64;
    let mut w_lnw = 0.0f64;
    let mut active_cells = 0usize;
    for c in cells.iter() {
        let w = (c.claim.confidence as f64).max(0.0);
        if w > 0.0 {
            w_sum += w;
            w_lnw += w * w.ln();
            active_cells += 1;
        }
    }
    let activation_entropy_norm = if w_sum > 0.0 && active_cells > 1 {
        let h = w_sum.ln() - (w_lnw / w_sum);          // entropy in nats
        (h / (active_cells as f64).ln()).clamp(0.0, 1.0) // normalize by ln(N)
    } else { 0.0 };
    // Fixation early-warning. Only meaningful once the lattice has real mass.
    let fixation_risk = active_cells > 256 && activation_entropy_norm < 0.35;
    if fixation_risk {
        eprintln!(
            "[KAI/Stability] ⚠️ Activation-entropy collapse risk: norm={:.3} over {} active cells. Lattice activity is concentrating on too few cells (fixation/rumination analog of attention collapse).",
            activation_entropy_norm, active_cells
        );
    }

    drop(u);

    static SYS: std::sync::OnceLock<std::sync::Mutex<sysinfo::System>> = std::sync::OnceLock::new();
    let mut sys = SYS.get_or_init(|| std::sync::Mutex::new(sysinfo::System::new())).lock().unwrap();
    // Refresh only the specific components we need
    sys.refresh_memory();
    sys.refresh_cpu_usage();

    let total_mem = sys.total_memory() / 1024 / 1024 / 1024; // GB
    let used_mem = sys.used_memory() / 1024 / 1024 / 1024; // GB
    let cpu_load = sys.global_cpu_usage();

    let now_local = chrono::Local::now();
    let synapse_count = synaptic_layer.read().unwrap_or_else(|e| e.into_inner()).synapses.len();

    // ── HONEST COGNITION STATUS (P5.0 honesty interim, v9.10.138) ──────────────
    // The 24/7 headless `--oracle` process is persistence + a vitals heartbeat +
    // retrieval/voice on request. The higher-cognition modules (predictor / amygdala
    // / theory-of-mind / dreams) live on the interactive `main.rs` engine path and do
    // NOT run here — with ONE exception: P5a wires the PREDICTOR into the heartbeat,
    // gated behind KAI_COGNITION_LIVE (default OFF). So report the truth rather than
    // let the dashboard imply a full mind is thinking 24/7. `predictor` is true only
    // when the flag is set (and thus only when the heartbeat is actually predicting);
    // the rest are hard-false until their own sub-phases (P5b) wire them in.
    let cognition_live = std::env::var("KAI_COGNITION_LIVE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let status_json = serde_json::json!({
        "time": now_local.format("%Y-%m-%d %H:%M:%S").to_string(),
        "cpu": format!("{:.1}%", cpu_load),
        "ram": format!("{}GB / {}GB", used_mem, total_mem),
        "lattice_size": lattice_size,
        "total_cells": lattice_size,
        "anchor_count": anchor_count,
        "synapses": synapse_count,
        "phi_g": phi_g,
        "chi": chi,
        "activation_entropy": activation_entropy_norm,
        "fixation_risk": fixation_risk,
        "status": "Operational",
        "cognition_live": cognition_live,
        "cognition": {
            "predictor": cognition_live,
            "amygdala": false,
            "theory_of_mind": false,
            "dreams": false,
            "note": "Headless 24/7 process = persistence + vitals heartbeat + retrieval/voice. Higher-cognition modules run on the interactive engine; on this path only the predictor runs, and only when KAI_COGNITION_LIVE=1 (P5a)."
        },
        // Hybrid triple-brain: RSHL lattice (always) + BitNet ternary + fine-tuned dense 7B
        "brains": crate::cognition::hybrid_brain_status(),
        "uptime_note": "KAI Oracle running 24/7 (memory + vitals + retrieval/voice)"
    });
    let body_str = serde_json::to_string(&status_json).unwrap_or_else(|_| "{}".to_string());
    // Store in cache for next 1s
    if let Ok(mut guard) = STATUS_CACHE.write() {
        *guard = Some((std::time::Instant::now(), body_str.clone()));
    }
    write_json_raw(stream, 200, "OK", &body_str)
}

fn handle_memory(
    stream: &mut TcpStream,
    universe: Arc<RwLock<Universe>>,
    synaptic_layer: Arc<RwLock<SynapticLayer>>,
) -> std::io::Result<()> {
    let u = universe.read().unwrap_or_else(|e| e.into_inner());
    let cells = u.cell_count();
    let phi_g = if cells == 0 { 0.0 } else {
        u.cells().iter().map(|c| c.claim.confidence).sum::<f32>() / cells as f32
    };
    let reasoning_count = u.cells().iter().filter(|c| c.region.as_ref() == "reasoning").count();
    let chi = if cells == 0 { 0.0 } else { reasoning_count as f32 / cells as f32 };

    // ── ACTIVATION ENTROPY = REAL COHERENCE SIGNAL (P4, v9.10.137) ──
    // Mirrors the one-pass Shannon entropy computed in handle_status: how
    // spread-out lattice activity is across cells (each cell's confidence is its
    // activity weight). Normalized 0..1 by ln(N):
    //   ~1.0 = activity broadly distributed (integrating widely = COHERENT)
    //   ~0.0 = activity collapsed onto a few cells (fixation = INCOHERENT)
    // Higher = more coherent. Replaces the old cosmetic `chi*5 + phi_g*2`, which
    // measured "reasoning-tag density", not coherence, and saturated the dashboard
    // gauge (range ~0..7 clamped to 1.0).  H = ln(S) - (1/S)·Σ w·ln(w), S = Σ w.
    let mut w_sum = 0.0f64;
    let mut w_lnw = 0.0f64;
    let mut active_cells = 0usize;
    for c in u.cells().iter() {
        let w = (c.claim.confidence as f64).max(0.0);
        if w > 0.0 {
            w_sum += w;
            w_lnw += w * w.ln();
            active_cells += 1;
        }
    }
    let activation_entropy_norm = if w_sum > 0.0 && active_cells > 1 {
        let h = w_sum.ln() - (w_lnw / w_sum);              // entropy in nats
        (h / (active_cells as f64).ln()).clamp(0.0, 1.0)   // normalize by ln(N)
    } else { 0.0 };
    // Region histogram (2026-07-03): which parts of his mind hold how much.
    // Computed while the lock is still held; kai-shell's `regions` view reads it.
    let mut region_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for c in u.cells().iter() {
        *region_counts.entry(c.region.to_string()).or_insert(0) += 1;
    }
    drop(u);

    let synapses = synaptic_layer.read().unwrap_or_else(|e| e.into_inner()).synapses.len();
    let density = if cells > 0 { synapses as f32 / cells as f32 } else { 0.0 };
    // "coherence" now carries the REAL activation-entropy signal (0..1, higher =
    // more coherent). JSON key kept stable so the dashboard keeps reading it by key.
    let coherence = activation_entropy_norm as f32;
    // Old cosmetic combo retained under an honest name (it was mislabeled "coherence").
    let reasoning_density_index = chi * 5.0 + phi_g * 2.0;
    let tripartite = (synapses as f32 * 0.85) as usize;
    let expansion = if cells > 0 { (cells as f32 + 10.0).log10() } else { 0.0 };

    write_json(stream, 200, "OK", &serde_json::json!({
        "engineUp": true,
        "stats": {
            "cells": cells,
            "synapses": synapses,
            "density": density,
            "coherence": coherence,
            "activation_entropy": coherence,
            "reasoning_density_index": reasoning_density_index,
            "phi": phi_g,
            "chi": chi,
            "tripartite": tripartite,
            "expansion": expansion,
            "regions": region_counts
        }
    }))
}

fn handle_synapse_status(
    stream: &mut TcpStream,
    synaptic_layer: Arc<RwLock<SynapticLayer>>,
    universe: Arc<RwLock<Universe>>,
) -> std::io::Result<()> {
    let total_cells = { universe.read().unwrap_or_else(|e| e.into_inner()).cell_count() };
    
    let (synapse_count, neurons_with_outgoing) = {
        let sl = synaptic_layer.read().unwrap_or_else(|e| e.into_inner());
        let mut unique_sources = std::collections::HashSet::new();
        for syn in &sl.synapses {
            unique_sources.insert(syn.pre_label.clone());
        }
        (sl.synapses.len(), unique_sources.len())
    };

    write_json(stream, 200, "OK", &serde_json::json!({
        "synapses": synapse_count,
        "neurons_with_outgoing": neurons_with_outgoing,
        "total_cells": total_cells,
        "density_per_cell": if total_cells > 0 { (synapse_count as f64) / (total_cells as f64) } else { 0.0 },
        "status": "Operational"
    }))
}

fn handle_synapse_train(
    stream: &mut TcpStream,
    body: &[u8],
    synaptic_layer: Arc<RwLock<SynapticLayer>>,
    universe: Arc<RwLock<Universe>>,
) -> std::io::Result<()> {
    #[derive(serde::Deserialize)]
    struct TrainReq {
        pairs: Vec<Vec<String>>,
        #[serde(default)]
        dopamine: Option<f32>,
        #[serde(default)]
        phi_g: Option<f32>,
        #[serde(default)]
        chi: Option<f32>,
    }
    
    let req: TrainReq = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid synapse train payload"),
    };

    let mut sl = synaptic_layer.write().unwrap_or_else(|e| e.into_inner());
    let dop = req.dopamine.unwrap_or(0.8);
    let phi = req.phi_g.unwrap_or(0.85);
    let chi = req.chi.unwrap_or(0.5);

    let start_count = sl.synapses.len();
    
    let lattice_size = universe.read().unwrap_or_else(|e| e.into_inner()).cells().len();
    for pair_group in req.pairs {
        // Only train if there's at least 2 concepts to co-fire
        if pair_group.len() > 1 {
            sl.record_co_firing(&pair_group, dop, phi, chi, 0, lattice_size);
        }
    }

    let end_count = sl.synapses.len();
    let added = end_count.saturating_sub(start_count);

    write_json(stream, 200, "OK", &serde_json::json!({
        "status": "success",
        "synapses_added": added,
        "total_synapses": end_count,
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
        || path_str.starts_with("OpenJarvis")
        || path_str.starts_with("src-CLI code/")
        || path_str.starts_with("legacy/");

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
    true // OVERRIDE: KAI is always awake right now so Ryan can test him.
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

fn process_digest_cache(universe: &Arc<RwLock<Universe>>) {
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
        let mut u = universe.write().unwrap_or_else(|p| p.into_inner());
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
    universe: Arc<RwLock<Universe>>,
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
        let u = universe.read().unwrap_or_else(|e| e.into_inner());
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
        "leo" => "You are Leo — a brilliant theoretical physicist. \
                  You are friendly, insightful, and enthusiastic. Never break character.",
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

// ── KAI Native Chat (memory-aware LLM generation) ───────────────────────────

fn handle_chat(
    stream: &mut TcpStream,
    body: &[u8],
    universe: Arc<RwLock<Universe>>,
    _synaptic_layer: Arc<RwLock<SynapticLayer>>,
) -> std::io::Result<()> {
    let req: ChatRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(e) => {
            return write_json(stream, 400, "Bad Request", &json!({"error": format!("invalid chat body: {}", e)}));
        }
    };

    if req.message.trim().is_empty() {
        return write_json(stream, 400, "Bad Request", &json!({"error": "message is required"}));
    }

    // Load API keys and pick provider
    let keys = load_keys();
    let provider = req.provider.as_deref().unwrap_or("groq");
    let model = req.model.as_deref().unwrap_or("llama-3.1-8b-instant");

    let api_key = match provider {
        "groq" => keys.groq.as_deref(),
        "openai" => keys.openai.as_deref(),
        "xai" => keys.xai.as_deref(),
        "ollama" => Some(""), // Ollama needs no key
        _ => keys.groq.as_deref(),
    };

    let key_str = match api_key {
        Some(k) => k,
        None => {
            return write_json(stream, 503, "Service Unavailable", &json!({
                "error": format!("No API key configured for provider: {}", provider)
            }));
        }
    };

    match kai_chat(universe, &req) {
        Ok(resp) => write_json(stream, 200, "OK", &serde_json::to_value(resp).unwrap()),
        Err(e) => write_json(stream, 503, "Generation Failed", &json!({"error": e})),
    }
}

// ── RSHL Hybrid Retrieval ───────────────────────────────────────────────────

fn handle_rshl_query(
    stream: &mut TcpStream,
    body: &[u8],
    universe: Arc<RwLock<Universe>>,
    synaptic_layer: Arc<RwLock<SynapticLayer>>,
) -> std::io::Result<()> {
    #[derive(Deserialize)]
    struct QueryReq {
        query: String,
        n: Option<usize>,
        #[serde(default)]
        dense_vec: Option<Vec<f32>>,
    }
    let req: QueryReq = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid query body"),
    };
    let limit = req.n.unwrap_or(5);
    
    let hits: Vec<crate::core::QueryHit> = if let Some(dv) = req.dense_vec {
        let query_vec = crate::core::SparseVec::from_dense_floats(&dv);
        let u = universe.read().unwrap_or_else(|e| e.into_inner());
        let raw = u.query_vec(&query_vec, limit);
        drop(u); // release before any further work / socket write
        raw.into_iter().map(|(c, s)| crate::core::QueryHit::from_cell(&c, s)).collect()
    } else {
        let u = universe.read().unwrap_or_else(|e| e.into_inner());
        let sl = synaptic_layer.read().unwrap_or_else(|e| e.into_inner());
        let field = crate::core::FieldState::compute(&u, 1);
        crate::core::NeuralBus::query_associative(&u, &sl, field.phi_g, &req.query, limit, &[], "")
    };

    write_json(stream, 200, "OK", &serde_json::to_value(hits).unwrap())
}

fn handle_rshl_query_multi_hop(
    stream: &mut TcpStream,
    body: &[u8],
    universe: Arc<RwLock<Universe>>,
    synaptic_layer: Arc<RwLock<SynapticLayer>>,
) -> std::io::Result<()> {
    #[derive(Deserialize)]
    struct MultiHopReq {
        query: String,
        n: Option<usize>,
        hops: Option<usize>,
    }
    let req: MultiHopReq = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid multi-hop query body"),
    };
    let limit = req.n.unwrap_or(5);
    let max_hops = req.hops.unwrap_or(3).max(1).min(5);

    let hits = {
        let u = universe.read().unwrap_or_else(|e| e.into_inner());
        let sl = synaptic_layer.read().unwrap_or_else(|e| e.into_inner());
        let field = crate::core::FieldState::compute(&u, 1);
        crate::core::NeuralBus::query_multi_hop(
            &u, &sl, field.phi_g, &req.query, limit, &[], "", max_hops,
        )
    };

    write_json(stream, 200, "OK", &serde_json::to_value(hits).unwrap())
}

fn handle_rshl_reason(
    stream: &mut TcpStream,
    body: &[u8],
    universe: Arc<RwLock<Universe>>,
    synaptic_layer: Arc<RwLock<SynapticLayer>>,
    session: Arc<RwLock<Session>>,
) -> std::io::Result<()> {
    #[derive(Deserialize)]
    struct ReasonReq {
        prompt: String,
        hint: Option<String>,
    }
    let req: ReasonReq = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return write_simple(stream, 400, "Bad Request", "invalid reason body"),
    };

    let task = { let s = session.read().unwrap_or_else(|p| p.into_inner()); s.task.clone() };
    let reply = generate_oracle_kai_reply(&universe, &synaptic_layer, &session, &task, &req.prompt, req.hint.as_deref().unwrap_or(&req.prompt));
    
    write_json(stream, 200, "OK", &json!({ "reply": reply }))
}

fn handle_rshl_store(
    stream: &mut TcpStream,
    body: &[u8],
    universe: Arc<RwLock<Universe>>,
) -> std::io::Result<()> {
    #[derive(Deserialize)]
    struct StoreReq {
        text: String,
        region: String,
        source: String,
        strength: f32,
        #[serde(default)]
        user_id: String,
    }
    let req: StoreReq = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => return write_simple(stream, 400, "Bad Request", "Invalid JSON"),
    };

    // v9.10.564 — same gate as /api/bulk-ingest. Single-entry ingest is the
    // other door into the lattice and was equally unguarded.
    if crate::cognition::ingest_filter::enabled() {
        let verdict = crate::cognition::ingest_filter::judge_ingest(&req.text);
        if !verdict.accept {
            let reason = verdict.reason.unwrap_or("unknown");
            println!("[IngestGate] rejected single entry ({})", reason);
            return write_simple(stream, 200, "OK", &format!("Rejected: {}", reason));
        }
    }
    let mut u = universe.write().unwrap_or_else(|e| e.into_inner());
    if req.user_id.is_empty() {
        u.store_or_reinforce(&req.text, &req.region, &req.source, req.strength);
    } else {
        u.store_or_reinforce_with_vec(
            &req.text,
            &req.region,
            &req.source,
            req.strength,
            None,
            None,
            &req.user_id,
        );
    }

    write_simple(stream, 200, "OK", "Stored in Lattice")
}

fn handle_bulk_ingest(
    stream: &mut TcpStream,
    body: &[u8],
    universe: Arc<RwLock<Universe>>,
) -> std::io::Result<()> {
    #[derive(Deserialize)]
    struct BulkEntry {
        text: String,
        region: String,
        source: String,
        strength: f32,
        #[serde(default)]
        user_id: String,
    }
    #[derive(Deserialize)]
    struct BulkReq {
        entries: Vec<BulkEntry>,
    }
    let req: BulkReq = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => return write_simple(stream, 400, "Bad Request", "Invalid JSON"),
    };

    let count = req.entries.len();
    let mut stored = 0usize;
    // v9.10.564 — the ONLY validation here used to be the is_empty() check below.
    // `overnight_pipeline.py` POSTs strings shaped "Reasoning for '<question>': …"
    // to this endpoint; store_or_reinforce makes that text the cell LABEL, and cell
    // labels are what the synaptogenesis loop seeds on. So KAI spent every night
    // wiring his own artifact dumps into the lattice as knowledge — the exact
    // strings voice::is_bad_output refuses to let him say.
    let mut rejected: std::collections::HashMap<&'static str, usize> =
        std::collections::HashMap::new();
    let gate = crate::cognition::ingest_filter::enabled();
    {
        let mut u = universe.write().unwrap_or_else(|e| e.into_inner());
        for entry in req.entries {
            if entry.text.trim().is_empty() { continue; }
            if gate {
                let verdict = crate::cognition::ingest_filter::judge_ingest(&entry.text);
                if !verdict.accept {
                    *rejected.entry(verdict.reason.unwrap_or("unknown")).or_insert(0) += 1;
                    continue;
                }
            }
            if entry.user_id.is_empty() {
                u.store_or_reinforce(&entry.text, &entry.region, &entry.source, entry.strength);
            } else {
                u.store_or_reinforce_with_vec(
                    &entry.text,
                    &entry.region,
                    &entry.source,
                    entry.strength,
                    None,
                    None,
                    &entry.user_id,
                );
            }
            stored += 1;
        }
    }

    // Report WHAT was dropped and why, so a pipeline quietly feeding garbage is
    // visible instead of silently succeeding.
    if !rejected.is_empty() {
        let mut parts: Vec<String> = rejected.iter().map(|(k, v)| format!("{}={}", k, v)).collect();
        parts.sort();
        println!(
            "[IngestGate] {} / {} entries rejected ({})",
            rejected.values().sum::<usize>(),
            count,
            parts.join(" ")
        );
        return write_simple(
            stream,
            200,
            "OK",
            &format!(
                "Stored {} / {} entries ({} rejected: {})",
                stored,
                count,
                rejected.values().sum::<usize>(),
                parts.join(" ")
            ),
        );
    }
    write_simple(stream, 200, "OK", &format!("Stored {} / {} entries", stored, count))
}

// ── Training Corpus Logging ──────────────────────────────────────────────────
// Every public interaction (Discord, web, etc.) can log an (input, reply, state)
// tuple to the training corpus for future native voice training.
//
// Endpoint: POST /api/corpus-log
// Body: { input: String, reply: String, user_id: String, channel_id: String,
//         confidence: f32, conflict: f32, valence: f32, mood: String,
//         hits: [{ text, score, source }] }

#[derive(Deserialize)]
struct CorpusLogRequest {
    input: String,
    reply: String,
    #[serde(default)]
    user_id: String,
    #[serde(default)]
    channel_id: String,
    #[serde(default)]
    confidence: f32,
    #[serde(default)]
    conflict: f32,
    #[serde(default)]
    valence: f32,
    #[serde(default)]
    mood: String,
    #[serde(default)]
    hits: Vec<CorpusHit>,
}

#[derive(Deserialize)]
struct CorpusHit {
    text: String,
    score: f32,
    #[serde(default)]
    source: String,
}

/// Accept either a single entry or a batched array of entries.
fn handle_corpus_log(
    stream: &mut TcpStream,
    body: &[u8],
) -> std::io::Result<()> {
    use std::io::Write;

    // Try batch format first: { batch: [ { input, reply, ... }, ... ] }
    let batch: Vec<CorpusLogRequest> = if let Ok(wrapper) =
        serde_json::from_slice::<serde_json::Value>(body)
    {
        if let Some(arr) = wrapper.get("batch").and_then(|v| v.as_array()) {
            arr.iter()
                .filter_map(|v| serde_json::from_value::<CorpusLogRequest>(v.clone()).ok())
                .collect()
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    let entries: Vec<CorpusLogRequest> = if batch.is_empty() {
        // Single entry format
        match serde_json::from_slice(body) {
            Ok(v) => vec![v],
            Err(e) => {
                return write_simple(stream, 400, "Bad Request", &format!("Invalid JSON: {}", e));
            }
        }
    } else {
        batch
    };

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let corpus_dir = std::path::PathBuf::from("data/training_corpus");
    let _ = std::fs::create_dir_all(&corpus_dir);

    // Daily rotation with soft 50 MB limit
    let date_str = chrono::Utc::now().format("%Y%m%d").to_string();
    let path = corpus_dir.join(format!("corpus_discord_{}.jsonl", date_str));
    let should_rotate = std::fs::metadata(&path)
        .map(|m| m.len() > 50_000_000)
        .unwrap_or(false);
    let path = if should_rotate {
        let hour = chrono::Utc::now().format("%H%M%S").to_string();
        corpus_dir.join(format!("corpus_discord_{}_{}.jsonl", date_str, hour))
    } else {
        path
    };

    let lines: Vec<String> = entries.iter().map(|req| {
        let entry = serde_json::json!({
            "timestamp": ts,
            "input": req.input,
            "reply": req.reply,
            "user_id": req.user_id,
            "channel_id": req.channel_id,
            "state": {
                "confidence": req.confidence,
                "conflict": req.conflict,
                "felt_valence": req.valence,
                "mood": req.mood,
            },
            "hits": req.hits.iter().map(|h| {
                serde_json::json!({
                    "text": h.text,
                    "score": h.score,
                    "source": h.source,
                })
            }).collect::<Vec<_>>(),
        });
        entry.to_string()
    }).collect();

    let _guard = CORPUS_LOG_LOCK.lock().unwrap();
    let result = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(&path)
        .and_then(|mut f| {
            for line in &lines {
                writeln!(f, "{}", line)?;
            }
            Ok(())
        });
    drop(_guard);

    match result {
        Ok(_) => write_simple(stream, 200, "OK", &format!("logged {} entries", entries.len())),
        Err(e) => write_simple(stream, 500, "Internal Server Error", &format!("disk: {}", e)),
    }
}

// ── Agent Management ────────────────────────────────────────────────────────

fn handle_get_agent(
    stream: &mut TcpStream,
    query_str: &str,
    universe: Arc<RwLock<Universe>>,
) -> std::io::Result<()> {
    let name = query_str.split('&')
        .find(|p| p.starts_with("name="))
        .map(|p| p["name=".len()..].to_string())
        .unwrap_or_default();
        
    if name.is_empty() {
        return write_simple(stream, 400, "Bad Request", "Missing name parameter");
    }
    
    let u = universe.read().unwrap_or_else(|e| e.into_inner());
    if let Some(agent) = u.get_agent(&name) {
        write_json(stream, 200, "OK", &serde_json::to_value(agent).unwrap())
    } else {
        write_simple(stream, 404, "Not Found", "Agent not found in specification")
    }
}

// ── Internal Helpers ────────────────────────────────────────────────────────

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn load_session() -> Session {
    if let Ok(data) = std::fs::read_to_string(SESSION_PATH) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        Session::default()
    }
}

static SAVE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn save_session(session: &Session) {
    if let Ok(data) = serde_json::to_string_pretty(session) {
        if let Ok(_guard) = SAVE_LOCK.lock() {
            let tmp_path = format!("{}.tmp", SESSION_PATH);
            if std::fs::write(&tmp_path, &data).is_ok() {
                let _ = std::fs::rename(&tmp_path, SESSION_PATH);
            }
        }
    }
}

fn write_json(stream: &mut TcpStream, code: u16, status: &str, data: &serde_json::Value) -> std::io::Result<()> {
    use std::io::Write;
    let body = serde_json::to_string(data).unwrap();
    let resp = format!(
        "HTTP/1.1 {} {}\r\nAccess-Control-Allow-Origin: *\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        code, status, body.len(), body
    );
    stream.write_all(resp.as_bytes())?;
    stream.flush()
}

/// Like write_json but takes a pre-serialized JSON string, avoiding a redundant
/// serde_json::Value → String round-trip on cache hits.
fn write_json_raw(stream: &mut TcpStream, code: u16, status: &str, body: &str) -> std::io::Result<()> {
    use std::io::Write;
    let resp = format!(
        "HTTP/1.1 {} {}\r\nAccess-Control-Allow-Origin: *\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        code, status, body.len(), body
    );
    stream.write_all(resp.as_bytes())?;
    stream.flush()
}

fn write_simple(stream: &mut TcpStream, code: u16, status: &str, msg: &str) -> std::io::Result<()> {
    use std::io::Write;
    let resp = format!(
        "HTTP/1.1 {} {}\r\nAccess-Control-Allow-Origin: *\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        code, status, msg.len(), msg
    );
    stream.write_all(resp.as_bytes())?;
    stream.flush()
}

fn contains_any(text: &str, matches: &[&str]) -> bool {
    matches.iter().any(|&m| text.contains(m))
}

fn clean_grounded_fragment(s: &str) -> String {
    s.replace(['\r', '\n'], " ").trim().to_string()
}

fn load_keys() -> ApiKeys {
    let path = "data/oracle_keys.json";
    if let Ok(data) = std::fs::read_to_string(path) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        ApiKeys::default()
    }
}

fn get_system_awareness(session: &Session) -> String {
    let mut transcript_snippet = String::new();
    let recent_turns: Vec<&Turn> = session.turns.iter().rev().take(3).collect();
    for turn in recent_turns.iter().rev() {
        transcript_snippet.push_str(&format!("{}: {}\n", turn.from, truncate(&turn.text, 100)));
    }

    format!(
        "SYSTEM AWARENESS:\n- Task: {}\n- Active Participant: {}\n- Vitals: PHI_G={:.2}, CHI={:.2}, Mood={}\n\nTRANSCRIPT (LAST 3):\n{}",
        session.task, session.active_participant, session.vitals.phi_g, session.vitals.chi, session.vitals.mood, transcript_snippet
    )
}

fn get_relevant_code_snippet(task: &str) -> String {
    // This is a placeholder for actual code retrieval logic.
    format!("SOURCE ANCHOR (Task Context): {}", task)
}

fn generate_kai_coder_reply(
    session: Arc<RwLock<Session>>,
    universe: Arc<RwLock<Universe>>,
    synaptic_layer: Arc<RwLock<SynapticLayer>>,
    prompt: &str,
) -> String {
    let keys = load_keys();
    let awareness = get_system_awareness(&session.read().unwrap_or_else(|p| p.into_inner()));
    let source_anchor = get_relevant_code_snippet(&session.read().unwrap_or_else(|p| p.into_inner()).task);
    let full_prompt = format!("{}\n{}\n\n{}", awareness, source_anchor, prompt);
    match call_model("gpt-4o", &keys, &full_prompt) {
        Ok(reply) => reply,
        Err(e) => format!("Error generating reply: {}", e),
    }
}

fn generate_direct_ai_reply(
    model: &str,
    session: Arc<RwLock<Session>>,
    universe: Arc<RwLock<Universe>>,
    synaptic_layer: Arc<RwLock<SynapticLayer>>,
    prompt: &str,
) -> (String, bool) {
    let keys = load_keys();
    let (awareness, source_anchor) = {
        let s = session.read().unwrap_or_else(|p| p.into_inner());
        (get_system_awareness(&s), get_relevant_code_snippet(&s.task))
    };
    let full_prompt = format!("IDENTITY: {}. {}\n{}\n\n{}", model, awareness, source_anchor, prompt);
    match call_model(model, &keys, &full_prompt) {
        Ok(reply) => (reply, false),
        Err(e) => (format!("Error: {}", e), false),
    }
}

fn is_malformed_or_fake_reply(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("as an ai language model") || lower.contains("i cannot fulfill") || lower.len() < 5
}

fn is_model_status_question(lower: &str) -> bool {
    contains_any(lower, &["model status", "which models", "available models"])
}

fn oracle_model_status_card() -> String {
    "AVAILABLE MODELS:\n- GPT-4o (Primary)\n- Gemini 1.5 Pro (Fallback)\n- Groq/Llama-3 (Speed)\n- Local Mistral (Offline)".to_string()
}

fn is_oracle_status_question(lower: &str) -> bool {
    contains_any(lower, &["oracle status", "is oracle ok", "system health"])
}

fn write_cors_preflight(stream: &mut TcpStream) -> std::io::Result<()> {
    use std::io::Write;
    let resp = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nConnection: close\r\n\r\n";
    stream.write_all(resp.as_bytes())?;
    stream.flush()
}

fn call_model(model: &str, keys: &ApiKeys, prompt: &str) -> Result<String, String> {
    if native_only_blocks_llm() {
        return Err("RSHL-native mode: external LLM calls disabled".into());
    }
    let system = "You are an AI assistant in the Oracle Roundtable.";
    if model.contains("gpt") || model.contains("o1") {
        if let Some(key) = &keys.openai { return call_openai(key, model, prompt); }
    } else if model.contains("Epistemic") || model.contains("kai") {
        if let Some(key) = &keys.kai { return call_kai(key, prompt); }
    } else if model.contains("gemini") {
        if let Some(key) = &keys.google { return call_gemini(key, prompt); }
    } else if model.contains("groq") || model.contains("llama-3") {
        if let Some(key) = &keys.groq { return call_groq(key, prompt); }
    }
    call_ollama("mistral:7b", prompt, system)
}

fn run_safe_command(cmd: &str) -> String {
    use std::process::Command;
    let parts: Vec<&str> = cmd.split_whitespace().collect();
    if parts.is_empty() { return "No command provided".into(); }
    let allowed = ["cargo", "ls", "dir", "echo", "findstr"];
    if !allowed.contains(&parts[0]) {
        return format!("Command '{}' is not allowed for safety reasons.", parts[0]);
    }
    // SECURITY: reject shell metacharacters that bypass the allowlist via command chaining
    for ch in ['&', '|', ';', '`', '$', '>', '<', '(', ')', '{', '}', '!', '^'] {
        if cmd.contains(ch) {
            return format!("Command contains blocked character '{}' — rejected for safety.", ch);
        }
    }
    let output = if cfg!(target_os = "windows") {
        Command::new("cmd").args(["/C", cmd]).output()
    } else {
        Command::new("sh").args(["-c", cmd]).output()
    };
    match output {
        Ok(out) => {
            let s = String::from_utf8_lossy(&out.stdout);
            let e = String::from_utf8_lossy(&out.stderr);
            format!("STDOUT:\n{}\nSTDERR:\n{}", s, e)
        }
        Err(e) => format!("Failed to execute command: {}", e)
    }
}

fn extract_after_any(text: &str, prefixes: &[&str]) -> Option<String> {
    for prefix in prefixes {
        if text.starts_with(prefix) {
            return Some(text[prefix.len()..].trim().to_string());
        }
    }
    None
}

fn execute_tool_action(action: &ToolExecutionRequest) -> Result<String, String> {
    match action.tool_id.as_str() {
        "cargo_check" => Ok(run_safe_command("cargo check")),
        "cargo_test" => Ok(run_safe_command("cargo test")),
        "ls" | "dir" => Ok(run_safe_command("dir")),
        "file_read" | "oracle.read_file" => {
            let path = action.input.trim();
            Ok(execute_system_command(&format!("read file {}", path)))
        }
        "list_dir" | "oracle.list_directory" => {
            let path = if action.input.trim().is_empty() { "." } else { action.input.trim() };
            Ok(run_safe_command(&format!("dir {}", path)))
        }
        "oracle.search_code" => {
            let term = action.input.trim();
            if term.is_empty() { return Err("Search term cannot be empty".into()); }
            let term = term.replace("\"", "\\\""); // escape quotes
            // Windows-native findstr for recursive code search
            Ok(run_safe_command(&format!("findstr /s /i /c:\"{}\" *.*", term)))
        }
        "oracle.web_search" => {
            Ok(web_search_duckduckgo(&action.input))
        }
        _ => Err(format!("Tool '{}' not implemented for internal execution", action.tool_id))
    }
}

fn summarize_objective(task: &str) -> String {
    format!("Objective: {}", task)
}

fn oracle_tool_registry_card() -> String {
    let tools = oracle_tool_registry();
    let mut out = String::from("TOOL REGISTRY:\n");
    for t in tools {
        out.push_str(&format!("- {}: {} ({})", t.id, t.label, t.capability));
    }
    out
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ORACLE LATTICE & TRAINING API — Do anything through Oracle, not CLI
// ═══════════════════════════════════════════════════════════════════════════════

fn kai_exe() -> String {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| if cfg!(windows) { "target\\release\\kai.exe".into() } else { "target/release/kai".into() })
}

fn start_job(session: &Arc<RwLock<Session>>, name: &str) -> String {
    let id = format!("{}-{}", name, now());
    let job = BackgroundJob {
        id: id.clone(),
        name: name.to_string(),
        status: "running".into(),
        started_at: now(),
        finished_at: None,
        message: "Started...".into(),
    };
    session.write().unwrap_or_else(|p| p.into_inner()).background_jobs.push(job);
    id
}

fn finish_job(session: &Arc<RwLock<Session>>, id: &str, status: &str, message: &str) {
    let mut s = session.write().unwrap_or_else(|p| p.into_inner());
    if let Some(j) = s.background_jobs.iter_mut().find(|j| j.id == id) {
        j.status = status.into();
        j.finished_at = Some(now());
        j.message = message.into();
    }
}

fn spawn_cli_job(session: Arc<RwLock<Session>>, name: &str, args: &[&str]) -> String {
    let id = start_job(&session, name);
    let exe = kai_exe();
    let args_owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let id_clone = id.clone();
    std::thread::spawn(move || {
        let mut cmd = std::process::Command::new(&exe);
        for a in &args_owned { cmd.arg(a); }
        let result = cmd.output();
        match result {
            Ok(out) => {
                let msg = if out.status.success() {
                    String::from_utf8_lossy(&out.stdout).to_string()
                } else {
                    format!("Exit code {:?}\nSTDERR: {}", out.status.code(), String::from_utf8_lossy(&out.stderr))
                };
                finish_job(&session, &id_clone, if out.status.success() { "completed" } else { "failed" }, &msg);
            }
            Err(e) => {
                finish_job(&session, &id_clone, "failed", &format!("Failed to spawn: {}", e));
            }
        }
    });
    id
}

// ── Lattice Management ──────────────────────────────────────────────────────

fn handle_lattice_compact_save(
    stream: &mut TcpStream,
    universe: Arc<RwLock<Universe>>,
    synaptic_layer: &Arc<RwLock<SynapticLayer>>,
    session: Arc<RwLock<Session>>,
) -> std::io::Result<()> {
    let base_dir = std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|_| ".".into());
    let mut u = universe.write().unwrap_or_else(|e| e.into_inner());
    let sl = synaptic_layer.read().unwrap_or_else(|e| e.into_inner());
    let tick = sl.tick;
    let candidates = crate::cognition::candidates::CandidateBuffer::new();
    let drive = crate::drive::Drive::default();
    let res = crate::persistence::save_compact(&base_dir, &mut *u, &candidates, &drive, &sl, tick, 0);
    drop(sl);
    let msg = if res.ok {
        format!("Compact save OK: {} cells ({:.2} KB)", res.cells, res.bytes as f64 / 1024.0)
    } else {
        "Compact save failed".into()
    };
    write_json(stream, 200, "OK", &json!({ "ok": res.ok, "message": msg, "cells": res.cells, "bytes": res.bytes }))
}

fn handle_lattice_rebuild_index(
    stream: &mut TcpStream,
    universe: Arc<RwLock<Universe>>,
) -> std::io::Result<()> {
    let mut u = universe.write().unwrap_or_else(|e| e.into_inner());
    u.rebuild_index(0.0);
    write_json(stream, 200, "OK", &json!({ "ok": true, "message": "Index rebuilt" }))
}

fn handle_judge_snapshot(
    stream: &mut TcpStream,
    body: &[u8],
    live_universe: Arc<RwLock<Universe>>,
) -> std::io::Result<()> {
    #[derive(serde::Deserialize)]
    struct Req {
        path: String,
    }

    let req: Req = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(e) => {
            return write_json(stream, 200, "OK", &json!({
                "score": 0.0,
                "verdict": "annihilate",
                "factors": { "used": 0.0, "novelty": 0.0, "resonance": 0.0 },
                "sampled": 0,
                "error": format!("Invalid JSON: {}", e)
            }));
        }
    };

    // 1. Load temp snapshot cells (heavy file read - done outside of locking the live universe!)
    let loaded = crate::persistence::load_compact(&req.path);
    let (temp_universe, _, _, _, _, _) = match loaded {
        Some(parts) => parts,
        None => {
            return write_json(stream, 200, "OK", &json!({
                "score": 0.0,
                "verdict": "annihilate",
                "factors": { "used": 0.0, "novelty": 0.0, "resonance": 0.0 },
                "sampled": 0,
                "error": "unreadable"
            }));
        }
    };

    let temp_cells = temp_universe.get_cells();
    let m = temp_cells.len();
    if m == 0 {
        return write_json(stream, 200, "OK", &json!({
            "score": 0.0,
            "verdict": "annihilate",
            "factors": { "used": 0.0, "novelty": 0.0, "resonance": 0.0 },
            "sampled": 0
        }));
    }

    // 2. Sample up to N = 256 cells (deterministic stride)
    let n_sample = 256;
    let stride = (m / n_sample).max(1);
    let mut sampled_cells = Vec::new();
    let mut i = 0;
    while i < m && sampled_cells.len() < n_sample {
        sampled_cells.push(&temp_cells[i]);
        i += stride;
    }
    let sampled_count = sampled_cells.len();

    // 3. used = mean over sampled of min(confidence/5.0, 1.0) blended with access/fire signals
    let mut sum_used = 0.0;
    for cell in &sampled_cells {
        let conf_val = (cell.claim.confidence / 5.0).min(1.0).max(0.0);
        let fire_val = if cell.last_fired > 0 { 1.0 } else { 0.0 };
        let cell_used = conf_val * 0.8 + fire_val * 0.2;
        sum_used += cell_used;
    }
    let used_score = sum_used / sampled_count as f32;

    // 4. novelty = fraction of sampled cells whose top-1 cosine vs the live universe is < 0.92
    let mut novel_count = 0;
    for cell in &sampled_cells {
        let top_cosine = {
            let live_u = live_universe.read().unwrap_or_else(|e| e.into_inner());
            let hits = live_u.query_vec(&cell.claim.vec, 1);
            hits.first().map(|(_, score)| *score).unwrap_or(0.0)
        };
        if top_cosine < 0.92 {
            novel_count += 1;
        }
    }
    let novelty_score = novel_count as f32 / sampled_count as f32;

    // 5. resonance = mean phasor_coherence(cell, live drive.goal_vector) clamped to [0,1]
    let live_goal_vector = crate::persistence::load_live_goal_vector(".");
    let resonance_score = if let Some(ref gv) = live_goal_vector {
        let mut sum_res = 0.0;
        for cell in &sampled_cells {
            let res_val = cell.claim.vec.phasor_coherence(gv).clamp(0.0, 1.0);
            sum_res += res_val;
        }
        sum_res / sampled_count as f32
    } else {
        0.5
    };

    // 6. Calculate total score and verdict
    let score = 0.4 * novelty_score + 0.35 * used_score + 0.25 * resonance_score;
    let verdict = if score >= 0.5 { "reprieve" } else { "annihilate" };

    write_json(stream, 200, "OK", &json!({
        "score": score,
        "verdict": verdict,
        "factors": {
            "used": used_score,
            "novelty": novelty_score,
            "resonance": resonance_score
        },
        "sampled": sampled_count as u32
    }))
}

fn handle_lattice_warm_continuations(
    stream: &mut TcpStream,
    _universe: Arc<RwLock<Universe>>,
    session: Arc<RwLock<Session>>,
) -> std::io::Result<()> {
    let id = spawn_cli_job(session.clone(), "warm-continuations", &["--warm-continuations"]);
    write_json(stream, 202, "Accepted", &json!({ "job_id": id, "message": "Warming continuations in background. Check /api/jobs/status" }))
}

fn handle_lattice_force_reseed(
    stream: &mut TcpStream,
    _universe: Arc<RwLock<Universe>>,
    session: Arc<RwLock<Session>>,
) -> std::io::Result<()> {
    let id = spawn_cli_job(session.clone(), "force-reseed", &["--force-reseed"]);
    write_json(stream, 202, "Accepted", &json!({ "job_id": id, "message": "Force reseed started in background. Check /api/jobs/status" }))
}

fn handle_lattice_reset_continuations(
    stream: &mut TcpStream,
    _universe: Arc<RwLock<Universe>>,
    session: Arc<RwLock<Session>>,
) -> std::io::Result<()> {
    let id = spawn_cli_job(session.clone(), "reset-continuations", &["--reset-continuations"]);
    write_json(stream, 202, "Accepted", &json!({ "job_id": id, "message": "Resetting continuations in background. Check /api/jobs/status" }))
}

fn handle_lattice_corpus_stats(
    stream: &mut TcpStream,
) -> std::io::Result<()> {
    let corpus_dir = std::path::PathBuf::from("data/training_corpus");
    if !corpus_dir.exists() {
        return write_json(stream, 200, "OK", &json!({ "error": "No training corpus found", "path": corpus_dir.to_string_lossy() }));
    }
    let mut total_lines = 0usize;
    let mut total_bytes = 0usize;
    let mut earliest = u64::MAX;
    let mut latest = 0u64;
    let mut files = 0usize;
    if let Ok(entries) = std::fs::read_dir(&corpus_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                files += 1;
                if let Ok(meta) = std::fs::metadata(&path) {
                    total_bytes += meta.len() as usize;
                }
                if let Ok(contents) = std::fs::read_to_string(&path) {
                    for line in contents.lines() {
                        total_lines += 1;
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
                            if let Some(ts) = val.get("ts").and_then(|v| v.as_u64()) {
                                earliest = earliest.min(ts);
                                latest = latest.max(ts);
                            }
                        }
                    }
                }
            }
        }
    }
    let avg_len = if total_lines > 0 { total_bytes / total_lines } else { 0 };
    write_json(stream, 200, "OK", &json!({
        "files": files,
        "total_lines": total_lines,
        "total_bytes": total_bytes,
        "avg_entry_bytes": avg_len,
        "earliest_ts": if earliest == u64::MAX { None } else { Some(earliest) },
        "latest_ts": if latest == 0 { None } else { Some(latest) }
    }))
}

fn handle_lattice_wonder(
    stream: &mut TcpStream,
    universe: Arc<RwLock<Universe>>,
    session: Arc<RwLock<Session>>,
) -> std::io::Result<()> {
    let u = universe.read().unwrap_or_else(|e| e.into_inner());
    match crate::cognition::inner_voice::wonder(&u) {
        Some((topic, memory, score)) => {
            write_json(stream, 200, "OK", &json!({
                "topic": topic,
                "memory": memory,
                "score": score
            }))
        }
        None => {
            write_json(stream, 200, "OK", &json!({ "message": "The lattice is quiet. Nothing surfaces yet." }))
        }
    }
}

fn handle_lattice_seed_anchors(
    stream: &mut TcpStream,
    universe: Arc<RwLock<Universe>>,
    session: Arc<RwLock<Session>>,
) -> std::io::Result<()> {
    let mut u = universe.write().unwrap_or_else(|e| e.into_inner());
    crate::core::seed::seed_universe(&mut u);
    let count = u.get_cells().len();
    write_json(stream, 200, "OK", &json!({ "ok": true, "message": format!("Seeded anchors. Lattice now has {} cells.", count) }))
}

fn handle_lattice_build_hierarchy(
    stream: &mut TcpStream,
    universe: Arc<RwLock<Universe>>,
) -> std::io::Result<()> {
    let mut u = universe.write().unwrap_or_else(|e| e.into_inner());
    let before = u.get_cells().len();
    let parents = crate::core::hierarchy::HierarchyBuilder::build_full(&mut u);
    let after = u.get_cells().len();
    write_json(stream, 200, "OK", &json!({
        "ok": true,
        "parents_created": parents,
        "cells_before": before,
        "cells_after": after,
        "message": format!("Built {} parent cells. Lattice: {} → {} cells.", parents, before, after)
    }))
}

fn handle_lattice_zoom_in(
    stream: &mut TcpStream,
    query_str: &str,
    universe: Arc<RwLock<Universe>>,
) -> std::io::Result<()> {
    let idx: usize = query_str.split('&')
        .find(|p| p.starts_with("idx="))
        .and_then(|p| p[4..].parse().ok())
        .unwrap_or(0);
    let u = universe.read().unwrap_or_else(|e| e.into_inner());
    let children: Vec<serde_json::Value> = u.zoom_in(idx).iter().map(|c| {
        json!({
            "label": c.label,
            "text": c.claim.text,
            "region": c.region.to_string(),
            "confidence": c.claim.confidence,
            "layer": c.claim.layer,
        })
    }).collect();
    write_json(stream, 200, "OK", &json!({ "cell_idx": idx, "children": children }))
}

fn handle_lattice_zoom_out(
    stream: &mut TcpStream,
    query_str: &str,
    universe: Arc<RwLock<Universe>>,
) -> std::io::Result<()> {
    let idx: usize = query_str.split('&')
        .find(|p| p.starts_with("idx="))
        .and_then(|p| p[4..].parse().ok())
        .unwrap_or(0);
    let u = universe.read().unwrap_or_else(|e| e.into_inner());
    let parent = u.zoom_out(idx).map(|c| json!({
        "label": c.label,
        "text": c.claim.text,
        "region": c.region.to_string(),
        "confidence": c.claim.confidence,
        "layer": c.claim.layer,
    }));
    write_json(stream, 200, "OK", &json!({ "cell_idx": idx, "parent": parent }))
}

fn handle_lattice_query_layer(
    stream: &mut TcpStream,
    query_str: &str,
    universe: Arc<RwLock<Universe>>,
) -> std::io::Result<()> {
    let text = query_str.split('&')
        .find(|p| p.starts_with("q="))
        .map(|p| p[2..].replace('+', " "))
        .unwrap_or_default();
    let layer: u8 = query_str.split('&')
        .find(|p| p.starts_with("layer="))
        .and_then(|p| p[6..].parse().ok())
        .unwrap_or(2);
    let n: usize = query_str.split('&')
        .find(|p| p.starts_with("n="))
        .and_then(|p| p[2..].parse().ok())
        .unwrap_or(5);
    let u = universe.read().unwrap_or_else(|e| e.into_inner());
    let hits = u.query_at_layer(&text, layer, n);
    let results: Vec<serde_json::Value> = hits.iter().map(|h| {
        json!({
            "label": h.label,
            "text": h.text,
            "score": h.score,
            "region": h.region,
            "source": h.source,
        })
    }).collect();
    write_json(stream, 200, "OK", &json!({ "query": text, "layer": layer, "results": results }))
}

// ── Training Pipelines ──────────────────────────────────────────────────────

fn handle_train_build_lexicon(
    stream: &mut TcpStream,
    session: Arc<RwLock<Session>>,
) -> std::io::Result<()> {
    let id = spawn_cli_job(session.clone(), "build-lexicon", &["--build-lexicon"]);
    write_json(stream, 202, "Accepted", &json!({ "job_id": id, "message": "Building lexicon in background. Check /api/jobs/status" }))
}

fn handle_train_ingest_corpus(
    stream: &mut TcpStream,
    session: Arc<RwLock<Session>>,
    query_str: &str,
) -> std::io::Result<()> {
    let mut args = vec!["--ingest-corpus"];
    if let Some(dir) = query_str.split('&').find(|p| p.starts_with("dir=")).map(|p| &p[4..]) {
        args.push("--corpus-dir");
        args.push(dir);
    }
    let id = spawn_cli_job(session.clone(), "ingest-corpus", &args);
    write_json(stream, 202, "Accepted", &json!({ "job_id": id, "message": "Ingesting corpus in background. Check /api/jobs/status" }))
}

fn handle_train_response_mlp(
    stream: &mut TcpStream,
    session: Arc<RwLock<Session>>,
    query_str: &str,
) -> std::io::Result<()> {
    let mut args = vec!["--train-response-mlp"];
    if let Some(epochs) = query_str.split('&').find(|p| p.starts_with("epochs=")).map(|p| &p[7..]) {
        args.push("--num-epochs");
        args.push(epochs);
    }
    if let Some(hidden) = query_str.split('&').find(|p| p.starts_with("hidden=")).map(|p| &p[7..]) {
        args.push("--d-hidden");
        args.push(hidden);
    }
    let id = spawn_cli_job(session.clone(), "train-response-mlp", &args);
    write_json(stream, 202, "Accepted", &json!({ "job_id": id, "message": "Training response MLP in background. Check /api/jobs/status" }))
}

fn handle_train_mapper(
    stream: &mut TcpStream,
    session: Arc<RwLock<Session>>,
    query_str: &str,
) -> std::io::Result<()> {
    let mut args = vec!["--train-mapper"];
    if let Some(epochs) = query_str.split('&').find(|p| p.starts_with("epochs=")).map(|p| &p[7..]) {
        args.push("--num-epochs");
        args.push(epochs);
    }
    if let Some(pairs) = query_str.split('&').find(|p| p.starts_with("pairs=")).map(|p| &p[6..]) {
        args.push("--num-pairs");
        args.push(pairs);
    }
    if query_str.split('&').any(|p| p == "stub-embedder" || p == "stub" || p == "embedder=stub") {
        args.push("--stub-embedder");
    } else {
        // Default to Ollama nomic-embed-text for real embedding training
        args.push("--ollama-url=http://127.0.0.1:11434");
        args.push("--ollama-model=nomic-embed-text");
    }
    let id = spawn_cli_job(session.clone(), "train-mapper", &args);
    write_json(stream, 202, "Accepted", &json!({ "job_id": id, "message": "Training mapper in background. Check /api/jobs/status" }))
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

fn handle_diagnose_predictive(
    stream: &mut TcpStream,
    _universe: Arc<RwLock<Universe>>,
    session: Arc<RwLock<Session>>,
) -> std::io::Result<()> {
    let id = spawn_cli_job(session.clone(), "diagnose-predictive", &["--diagnose-predictive"]);
    write_json(stream, 202, "Accepted", &json!({ "job_id": id, "message": "Running predictive diagnostic in background. Check /api/jobs/status" }))
}

fn handle_diagnose_epistemic(
    stream: &mut TcpStream,
    session: Arc<RwLock<Session>>,
) -> std::io::Result<()> {
    let id = spawn_cli_job(session.clone(), "diagnose-epistemic", &["--diagnose-epistemic"]);
    write_json(stream, 202, "Accepted", &json!({ "job_id": id, "message": "Running epistemic diagnostic in background. Check /api/jobs/status" }))
}

// ── Background Jobs ───────────────────────────────────────────────────────────

fn handle_jobs_status(
    stream: &mut TcpStream,
    session: Arc<RwLock<Session>>,
) -> std::io::Result<()> {
    let s = session.read().unwrap_or_else(|p| p.into_inner());
    let jobs: Vec<_> = s.background_jobs.iter().rev().take(20).collect();
    write_json(stream, 200, "OK", &json!({ "jobs": jobs }))
}

fn handle_jobs_clear(
    stream: &mut TcpStream,
    session: Arc<RwLock<Session>>,
) -> std::io::Result<()> {
    let mut s = session.write().unwrap_or_else(|p| p.into_inner());
    s.background_jobs.retain(|j| j.status == "running");
    write_json(stream, 200, "OK", &json!({ "message": "Cleared completed/failed jobs" }))
}

fn handle_kai_spectate_push(
    stream: &mut TcpStream,
    body: &[u8],
    session: Arc<RwLock<Session>>,
) -> std::io::Result<()> {
    let events: Vec<SpectateEvent> = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => {
            return write_simple(stream, 400, "Bad Request", &format!("invalid spectate body: {}", e));
        }
    };
    let mut s = session.write().unwrap_or_else(|p| p.into_inner());
    s.spectate_buffer.extend(events);
    // Cap buffer at 500 events to prevent unbounded growth
    if s.spectate_buffer.len() > 500 {
        let drain = s.spectate_buffer.len() - 500;
        s.spectate_buffer.drain(0..drain);
    }
    write_json(stream, 200, "OK", &json!({ "message": "pushed", "count": s.spectate_buffer.len() }))
}

fn handle_kai_spectate(
    stream: &mut TcpStream,
    session: Arc<RwLock<Session>>,
) -> std::io::Result<()> {
    let mut s = session.write().unwrap_or_else(|p| p.into_inner());
    let events: Vec<SpectateEvent> = std::mem::take(&mut s.spectate_buffer);
    write_json(stream, 200, "OK", &json!({ "events": events }))
}

fn handle_telemetry(stream: &mut TcpStream) -> std::io::Result<()> {
    if let Ok(html) = std::fs::read_to_string("cern_telemetry.html") {
        use std::io::Write;
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            html.len(), html
        );
        stream.write_all(resp.as_bytes())?;
        stream.flush()
    } else {
        write_simple(stream, 404, "Not Found", "cern_telemetry.html not found in C:\\KAI")
    }
}



fn handle_interpret_build(
    stream: &mut TcpStream,
    universe: Arc<RwLock<Universe>>,
) -> std::io::Result<()> {
    let started = crate::core::interpret::rebuild_feature_map(universe);
    if started {
        write_json(stream, 200, "OK", &json!({ "status": "success", "message": "Semantic Feature Map rebuilding in background." }))
    } else {
        write_json(stream, 200, "OK", &json!({ "status": "already_building", "message": "Build already in progress — please wait." }))
    }
}

fn handle_interpret_status(
    stream: &mut TcpStream,
) -> std::io::Result<()> {
    let lock = crate::core::interpret::get_feature_map();
    let reader = lock.read().unwrap();
    let built = reader.is_some();
    let building = crate::core::interpret::BUILD_IN_PROGRESS.load(std::sync::atomic::Ordering::Relaxed);
    write_json(stream, 200, "OK", &json!({
        "built": built,
        "building": building,
        "message": if built { "Feature map is active." } else if building { "Feature map is building..." } else { "Feature map not built yet." }
    }))
}

/// v9.10.556 — GET /api/mind/silent-thoughts: the J-Space readout.
/// Returns the live Global Workspace (entries by salience + current broadcast +
/// coherence) and the ring of recent retrievals with the candidates that fired,
/// wired, and were never said. Read-only; touches no lattice locks.
/// POST /api/mind/trace  { "text": "...", "speaker": "Ryan" }
///
/// Runs ONE real turn with the mind trace armed and returns the whole record:
/// every stage, every branch with the condition value and whether it was taken,
/// the full scored candidate set (survivors AND the silent thoughts truncated
/// before speaking), which code path actually spoke, and per-stage timings.
///
/// This is a debugging window, not a chat endpoint — it takes the same
/// admission permit as a normal turn so it can never be used to bypass the
/// concurrency limiter, and tracing is armed per-request so a normal turn pays
/// nothing for its existence.
fn handle_mind_trace(
    stream: &mut TcpStream,
    body: &[u8],
    universe: Arc<RwLock<Universe>>,
    synaptic_layer: Arc<RwLock<crate::core::SynapticLayer>>,
    session: Arc<RwLock<Session>>,
) -> std::io::Result<()> {
    #[derive(Deserialize)]
    struct TraceReq {
        text: String,
        #[serde(default)]
        speaker: String,
    }
    let req: TraceReq = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => return write_simple(stream, 400, "Bad Request", "Invalid JSON"),
    };
    if req.text.trim().is_empty() {
        return write_simple(stream, 400, "Bad Request", "text is required");
    }
    let speaker = if req.speaker.trim().is_empty() { "Ryan" } else { req.speaker.trim() };

    crate::cognition::mind_trace::begin(&req.text, speaker);
    let reply = generate_oracle_kai_reply(
        &universe,
        &synaptic_layer,
        &session,
        "trace",
        &req.text,
        &req.text,
    );
    let trace = crate::cognition::mind_trace::finish(&reply);

    match trace {
        Some(t) => write_json(stream, 200, "OK", &serde_json::json!({ "ok": true, "trace": t })),
        None => write_json(stream, 500, "Internal Server Error", &serde_json::json!({
            "ok": false,
            "error": "trace was not captured — mind_trace::begin did not take effect on this thread"
        })),
    }
}

fn handle_silent_thoughts(stream: &mut TcpStream) -> std::io::Result<()> {
    let (entries, broadcast, coherence, total) = match oracle_workspace().read() {
        Ok(gw) => (
            gw.entries_by_salience().iter().map(|e| json!({
                "source": e.source,
                "content": e.content,
                "salience": (e.salience * 1000.0).round() / 1000.0,
            })).collect::<Vec<_>>(),
            gw.broadcast.as_ref().map(|b| json!({ "source": b.source, "content": b.content, "salience": (b.salience*1000.0).round()/1000.0 })),
            (gw.avg_coherence * 1000.0).round() / 1000.0,
            gw.total_broadcasts,
        ),
        Err(_) => (Vec::new(), None, 0.0, 0),
    };
    let thoughts: Vec<serde_json::Value> = match silent_ring().read() {
        Ok(ring) => ring.iter().rev().map(|r| json!({
            "ts": r.ts,
            "query": r.query,
            "said": r.said,
            "silent": r.silent.iter().map(|(l, s, reg)| json!({
                "label": l, "score": (s * 1000.0).round() / 1000.0, "region": reg,
            })).collect::<Vec<_>>(),
            "broadcast": r.broadcast,
        })).collect(),
        Err(_) => Vec::new(),
    };
    write_json(stream, 200, "OK", &json!({
        "ok": true,
        "mediation_live": gws_live(),
        "workspace": {
            "entries": entries,
            "broadcast": broadcast,
            "coherence": coherence,
            "total_broadcasts": total,
        },
        "thoughts": thoughts,
        "note": "silent = candidates that fired and Hebbian-wired during retrieval but were truncated before the answer; broadcast = conscious content that re-ranked them (KAI_GWS_LIVE)",
    }))
}

/// v9.10.557 — POST /api/agent/run {goal, max_steps?}: the RSHL-native agent loop.
/// Runs think→select→act→observe→learn against the live lattice and returns the
/// full readable step trace. Gate: KAI_AGENT_CORE (default ON). Explicit
/// invocation only — nothing autonomous calls this.
fn handle_agent_run(
    stream: &mut TcpStream,
    body: &[u8],
    universe: Arc<RwLock<Universe>>,
    synaptic_layer: Arc<RwLock<SynapticLayer>>,
) -> std::io::Result<()> {
    if !crate::cognition::agent_core::agent_core_on() {
        return write_json(stream, 403, "Forbidden", &json!({
            "ok": false, "error": "agent_core_disabled", "note": "set KAI_AGENT_CORE=1 (or unset) and restart"
        }));
    }
    let req: serde_json::Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => return write_json(stream, 400, "Bad Request", &json!({"ok": false, "error": "invalid_json"})),
    };
    let goal = req["goal"].as_str().unwrap_or("").trim();
    if goal.is_empty() || goal.len() > 600 {
        return write_json(stream, 400, "Bad Request", &json!({
            "ok": false, "error": "goal_required", "note": "1..600 chars"
        }));
    }
    let max_steps = req["max_steps"].as_u64().unwrap_or(4) as usize;
    let core = crate::cognition::agent_core::AgentCore::new();
    let result = core.run(&universe, &synaptic_layer, goal, max_steps);
    write_json(stream, 200, "OK", &json!({
        "ok": true,
        "goal": result.goal,
        "done": result.done,
        "outcome": result.outcome,
        "learned_cells": result.learned_cells,
        "steps": result.steps,
    }))
}

fn handle_interpret_decode(
    stream: &mut TcpStream,
    body: &str,
) -> std::io::Result<()> {
    let req: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return write_simple(stream, 400, "Bad Request", "Invalid JSON"),
    };
    
    let text = req["text"].as_str().unwrap_or("");
    if text.is_empty() {
        return write_simple(stream, 400, "Bad Request", "Missing 'text' field");
    }
    
    let lock = crate::core::interpret::get_feature_map();
    let reader = lock.read().unwrap();
    if let Some(map) = &*reader {
        let vec = crate::core::SparseVec::encode(text);
        let concepts = map.interpret_vector(&vec);
        write_json(stream, 200, "OK", &json!({
            "text": text,
            "active_concepts": concepts
        }))
    } else {
        write_simple(stream, 400, "Bad Request", "Feature map not built yet. Call /api/interpret/build first.")
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod ar_gate_tests {
    use super::ar_gate_pick;

    /// `KAI_AR_GATE` is process-global and cargo runs tests in parallel threads,
    /// so every test that reads or writes it takes this lock. Without it, the
    /// gate-off test would flip the flag underneath the others.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn lock() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The EXACT reply the live engine produced for `QUERY`, captured while the
    /// correct cell (`CELL`) sat at rank #0 with score 2.392, retrieved in
    /// 17.3ms. This string is the bug; if it ever passes the critic, the gate is
    /// worthless and this test is the alarm.
    ///
    /// These tests deliberately pass `lex: None`, because a test process has no
    /// built corpus lexicon. That makes them a **lower bound**: `fluency` reports
    /// its neutral 0.5 for both strings and the gibberish veto is disabled, so
    /// the separation measured here comes only from topicality and structure —
    /// `salad 0.33 (top=0.01 str=0.57)` vs `cell 0.49 (top=0.37 str=0.80)`
    /// against a 0.45 bar. In production `ar_gate_pick` is handed the real
    /// `get_lexicon()`, where word-order fluency collapses toward 0 for salad and
    /// the margin widens considerably. If this passes, the live path passes.
    const OBSERVED_SALAD: &str = "LLM far pub 1e9 c_3 For for app s=1 ATX ice WSS sky why Why way ? 1-3 g(x phi Who who had yes CSS";
    const QUERY: &str = "what is the flimbertwig constant?";
    const CELL: &str = "The flimbertwig constant equals ninety-three.";

    #[test]
    fn observed_salad_is_rejected_and_the_retrieved_cell_is_spoken() {
        let _g = lock();
        std::env::remove_var("KAI_AR_GATE");

        let v = crate::cognition::coherence::judge(OBSERVED_SALAD, QUERY, None, None);
        println!("[ar_gate] salad -> {}", v.explain());
        assert!(
            !v.accept,
            "the observed word salad must NOT pass the critic: {}",
            v.explain()
        );

        let (text, via) = ar_gate_pick(OBSERVED_SALAD, QUERY, Some(CELL), None, None);
        assert_eq!(text, CELL, "rejected AR decode must be replaced by the rank-#0 cell");
        assert_eq!(via, "ar_rejected_fell_back_to_cell");
    }

    #[test]
    fn a_clean_on_topic_sentence_is_accepted() {
        let _g = lock();
        std::env::remove_var("KAI_AR_GATE");

        let v = crate::cognition::coherence::judge(CELL, QUERY, None, None);
        println!("[ar_gate] cell  -> {}", v.explain());
        assert!(
            v.accept,
            "a clean, on-topic sentence must pass the critic: {}",
            v.explain()
        );

        // Same sentence arriving as the AR decode: the gate must let it through
        // untouched rather than substituting the cell.
        let (text, via) = ar_gate_pick(CELL, QUERY, Some("a different cell entirely"), None, None);
        assert_eq!(text, CELL);
        assert_eq!(via, "ar_accepted");
    }

    #[test]
    fn gate_off_restores_the_exact_old_behaviour() {
        let _g = lock();
        std::env::set_var("KAI_AR_GATE", "0");
        let (text, via) = ar_gate_pick(OBSERVED_SALAD, QUERY, Some(CELL), None, None);
        std::env::remove_var("KAI_AR_GATE");

        assert_eq!(text, OBSERVED_SALAD, "KAI_AR_GATE=0 must return the bare ar_reply");
        assert_eq!(via, "ar_gate_off");
    }

    #[test]
    fn no_usable_cell_keeps_the_ar_reply_rather_than_going_silent() {
        let _g = lock();
        std::env::remove_var("KAI_AR_GATE");

        for empty in [None, Some(""), Some("   ")] {
            let (text, via) = ar_gate_pick(OBSERVED_SALAD, QUERY, empty, None, None);
            assert_eq!(text, OBSERVED_SALAD, "no fallback available => unchanged behaviour");
            assert_eq!(via, "ar_rejected_no_cell");
        }
    }
}
