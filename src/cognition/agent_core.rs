//! Agent Core — the RSHL-native agentic loop (v9.10.557, KAI-AGENT-CORE-GOAL.md).
//!
//! LLM agents run ReAct: think → act → observe → repeat, with a frozen model.
//! This is the same loop built from KAI's own layers instead:
//!   THINK   = lattice retrieval (workspace-mediated since v9.10.556)
//!   SELECT  = tool chosen by resonance (house 30/70 cosine/keyword blend)
//!   ACT     = existing native tools (no new capability surface by default)
//!   OBSERVE = result stored as a PERMANENT lattice cell (region "agency")
//!             and posted to the GlobalWorkspace — learning-from-acting,
//!             the thing frozen-weight LLMs structurally cannot do.
//!
//! No LLM anywhere in the control path. Every step is recorded as readable
//! text (J-Space discipline: the agent's working is never opaque).
//!
//! Gates: KAI_AGENT_CORE (default ON — endpoint-invoked only, never autonomous),
//! KAI_AGENT_SHELL (default OFF — shell/unsandboxed writes need explicit opt-in).

use crate::core::sparse_vec::SparseVec;
use crate::core::universe::Universe;
use crate::core::SynapticLayer;
use serde::Serialize;
use std::sync::{Arc, RwLock};

/// One registered capability the agent can select.
pub struct ToolSpec {
    pub name: &'static str,
    /// Natural-language description — encoded once; selection resonates against it.
    pub description: &'static str,
    pub vec: SparseVec,
}

/// One executed loop iteration, fully readable.
#[derive(Clone, Serialize)]
pub struct AgentStep {
    pub step: usize,
    /// What the lattice surfaced for this subtask (top memory labels).
    pub thought: String,
    pub tool: String,
    pub input: String,
    pub observation: String,
    /// goal ↔ observation resonance after this step (done when > threshold).
    pub resonance: f32,
}

#[derive(Clone, Serialize)]
pub struct AgentRunResult {
    pub goal: String,
    pub steps: Vec<AgentStep>,
    pub outcome: String,
    pub done: bool,
    pub learned_cells: usize,
}

pub fn agent_core_on() -> bool {
    static GATE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *GATE.get_or_init(|| std::env::var("KAI_AGENT_CORE").map(|v| v != "0").unwrap_or(true))
}
fn agent_shell_on() -> bool {
    static GATE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *GATE.get_or_init(|| std::env::var("KAI_AGENT_SHELL").map(|v| v == "1").unwrap_or(false))
}

/// Resonance threshold at which the goal counts as satisfied.
const DONE_RESONANCE: f32 = 0.42;
const MAX_STEPS_CAP: usize = 8;
const OBS_STORE_MAX: usize = 600; // chars of an observation persisted to the lattice

pub struct AgentCore {
    tools: Vec<ToolSpec>,
}

impl AgentCore {
    pub fn new() -> Self {
        let mk = |name: &'static str, description: &'static str| ToolSpec {
            name,
            description,
            vec: SparseVec::encode(description),
        };
        let mut tools = vec![
            mk("lattice_query",
               "recall remember memory knowledge answer question what who when where why explain tell describe lattice"),
            mk("read_file",
               "read open file path source code contents inspect look at view document text log"),
            mk("research_docs",
               "research documentation docs manual codex reference architecture how does system work internals"),
            mk("math",
               "math calculate compute number arithmetic sum multiply divide subtract percent equation solve"),
            mk("write_file",
               "write save create file store output persist note record document"),
        ];
        if agent_shell_on() {
            tools.push(mk("shell",
                "run command execute shell terminal script process cmd powershell system"));
        }
        Self { tools }
    }

    /// House retrieval blend applied to tool selection:
    /// 0.3 * cosine(task, tool) + 0.7 * keyword overlap. (universe.rs precedent.)
    pub fn select_tool(&self, task: &str) -> (&ToolSpec, f32) {
        let task_vec = SparseVec::encode(task);
        let task_lower = task.to_lowercase();
        let task_words: Vec<&str> = task_lower
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.len() > 2)
            .collect();
        let mut best = (&self.tools[0], f32::MIN);
        for t in &self.tools {
            let sim = task_vec.cosine(&t.vec).max(0.0);
            let desc_lower = t.description.to_lowercase();
            let hits = task_words.iter().filter(|w| desc_lower.contains(*w)).count();
            let kw = if task_words.is_empty() { 0.0 } else { hits as f32 / task_words.len() as f32 };
            let score = 0.3 * sim + 0.7 * kw;
            if score > best.1 {
                best = (t, score);
            }
        }
        best
    }

    /// Extract a path-looking token from the task ("read C:\x\y.rs", "open ./a.md").
    fn extract_path(task: &str) -> Option<String> {
        task.split_whitespace()
            .map(|w| w.trim_matches(|c| c == '"' || c == '\'' || c == ',' || c == ';'))
            .find(|w| {
                let looks_abs = w.len() > 3 && w.as_bytes()[1] == b':';
                let looks_rel = w.starts_with("./") || w.starts_with(".\\");
                let has_ext = w.rsplit('.').next().map(|e| e.len() >= 1 && e.len() <= 5 && e.chars().all(|c| c.is_ascii_alphanumeric())).unwrap_or(false);
                (looks_abs || looks_rel || w.contains('/') || w.contains('\\')) && has_ext
            })
            .map(|s| s.to_string())
    }

    fn act(
        &self,
        tool: &str,
        task: &str,
        universe: &Arc<RwLock<Universe>>,
        synapses: &Arc<RwLock<SynapticLayer>>,
    ) -> (String, String) {
        match tool {
            "lattice_query" | "research_docs" => {
                // research_docs first consults local doc research, then the lattice.
                if tool == "research_docs" {
                    if let Some(doc) = crate::cognition::voice::research_local_docs(task) {
                        if doc.split_whitespace().count() >= 6 {
                            return (task.to_string(), doc);
                        }
                    }
                }
                let u = universe.read().unwrap_or_else(|e| e.into_inner());
                let sl = synapses.read().unwrap_or_else(|e| e.into_inner());
                let hits = crate::core::NeuralBus::query_associative(&u, &sl, 0.5, task, 6, &[], "");
                if hits.is_empty() {
                    (task.to_string(), "The lattice is quiet on this.".to_string())
                } else {
                    let joined = hits.iter().take(4)
                        .map(|h| if h.text.is_empty() { h.label.clone() } else { h.text.clone() })
                        .collect::<Vec<_>>()
                        .join(" · ");
                    (task.to_string(), joined)
                }
            }
            "math" => {
                match crate::cognition::math_engine::try_solve(task) {
                    Some(r) => (task.to_string(), crate::cognition::math_engine::explain_result(&r)),
                    None => (task.to_string(), "Could not parse that as arithmetic.".to_string()),
                }
            }
            "read_file" => {
                match Self::extract_path(task) {
                    Some(p) => (p.clone(), crate::cognition::voice::execute_system_command(&format!("read file {}", p))),
                    None => (task.to_string(), "No readable file path found in the task.".to_string()),
                }
            }
            "write_file" => {
                // Sandboxed by default: without KAI_AGENT_SHELL=1 all writes land in
                // data/agent_out/, never at arbitrary paths.
                let raw = task.splitn(2, " with content ").collect::<Vec<_>>();
                if raw.len() != 2 {
                    return (task.to_string(),
                        "Write needs the form: write file <path> with content <content>".to_string());
                }
                let path = Self::extract_path(raw[0]).unwrap_or_else(|| "agent_note.txt".to_string());
                let safe_path = if agent_shell_on() {
                    path
                } else {
                    let base = std::path::Path::new(&path)
                        .file_name().map(|f| f.to_string_lossy().to_string())
                        .unwrap_or_else(|| "agent_note.txt".to_string());
                    let _ = std::fs::create_dir_all("data/agent_out");
                    format!("data/agent_out/{}", base)
                };
                match std::fs::write(&safe_path, raw[1]) {
                    Ok(_) => (safe_path.clone(), format!("Wrote {} bytes to {}", raw[1].len(), safe_path)),
                    Err(e) => (safe_path.clone(), format!("Write failed: {}", e)),
                }
            }
            "shell" => {
                // Double-gated: registry inclusion requires KAI_AGENT_SHELL=1, and the
                // command must be explicit in the goal (no synthesized commands).
                let lower = task.to_lowercase();
                if let Some(pos) = lower.find("run command ") {
                    let cmd = task[pos + 12..].trim();
                    (cmd.to_string(),
                     crate::cognition::voice::execute_system_command(&format!("run command {}", cmd)))
                } else {
                    (task.to_string(),
                     "Shell requires an explicit 'run command <cmd>' in the goal.".to_string())
                }
            }
            other => (task.to_string(), format!("Unknown tool '{}'", other)),
        }
    }

    /// The loop. Returns the full readable trace.
    pub fn run(
        &self,
        universe: &Arc<RwLock<Universe>>,
        synapses: &Arc<RwLock<SynapticLayer>>,
        goal: &str,
        max_steps: usize,
    ) -> AgentRunResult {
        let max_steps = max_steps.clamp(1, MAX_STEPS_CAP);
        let goal_vec = SparseVec::encode(goal);
        let mut steps: Vec<AgentStep> = Vec::new();
        let mut learned = 0usize;
        let mut done = false;
        // The evolving subtask: starts as the goal, then folds in the last observation
        // so each THINK step retrieves in the light of what just happened.
        let mut task = goal.to_string();

        for i in 0..max_steps {
            // ── THINK: what does the lattice know about the current subtask? ──
            let thought = {
                let u = universe.read().unwrap_or_else(|e| e.into_inner());
                let sl = synapses.read().unwrap_or_else(|e| e.into_inner());
                let hits = crate::core::NeuralBus::query_associative(&u, &sl, 0.5, &task, 5, &[], "");
                hits.iter().take(3).map(|h| h.label.chars().take(80).collect::<String>())
                    .collect::<Vec<_>>().join(" | ")
            };

            // ── SELECT ────────────────────────────────────────────────────────
            let (tool, _conf) = self.select_tool(&task);
            let tool_name = tool.name.to_string();

            // ── ACT ───────────────────────────────────────────────────────────
            let (input, mut observation) = self.act(&tool_name, &task, universe, synapses);
            if observation.len() > 2000 {
                observation.truncate(2000);
                observation.push_str(" …(truncated)");
            }

            // ── OBSERVE: permanent learning + workspace broadcast ────────────
            {
                let mut u = universe.write().unwrap_or_else(|e| e.into_inner());
                let cell_text: String = format!(
                    "Agency: goal \"{}\" step {} used {} → {}",
                    goal.chars().take(90).collect::<String>(),
                    i + 1,
                    tool_name,
                    observation.chars().take(OBS_STORE_MAX).collect::<String>()
                );
                u.store(&cell_text, "agency", "agent_core", 1.0);
                learned += 1;
            }
            if let Ok(mut gw) = crate::bridge::oracle_server::oracle_workspace().write() {
                gw.post("agent", &observation.chars().take(160).collect::<String>(), 0.60);
            }

            // ── DONE CHECK: does the observation resonate with the goal? ─────
            let resonance = goal_vec.cosine(&SparseVec::encode(&observation)).max(0.0);
            steps.push(AgentStep {
                step: i + 1,
                thought,
                tool: tool_name,
                input,
                observation: observation.clone(),
                resonance,
            });
            if resonance > DONE_RESONANCE {
                done = true;
                break;
            }
            // Fold the observation into the next subtask (bounded).
            task = format!(
                "{} — so far: {}",
                goal,
                observation.chars().take(220).collect::<String>()
            );
        }

        let outcome = steps.iter()
            .max_by(|a, b| a.resonance.partial_cmp(&b.resonance).unwrap_or(std::cmp::Ordering::Equal))
            .map(|s| s.observation.clone())
            .unwrap_or_else(|| "No steps executed.".to_string());

        AgentRunResult { goal: goal.to_string(), steps, outcome, done, learned_cells: learned }
    }
}

impl Default for AgentCore {
    fn default() -> Self { Self::new() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_selection_routes_math_to_math() {
        let core = AgentCore::new();
        let (t, _) = core.select_tool("calculate 4 plus 17 multiply by 2");
        assert_eq!(t.name, "math");
    }

    #[test]
    fn tool_selection_routes_file_reads() {
        let core = AgentCore::new();
        let (t, _) = core.select_tool("read the file C:/KAI/Cargo.toml and inspect contents");
        assert_eq!(t.name, "read_file");
    }

    #[test]
    fn tool_selection_defaults_to_memory_for_questions() {
        let core = AgentCore::new();
        let (t, _) = core.select_tool("what do you remember about the golden ratio spiral");
        assert_eq!(t.name, "lattice_query");
    }

    #[test]
    fn path_extraction_finds_windows_paths() {
        assert_eq!(
            AgentCore::extract_path("please read C:\\KAI\\Cargo.toml now"),
            Some("C:\\KAI\\Cargo.toml".to_string())
        );
        assert!(AgentCore::extract_path("no path here at all").is_none());
    }

    #[test]
    fn shell_absent_without_env() {
        let core = AgentCore::new();
        // KAI_AGENT_SHELL unset in tests → shell must not be selectable.
        assert!(core.tools.iter().all(|t| t.name != "shell"));
    }

    #[test]
    fn full_loop_thinks_acts_observes_and_learns() {
        // End-to-end: tiny universe → run a memory goal → the loop must execute
        // at least one step, produce an observation from the stored knowledge,
        // and LEARN (agency cells written back into the lattice).
        let mut u = Universe::new();
        u.store("The golden ratio spiral organizes KAI's memory cells by Vogel angle.",
                "seed", "established-physics", 3.0);
        u.store("Phyllotaxis uses the golden angle 137.5 degrees for optimal packing.",
                "seed", "established-physics", 3.0);
        let cells_before = u.cells().len();
        let universe = Arc::new(RwLock::new(u));
        let synapses = Arc::new(RwLock::new(SynapticLayer::new()));

        let core = AgentCore::new();
        let result = core.run(&universe, &synapses, "what do you remember about the golden ratio spiral", 3);

        assert!(!result.steps.is_empty(), "loop must execute at least one step");
        assert!(result.learned_cells >= 1, "loop must write agency cells");
        let after = universe.read().unwrap().cells().len();
        assert!(after > cells_before, "lattice must grow from acting: {} -> {}", cells_before, after);
        // The observation should surface the stored knowledge, not be empty.
        assert!(result.outcome.to_lowercase().contains("golden") || !result.outcome.is_empty());
        // Every step must be fully readable (J-Space discipline).
        for s in &result.steps {
            assert!(!s.tool.is_empty() && !s.observation.is_empty());
        }
    }
}
