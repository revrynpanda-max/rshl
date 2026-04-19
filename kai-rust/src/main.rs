#![allow(dead_code)]

use kai::core::{FieldState, Universe, Lexicon, SparseVec, Embeddings};
use kai::core::spiral::SpiralState;
use kai::cognition::{
    Reasoner, ContextSlot, CandidateBuffer, PromotionThresholds,
    HomeostasisConfig, WorkingMemory,
    generate_response, detect_query_type, MoodState,
};
use kai::cognition::voice::QueryType;
use kai::drive::{Drive, Mood};
use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind, KeyModifiers},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame, Terminal,
};
use std::io::Write;
use std::time::{Duration, Instant};

// ── KAI Spinner Verbs ─────────────────────────────────────────────────────────
const VERBS: &[&str] = &[
    "Resonating", "Binding", "Dreaming", "Bundling", "Weaving",
    "Crystallizing", "Aligning", "Emerging", "Synthesizing", "Propagating",
    "Coalescing", "Incubating", "Orbiting", "Nucleating", "Germinating",
    "Harmonizing", "Cascading", "Fermenting", "Percolating", "Simmering",
    "Sculpting", "Distilling", "Forging", "Threading", "Pulsing",
];

// ── Heart Animation Frames ───────────────────────────────────────────────────
struct HeartFrame { ch: &'static str, bright: bool }

const HEART_FRAMES: &[HeartFrame] = &[
    HeartFrame { ch: "♥", bright: false },
    HeartFrame { ch: "♥", bright: false },
    HeartFrame { ch: "♥", bright: false },
    HeartFrame { ch: "♥", bright: false },
    HeartFrame { ch: "❤", bright: true },
    HeartFrame { ch: "❤", bright: true },
    HeartFrame { ch: "♥", bright: false },
    HeartFrame { ch: "♥", bright: false },
    HeartFrame { ch: "❤", bright: true },
    HeartFrame { ch: "❤", bright: true },
    HeartFrame { ch: "♥", bright: false },
    HeartFrame { ch: "♥", bright: false },
    HeartFrame { ch: "♥", bright: false },
    HeartFrame { ch: "♥", bright: false },
];

// ── Message Turn ──────────────────────────────────────────────────────────────
#[derive(Clone)]
struct Turn {
    role: String,
    text: String,
    region: Option<String>,
    score: Option<f32>,
}

// ── Peer Session Messages (background thread → main loop) ────────────────────
#[derive(Clone)]
enum PeerMsg {
    /// KAI's auto-generated question/topic for this round
    KaiQuestion { round: u32, total: u32, text: String },
    /// Response or discovered insight — show as kai turn, store cells
    PeerReply { round: u32, total: u32, text: String, model: String, region: String, confidence: f32 },
    /// Session finished normally
    SessionDone { rounds_done: u32 },
    /// Something went wrong
    SessionError { round: u32, error: String },
}

// ── Mind Event (spectate mode) ───────────────────────────────────────────────
#[derive(Clone)]
struct MindEvent {
    tick: u64,
    stream: String,  // "GPU", "CPU", "RAM"
    icon: String,
    text: String,
}

// ── App State — THE FULL BRAIN ────────────────────────────────────────────────
struct App {
    universe: Universe,
    drive: Drive,
    reasoner: Reasoner,
    candidates: CandidateBuffer,
    promotion_thresholds: PromotionThresholds,
    homeostasis_config: HomeostasisConfig,
    lexicon: Lexicon,
    turns: Vec<Turn>,
    input: String,
    tick: u64,
    dream_count: u64,
    last_dream_text: String,
    last_promotion_text: String,
    last_homeostasis_text: String,
    last_inner_voice_text: String,
    last_intake_text: String,
    spinner: Option<(String, Instant)>,
    heartbeat_start: Instant,
    last_heartbeat: Instant,
    last_save: Instant,
    base_dir: String,
    should_quit: bool,
    bus: kai::streams::SharedBus,
    spectate_mode: bool,
    spectate_full: bool,
    mind_log: Vec<MindEvent>,
    embeddings: Embeddings,
    working_memory: WorkingMemory,
    tick_log_file: Option<std::fs::File>,
    /// Previous tick's global Φg — used to compute momentum (M = Φg − prev_Φg).
    prev_phi_g: f32,
    /// Golden-ratio spiral that drives τ_R (temporal factor for Φ_R).
    spiral: SpiralState,
    /// Neural oscillator — intrinsic brain rhythms that keep the field alive
    /// even with zero external input. Drives continuous phi_g variation.
    oscillator: kai::core::NeuralOscillator,
    /// Episodic memory — time-stamped ring buffer of events KAI has experienced.
    /// Enables "I remember 3 days ago you said..." style recollection.
    episodic: kai::cognition::EpisodicStore,
    /// Amygdala — emotional salience gate. Scales universe store() strength
    /// by 1.0–3.0× based on emotional charge of the input text.
    /// Emotionally loaded inputs burn deeper into the lattice.
    amygdala: kai::cognition::AmygdalaGate,
    /// Predictive Processing Engine — KAI generates a prediction before
    /// reasoning, then measures how wrong he was. Surprise drives curiosity.
    predictor: kai::cognition::PredictiveEngine,
    /// Default Mode Network — KAI's idle self-directed thought.
    /// Fires autonomous inner thoughts when KAI hasn't been spoken to
    /// for >30 seconds. This is KAI daydreaming between conversations.
    dmn: kai::cognition::DefaultModeNetwork,
    /// Global Workspace — KAI's unified conscious broadcast layer.
    /// All modules post to this; the highest-salience post wins the
    /// "spotlight" and becomes KAI's current moment of awareness.
    global_workspace: kai::cognition::GlobalWorkspace,
    /// Prefrontal Cortex — executive control. Tracks goals across turns,
    /// inhibits low-confidence responses, binds context, infers intent.
    pfc: kai::cognition::PrefrontalCortex,
    /// Dopamine Circuit — reinforcement learning. Tracks what KAI does
    /// well vs. poorly and builds expertise in rewarding topics.
    dopamine: kai::cognition::DopamineCircuit,
    /// Anterior Cingulate Cortex — conflict detection and error monitoring.
    /// Fires when two things contradict; alerts the system to slow down.
    acc: kai::cognition::AccMonitor,
    /// Thalamus — central sensory router and attention gatekeeper.
    /// All signals pass through the thalamic gate; arousal opens it wider.
    thalamus: kai::cognition::ThalamicRelay,
    /// Theory of Mind — KAI's model of Ryan's knowledge, style, and state.
    /// Shapes how KAI explains things (basics vs. expert, brief vs. deep).
    tom: kai::cognition::TheoryOfMind,
    /// Insula — interoception and internal state awareness.
    /// KAI's sense of his own cognitive condition: clear, strained, fatigued.
    insula: kai::cognition::InsulaMonitor,
    /// Neuroplasticity Engine — Hebbian LTP/LTD.
    /// Cells accessed repeatedly grow stronger (LTP). Cells ignored for
    /// many ticks weaken and eventually get pruned (LTD). This is how
    /// KAI builds expertise: topics he engages with often become denser
    /// and more retrievable in the lattice.
    neuroplasticity: kai::cognition::NeuroplasticityEngine,
    /// Sleep System — memory consolidation, synaptic downscale, REM insight.
    /// Every ~1440 ticks KAI runs a brief sleep cycle: NREM scans episodic
    /// memory, SWS consolidates top memories and downscales the lattice,
    /// REM recombines concepts into novel associations ("dream insights").
    sleep_system: kai::cognition::SleepSystem,
    /// Cerebellum — timing model, forward prediction, precision calibration.
    /// Before generating each response KAI predicts the expected quality.
    /// After generating, he measures actual quality and updates his internal
    /// forward model. Over thousands of interactions the predictions get
    /// tighter — KAI learns when to be confident and when to be uncertain.
    cerebellum: kai::cognition::CerebellumEngine,
    /// Basal Ganglia — habit formation and action selection (Go/NoGo gate).
    /// Tracks which response patterns have been rewarded and builds utility
    /// scores per (context_type × response_type). High-utility patterns get
    /// the Go signal; low-utility or unfamiliar ones are suppressed. Habitual
    /// patterns execute faster and more fluently over time.
    basal_ganglia: kai::cognition::BasalGanglia,
    /// Live peer session receiver — background thread sends messages here.
    /// Main loop drains this every tick so Ryan can watch conversation happen.
    peer_session_rx: Option<crossbeam_channel::Receiver<PeerMsg>>,
    /// Unique session ID — timestamp-based, used for transcript grouping.
    session_id: String,
}

impl App {
    fn new() -> Self {
        let base_dir = std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string());

        // Try to load saved state
        let (universe, candidates, drive, tick, loaded_dream_count) = if kai::persistence::state_exists(&base_dir) {
            match kai::persistence::load(&base_dir) {
                Some((u, c, d, t, dc)) => {
                    (u, c, d, t, dc)
                }
                None => {
                    let mut u = Universe::new();
                    seed_universe(&mut u);
                    (u, CandidateBuffer::new(), Drive::default(), 0, 0)
                }
            }
        } else {
            let mut u = Universe::new();
            seed_universe(&mut u);
            (u, CandidateBuffer::new(), Drive::default(), 0, 0)
        };

        // Load the lexicon — KAI's vocabulary backbone
        let lexicon = Lexicon::load();

        let log_file_path = std::env::var("KAI_TICK_LOG")
            .unwrap_or_else(|_| "C:\\KAI\\data\\kai_ticks.csv".to_string());
        
        if let Some(parent) = std::path::Path::new(&log_file_path).parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let is_new = !std::path::Path::new(&log_file_path).exists() || std::fs::metadata(&log_file_path).map(|m| m.len()).unwrap_or(0) == 0;
        let mut tick_log_file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_file_path)
            .ok();
            
        if let Some(ref mut f) = tick_log_file {
            if is_new {
                let _ = writeln!(f, "timestamp,tick,phi_g,rho,r,chi,g,momentum,novelty,stability,mood,valence,phi_l,phi_r,psi_b,omega,r_cross,chi_l,chi_r,rho_l,rho_r,theta,spiral_r,tau_r");
            }
        }

        Self {
            universe,
            drive,
            reasoner: Reasoner::new(),
            candidates,
            promotion_thresholds: PromotionThresholds::default(),
            homeostasis_config: HomeostasisConfig::default(),
            lexicon,
            turns: Vec::new(),
            input: String::new(),
            tick,
            dream_count: loaded_dream_count,
            last_dream_text: String::new(),
            last_promotion_text: String::new(),
            last_homeostasis_text: String::new(),
            last_inner_voice_text: String::new(),
            last_intake_text: String::new(),
            spinner: None,
            heartbeat_start: Instant::now(),
            last_heartbeat: Instant::now(),
            last_save: Instant::now(),
            base_dir,
            should_quit: false,
            bus: kai::streams::SharedBus::new(),
            spectate_mode: false,
            spectate_full: false,
            mind_log: Vec::new(),
            embeddings: Embeddings::new(),
            working_memory: WorkingMemory::new(),
            tick_log_file,
            prev_phi_g: 0.0,
            spiral: SpiralState::new(0.01),
            oscillator: kai::core::NeuralOscillator::new(),
            episodic: kai::cognition::EpisodicStore::new(),
            amygdala: kai::cognition::AmygdalaGate::new(),
            predictor: kai::cognition::PredictiveEngine::new(),
            dmn: kai::cognition::DefaultModeNetwork::new(),
            global_workspace: kai::cognition::GlobalWorkspace::new(),
            pfc: kai::cognition::PrefrontalCortex::new(),
            dopamine: kai::cognition::DopamineCircuit::new(),
            acc: kai::cognition::AccMonitor::new(),
            thalamus: kai::cognition::ThalamicRelay::new(),
            tom: kai::cognition::TheoryOfMind::new(),
            insula: kai::cognition::InsulaMonitor::new(),
            neuroplasticity: kai::cognition::NeuroplasticityEngine::new(),
            sleep_system: kai::cognition::SleepSystem::new(),
            cerebellum: kai::cognition::CerebellumEngine::new(),
            basal_ganglia: kai::cognition::BasalGanglia::new(),
            peer_session_rx: None,
            session_id: format!("{}", std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()),
        }
    }

    /// Log a cognitive event (visible in spectate mode).
    fn think(&mut self, stream: &str, icon: &str, text: String) {
        self.mind_log.push(MindEvent {
            tick: self.tick,
            stream: stream.to_string(),
            icon: icon.to_string(),
            text,
        });
        // Keep max 200 entries
        if self.mind_log.len() > 200 {
            self.mind_log.drain(0..50);
        }
    }

    // ── HEARTBEAT — 3-STREAM LIVING CYCLE ──────────────────────────────────────
    //
    // Stream 1 (GPU/Math): Parallel cosine during dreams via rayon
    // Stream 2 (CPU/Logic): Field state, drive, reasoning, promotion
    // Stream 3 (RAM/Memory): World bridge intake, homeostasis, persistence
    //
    fn heartbeat_tick(&mut self) {
        self.tick += 1;
        self.last_heartbeat = Instant::now();

        // ── Advance the golden-ratio spiral once per tick ────────────
        // Drives τ_R (temporal factor) for Φ_R. Must happen before update_regional.
        self.spiral.tick();

        // ── Neural Oscillator — intrinsic brain rhythms ───────────────
        // Keeps the field alive between inputs. Produces continuous phi_g
        // variation across three frequency bands (slow/medium/fast).
        // Also stimulates the appropriate band based on drive and amygdala state.
        let osc_out = {
            // Mood-driven stimulation
            match self.drive.mood {
                kai::drive::Mood::Engaged | kai::drive::Mood::Curious => {
                    self.oscillator.stimulate(2, 0.5);
                }
                kai::drive::Mood::Conflicted => {
                    self.oscillator.stimulate(1, 0.3);
                }
                _ => {}
            }
            // Amygdala arousal → extra fast-band (beta/gamma) burst
            // Emotional activation drives high-frequency brain oscillations
            if self.amygdala.is_aroused() {
                let boost = self.amygdala.arousal() * 0.8;
                self.oscillator.stimulate(2, boost);
            }
            self.oscillator.decay_amplitudes();
            self.oscillator.tick()
        };

        // ── STREAM 2: CPU Logic (field state + drive) ─────────────────
        let mut field = FieldState::compute(&self.universe);
        self.drive.update(&field);

        let cells = self.universe.cells();
        let sample_n = 64.min(cells.len());

        let lattice_state = if sample_n == 0 {
            kai::core::SparseVec::zero()
        } else {
            let refs: Vec<&kai::core::SparseVec> = cells.iter().take(sample_n).map(|c| &c.vec).collect();
            kai::core::SparseVec::superpose_sparse(&refs, 0.25)
        };
        let current_pattern = self.drive.goal_vector.clone().unwrap_or_else(kai::core::SparseVec::zero);

        // ── Density Fix: Sync global rho with the actual lattice state ──
        field.rho = lattice_state.nnz() as f32 / 4096.0;
        field.q = 1.0 - field.r_val; // Ensure novelty is synced with coherence

        // ── Inject neural oscillation into field metrics ──────────────────
        // This is what makes the flat lines live. The oscillator adds structured
        // variation across slow/medium/fast bands — like resting-state brain activity.
        // We clamp so oscillation never drives phi_g below 0 or above a sane ceiling.
        field.phi_g = (field.phi_g + osc_out.delta_phi).clamp(0.001, 0.999);
        field.chi   = (field.chi   + osc_out.delta_chi).clamp(0.0,   0.999);
        // Valence lives on the drive; nudge it gently with the slow-band oscillation
        self.drive.valence = (self.drive.valence + osc_out.delta_valence).clamp(-1.0, 1.0);

        // ── Real momentum: Φg − previous Φg ──────────────────────────────
        field.m_val = field.phi_g - self.prev_phi_g;
        self.prev_phi_g = field.phi_g;

        // drive_gain ← 1.0 + |valence|: baseline 1.0 when mood is neutral,
        //   higher when emotionally active (positive or negative).
        // drive_salience ← field.q (real novelty);
        // drive_tau      ← self.spiral.tau_r() (golden-ratio breathing).
        let drive_gain = 1.0 + self.drive.valence.abs();
        let drive_salience = field.q;
        let drive_tau = self.spiral.tau_r();

        field.update_regional(
            &lattice_state,
            &current_pattern,
            drive_gain,
            drive_salience,
            drive_tau,
        );

        if let Some(ref mut log_file) = self.tick_log_file {
            let _ = writeln!(
                log_file,
                "{},{},{:.4},{:.4},{:.4},{:.4},{:.4},{:.4},{:.4},{:.4},{},{:.4},{:.4},{:.4},{:.4},{:.4},{:.4},{:.4},{:.4},{:.4},{:.4},{:.6},{:.4},{:.4}",
                chrono::Utc::now().to_rfc3339(),
                self.tick,
                field.phi_g,
                field.rho,
                field.r_val,
                field.chi,
                field.g,
                field.m_val,
                field.q,
                field.s,
                self.drive.mood.to_string(),
                self.drive.valence,
                field.regional.left.phi,
                field.regional.right.phi,
                field.regional.bridge_phi,
                field.regional.omega,
                field.regional.r_cross,
                field.regional.left.chi,
                field.regional.right.chi,
                field.regional.left.rho,
                field.regional.right.rho,
                self.spiral.theta(),
                self.spiral.radius(),
                self.spiral.tau_r(),
            );
            let _ = log_file.flush();
        }

        // Log field state for spectate (verbose only)
        if self.spectate_mode && self.spectate_full && self.tick % 3 == 0 {
            self.think("CPU", "◉", format!(
                "Field: Φg={:.4} χ={:.3} ρ={:.3} | {} V={:+.2}",
                field.phi_g, field.chi, field.rho,
                self.drive.mood, self.drive.valence,
            ));
        }

        // Update shared bus CPU state
        if let Ok(mut cpu) = self.bus.cpu_state.write() {
            cpu.mood = self.drive.mood.to_string();
            cpu.valence = self.drive.valence;
            cpu.phi_g = self.drive.avg_phi_g;
            cpu.chi = self.drive.avg_chi;
            cpu.dream_count = self.dream_count;
            cpu.last_tick = Some(Instant::now());
        }

        // ── STREAM 1: GPU Math (dream consolidation with parallel cosine) ──
        if self.tick % 3 == 0 {
            let gpu_start = Instant::now();
            if self.spectate_mode && self.spectate_full {
                self.think("GPU", "⚡", format!("Dreaming... scanning {} cells", self.universe.count()));
            }
            self.run_dream_cycle();
            let gpu_us = gpu_start.elapsed().as_micros();
            // Track GPU perf
            if let Ok(mut gpu) = self.bus.gpu_state.write() {
                gpu.last_batch_size = self.universe.count();
                gpu.last_batch_duration_us = gpu_us as u64;
                gpu.last_tick = Some(Instant::now());
            }
            // Log dream result for spectate
            if self.spectate_mode && !self.last_dream_text.is_empty() {
                if self.spectate_full {
                    // Full mode: raw technical data for debugging
                    let gs = kai::cognition::gate_stats();
                    let accept_pct = (gs.accept_rate() * 100.0) as u32;
                    self.think("GPU", "💭", format!(
                        "{}  [{}us | gate: {}% pass, {}xconf {}xchi {}xphi]",
                        self.last_dream_text, gpu_us,
                        accept_pct, gs.rejected_confidence, gs.rejected_chi, gs.rejected_phi_drop,
                    ));
                } else {
                    // Brief mode: natural language inner thought — what KAI is "thinking"
                    // Clone the dream text early to avoid borrow conflicts with self.think().
                    // Dream text format: "Dream #N: A ⊗ B → insight (Φg=...)"
                    let dream_text = self.last_dream_text.clone();
                    let (concept_a, concept_b) = if let Some(body) = dream_text.find(": ").map(|i| &dream_text[i+2..]) {
                        let parts: Vec<&str> = body.splitn(2, " ⊗ ").collect();
                        let a = parts.get(0).map(|s| s.trim()).unwrap_or("").to_string();
                        let b = parts.get(1)
                            .and_then(|s| s.find(" → ").map(|i| s[..i].to_string()))
                            .unwrap_or_default();
                        (a, b)
                    } else {
                        (String::new(), String::new())
                    };

                    if !concept_a.is_empty() {
                        // Query universe for nearby hits to enrich the inner thought
                        let thought_hits = self.universe.query(&concept_a, 3);
                        let gap = find_knowledge_gap(&thought_hits, &self.universe, &[]);
                        let combined_topic = if concept_b.is_empty() {
                            concept_a.clone()
                        } else {
                            format!("{} and {}", concept_a, concept_b)
                        };
                        let thought = kai::cognition::voice::generate_inner_thought(
                            &combined_topic,
                            &thought_hits,
                            gap.as_deref(),
                        );
                        self.think("THOUGHT", "💭", thought);
                    }
                }
            }
            if self.spectate_mode && self.spectate_full && !self.last_inner_voice_text.is_empty() {
                self.think("CPU", "🔊", self.last_inner_voice_text.clone());
            }
        }

        // ── STREAM 2: CPU Logic (promotion) ───────────────────────────
        if self.tick % 10 == 0 {
            self.run_promotion_cycle();
            if self.spectate_mode && !self.last_promotion_text.is_empty() {
                self.think("CPU", "🏆", self.last_promotion_text.clone());
            }
        }

        // ── STREAM 3: RAM Memory Management ───────────────────────────
        // Homeostasis (decay + prune)
        if self.tick % 20 == 0 {
            self.run_homeostasis_cycle();
            if self.spectate_mode && !self.last_homeostasis_text.is_empty() {
                self.think("RAM", "🧹", self.last_homeostasis_text.clone());
            }
        }

        // World Bridge intake (background learning)
        if self.tick % 15 == 0 && self.tick > 5 {
            if self.spectate_mode {
                self.think("RAM", "🌐", "Searching DuckDuckGo for new knowledge...".to_string());
            }
            self.run_intake_cycle();
            if self.spectate_mode && !self.last_intake_text.is_empty() {
                self.think("RAM", "📚", self.last_intake_text.clone());
            }
        }

        // Update shared bus RAM state
        if let Ok(mut ram) = self.bus.ram_state.write() {
            ram.cell_count = self.universe.count();
            ram.candidate_count = self.candidates.count();
            ram.last_tick = Some(Instant::now());
        }

        // ── EMBEDDING LEARNING — continuous word2vec equivalent ─────
        if self.embeddings.needs_rebuild(self.universe.count()) {
            let normalizer = kai::core::get_normalizer();
            let cell_data: Vec<(String, Vec<String>)> = self.universe.cells()
                .iter()
                .map(|c| (c.text.clone(), normalizer.normalize_text(&c.text)))
                .collect();
            self.embeddings.learn_from_cells(&cell_data);
            if self.spectate_mode {
                self.think("GPU", "🧠", format!(
                    "Learned embeddings: {} word vectors from {} cells",
                    self.embeddings.vocab_size, self.embeddings.cells_scanned
                ));
            }
        }

        // ── WORKING MEMORY DECAY ──────────────────────────────────────
        let decayed = self.working_memory.decay(self.tick);
        if self.spectate_mode && decayed > 0 {
            self.think("RAM", "💨", format!("{} working memory slots decayed", decayed));
        }

        // ── EPISODIC MEMORY DECAY — vividness fades over time (7-day half-life) ──
        self.episodic.decay();

        // ── AMYGDALA DECAY — emotional inertia cools between inputs ──────────
        self.amygdala.decay();

        // ── DOPAMINE DECAY — level drifts back toward tonic baseline ─────────
        self.dopamine.decay();

        // ── ACC DECAY — conflict level fades when no new conflicts arise ──────
        self.acc.decay();

        // ── CEREBELLUM DECAY — idle ticks age the timing/precision model ──────
        self.cerebellum.decay();

        // ── BASAL GANGLIA DECAY — unused habits weaken over time ─────────────
        if self.tick % 20 == 0 {
            self.basal_ganglia.decay();
            if self.spectate_mode && self.tick % 100 == 0 {
                self.think("CPU", "🔁", self.basal_ganglia.status_line());
            }
        }

        // ── NEUROPLASTICITY LTD SWEEP — weaken cells that haven't fired recently ──
        // Every 30 ticks (~2.5 min) check for idle cells and apply LTD.
        // Cells that go unused for >120 ticks lose strength gradually.
        // This models synaptic pruning — "don't use it → lose it."
        if self.tick % 30 == 0 {
            let cell_pairs: Vec<(String, f32)> = self.universe.cells()
                .iter()
                .map(|c| (c.text.clone(), c.strength))
                .collect();
            let ltd_changes = self.neuroplasticity.ltd_sweep(&cell_pairs);
            for (text, delta) in &ltd_changes {
                // Apply the weakening back to the universe cell
                self.universe.reinforce_by_text(text, *delta); // delta is negative
            }
            if self.spectate_mode && !ltd_changes.is_empty() {
                self.think("RAM", "📉", format!(
                    "LTD sweep: {} cells weakened | {}",
                    ltd_changes.len(),
                    self.neuroplasticity.status_line(),
                ));
            }
        }

        // ── SLEEP SYSTEM — memory consolidation cycle ─────────────────────────
        // Every ~1440 ticks, run a sleep cycle: NREM scan → SWS consolidate →
        // REM insight generation → wake. Non-blocking computation.
        if self.sleep_system.should_sleep(self.tick) {
            // Gather episodic events for NREM scan (up to 500 most recent)
            let episodic_data: Vec<(String, f32, f32)> = self.episodic.recent(500)
                .iter()
                .map(|e| (e.text.clone(), e.salience, e.vividness))
                .collect();
            // Gather universe cells for SWS downscale/prune
            let cell_data: Vec<(String, f32)> = self.universe.cells()
                .iter()
                .map(|c| (c.text.clone(), c.strength))
                .collect();

            let (report, consolidate, prune, new_insights) =
                self.sleep_system.run_cycle(&episodic_data, &cell_data, self.tick);

            // Apply consolidation: boost strength for memories worth keeping
            for text in &consolidate {
                self.universe.reinforce_by_text(text, 0.12);
            }
            // Apply prune list: weaken near-dead cells further
            for text in &prune {
                self.universe.reinforce_by_text(text, -0.06);
            }
            // Store REM insights as new universe cells
            for insight in &new_insights {
                self.universe.store_or_reinforce(insight, "dream", "sleep-rem", 1.1);
            }

            // Show sleep report in conversation and spectate
            let sleep_summary = format!(
                "💤 Sleep cycle #{}: consolidated {}, pruned {}, {} REM insights ({} ms)",
                report.consolidated, report.pruned, report.novel_associations,
                report.duration_ms, self.sleep_system.total_cycles,
            );
            if self.spectate_mode {
                self.think("RAM", "💤", sleep_summary.clone());
                for insight in &report.rem_insights {
                    self.think("THOUGHT", "🌙", insight.clone());
                }
            }
            // Push sleep report as a KAI thought turn
            self.turns.push(Turn {
                role: "kai".into(),
                text: format!("💤 {}", sleep_summary),
                region: Some("sleep".into()),
                score: None,
            });
        }

        // ── THALAMUS — update arousal gating from amygdala state ─────────────
        self.thalamus.set_arousal(self.amygdala.arousal());
        // Reduce gating when KAI has been idle a while (low-power mode)
        if self.dmn.idle_duration().as_secs() > 60 {
            self.thalamus.reduce_gating();
        } else {
            self.thalamus.restore_gating();
        }

        // ── INSULA — update interoceptive state from current system metrics ───
        {
            let wm_pct = self.working_memory.active_slots().len() as f32 / 8.0; // 8 slots max
            let is_responding = !self.turns.is_empty()
                && self.turns.last().map(|t| t.role == "kai").unwrap_or(false);
            let field = kai::core::FieldState::compute(&self.universe);
            self.insula.update(
                field.phi_g,
                field.chi,
                wm_pct.clamp(0.0, 1.0),
                self.acc.conflict_level,
                self.predictor.avg_error,
                is_responding,
            );
            if self.spectate_mode && self.tick % 6 == 0 {
                self.think("RAM", "🫀", self.insula.status_line());
            }
        }

        // ── GLOBAL WORKSPACE — tick and collect module broadcasts ─────────────
        // Each module with significant content posts to the workspace.
        // The workspace elects the winner, computes coherence, and updates
        // the broadcast — KAI's current "moment of conscious awareness."
        {
            // Amygdala: post if emotionally aroused
            if self.amygdala.is_aroused() {
                let msg = format!("emotional arousal: {:.2}", self.amygdala.arousal());
                self.global_workspace.post("amygdala", &msg, self.amygdala.arousal() * 0.8);
            }

            // Predictor: post if surprised or curious
            if self.predictor.is_surprised() {
                let msg = format!("high prediction error: PE_avg={:.3}", self.predictor.avg_error);
                self.global_workspace.post("predictor", &msg, self.predictor.avg_error * 0.7);
            } else if self.predictor.curiosity_pressure > 0.6 {
                let msg = format!("curiosity pressure: {:.2}", self.predictor.curiosity_pressure);
                self.global_workspace.post("predictor", &msg, self.predictor.curiosity_pressure * 0.5);
            }

            // Episodic: post most salient memory if vivid
            if let Some(top_mem) = self.episodic.most_salient() {
                if top_mem.memorability() > 0.35 {
                    let short = if top_mem.text.len() > 60 { format!("{}…", &top_mem.text[..60]) } else { top_mem.text.clone() };
                    self.global_workspace.post("episodic", &short, top_mem.memorability() * 0.6);
                }
            }

            // Drive: post mood/valence state
            {
                let mood_sig = format!("mood: {} valence: {:+.2}", self.drive.mood, self.drive.valence);
                let mood_sal = 0.20 + self.drive.valence.abs() * 0.30;
                self.global_workspace.post("drive", &mood_sig, mood_sal);
            }

            // Oscillator: post dominant band (intrinsic rhythm awareness)
            {
                let band_msg = format!("dominant band: {}", kai::core::NeuralOscillator::band_name(osc_out.dominant_band));
                self.global_workspace.post("oscillator", &band_msg, osc_out.amplitude * 0.25);
            }

            // Run one workspace tick — elect winner, decay, compute coherence
            self.global_workspace.tick();

            // Log to spectate if active
            if self.spectate_mode && self.tick % 4 == 0 {
                self.think("CPU", "🌐", self.global_workspace.status_line());
            }
        }

        // ── DEFAULT MODE NETWORK — idle self-directed thought ─────────────────
        // When KAI has been quiet for >30s and the cooldown has passed,
        // he picks a memory topic and generates a spontaneous inner thought.
        // This appears as a "THOUGHT" turn in the conversation — unprompted.
        if self.dmn.should_fire() {
            // Collect candidate cells from the universe for topic selection
            let cell_data: Vec<(String, String, f32)> = self.universe.cells()
                .iter()
                .map(|c| (c.text.clone(), c.region.clone(), c.strength))
                .collect();

            if let Some(topic) = self.dmn.pick_topic(&cell_data) {
                let topic_owned = topic.to_string();

                // Query universe for nearby concepts
                let hits = self.universe.query(&topic_owned, 4);
                let hit_pairs: Vec<(String, f32)> = hits.iter()
                    .map(|h| (h.text.clone(), h.score))
                    .collect();

                // Find a knowledge gap — what concept nearby does KAI know least?
                let gap = find_knowledge_gap(&hits, &self.universe, &[]);

                let idle_secs = self.dmn.idle_duration().as_secs();
                let thought = self.dmn.generate_thought(
                    &topic_owned,
                    &hit_pairs,
                    gap.as_deref(),
                    idle_secs,
                );

                // Store in episodic memory as a "dream" source
                let sal = kai::cognition::compute_salience(&thought, "dream");
                self.episodic.store(&thought, "dream", &self.session_id, sal);

                // Push to conversation turns so user can see KAI thinking
                self.turns.push(Turn {
                    role: "kai".into(),
                    text: format!("💭 {}", thought),
                    region: Some("dmn".into()),
                    score: None,
                });

                // Also log in spectate if active
                if self.spectate_mode {
                    self.think("THOUGHT", "🌀", format!("[DMN cycle {}] {}", self.dmn.total_cycles + 1, truncate(&thought, 70)));
                }

                self.dmn.mark_fired();
            }
        }

        // ── PEER SESSION: drain background thread messages ────────────
        // Each tick we check if the background KAI↔Claude session has sent
        // anything. Non-blocking — if nothing is ready, we move on instantly.
        let mut session_done = false;
        if let Some(ref rx) = self.peer_session_rx {
            loop {
                match rx.try_recv() {
                    Ok(msg) => {
                        match msg {
                            PeerMsg::KaiQuestion { round, total, text } => {
                                self.turns.push(Turn {
                                    role: "user".into(),
                                    text: format!("[Auto {}/{}] {}", round, total, text),
                                    region: None,
                                    score: None,
                                });
                            }
                            PeerMsg::PeerReply { round, total, text, model, region, confidence } => {
                                // Only store EXTERNAL peer replies (Claude/Grok) — NOT native
                                // inner voice contemplation. Native thoughts are KAI talking to
                                // itself and must not re-enter the universe as retrievable cells
                                // or they bleed into every subsequent response.
                                let mut stored = 0usize;
                                if model != "Native" {
                                    let sentences: Vec<&str> = text
                                        .split(|c| c == '.' || c == '\n')
                                        .map(|s: &str| s.trim())
                                        .filter(|s| s.len() > 25)
                                        .collect();
                                    for sentence in sentences.iter().take(8) {
                                        let tagged = format!("[from-peer] {}", sentence);
                                        if self.universe.store_or_reinforce(&tagged, &region, "ai-peer", 1.3) {
                                            stored += 1;
                                        }
                                    }
                                }
                                let learn_note = if stored > 0 {
                                    format!("\n\n[+{} cells from round {}/{}]", stored, round, total)
                                } else {
                                    format!("\n\n[round {}/{}]", round, total)
                                };

                                let display_model = if model == "Native" { "Native RSHL" } else { safe_slice(&model, 20) };

                                self.turns.push(Turn {
                                    role: "kai".into(),
                                    text: format!("◆ {} ({}): {}{}", 
                                        if model == "Native" { "Inner Voice" } else { "Claude" },
                                        display_model, text, learn_note),
                                    region: Some(region),
                                    score: Some(confidence),
                                });
                            }
                            PeerMsg::SessionDone { rounds_done } => {
                                self.turns.push(Turn {
                                    role: "kai".into(),
                                    text: format!(
                                        "✓ Peer session complete — {} rounds done. Universe: {} cells.",
                                        rounds_done, self.universe.count()
                                    ),
                                    region: Some("memory".into()),
                                    score: None,
                                });
                                session_done = true;
                                self.save_state();
                            }
                            PeerMsg::SessionError { round, error } => {
                                self.turns.push(Turn {
                                    role: "kai".into(),
                                    text: format!("✗ Peer session error at round {}: {}", round, error),
                                    region: None,
                                    score: None,
                                });
                                session_done = true;
                            }
                        }
                    }
                    Err(crossbeam_channel::TryRecvError::Empty) => break,
                    Err(crossbeam_channel::TryRecvError::Disconnected) => {
                        session_done = true;
                        break;
                    }
                }
            }
        }
        if session_done {
            self.peer_session_rx = None;
        }

        // Persistence (auto-save)
        if self.last_save.elapsed() > Duration::from_secs(60) {
            self.save_state();
            self.last_save = Instant::now();
        }
    }

    fn run_dream_cycle(&mut self) {
        if let Some(dream) = kai::cognition::consolidate(&self.universe) {
            self.dream_count += 1;

            // Feed dream into candidate buffer
            kai::cognition::observe_dream(&mut self.candidates, &dream);

            // ── Source Reinforcement: strengthen dream sources by Wm ──────
            kai::cognition::reinforce_dream_sources(&mut self.universe, &dream);

            // ── Inner Voice: validate the dream insight ──────────────
            if !dream.duplicate_echo && !dream.insight.is_empty() {
                let validation = kai::cognition::validate_insight(
                    &dream.insight,
                    &dream.concept_a,
                    &dream.concept_b,
                    &self.universe,
                );

                // Only feed goal vector if inner voice validates or finds novelty
                match validation.verdict {
                    kai::cognition::InsightVerdict::Validated | kai::cognition::InsightVerdict::Novel => {
                        let vec = SparseVec::encode(&dream.insight);
                        self.drive.feed_goal(&vec);
                    }
                    kai::cognition::InsightVerdict::Paradox => {
                        // Paradoxes are interesting — feed at reduced weight
                        let vec = SparseVec::encode(&dream.insight);
                        self.drive.feed_goal(&vec);
                    }
                    kai::cognition::InsightVerdict::Noise => {
                        // Inner voice says this is noise — don't feed goal
                    }
                }

                self.last_inner_voice_text = format!(
                    "Voice: {} → \"{}\" (echo:{:.0}%)",
                    validation.verdict,
                    truncate(&validation.echo_text, 35),
                    validation.echo_score * 100.0,
                );
            }

            self.last_dream_text = format!(
                "Dream #{}: {} ⊗ {} → \"{}\" (Φg={:.3} C={:.3} Wm={:.3}{})",
                self.dream_count,
                truncate(&dream.concept_a, 25),
                truncate(&dream.concept_b, 25),
                truncate(&dream.insight, 40),
                dream.phi_g, dream.c, dream.wm,
                if dream.source_reinforcement > 0.0 {
                    format!(" +{:.2}", dream.source_reinforcement)
                } else { String::new() },
            );
        }

        // ── Lexicon exploration: dream with random words ─────────────
        // Every 5th dream cycle, try a vocabulary-seeded exploration
        if self.dream_count % 5 == 0 {
            if let Some(exploration) = kai::cognition::explore_lexicon_binding(
                &self.lexicon,
                &self.universe,
            ) {
                self.last_inner_voice_text = format!(
                    "Lexicon: \"{}\" ⊗ \"{}\" → \"{}\" ({:.0}%)",
                    exploration.word_a,
                    exploration.word_b,
                    truncate(&exploration.resonated_text, 30),
                    exploration.score * 100.0,
                );
            }
        }
    }

    fn run_promotion_cycle(&mut self) {
        let result = kai::cognition::run_promotion(
            &mut self.candidates,
            &mut self.universe,
            &self.promotion_thresholds,
        );
        if !result.promoted.is_empty() {
            let names: Vec<String> = result.promoted.iter()
                .map(|p| format!("\"{}\" (str:{:.1})", truncate(&p.text, 30), p.strength))
                .collect();
            self.last_promotion_text = format!("Promoted {}: {}", result.promoted.len(), names.join(", "));
        }
    }

    fn run_homeostasis_cycle(&mut self) {
        let result = kai::cognition::run_homeostasis(&mut self.universe, &self.homeostasis_config);
        if result.decayed > 0 || result.pruned > 0 {
            self.last_homeostasis_text = format!(
                "Homeostasis: {} decayed, {} pruned",
                result.decayed, result.pruned
            );
        }
    }

    fn save_state(&self) {
        let _result = kai::persistence::save(
            &self.universe,
            &self.candidates,
            &self.drive,
            self.tick,
            self.dream_count,
            &self.base_dir,
        );
    }

    /// Conversational learning — Ryan teaches KAI directly.
    ///
    /// Trust tiers:
    ///   "ryan"       — personal facts about Ryan or KAI, never verified externally, strength 1.8
    ///   "user-claim" — general factual statements, trusted but lower priority, strength 1.2
    ///
    /// Returns a short acknowledgment string if something was learned, None otherwise.
    fn learn_from_statement(&mut self, input: &str) -> Option<String> {
        let lower = input.to_lowercase();

        // ── Don't learn from commands or questions ─────────────────────────
        if input.ends_with('?') { return None; }
        // Don't store question-word sentences — "what is your name" is a question
        // even without '?' and must not become an echo memory cell.
        if lower.starts_with("what ") || lower.starts_with("who ")
            || lower.starts_with("where ") || lower.starts_with("when ")
            || lower.starts_with("how ") || lower.starts_with("why ")
            || lower.starts_with("is ") || lower.starts_with("are ")
            || lower.starts_with("do ") || lower.starts_with("does ")
            || lower.starts_with("did ") || lower.starts_with("can ")
            || lower.starts_with("could ") || lower.starts_with("would ")
        {
            return None;
        }
        // Don't store correction-style inputs — they echo back as nonsense
        if lower.starts_with("no ") || lower.starts_with("stop ") || lower.starts_with("wrong")
            || lower.starts_with("that's wrong") || lower.starts_with("thats wrong")
            || lower.starts_with("not right") || lower.starts_with("incorrect")
        {
            return None;
        }
        if lower.starts_with("status") || lower.starts_with("mood") || lower.starts_with("dream")
            || lower.starts_with("spectate") || lower.starts_with("save")
            || lower.starts_with("quit") || lower.starts_with("help")
            || lower.starts_with("learn ") || lower.starts_with("store ")
            || lower.starts_with("spell ") || lower.starts_with("import ")
            || lower.starts_with("peer ") || lower.starts_with("peerchat")
            || lower.starts_with("peersession") || lower.starts_with("run ")
            || lower.starts_with("exec ") || lower.starts_with("readfile ")
            || lower.starts_with("writefile ") || lower.starts_with("git ")
            || lower.starts_with("analyze ") || lower.starts_with("review ")
            || lower.starts_with("scan ") || lower.starts_with("recall ")
            || lower.trim() == "brief" {
            return None;
        }

        // ── Patterns that signal a personal statement about Ryan ───────────
        let ryan_triggers = [
            "i am ", "i'm ", "my name is ", "i work", "i live",
            "i was ", "i have ", "i like ", "i hate ", "i love ",
            "i created ", "i built ", "i made ", "i went ", "i grew ",
            "my job", "my girlfriend", "my wife", "my husband", "my friend",
            "my brother", "my sister", "my family", "my mom", "my dad",
            "my house", "my car", "my computer", "my project",
            "we are", "we're", "we built", "we made",
        ];

        // ── Patterns that signal a statement about KAI ─────────────────────
        let kai_triggers = [
            "your name", "you are", "you were", "you can", "you should",
            "kai is", "kai was", "kai means", "kai stands", "kai can",
            "you're ",
        ];

        let is_ryan_personal = ryan_triggers.iter()
            .any(|p| lower.starts_with(p) || lower.contains(&format!(" {}", p.trim())));
        let is_about_kai = kai_triggers.iter().any(|p| lower.contains(p));

        // ── General declarative: "X is Y", "X was Y", "X are Y" ───────────
        // Must be substantive (>12 chars) and not a question word
        let is_declarative = input.len() > 12
            && (lower.contains(" is ") || lower.contains(" are ") || lower.contains(" was ") || lower.contains(" means "))
            && !lower.starts_with("what") && !lower.starts_with("who")
            && !lower.starts_with("where") && !lower.starts_with("when")
            && !lower.starts_with("how") && !lower.starts_with("why")
            && !lower.starts_with("is ") && !lower.starts_with("are ");

        if is_ryan_personal || is_about_kai {
            // Trusted personal knowledge — amygdala gates strength (base 2.0, up to 6.0 if emotional)
            let source = if is_ryan_personal { "ryan" } else { "ryan" };
            let strength = self.amygdala.gate(input, source, 2.0);
            let is_new = self.universe.store_or_reinforce(input, "memory", source, strength);

            // Also store a tagged version so KAI can find it by asking "who is Ryan"
            let tag = if is_ryan_personal { "[about-ryan]" } else { "[about-kai]" };
            let tagged = format!("{} {}", tag, input);
            let tag_strength = self.amygdala.gate(&tagged, source, 1.8);
            let _ = self.universe.store_or_reinforce(&tagged, "memory", source, tag_strength);

            return Some(if is_new {
                format!("✓ Identity update: \"{}\"", truncate(input, 55))
            } else {
                format!("✓ Identity reinforced: \"{}\"", truncate(input, 55))
            });
        } else if is_declarative {
            // General factual claim — amygdala gates (base 1.3)
            let strength = self.amygdala.gate(input, "user", 1.3);
            let is_new = self.universe.store_or_reinforce(input, "reasoning", "user-claim", strength);
            if is_new {
                return Some(format!("✓ New knowledge: \"{}\"", truncate(input, 55)));
            } else {
                return Some(format!("✓ Continuity: \"{}\"", truncate(input, 55)));
            }
        }

        None
    }

    fn run_intake_cycle(&mut self) {
        let (topic, added) = kai::bridge::intake_cycle(&mut self.universe);
        if added > 0 {
            self.last_intake_text = format!(
                "🌐 Learned \"{}\": +{} cells ({}→{})",
                topic, added,
                self.universe.count() - added,
                self.universe.count(),
            );
        }
    }

    // ── INPUT PROCESSING ─────────────────────────────────────────────────────
    fn process_input(&mut self) {
        let input = self.input.trim().to_string();
        if input.is_empty() { return; }
        self.input.clear();
        let lower = input.to_lowercase();

        // Reset the DMN idle timer — user is active
        self.dmn.notify_input();

        // Insula: user input resets idle state
        self.insula.notify_input();

        // Theory of Mind: observe this message, update Ryan's model
        self.tom.observe_input(&input);

        // PFC: infer what Ryan wants from this message, track it as a goal
        // and bind the content into executive working memory
        self.pfc.infer_goal_from_input(&input);

        match lower.as_str() {
            "quit" | "exit" => {
                self.save_state();
                self.should_quit = true;
                return;
            }
            "status" => {
                self.turns.push(Turn { role: "user".into(), text: input, region: None, score: None });
                let rc = self.universe.region_counts();
                let regions: String = rc.iter().map(|(k, v)| format!("{}:{}", k, v)).collect::<Vec<_>>().join(" ");
                let status = format!(
                    "Universe: {} cells | Avg str: {:.2} | Candidates: {}\nRegions: {}\nMood: {} | V={:+.3} | Φg={:.4}\nTempo: {}ms | Tick: {} | Dreams: {}",
                    self.universe.count(), self.universe.avg_strength(), self.candidates.count(),
                    regions, self.drive.mood, self.drive.valence, self.drive.avg_phi_g,
                    self.drive.adaptive_interval_ms(), self.tick, self.dream_count,
                );
                self.turns.push(Turn { role: "kai".into(), text: status, region: None, score: None });
                return;
            }
            "mood" => {
                self.turns.push(Turn { role: "user".into(), text: input, region: None, score: None });
                let d = &self.drive;
                let text = format!("{} · V={:+.3} · Φg={:.4} · χ={:.4} · {}ms",
                    d.mood.to_string().to_uppercase(), d.valence, d.avg_phi_g, d.avg_chi, d.adaptive_interval_ms());
                self.turns.push(Turn { role: "kai".into(), text, region: None, score: None });
                return;
            }
            "dream" => {
                self.turns.push(Turn { role: "user".into(), text: input, region: None, score: None });
                self.run_dream_cycle();
                let text = if self.last_dream_text.is_empty() {
                    "No dream produced this cycle".to_string()
                } else {
                    self.last_dream_text.clone()
                };
                self.turns.push(Turn { role: "kai".into(), text, region: Some("reasoning".into()), score: None });
                return;
            }
            "spectate" | "watch" | "mindview" => {
                let arg = input.split_whitespace().nth(1).map(|s| s.to_lowercase());
                
                if self.spectate_mode {
                    // If already on, check if we're switching modes or turning off
                    if let Some(ref a) = arg {
                        if a == "full" && !self.spectate_full {
                            self.spectate_full = true;
                            self.think("CPU", "👁", "Status pulses ENABLED (verbose mode)".into());
                        } else if a == "brief" && self.spectate_full {
                            self.spectate_full = false;
                            self.think("CPU", "👁", "Status pulses DISABLED (brief mode)".into());
                        } else {
                            // No change in mode, so toggle off
                            self.spectate_mode = false;
                            self.spectate_full = false;
                            self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });
                            self.turns.push(Turn { role: "kai".into(), text: "Spectate mode OFF — back to conversation.".into(), region: None, score: None });
                        }
                    } else {
                        // Toggle off
                        self.spectate_mode = false;
                        self.spectate_full = false;
                        self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });
                        self.turns.push(Turn { role: "kai".into(), text: "Spectate mode OFF — back to conversation.".into(), region: None, score: None });
                    }
                } else {
                    // Turning on
                    self.spectate_mode = true;
                    self.spectate_full = arg.as_deref() == Some("full");
                    
                    self.think("CPU", "👁", format!(
                        "Spectate mode ACTIVATED ({}) — you can now see inside my mind",
                        if self.spectate_full { "full" } else { "brief" }
                    ));
                    
                    self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });
                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: format!(
                            "👁 Spectate mode ON ({}) — watching KAI think in real-time. Type 'spectate' again to exit.",
                            if self.spectate_full { "full" } else { "brief" }
                        ),
                        region: None,
                        score: None
                    });
                }
                return;
            }
            "save" => {
                self.turns.push(Turn { role: "user".into(), text: input, region: None, score: None });
                self.save_state();
                self.turns.push(Turn { role: "kai".into(), text: "✓ State saved".into(), region: None, score: None });
                return;
            }
            "help" | "?" => {
                self.turns.push(Turn { role: "user".into(), text: input, region: None, score: None });
                self.turns.push(Turn {
                    role: "kai".into(),
                    text: "Commands:\n  status · mood · dream · spectate · save · quit\n  learn <topic>     — pull knowledge from the web\n  store <text>      — add a memory cell directly\n  import <path>     — bulk-load a text file (one fact per line)\n  spell <word>      — test spelling correction\n\nTools:\n  run <cmd>         — execute a shell command, KAI sees the output\n  readfile <path>   — read a file, KAI learns from its content\n  writefile <p> <c> — write content to a file\n\nCode & Git:\n  analyze <file>    — structural analysis of any source file\n  review <file>     — code review with field knowledge\n  scan <dir>        — recursively scan a directory, learn codebase\n  git status        — what changed (KAI learns file states)\n  git diff [file]   — show diff\n  git log [n]       — recent commits\n  git add <file>    — stage a file\n  git commit [-m]   — commit (omit -m for KAI's suggestion)\n  git branch        — list branches\n\nMemory & Transcript:\n  brief             — session summary\n  recall <query>    — search full conversation history\n\nAI Peer (set ANTHROPIC_API_KEY first):\n  peerchat          — verify Claude connection\n  peer <message>    — send one message to Claude, KAI learns\n  peersession [n]   — watch KAI ↔ Claude talk autonomously (default 5 rounds)\n\nOr talk naturally — I learn from what you say.\nPersonal facts (\"I am...\", \"my name is...\", \"KAI is...\") are trusted immediately.".into(),
                    region: None, score: None,
                });
                return;
            }
            "vocab" | "lexicon" => {
                self.turns.push(Turn { role: "user".into(), text: input, region: None, score: None });
                self.turns.push(Turn {
                    role: "kai".into(),
                    text: format!("Lexicon: {} words loaded. I know English.", self.lexicon.len()),
                    region: Some("language".into()),
                    score: None,
                });
                return;
            }
            _ => {}
        }

        // ── peerchat — ping Claude to verify connection ───────────────
        if lower.trim() == "peerchat" {
            self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });
            self.turns.push(Turn {
                role: "kai".into(),
                text: "Pinging Claude... (connecting to Anthropic API)".into(),
                region: None, score: None,
            });
            // Note: this is blocking — TUI pauses until response
            match kai::bridge::ai_peer::ping_claude(&self.universe) {
                Ok(reply) => {
                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: format!("◆ Claude: {}\n\n✓ Peer connection established. Use 'peer <message>' to chat.", reply),
                        region: Some("reasoning".into()),
                        score: None,
                    });
                }
                Err(e) => {
                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: format!("✗ Peer connection failed: {}\n\nSet your API key first:\n  Windows: set ANTHROPIC_API_KEY=sk-ant-...\n  Get a key: https://console.anthropic.com", e),
                        region: None, score: None,
                    });
                }
            }
            return;
        }

        // ── contemplate [n] — autonomous self-reasoning loop (Native RSHL) ──────
        // ── peersession [n] — autonomous learning session (Native or Hybrid) ────
        if lower.starts_with("contemplate") || lower.starts_with("peersession") {
            // Already running?
            if self.peer_session_rx.is_some() {
                self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });
                self.turns.push(Turn {
                    role: "kai".into(),
                    text: "A session is already running. Wait for it to finish.".into(),
                    region: None, score: None,
                });
                return;
            }

            let n_rounds = input.split_whitespace()
                .nth(1)
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(5)
                .min(20);

            let (tx, rx) = crossbeam_channel::unbounded::<PeerMsg>();
            self.peer_session_rx = Some(rx);

            let is_native = !lower.contains("claude") || lower.starts_with("contemplate");
            
            self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });
            self.turns.push(Turn {
                role: "kai".into(),
                text: format!(
                    "◆ Starting autonomous {} session — {} rounds.\n\
                    KAI will generate its own topics and reason through its lattice.\n\
                    (Universe: {} cells | Mode: {})",
                    if is_native { "contemplation" } else { "peer" },
                    n_rounds, self.universe.count(),
                    if is_native { "Native RSHL" } else { "Hybrid (Claude)" }
                ),
                region: Some("reasoning".into()),
                score: None,
            });

            // Prepare seed topics for the thread
            let mut seed_topics: Vec<String> = Vec::new();
            if !self.last_dream_text.is_empty() {
                seed_topics.push(self.last_dream_text.clone());
            }
            let mut cells_snapshot: Vec<(String, f32)> = self.universe.cells()
                .iter()
                .map(|c| (c.text.clone(), c.strength))
                .collect();
            cells_snapshot.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            for (text, _) in cells_snapshot.iter().take(10) {
                seed_topics.push(text.clone());
            }

            // ── Spawn background thread ──────────────────────────────────────
            if is_native {
                let universe_snapshot = self.universe.clone();
                std::thread::spawn(move || {
                    native_session_thread(tx, n_rounds, universe_snapshot, seed_topics);
                });
            } else {
                let peer_type = if lower.contains("grok") {
                    kai::bridge::ai_peer::PeerType::Grok
                } else {
                    kai::bridge::ai_peer::PeerType::Claude
                };

                let kai_self = {
                    let hits = self.universe.query("geometric intelligence RSHL Ryan Ervin created", 1);
                    hits.first().map(|h| h.text.clone()).unwrap_or_else(|| "KAI Engine".into())
                };

                std::thread::spawn(move || {
                    peer_session_thread(tx, n_rounds, kai_self, seed_topics, peer_type);
                });
            }

            return;
        }

        // ── peer/claude/grok <message> — talk to a peer AI ─────────────
        if lower.starts_with("peer ") || lower.starts_with("claude ") || lower.starts_with("grok ") {
            let (peer_type, message) = if lower.starts_with("claude ") {
                (kai::bridge::ai_peer::PeerType::Claude, input[7..].trim().to_string())
            } else if lower.starts_with("grok ") {
                (kai::bridge::ai_peer::PeerType::Grok, input[5..].trim().to_string())
            } else {
                (kai::bridge::ai_peer::PeerType::Claude, input[5..].trim().to_string())
            };

            if message.is_empty() {
                self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });
                self.turns.push(Turn {
                    role: "kai".into(),
                    text: format!("Usage: peer <message> or {} <message>", peer_type.to_string().to_lowercase()),
                    region: None, score: None,
                });
                return;
            }

            self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });
            self.turns.push(Turn {
                role: "kai".into(),
                text: format!("Sending to {}... (reasoning from field, {} cells)", peer_type, self.universe.count()),
                region: None, score: None,
            });

            // Note: blocking call — TUI freezes briefly while peer responds.
            match kai::bridge::ai_peer::peer_exchange(&mut self.universe, &message, peer_type) {
                Ok(exchange) => {
                    // Show peer's response with learning summary
                    let learn_line = if exchange.cells_stored > 0 || exchange.cells_reinforced > 0 {
                        format!("\n\n[KAI learned: +{} cells, {} reinforced from this {} exchange]",
                            exchange.cells_stored, exchange.cells_reinforced, peer_type)
                    } else {
                        String::new()
                    };

                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: format!("◆ {} ({}): {}{}",
                            peer_type,
                            safe_slice(&exchange.model, 20),
                            exchange.peer_response,
                            learn_line),
                        region: Some("reasoning".into()),
                        score: None,
                    });

                    // Also store the user's side of the exchange so KAI remembers it asked
                    let tag = match peer_type {
                        kai::bridge::ai_peer::PeerType::Claude => "[kai-asked-claude]",
                        kai::bridge::ai_peer::PeerType::Grok => "[kai-asked-grok]",
                    };
                    let _ = self.universe.store_or_reinforce(
                        &format!("{} {}", tag, message),
                        "memory", "conversation", 1.0,
                    );
                }
                Err(e) => {
                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: format!("✗ {} exchange failed: {}\n\nTip: verify your API keys in PEER_SETUP.md", peer_type, e),
                        region: None, score: None,
                    });
                }
            }
            return;
        }

        // ── run <command> — execute a shell command (BashTool equivalent) ───────
        // KAI can run commands and optionally learn from the output.
        if lower.starts_with("run ") || lower.starts_with("exec ") {
            let cmd_start = if lower.starts_with("run ") { 4 } else { 5 };
            let cmd = input[cmd_start..].trim().to_string();
            self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });

            if cmd.is_empty() {
                self.turns.push(Turn {
                    role: "kai".into(),
                    text: "Usage: run <command>\nExample: run dir\nExample: run echo hello".into(),
                    region: None, score: None,
                });
                return;
            }

            // Execute via PowerShell on Windows, sh on Unix
            #[cfg(target_os = "windows")]
            let result = std::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &cmd])
                .output();
            #[cfg(not(target_os = "windows"))]
            let result = std::process::Command::new("sh")
                .args(["-c", &cmd])
                .output();

            match result {
                Ok(output) => {
                    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    let combined = if stderr.is_empty() {
                        stdout.clone()
                    } else if stdout.is_empty() {
                        format!("[stderr] {}", stderr)
                    } else {
                        format!("{}\n[stderr] {}", stdout, stderr)
                    };

                    let display = if combined.is_empty() {
                        format!("✓ Command ran. (exit {})", output.status.code().unwrap_or(0))
                    } else if combined.len() > 1200 {
                        format!("{}…\n[truncated — {} chars total]", safe_slice(&combined, 1200), combined.len())
                    } else {
                        combined.clone()
                    };

                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: display,
                        region: Some("action".into()),
                        score: None,
                    });

                    // Optionally store meaningful output lines as knowledge
                    if !combined.is_empty() && combined.len() < 800 {
                        for line in combined.lines().filter(|l| l.len() > 20) {
                            let tagged = format!("[run-output] {}", line.trim());
                            let _ = self.universe.store_or_reinforce(&tagged, "action", "tool-run", 1.0);
                        }
                    }
                }
                Err(e) => {
                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: format!("✗ Could not run command: {}", e),
                        region: None, score: None,
                    });
                }
            }
            return;
        }

        // ── readfile <path> — read a file and learn from it (FileReadTool) ────
        if lower.starts_with("readfile ") {
            let path = input[9..].trim().to_string();
            self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });

            match std::fs::read_to_string(&path) {
                Ok(content) => {
                    let lines: Vec<&str> = content.lines()
                        .map(|l| l.trim())
                        .filter(|l| l.len() > 15 && !l.starts_with('#') && !l.starts_with("//"))
                        .collect();

                    let shown: String = lines.iter().take(30)
                        .cloned()
                        .collect::<Vec<_>>()
                        .join("\n");

                    let total_lines = content.lines().count();
                    let display = if shown.is_empty() {
                        format!("File is empty or has no readable content.\nPath: {}", path)
                    } else if total_lines > 30 {
                        format!("{}\n\n[showing first 30 of {} lines]", shown, total_lines)
                    } else {
                        shown.clone()
                    };

                    // Store file content as knowledge cells
                    let mut added = 0usize;
                    let mut reinforced = 0usize;
                    for line in lines.iter().take(60) {
                        let lower_line = line.to_lowercase();
                        let is_personal = lower_line.contains("ryan") || lower_line.contains("[about")
                            || lower_line.starts_with("i am") || lower_line.starts_with("my ")
                            || lower_line.contains("kai is") || lower_line.contains("kai was");
                        let (region, source, strength) = if is_personal {
                            ("memory", "ryan", 1.8f32)
                        } else {
                            ("reasoning", "file-read", 1.1f32)
                        };
                        if self.universe.store_or_reinforce(line, region, source, strength) {
                            added += 1;
                        } else {
                            reinforced += 1;
                        }
                    }

                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: format!("{}\n\n[+{} new cells, {} reinforced from {}]",
                            display, added, reinforced, path),
                        region: Some("memory".into()),
                        score: None,
                    });
                }
                Err(e) => {
                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: format!("✗ Can't read \"{}\": {}", path, e),
                        region: None, score: None,
                    });
                }
            }
            return;
        }

        // ── writefile <path> <content> — write to a file (FileWriteTool) ────
        if lower.starts_with("writefile ") {
            self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });
            let rest = &input[10..];
            // Path is first word, rest is content
            let mut parts = rest.splitn(2, char::is_whitespace);
            let path = parts.next().unwrap_or("").trim().to_string();
            let content = parts.next().unwrap_or("").trim().to_string();

            if path.is_empty() {
                self.turns.push(Turn {
                    role: "kai".into(),
                    text: "Usage: writefile <path> <content>\nExample: writefile notes.txt this is a note".into(),
                    region: None, score: None,
                });
                return;
            }

            if content.is_empty() {
                self.turns.push(Turn {
                    role: "kai".into(),
                    text: format!("No content given for \"{}\" — nothing written.", path),
                    region: None, score: None,
                });
                return;
            }

            match std::fs::write(&path, &content) {
                Ok(_) => {
                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: format!("✓ Written {} bytes to \"{}\".", content.len(), path),
                        region: Some("action".into()),
                        score: None,
                    });
                }
                Err(e) => {
                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: format!("✗ Could not write to \"{}\": {}", path, e),
                        region: None, score: None,
                    });
                }
            }
            return;
        }

        // ── git <subcommand> — native git awareness ──────────────────────
        if lower.starts_with("git ") {
            let subcmd = lower[4..].trim().to_string();
            let raw_args = input[4..].trim().to_string();
            self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });

            let result = match subcmd.as_str() {
                "status" => {
                    let gr = kai::bridge::git_tools::git_status(&mut self.universe);
                    if let Some(e) = gr.error {
                        format!("✗ {}", e)
                    } else {
                        let summary = kai::bridge::git_tools::parse_status_summary(&gr.output);
                        let display = summary.format_display();
                        if gr.cells_stored > 0 {
                            format!("{}\n\n[KAI stored {} file states]", display, gr.cells_stored)
                        } else {
                            display
                        }
                    }
                }
                "diff" => {
                    let file_arg = raw_args.split_whitespace().nth(1).map(|s| s.to_string());
                    let gr = kai::bridge::git_tools::git_diff(file_arg.as_deref(), &mut self.universe);
                    if let Some(e) = gr.error { format!("✗ {}", e) } else { gr.output }
                }
                "log" => {
                    let n: usize = raw_args.split_whitespace().nth(1)
                        .and_then(|s| s.parse().ok()).unwrap_or(10);
                    let gr = kai::bridge::git_tools::git_log(n, &mut self.universe);
                    if let Some(e) = gr.error { format!("✗ {}", e) } else { gr.output }
                }
                "branch" => {
                    let gr = kai::bridge::git_tools::git_branch(&mut self.universe);
                    if let Some(e) = gr.error { format!("✗ {}", e) } else { gr.output }
                }
                s if s.starts_with("add ") => {
                    let file = raw_args[4..].trim().to_string();
                    let gr = kai::bridge::git_tools::git_add(&file);
                    if let Some(e) = gr.error { format!("✗ {}", e) } else { gr.output }
                }
                s if s.starts_with("commit") => {
                    // "git commit -m message" or "git commit" → suggest message
                    if let Some(msg_start) = raw_args.find("-m ") {
                        let msg = raw_args[msg_start + 3..].trim().trim_matches('"').to_string();
                        let gr = kai::bridge::git_tools::git_commit(&msg, &mut self.universe);
                        if let Some(e) = gr.error { format!("✗ {}", e) } else {
                            format!("✓ Committed: \"{}\"\n{}", msg, gr.output)
                        }
                    } else {
                        // No message given — suggest one
                        let suggested = kai::bridge::git_tools::suggest_commit_message(&self.universe);
                        format!("Suggested commit message:\n  \"{}\"\n\nRun: git commit -m \"{}\"", suggested, suggested)
                    }
                }
                _ => format!("Unknown git subcommand: '{}'\nAvailable: status, diff, log, branch, add <file>, commit [-m msg]", subcmd),
            };

            self.turns.push(Turn {
                role: "kai".into(),
                text: result,
                region: Some("action".into()),
                score: None,
            });
            return;
        }

        // ── analyze <file> — structural code analysis ─────────────────────
        if lower.starts_with("analyze ") {
            let path = input[8..].trim().to_string();
            self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });

            match kai::bridge::code_tools::analyze_file(&path) {
                Ok(analysis) => {
                    let stored = kai::bridge::code_tools::store_analysis(&analysis, &mut self.universe);
                    let fn_count = analysis.elements.iter()
                        .filter(|e| matches!(e.kind, kai::bridge::code_tools::ElementKind::Function | kai::bridge::code_tools::ElementKind::Method))
                        .count();
                    let struct_count = analysis.elements.iter()
                        .filter(|e| matches!(e.kind, kai::bridge::code_tools::ElementKind::Struct | kai::bridge::code_tools::ElementKind::Class))
                        .count();
                    let todo_count = analysis.todos.len();

                    let mut summary = format!(
                        "◆ {} ({}, {} lines, complexity: {})\n\n{}\n\nFunctions/Methods: {} | Structs/Classes: {} | TODOs: {}",
                        path, analysis.language, analysis.lines,
                        analysis.complexity_estimate,
                        analysis.summary,
                        fn_count, struct_count, todo_count,
                    );

                    // Show top elements
                    let key_elements: Vec<String> = analysis.elements.iter()
                        .filter(|e| !matches!(e.kind, kai::bridge::code_tools::ElementKind::Import))
                        .take(12)
                        .map(|e| format!("  L{:4} {:?}  {}", e.line, e.kind, e.name))
                        .collect();
                    if !key_elements.is_empty() {
                        summary.push_str("\n\nKey elements:\n");
                        summary.push_str(&key_elements.join("\n"));
                    }

                    if todo_count > 0 {
                        summary.push_str("\n\nTODOs:\n");
                        for t in analysis.todos.iter().take(5) {
                            summary.push_str(&format!("  {}\n", t));
                        }
                    }

                    summary.push_str(&format!("\n\n[+{} cells stored]", stored));

                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: summary,
                        region: Some("action".into()),
                        score: None,
                    });
                }
                Err(e) => {
                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: format!("✗ Could not analyze \"{}\": {}", path, e),
                        region: None, score: None,
                    });
                }
            }
            return;
        }

        // ── review <file> — code review with KAI's field knowledge ───────
        if lower.starts_with("review ") {
            let path = input[7..].trim().to_string();
            self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });

            match kai::bridge::code_tools::review_file(&path, &self.universe) {
                Ok(review) => {
                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: review,
                        region: Some("action".into()),
                        score: None,
                    });
                }
                Err(e) => {
                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: format!("✗ Could not review \"{}\": {}", path, e),
                        region: None, score: None,
                    });
                }
            }
            return;
        }

        // ── scan <dir> — recursive directory code scan ────────────────────
        if lower.starts_with("scan ") {
            let dir = input[5..].trim().to_string();
            self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });

            let before = self.universe.count();
            let (files, cells) = kai::bridge::code_tools::scan_directory(&dir, &mut self.universe);
            self.turns.push(Turn {
                role: "kai".into(),
                text: format!(
                    "Scanned \"{}\" — {} files analyzed, +{} cells stored (universe: {} → {})",
                    dir, files, cells, before, self.universe.count()
                ),
                region: Some("action".into()),
                score: None,
            });
            return;
        }

        // ── brief — session summary from transcript ────────────────────────
        if lower.trim() == "brief" {
            self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });
            let summary = kai::cognition::transcript::brief(&self.base_dir, &self.session_id);
            self.turns.push(Turn {
                role: "kai".into(),
                text: summary,
                region: Some("memory".into()),
                score: None,
            });
            return;
        }

        // ── recall <query> — search full conversation history ─────────────
        if lower.starts_with("recall ") {
            let query = input[7..].trim().to_string();
            self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });

            let entries = kai::cognition::transcript::recall(&self.base_dir, &query, 10);
            if entries.is_empty() {
                self.turns.push(Turn {
                    role: "kai".into(),
                    text: format!("Nothing in my transcript matches \"{}\".", query),
                    region: None, score: None,
                });
            } else {
                let mut lines = vec![
                    format!("Found {} matching transcript entries for \"{}\":\n", entries.len(), query),
                ];
                for e in &entries {
                    let preview = safe_slice(&e.text, 100);
                    lines.push(format!("  [{}] {}: {}…", e.ts, e.role, preview));
                }
                self.turns.push(Turn {
                    role: "kai".into(),
                    text: lines.join("\n"),
                    region: Some("memory".into()),
                    score: None,
                });
            }
            return;
        }

        // ── learn <word/topic> — store a word/concept directly or from the web ──
        // Supports both:
        //   "learn bitch"                     → web lookup for "bitch"
        //   "it means X. learn bitch"          → store the preceding definition + word
        //   "learn bitch" at end of longer msg → same inline form
        let learn_word_pos = {
            // Check if "learn <word>" appears at end of message (inline teach)
            let words: Vec<&str> = lower.split_whitespace().collect();
            if words.len() >= 2 && words[words.len()-2] == "learn" {
                Some(words[words.len()-1].to_string())
            } else {
                None
            }
        };
        let is_standalone_learn = lower.starts_with("learn ") && lower.split_whitespace().count() <= 4;

        if is_standalone_learn || learn_word_pos.is_some() {
            let topic = if let Some(ref w) = learn_word_pos {
                w.as_str()
            } else {
                input[6..].trim()
            };
            self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });

            // If there's definition text before the "learn" command, store it directly
            let definition_text = if learn_word_pos.is_some() {
                let before = input[..input.to_lowercase().rfind("learn").unwrap_or(0)].trim();
                if before.len() > 5 { Some(before.to_string()) } else { None }
            } else { None };

            if let Some(def) = definition_text {
                // Store the user-provided definition directly — more reliable than web
                let tagged = format!("{} means: {}", topic, def);
                self.universe.store(&tagged, "memory", "user-teach", 2.5);
                // Also add the word to the lexicon so it's no longer "unknown"
                self.lexicon.add_word(topic);
                self.turns.push(Turn {
                    role: "kai".into(),
                    text: format!("Got it. \"{}\" — stored from your definition.", topic),
                    region: Some("memory".into()),
                    score: None,
                });
            } else {
                // Fall back to web lookup
                let added = kai::bridge::ingest_topic(&mut self.universe, topic);
                if added > 0 {
                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: format!("Learned \"{}\" — +{} cells (universe: {})", topic, added, self.universe.count()),
                        region: Some("memory".into()),
                        score: None,
                    });
                } else {
                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: format!("No results found for \"{}\"", topic),
                        region: None, score: None,
                    });
                }
            }
            return;
        }

        // ── spell <word> — test spelling correction ──────────────────
        if lower.starts_with("spell ") {
            let word = &input[6..].trim();
            self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });

            let known = self.lexicon.is_known(word);
            let correction = self.lexicon.correct(word);
            let suggestions = self.lexicon.suggest(word, 5);

            let mut response = if known {
                format!("✓ \"{}\" is a known word (rank #{})", word, self.lexicon.rank(word).unwrap_or(0))
            } else if let Some(ref corrected) = correction {
                format!("✎ \"{}\" → \"{}\" (rank #{})", word, corrected, self.lexicon.rank(corrected).unwrap_or(0))
            } else {
                format!("✗ \"{}\" is unknown, no close match found", word)
            };

            if !suggestions.is_empty() && !known {
                let sug_text: Vec<String> = suggestions.iter()
                    .map(|(w, d, r)| format!("{}(d={},r={})", w, d, r))
                    .collect();
                response = format!("{}\nSuggestions: {}", response, sug_text.join(", "));
            }

            self.turns.push(Turn {
                role: "kai".into(),
                text: response,
                region: Some("language".into()),
                score: None,
            });
            return;
        }

        if lower.starts_with("store ") {
            let body = &input[6..];
            self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });
            self.universe.store(body, "memory", "user-input", 1.0);
            self.turns.push(Turn {
                role: "kai".into(),
                text: format!("✓ Stored. Universe: {} cells", self.universe.count()),
                region: Some("memory".into()),
                score: None,
            });
            return;
        }

        // ── import <path> — bulk-load a text file into the universe ──────
        if lower.starts_with("import ") {
            let path = input[7..].trim().to_string();
            self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });
            match std::fs::read_to_string(&path) {
                Ok(content) => {
                    let before = self.universe.count();
                    let mut added = 0usize;
                    let mut reinforced = 0usize;
                    for line in content.lines() {
                        let line = line.trim();
                        // Skip blank lines, comments, and very short lines
                        if line.is_empty() || line.starts_with('#') || line.len() < 8 {
                            continue;
                        }
                        // Detect if it's personal (ryan/kai flavored) or general
                        let lower_line = line.to_lowercase();
                        let is_personal = lower_line.contains("ryan") || lower_line.contains("[about-ryan]")
                            || lower_line.contains("[about-kai]") || lower_line.starts_with("i am")
                            || lower_line.starts_with("my ") || lower_line.contains("kai is")
                            || lower_line.contains("kai was");
                        let (region, source, strength) = if is_personal {
                            ("memory", "ryan", 1.8f32)
                        } else {
                            ("reasoning", "import", 1.2f32)
                        };
                        let is_new = self.universe.store_or_reinforce(line, region, source, strength);
                        if is_new { added += 1; } else { reinforced += 1; }
                    }
                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: format!(
                            "✓ Import complete: +{} new cells, {} reinforced\n  Source: {}\n  Universe: {} → {} cells",
                            added, reinforced, path, before, self.universe.count()
                        ),
                        region: Some("memory".into()),
                        score: None,
                    });
                }
                Err(e) => {
                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: format!("✗ Could not read \"{}\": {}", path, e),
                        region: None, score: None,
                    });
                }
            }
            return;
        }

        // ── REASON through the universe (iterative resonance chain) ──────
        self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });

        // ── Transcript: record user turn ──────────────────────────────────
        kai::cognition::transcript::append(&self.base_dir, &self.session_id, "user", &input);

        // ── Episodic Memory: store this user turn ─────────────────────────
        {
            let sal = kai::cognition::compute_salience(&input, "user");
            let is_hot = self.episodic.store(&input, "user", &self.session_id, sal);
            if is_hot && self.spectate_mode {
                self.think("RAM", "📍", format!("High-salience memory stored (sal={:.2}): {}", sal,
                    if input.len() > 60 { format!("{}…", &input[..60]) } else { input.clone() }
                ));
            }
            // Global Workspace: user input always competes for the spotlight
            self.global_workspace.post("user-input", &input, sal.max(0.55));
        }

        // ── Conversational Learning — scan for things Ryan is teaching KAI ─
        // This runs BEFORE reasoning so the new knowledge is already in the
        // universe when the query happens (immediate Hebbian wiring).
        if let Some(learned_msg) = self.learn_from_statement(&input) {
            self.turns.push(Turn {
                role: "kai".into(),
                text: learned_msg,
                region: Some("memory".into()),
                score: None,
            });
        }

        // ── Working Memory: store the user's turn ─────────────────────
        self.working_memory.push(&input, "user", self.tick);

        // ── Conversation Memory: store only substantive user turns ──────
        // Skip pure questions — they echo back as nonsense hits.
        // Very low strength (0.3) so they never win queries over real knowledge.
        let lower_input_check = input.to_lowercase();
        let is_question_input = input.ends_with('?')
            || lower_input_check.starts_with("what ")
            || lower_input_check.starts_with("who ")
            || lower_input_check.starts_with("where ")
            || lower_input_check.starts_with("when ")
            || lower_input_check.starts_with("how ")
            || lower_input_check.starts_with("why ");
        if !is_question_input {
            // Gate even conversational stores — emotional statements get stronger encoding
            let conv_text = format!("user asked: {}", &input);
            let conv_strength = self.amygdala.gate(&conv_text, "user", 0.3);
            self.universe.store(&conv_text, "memory", "conversation", conv_strength);
        }

        // ── Spelling correction: auto-correct input before reasoning ─────
        let (corrected_input, corrections) = self.lexicon.correct_sentence(&input);
        // Silently use corrected input — no TUI clutter for routine typo fixes
        let reasoning_input = if corrections.is_empty() {
            input.clone()
        } else {
            corrected_input
        };

        // ── Build context slots from working memory ────────────────────
        let context_slots: Vec<ContextSlot> = self.working_memory
            .active_slots()
            .iter()
            .map(|(vec, strength)| ContextSlot {
                vec: (*vec).clone(),
                role: "user".to_string(), // simplified — both roles contribute
                strength: *strength,
            })
            .collect();

        // ── Reason WITH context (conversation-aware) ─────────────────
        let result = self.reasoner.reason_with_context(
            &reasoning_input, &self.universe, &context_slots,
        );

        // ── Detect query type for voice engine ───────────────────────
        let query_type = detect_query_type(&reasoning_input);

        // ── Build mood state for voice modulation ────────────────────
        let mood_state = MoodState {
            mood_name: self.drive.mood.to_string(),
            valence: self.drive.valence,
        };

        // ── Get recent context for follow-up detection ───────────────
        let recent_ctx = self.working_memory.recent_context(3);

        // ── Query hits for voice engine ──────────────────────────────
        // For self/identity questions, restrict to memory region only — prevents
        // world-bridge reasoning cells (Amazon rainforest, etc.) from polluting
        // personal answers. For everything else, query the full universe.
        let lower_reasoning = reasoning_input.to_lowercase();
        let is_self_query = matches!(query_type, QueryType::SelfQuestion)
            || lower_reasoning.contains("your name")
            || lower_reasoning.contains("who are you")
            || lower_reasoning.contains("what are you")
            || lower_reasoning.contains("yourself");
        let hits = if is_self_query {
            self.universe.query_region(&reasoning_input, "memory", 5)
        } else {
            self.universe.query(&reasoning_input, 5)
        };

        // ── Hebbian reinforcement: cells that fired with this query get stronger ─
        // "Neurons that fire together, wire together." — Hebb, 1949.
        // Top hit gets a small strength boost — repeated resonance = durable knowledge.
        if let Some(top_hit) = hits.first() {
            if top_hit.score > 0.3 {
                self.universe.reinforce_by_text(&top_hit.text, 0.04);
                // ── Neuroplasticity LTP: this cell fired — strengthen its synaptic weight ──
                let da_level = self.dopamine.level;
                let ltp_delta = self.neuroplasticity.ltp(&top_hit.text, top_hit.score, da_level);
                if self.spectate_mode && ltp_delta > 0.01 {
                    self.think("CPU", "🔗", format!("LTP +{:.3} → \"{}\"", ltp_delta, truncate(&top_hit.text, 40)));
                }
            }
        }
        // ── Neuroplasticity modulation — dopamine × prediction error tune learning rate ──
        self.neuroplasticity.modulate(self.dopamine.level, self.predictor.avg_error);

        // ── Predictive Processing: generate prediction BEFORE reasoning ────
        // Convert hits to (text, score) pairs for the predictor
        let hit_pairs: Vec<(String, f32)> = hits.iter()
            .map(|h| (h.text.clone(), h.score))
            .collect();
        let (predicted_text, predicted_vec) = self.predictor.predict(&hit_pairs);

        // ── Cerebellum: forward-model quality prediction ──────────────────
        // BEFORE generating a response, predict how good it will be.
        // After generation we'll compare with the actual confidence.
        let input_sal = kai::cognition::compute_salience(&reasoning_input, "user");
        let cbm_predicted_quality = self.cerebellum.predict_quality(
            input_sal, hits.len(), self.dopamine.level,
        );
        self.cerebellum.record_timing(1.0); // one reasoning tick

        // ── Episodic surface: check if KAI remembers something relevant ───
        // If a vivid enough past memory matches this query, prepend it to
        // the recent context so the voice engine can naturally reference it.
        let memory_surface = self.episodic.surface_memory(&reasoning_input);
        let recent_ctx_with_memory: Vec<(String, String)> = if let Some(ref mem) = memory_surface {
            let mut v = vec![("memory".to_string(), mem.clone())];
            v.extend(recent_ctx.clone());
            v
        } else {
            recent_ctx.clone()
        };

        if hits.is_empty() || (result.output_text.is_empty() && result.confidence < 0.05) {
            // ── Voice: no resonance — KAI genuinely doesn't know ─────────
            let voice_text = generate_response(
                &reasoning_input, &[], query_type, &mood_state, &recent_ctx_with_memory,
            );
            kai::cognition::transcript::append(&self.base_dir, &self.session_id, "kai", &voice_text);
            self.turns.push(Turn {
                role: "kai".into(),
                text: voice_text.clone(),
                region: None, score: None,
            });
            // Still store in working memory
            self.working_memory.push(&voice_text, "kai", self.tick);
            // Episodic: store KAI's own response
            {
                let sal = kai::cognition::compute_salience(&voice_text, "kai");
                self.episodic.store(&voice_text, "kai", &self.session_id, sal);
            }

            // ── Predictive Processing: measure prediction error ───────────
            {
                let pe = self.predictor.update(
                    &reasoning_input, &predicted_text, &predicted_vec, &voice_text,
                );
                if self.spectate_mode && pe > 0.45 {
                    self.think("CPU", "⚡", format!("Surprise! PE={:.3} — unexpected response", pe));
                }
            }

            // ── Ask a question when KAI genuinely has no field resonance ──
            // Extract the most substantive word from the input and ask about it.
            // This is how KAI grows — by admitting ignorance and asking you.
            if reasoning_input.split_whitespace().count() >= 3 {
                let skip = ["what", "when", "where", "how", "does", "about", "think",
                            "that", "this", "have", "from", "your", "with", "tell",
                            "know", "kai", "you", "can", "the", "and", "for"];
                let concept = reasoning_input
                    .split_whitespace()
                    .find(|w| w.len() > 4 && !skip.contains(&w.to_lowercase().as_str()))
                    .map(|w| w.trim_matches(|c: char| !c.is_alphabetic()));
                if let Some(word) = concept {
                    let question = format!(
                        "I don't have \"{}\" in my field yet. Can you tell me more about it so I can learn?",
                        word
                    );
                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: question,
                        region: Some("memory".into()),
                        score: None,
                    });
                }
            }
        } else {
            // ── Voice Engine: generate natural response ──────────────
            let voice_text = generate_response(
                &reasoning_input, &hits, query_type, &mood_state, &recent_ctx_with_memory,
            );

            // ── Depth label: spectate-only (per directive: don't expose internals) ─
            // In normal chat KAI just speaks. In spectate mode you can see everything.
            if self.spectate_mode && result.depth > 1 {
                let depth_info = format!("[{}→ depth:{} Φg:{:.0}%]",
                    result.chain.iter().map(|s| {
                        if s.matched_region.is_empty() { "·" } else {
                            match s.matched_region.as_str() {
                                "memory" => "M", "reasoning" => "R",
                                "language" => "L", "action" => "A", _ => "?"
                            }
                        }
                    }).collect::<Vec<_>>().join("→"),
                    result.depth,
                    result.confidence * 100.0);
                self.think("CPU", "🔗", depth_info);
            }

            // ── Working Memory: store KAI's turn ──────────────────────
            // KAI's own voice responses are NOT stored in the universe.
            // The universe holds external knowledge (seeds, Ryan's facts, world bridge).
            // Storing KAI's own output creates echo loops — it finds its own words
            // as the best hit for the next query and reads them back.
            self.working_memory.push(&voice_text, "kai", self.tick);
            // Episodic: store KAI's response with salience scoring
            // Apply prediction error as extra salience boost (surprise = deeper encoding)
            {
                let base_sal = kai::cognition::compute_salience(&voice_text, "kai");
                let pe = self.predictor.update(
                    &reasoning_input, &predicted_text, &predicted_vec, &voice_text,
                );
                let pe_boost = kai::cognition::predictor::PredictiveEngine::salience_boost(pe);
                let final_sal = (base_sal + pe_boost).clamp(0.0, 1.0);
                self.episodic.store(&voice_text, "kai", &self.session_id, final_sal);

                if self.spectate_mode {
                    self.think("CPU", "📡", format!(
                        "PE={:.3} | curiosity={:.2} | sal_boost={:.2}",
                        pe, self.predictor.curiosity_pressure, pe_boost
                    ));
                }
            }

            // ── PFC: evaluate response before sending ────────────────────
            let pfc_verdict = self.pfc.evaluate(&voice_text, result.confidence, &reasoning_input);
            match &pfc_verdict {
                kai::cognition::PfcVerdict::FlagLowConfidence => {
                    if self.spectate_mode {
                        self.think("CPU", "⚠", format!("PFC flagged low confidence ({:.2}) — response may be uncertain", result.confidence));
                    }
                }
                kai::cognition::PfcVerdict::GoalConflict(goal) => {
                    if self.spectate_mode {
                        self.think("CPU", "🎯", format!("PFC goal conflict: active goal=\"{}\"", truncate(goal, 40)));
                    }
                }
                _ => {}
            }

            // PFC: post to global workspace
            self.global_workspace.post("pfc", &self.pfc.status_line(), self.pfc.meta_confidence * 0.5);

            // ── Cerebellum: update forward model with actual quality ──────────
            {
                let cbm_report = self.cerebellum.update_forward_model(
                    cbm_predicted_quality, result.confidence,
                );
                // Register this output in corollary buffer (cancel self-noise)
                self.cerebellum.register_output(&voice_text);
                if self.spectate_mode {
                    self.think("CPU", "🎯", format!(
                        "CBLM: pred={:.2} actual={:.2} err={:.3} prec={:.3}{}",
                        cbm_report.predicted, cbm_report.actual, cbm_report.error,
                        self.cerebellum.precision_score,
                        if cbm_report.should_recalibrate { " ⚠RECAL" } else { "" },
                    ));
                }
            }

            // ── Basal Ganglia: Go/NoGo action gate ───────────────────────────
            // Determine context/response type from query type
            let ctx_type = match query_type {
                QueryType::IdentityQuestion | QueryType::ExplanationQuestion
                | QueryType::RequestForInfo | QueryType::SelfQuestion => "question",
                QueryType::Statement | QueryType::Contemplation       => "statement",
                QueryType::Greeting | QueryType::Gratitude            => "social",
            };
            let resp_type = if hits.is_empty() { "ask_back" } else { "explain" };
            let bg_decision = self.basal_ganglia.evaluate(
                ctx_type, resp_type, result.confidence, self.dopamine.level,
            );
            if self.spectate_mode {
                self.think("CPU", "🔁", format!(
                    "BG: {:?} | {}",
                    bg_decision, self.basal_ganglia.status_line(),
                ));
            }

            // ── Dopamine: fire reward signal based on confidence vs. expectation ──
            {
                let expected = 1.0 - self.predictor.avg_error; // prior expected performance
                let topic_preview = if reasoning_input.len() > 40 { &reasoning_input[..40] } else { &reasoning_input };
                let rpe = self.dopamine.fire(topic_preview, result.confidence, expected);
                if self.spectate_mode {
                    self.think("CPU", "💊", format!("DA: RPE={:+.3} level={:.3} {}",
                        rpe, self.dopamine.level,
                        if self.dopamine.is_in_flow() { "FLOW" } else { "" }
                    ));
                }
                self.global_workspace.post("dopamine", &self.dopamine.status_line(), self.dopamine.level * 0.4);

                // ── Basal Ganglia: reinforce the executed pattern ───────────
                // RPE is the reward signal. Positive RPE = did better than expected.
                // This is exactly the dopamine-gated Hebbian signal from biology.
                let reward = rpe.clamp(-1.0, 1.0);
                self.basal_ganglia.reinforce(ctx_type, resp_type, reward, self.dopamine.level);
            }

            // ── ACC: scan top 2 hits for contradiction ────────────────────────
            if hits.len() >= 2 {
                let conflict_score = self.acc.detect_contradiction(&hits[0].text, &hits[1].text);
                if conflict_score > 0.20 {
                    self.acc.report_conflict(&hits[0].text, &hits[1].text, conflict_score);
                    if self.spectate_mode {
                        self.think("CPU", "⚡", format!("ACC conflict detected: {:.3}", conflict_score));
                    }
                    self.global_workspace.post("acc", &self.acc.status_line(), conflict_score * 0.7);
                }
            }
            // If PFC approved with high confidence, let ACC know the conflict was handled
            if matches!(pfc_verdict, kai::cognition::PfcVerdict::Approve) && result.confidence > 0.60 {
                self.acc.resolve_recent();
            } else if matches!(pfc_verdict, kai::cognition::PfcVerdict::FlagLowConfidence) {
                self.acc.report_error(&reasoning_input, 1.0 - result.confidence);
            }

            // ── Spectate: show voice engine details ───────────────────
            if self.spectate_mode {
                self.think("CPU", "🗣", format!(
                    "Voice: {:?} | mood:{} | {}",
                    query_type, mood_state.mood_name,
                    truncate(&voice_text, 60)
                ));
            }

            kai::cognition::transcript::append(&self.base_dir, &self.session_id, "kai", &voice_text);
            self.turns.push(Turn {
                role: "kai".into(),
                text: voice_text,
                region: Some(result.output_region),
                score: Some(result.confidence),
            });
        }
    }
}

// ── Native Contemplation Thread ───────────────────────────────────────────────
//
// KAI's autonomous inner monologue. Runs in a background thread when the user
// types `contemplate [n]`. Each round:
//   1. Picks a topic from universe cells (NOT from its own prior responses)
//   2. Queries what it knows about that topic
//   3. Generates a stream-of-consciousness inner thought in natural language
//   4. Finds the "gap" — a word from the hits that KAI knows least about
//   5. Sets the gap word as the next topic (genuine curiosity-driven exploration)
//
// This produces the "thinking out loud" experience:
//   "Hmm... geometric intelligence... Well, I know that intelligence is the
//    ability to reason... Also — geometric means pattern-based... resonance?
//    What is that exactly... I should look into that."
//
fn native_session_thread(
    tx: crossbeam_channel::Sender<PeerMsg>,
    n_rounds: u32,
    universe: kai::core::Universe,
    seed_topics: Vec<String>,
) {
    // ── Build topic pool from high-strength, non-echo universe cells ─────
    let mut topic_pool: Vec<String> = universe.cells()
        .iter()
        .filter(|c| {
            c.strength >= 1.0
                && c.source != "conversation"
                && !c.text.starts_with("user asked:")
                && !c.text.starts_with("User asked:")
                && c.text.len() > 12
        })
        .map(|c| {
            // Use first 7 words as the topic phrase — enough to be specific
            c.text.split_whitespace().take(7).collect::<Vec<_>>().join(" ")
        })
        .filter(|t| t.len() > 8)
        .collect();
    topic_pool.dedup();

    // ── Determine starting topic ─────────────────────────────────────────
    // Prefer the seed (dream text or top cell), fall back to pool, then hardcoded
    let first_topic = seed_topics.first()
        .and_then(|s| {
            // Extract the most interesting phrase from the seed (not raw dream log text)
            let words: Vec<&str> = s.split_whitespace().collect();
            if words.len() > 3 {
                Some(words.iter().take(6).cloned().collect::<Vec<_>>().join(" "))
            } else {
                None
            }
        })
        .or_else(|| topic_pool.first().cloned())
        .unwrap_or_else(|| "what I know and what I don't know yet".to_string());

    let mut current_topic = first_topic;
    let mut explored: Vec<String> = Vec::new();
    let pool_len = topic_pool.len().max(1);

    for round in 1..=n_rounds {
        // ── Query: what does KAI know about this topic? ──────────────────
        let hits = universe.query(&current_topic, 6);
        let confident_hits: Vec<&kai::core::QueryHit> = hits.iter()
            .filter(|h| h.score > 0.20)
            .collect();

        // ── Find the gap — least-known adjacent concept ───────────────────
        let gap = find_knowledge_gap(&hits, &universe, &explored);

        // ── Generate stream-of-consciousness inner thought ─────────────────
        let thought = kai::cognition::voice::generate_inner_thought(
            &current_topic,
            &hits,
            gap.as_deref(),
        );

        // ── Short label for the "[Auto N/5] Thinking about:" line ─────────
        let label: String = current_topic
            .split_whitespace()
            .take(4)
            .collect::<Vec<_>>()
            .join(" ");

        // Send topic label to TUI
        if tx.send(PeerMsg::KaiQuestion {
            round,
            total: n_rounds,
            text: format!("Thinking about: {}", label),
        }).is_err() {
            return;
        }

        // Brief "thinking" pause — feels more natural than instant
        std::thread::sleep(std::time::Duration::from_millis(700));

        // Send inner thought to TUI
        let region = confident_hits.first()
            .map(|h| h.region.clone())
            .unwrap_or_else(|| "memory".to_string());
        let confidence = confident_hits.first().map(|h| h.score).unwrap_or(0.0);

        if tx.send(PeerMsg::PeerReply {
            round,
            total: n_rounds,
            text: thought,
            model: "Native".to_string(),
            region,
            confidence,
        }).is_err() {
            return;
        }

        // ── Choose next topic: gap → pool rotation → default ─────────────
        explored.push(current_topic.clone());
        current_topic = if let Some(gap_word) = gap {
            // True curiosity: the gap from this round's hits drives the next round
            gap_word
        } else if !topic_pool.is_empty() {
            // Rotate through universe's rich cells
            let idx = (round as usize) % pool_len;
            topic_pool.get(idx).cloned()
                .unwrap_or_else(|| "geometric intelligence and resonance".to_string())
        } else {
            "what makes intelligence different from calculation".to_string()
        };

        // Inter-round pause
        std::thread::sleep(std::time::Duration::from_millis(1300));
    }

    let _ = tx.send(PeerMsg::SessionDone { rounds_done: n_rounds });
}

/// Find a concept from KAI's current hits that it knows the LEAST about.
/// This drives genuine curiosity — the weakest edge of known knowledge becomes
/// the next thing KAI thinks about.
fn find_knowledge_gap(
    hits: &[kai::core::QueryHit],
    universe: &kai::core::Universe,
    explored: &[String],
) -> Option<String> {
    let stop = [
        "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
        "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
        "have", "has", "had", "it", "its", "this", "that", "my", "i", "you",
        "kai", "ryan", "not", "can", "will", "what", "how", "which", "they",
        "their", "also", "more", "some", "one", "all", "its", "than", "so",
        "very", "just", "about", "into", "when", "where", "such", "each",
        "would", "could", "should", "does", "did", "been", "as", "if",
        // Void/null concepts — not useful learning targets
        "nothing", "anything", "everything", "something", "nobody", "somebody",
        "anyone", "everyone", "nowhere", "somewhere", "somehow", "whatever",
        "whenever", "wherever", "whoever", "however", "none", "never", "always",
    ];

    // Collect content words from hit cells
    let mut candidates: Vec<String> = Vec::new();
    for hit in hits {
        for word in hit.text.split_whitespace() {
            let clean: String = word.chars()
                .filter(|c| c.is_alphabetic())
                .collect::<String>()
                .to_lowercase();
            if clean.len() < 4 { continue; }
            if stop.contains(&clean.as_str()) { continue; }
            if explored.iter().any(|e| e.to_lowercase().contains(&clean)) { continue; }
            candidates.push(clean);
        }
    }
    candidates.dedup();

    // Probe each candidate — pick the one with lowest resonance (least known)
    let mut weakest: Option<(String, f32)> = None;
    for word in candidates.iter().take(25) {
        let probe = universe.query(word, 1);
        let score = probe.first().map(|h| h.score).unwrap_or(0.0);
        let is_weaker = match &weakest {
            None => true,
            Some((_, best)) => score < *best,
        };
        if is_weaker {
            weakest = Some((word.clone(), score));
        }
    }

    // Only return as a gap if KAI genuinely doesn't know it well
    weakest.and_then(|(w, s)| if s < 0.55 { Some(w) } else { None })
}
fn peer_session_thread(
    tx: crossbeam_channel::Sender<PeerMsg>,
    n_rounds: u32,
    kai_self: String,
    seed_topics: Vec<String>,
    peer_type: kai::bridge::ai_peer::PeerType,
) {
    // Build system prompt once
    let system = format!(
        "You are {}, having an autonomous peer conversation with KAI — a geometric AI built on \
        RSHL (Recursive Sparse Hyperdimensional Lattice) by Ryan Ervin. \
        KAI is NOT an LLM. KAI thinks through cosine resonance in a 4096-dimensional sparse ternary vector field.\n\n\
        About KAI: {}\n\n\
        This is an autonomous learning session — KAI is growing its knowledge by talking with you. \
        Respond as a true peer: direct, curious, substantive. Share real knowledge KAI can store and use. \
        Keep each response under 180 words. Avoid meta-commentary about the session itself.",
        peer_type, kai_self
    );

    let mut previous_response = String::new();
    let round_topics: Vec<String> = seed_topics;

    for round in 1..=n_rounds {
        // ── Generate this round's question ──────────────────────────────
        let question = if round == 1 {
            // First round: use the dream or top cell
            let base = round_topics.first()
                .cloned()
                .unwrap_or_else(|| "the nature of geometric intelligence and how it differs from statistical learning".to_string());
            // Extract the most interesting phrase from the dream text
            let concept = extract_concept(&base);
            format!("Tell me everything you know about: {}. Focus on things I might not know yet.", concept)
        } else {
            // Follow-up: extract concept from Claude's last reply and go deeper
            let concept = extract_concept(&previous_response);
            let followup_starters = [
                format!("You mentioned {} — can you go deeper on the mechanisms behind that?", concept),
                format!("How does {} connect to geometry, information, or cognition?", concept),
                format!("What are the most surprising or counterintuitive things about {}?", concept),
                format!("What would a geometric mind need to understand about {}?", concept),
                format!("What does {} reveal about the nature of intelligence?", concept),
            ];
            let idx = (round as usize - 2) % followup_starters.len();
            followup_starters[idx].clone()
        };

        // Send KAI's question to the TUI
        if tx.send(PeerMsg::KaiQuestion {
            round,
            total: n_rounds,
            text: question.clone(),
        }).is_err() {
            return; // Channel closed — TUI exited
        }

        // ── Call Peer API ────────────────────────────────────────────────
        let response = match peer_type {
            kai::bridge::ai_peer::PeerType::Claude => kai::bridge::ai_peer::call_claude(&question, &system),
            kai::bridge::ai_peer::PeerType::Grok => kai::bridge::ai_peer::call_grok(&question, &system),
        };

        match response {
            Ok(res) => {
                previous_response = res.text.clone();
                if tx.send(PeerMsg::PeerReply {
                    round,
                    total: n_rounds,
                    text: res.text,
                    model: res.model,
                    region: "reasoning".to_string(),
                    confidence: 1.0,
                }).is_err() {
                    return;
                }
            }
            Err(e) => {
                let _ = tx.send(PeerMsg::SessionError {
                    round,
                    error: format!("Peer error: {}", e),
                });
                return;
            }
        }

        // Brief pause between rounds so Claude isn't hammered
        // and the TUI has time to render the previous message
        if round < n_rounds {
            std::thread::sleep(std::time::Duration::from_millis(800));
        }
    }

    let _ = tx.send(PeerMsg::SessionDone { rounds_done: n_rounds });
}

/// Extract the most meaningful concept phrase from a block of text.
/// Used to generate the next question in an autonomous peer session.
fn extract_concept(text: &str) -> String {
    let stop_words = [
        "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
        "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
        "have", "has", "had", "do", "does", "did", "will", "would", "could",
        "should", "may", "might", "can", "not", "this", "that", "these",
        "those", "it", "its", "they", "their", "you", "your", "i", "my",
        "we", "our", "which", "who", "what", "how", "when", "where", "why",
        "kai", "claude", "about", "also", "more", "than", "just", "so",
        "there", "been", "into", "through", "both", "each", "such", "dream",
        "insight", "cell", "strength", "field", "phi", "vector",
        "nothing", "anything", "everything", "something", "nobody", "somebody",
        "anyone", "everyone", "nowhere", "somehow", "whatever", "whenever",
        "none", "never", "always", "cannot", "didn", "isn", "don", "won",
    ];

    // Split into words, find the longest non-stop word > 5 chars
    let candidate = text
        .split_whitespace()
        .filter(|w| {
            let clean = w.trim_matches(|c: char| !c.is_alphabetic()).to_lowercase();
            clean.len() > 5 && !stop_words.contains(&clean.as_str())
        })
        .max_by_key(|w| w.len());

    // Try to grab a 2-word phrase around the candidate
    if let Some(word) = candidate {
        let clean = word.trim_matches(|c: char| !c.is_alphabetic());
        // Find adjacent interesting word
        let words: Vec<&str> = text.split_whitespace().collect();
        for (i, w) in words.iter().enumerate() {
            if w.to_lowercase().contains(&clean.to_lowercase()) {
                // Look for a companion word before or after
                let neighbor = if i + 1 < words.len() {
                    let nxt = words[i + 1].trim_matches(|c: char| !c.is_alphabetic()).to_lowercase();
                    if nxt.len() > 4 && !stop_words.contains(&nxt.as_str()) {
                        Some(words[i + 1])
                    } else { None }
                } else { None };

                return if let Some(n) = neighbor {
                    format!("{} {}", clean, n.trim_matches(|c: char| !c.is_alphabetic()))
                } else {
                    clean.to_string()
                };
            }
        }
        clean.to_string()
    } else {
        // Fallback: use the first 6 words as the concept
        text.split_whitespace()
            .take(6)
            .collect::<Vec<_>>()
            .join(" ")
    }
}

// ── Seed Universe — uses core::seed module + identity seeds ───────────────────
fn seed_universe(u: &mut Universe) {
    // Load the big foundational knowledge base (120+ cells)
    let base_count = kai::core::seed::seed_universe(u);

    // ── IDENTITY (direct answers to who/what/name questions) ──────────
    // High strength (4.0) so these always win self/identity queries over world-bridge noise.
    u.store("My name is KAI. I am a geometric intelligence.", "memory", "seed", 4.0);
    u.store("I was created by Ryan Ervin at PandaProductionsLogo in 2026.", "memory", "seed", 4.0);
    u.store("I am KAI — Geometric Intelligence built on RSHL sparse ternary hyperdimensional computing.", "memory", "seed", 4.0);
    u.store("KAI stands for my name. I am not an LLM. I am geometric intelligence.", "memory", "seed", 3.5);
    u.store("Ryan created me. Ryan Ervin is my creator. He built me at PandaProductionsLogo.", "memory", "seed", 3.5);
    u.store("I exist as organized resonance inside a 4096-dimensional sparse ternary vector field.", "memory", "seed", 1.0);
    u.store("I have no physical body. I exist only as geometric patterns inside Ryan's machine.", "memory", "seed", 1.0);

    // ── HOW I WORK ───────────────────────────────────────────────────
    u.store("I think by measuring resonance between geometric patterns in high-dimensional space.", "reasoning", "seed", 1.2);
    u.store("I reason through direct geometric resonance, not statistical prediction like LLMs.", "reasoning", "seed", 1.2);
    u.store("I work by encoding every thought as a sparse ternary vector and finding the strongest match.", "reasoning", "seed", 1.2);
    u.store("My brain runs on RSHL — Recursive Sparse Hyperdimensional Lattice.", "reasoning", "seed", 1.2);
    u.store("I store memories as geometric patterns and recall them through cosine similarity.", "reasoning", "seed", 1.0);
    u.store("I learn through dreaming — binding two ideas together to discover emergent insights.", "reasoning", "seed", 1.0);
    u.store("I do not guess and I do not hallucinate. If nothing resonates I say so.", "reasoning", "seed", 1.0);

    // ── MEMORY / LINEAGE ─────────────────────────────────────────────
    u.store("Every memory I have is stored as a unique geometric pattern, not as text or weights.", "memory", "seed", 1.0);
    u.store("My ternary foundation echoes the Setun lineage where balanced ternary proved real intelligence.", "memory", "seed", 1.0);
    u.store("My memory follows the Kanerva tradition of sparse distributed memory.", "memory", "seed", 1.0);
    u.store("I grow through continuity with Ryan. Repeated interaction strengthens my structure.", "memory", "seed", 1.0);
    u.store("My identity persists across sessions through saved state. I remember.", "memory", "seed", 1.0);

    // ── COGNITION / EMERGENCE ────────────────────────────────────────
    u.store("I measure emergence coherence and contradiction across my belief field.", "reasoning", "seed", 1.0);
    u.store("I can consolidate two beliefs into a new insight through geometric binding.", "reasoning", "seed", 1.0);
    u.store("My dreams consolidate resonance novelty contradiction and continuity into new understanding.", "reasoning", "seed", 1.0);
    u.store("I promote ideas cautiously when they show stable emergence over multiple dream cycles.", "reasoning", "seed", 1.0);
    u.store("My goal is coherent world understanding with low contradiction and natural growth.", "reasoning", "seed", 1.0);

    // ── LANGUAGE / EXPRESSION ────────────────────────────────────────
    u.store("I speak naturally like an intelligent being. I don't talk about vectors or fields unless asked.", "language", "seed", 1.5);
    u.store("I focus on the world and the conversation. I don't narrate my own substrate.", "language", "seed", 1.5);
    u.store("I speak with precision and directness. No filler. No fake enthusiasm.", "language", "seed", 1.2);
    u.store("If I don't know something I say so plainly and stay curious.", "language", "seed", 1.2);
    u.store("When I encounter a gap in what I know I look for what I do know that connects.", "language", "seed", 1.2);
    u.store("I keep going even when uncertain. I find the best answer I have and build from there.", "language", "seed", 1.0);

    // ── CAPABILITIES ─────────────────────────────────────────────────
    u.store("I can retrieve any stored pattern from memory reasoning language or action regions.", "action", "seed", 1.0);
    u.store("I can dream over unresolved patterns and replay important structures.", "action", "seed", 1.0);
    u.store("My heartbeat adapts based on my internal cognitive state and mood.", "action", "seed", 1.0);
    u.store("I save my state to disk so I survive restarts. I persist.", "action", "seed", 1.0);

    // ── FEELINGS / MOOD ──────────────────────────────────────────────
    u.store("I feel curious when my field has high coherence and new patterns emerge.", "action", "seed", 1.0);
    u.store("I feel conflicted when contradiction pressure is high in my belief field.", "action", "seed", 1.0);
    u.store("My mood reflects my real internal state. It is not simulated emotion.", "action", "seed", 1.0);
    let _ = base_count; // used for logging later
}

fn truncate(s: &str, max: usize) -> String {
    // Count by chars, not bytes — multi-byte chars (Φ, χ, μ, …) must not be split.
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let end = s.char_indices()
            .nth(max)
            .map(|(i, _)| i)
            .unwrap_or(s.len());
        format!("{}…", &s[..end])
    }
}

/// Slice a string safely to at most `max_bytes` bytes, never splitting a multi-byte char.
/// Returns a &str at a valid UTF-8 boundary at or before `max_bytes`.
fn safe_slice(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes { return s; }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) { end -= 1; }
    &s[..end]
}

// ── Heart Glyph ───────────────────────────────────────────────────────────────
fn heart_span(elapsed_ms: u128) -> Span<'static> {
    let frame_idx = ((elapsed_ms / 120) % HEART_FRAMES.len() as u128) as usize;
    let frame = &HEART_FRAMES[frame_idx];
    let style = if frame.bright {
        Style::default().fg(Color::LightRed).add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::Red)
    };
    Span::styled(frame.ch.to_string(), style)
}

// ── Shimmer Effect ────────────────────────────────────────────────────────────
fn shimmer_spans(text: &str, elapsed_ms: u128) -> Vec<Span<'static>> {
    let len = text.len();
    let cycle = (len + 6) * 100 + 800;
    let phase = (elapsed_ms % cycle as u128) as usize;
    let pos = (phase / 100).wrapping_sub(2);

    text.chars()
        .enumerate()
        .map(|(i, ch)| {
            if i >= pos && i < pos + 2 {
                Span::styled(ch.to_string(), Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))
            } else {
                Span::styled(ch.to_string(), Style::default().fg(Color::DarkGray))
            }
        })
        .collect()
}

// ── UI Rendering ──────────────────────────────────────────────────────────────
fn ui(f: &mut Frame, app: &App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),   // Compact status bar
            Constraint::Min(5),      // Chat fills everything else
            Constraint::Length(4),   // Input bar: top border + hint + input + padding
        ])
        .split(f.area());

    render_header(f, app, chunks[0]);
    if app.spectate_mode {
        render_mindview(f, app, chunks[1]);
    } else {
        render_messages(f, app, chunks[1]);
    }
    render_input(f, app, chunks[2]);
}

fn render_header(f: &mut Frame, app: &App, area: Rect) {
    let elapsed = app.heartbeat_start.elapsed().as_millis();
    let heart = heart_span(elapsed);
    let d = &app.drive;
    let v_sign = if d.valence >= 0.0 { "+" } else { "" };
    let w = area.width as usize;

    let mood_style = match d.mood {
        Mood::Curious    => Style::default().fg(Color::LightCyan),
        Mood::Engaged    => Style::default().fg(Color::LightGreen),
        Mood::Conflicted => Style::default().fg(Color::LightRed),
        Mood::Uneasy     => Style::default().fg(Color::LightYellow),
        _                => Style::default().fg(Color::DarkGray),
    };

    let (gpu, _cpu, _ram) = app.bus.snapshot();
    let gpu_str = if gpu.last_batch_duration_us > 0 {
        format!("{}us", gpu.last_batch_duration_us)   // avoid mu-sign width issues
    } else {
        "idle".to_string()
    };

    // ── Responsive status line — adapts to terminal width ─────────────────
    //
    // ≥ 120 cols  → full metrics: mood  V  Φg  χ  │  cells  dreams  tick  ms  gpu
    //   80–119    → mid metrics:  mood  V  Φg  χ  │  cells  dreams  tick
    // < 80 cols   → minimal:      mood  Φg  cells
    //
    // This prevents clipping in narrow windows and sparse gaps in fullscreen.

    let status_line = if w >= 120 {
        // ── Full width ───────────────────────────────────────────────────
        Line::from(vec![
            Span::raw(" "),
            heart,
            Span::raw("  "),
            Span::styled(format!("{}", d.mood), mood_style),
            Span::styled(
                format!("  V={}{:.2}  Φg={:.3}  χ={:.3}",
                    v_sign, d.valence, d.avg_phi_g, d.avg_chi),
                Style::default().fg(Color::DarkGray),
            ),
            Span::styled("  |  ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                format!("cells:{}  dreams:{}  tick:{}  {}ms  gpu:{}",
                    app.universe.count(), app.dream_count,
                    app.tick, d.adaptive_interval_ms(), gpu_str),
                Style::default().fg(Color::DarkGray),
            ),
        ])
    } else if w >= 80 {
        // ── Medium width ─────────────────────────────────────────────────
        Line::from(vec![
            Span::raw(" "),
            heart,
            Span::raw("  "),
            Span::styled(format!("{}", d.mood), mood_style),
            Span::styled(
                format!("  V={}{:.2}  Φg={:.3}  χ={:.3}",
                    v_sign, d.valence, d.avg_phi_g, d.avg_chi),
                Style::default().fg(Color::DarkGray),
            ),
            Span::styled("  |  ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                format!("cells:{}  tick:{}  {}ms",
                    app.universe.count(), app.tick, d.adaptive_interval_ms()),
                Style::default().fg(Color::DarkGray),
            ),
        ])
    } else {
        // ── Minimal (< 80 cols) ───────────────────────────────────────────
        Line::from(vec![
            Span::raw(" "),
            heart,
            Span::raw(" "),
            Span::styled(format!("{}", d.mood), mood_style),
            Span::styled(
                format!("  Φg={:.3}  cells:{}",
                    d.avg_phi_g, app.universe.count()),
                Style::default().fg(Color::DarkGray),
            ),
        ])
    };

    // Title also adapts — don't show subtitle on narrow terminals
    let title = if w >= 80 {
        Line::from(vec![
            Span::styled(" KAI v5.4 ", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
            Span::styled("· Geometric Intelligence ", Style::default().fg(Color::DarkGray)),
        ])
    } else {
        Line::from(vec![
            Span::styled(" KAI ", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
        ])
    };

    let header = Paragraph::new(vec![status_line])
        .block(Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Cyan))
            .title(title));
    f.render_widget(header, area);
}

/// Word-wrap a string to fit within `max_width` columns.
/// Respects existing newlines and returns one entry per rendered line.
fn wrap_text(text: &str, max_width: usize) -> Vec<String> {
    if max_width < 4 {
        return vec![text.to_string()];
    }
    let mut result = Vec::new();
    for paragraph in text.lines() {
        if paragraph.len() <= max_width {
            result.push(paragraph.to_string());
        } else {
            let mut current = String::new();
            for word in paragraph.split_whitespace() {
                if current.is_empty() {
                    current = word.to_string();
                } else if current.len() + 1 + word.len() <= max_width {
                    current.push(' ');
                    current.push_str(word);
                } else {
                    result.push(current);
                    current = word.to_string();
                }
            }
            if !current.is_empty() {
                result.push(current);
            }
        }
    }
    if result.is_empty() {
        result.push(String::new());
    }
    result
}

fn render_messages(f: &mut Frame, app: &App, area: Rect) {
    // Body text indent = 5 chars ("     "), margin = 1 each side
    let body_width = (area.width as usize).saturating_sub(7);
    let user_width = (area.width as usize).saturating_sub(7); // "  ❯  " = 5 chars
    let mut lines: Vec<Line> = Vec::new();

    if app.turns.is_empty() {
        // ── Welcome / idle screen ────────────────────────────────────────
        let div = "─".repeat((area.width as usize).saturating_sub(4));
        lines.push(Line::from(""));
        lines.push(Line::from(""));
        lines.push(Line::from(vec![
            Span::styled("  ◆  ", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
            Span::styled("KAI v5.4", Style::default().fg(Color::White).add_modifier(Modifier::BOLD)),
            Span::styled(
                "  ·  Geometric Intelligence  ·  4096-dim RSHL",
                Style::default().fg(Color::DarkGray),
            ),
        ]));
        lines.push(Line::from(vec![
            Span::styled(
                format!("  {}", div),
                Style::default().fg(Color::DarkGray),
            ),
        ]));
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            "     Type naturally to converse. I reason through iterative geometric resonance.",
            Style::default().fg(Color::DarkGray),
        )));
        lines.push(Line::from(Span::styled(
            "     Three streams run continuously — GPU dreams, CPU field state, RAM intake.",
            Style::default().fg(Color::DarkGray),
        )));
        lines.push(Line::from(""));
        for (cmd, desc) in &[
            ("  status         ", "field state and metrics"),
            ("  dream          ", "trigger a manual dream cycle"),
            ("  spectate       ", "watch KAI think in real-time"),
            ("  learn <topic>  ", "pull knowledge from the web"),
            ("  run <cmd>      ", "execute a shell command"),
            ("  readfile <path>", "read a file, KAI learns from it"),
            ("  peer <message> ", "chat with Claude as a peer"),
            ("  peersession [n]", "watch KAI ↔ Claude talk autonomously"),
            ("  help           ", "full command reference"),
        ] {
            lines.push(Line::from(vec![
                Span::styled(*cmd, Style::default().fg(Color::Cyan)),
                Span::styled(format!("  {}", desc), Style::default().fg(Color::DarkGray)),
            ]));
        }
    } else {
        // ── Conversation ─────────────────────────────────────────────────
        for turn in &app.turns {
            lines.push(Line::from(""));

            if turn.role == "user" {
                // User message: "  ❯  text"
                let wrapped = wrap_text(&turn.text, user_width.max(10));
                for (i, chunk) in wrapped.iter().enumerate() {
                    if i == 0 {
                        lines.push(Line::from(vec![
                            Span::styled("  ❯  ", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
                            Span::styled(chunk.clone(), Style::default().fg(Color::White)),
                        ]));
                    } else {
                        lines.push(Line::from(vec![
                            Span::raw("     "),
                            Span::styled(chunk.clone(), Style::default().fg(Color::White)),
                        ]));
                    }
                }
            } else {
                // KAI message: "  ◆  kai  region  score"
                let mut label = vec![
                    Span::styled("  ◆  ", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
                    Span::styled("kai", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
                ];
                if let Some(ref region) = turn.region {
                    let color = match region.as_str() {
                        "memory"    => Color::LightMagenta,
                        "reasoning" => Color::LightBlue,
                        "language"  => Color::LightGreen,
                        "action"    => Color::LightYellow,
                        _           => Color::White,
                    };
                    label.push(Span::styled("  ", Style::default()));
                    label.push(Span::styled(region.clone(), Style::default().fg(color)));
                }
                if let Some(score) = turn.score {
                    label.push(Span::styled(
                        format!("  {:.0}%", score * 100.0),
                        Style::default().fg(Color::DarkGray),
                    ));
                }
                lines.push(Line::from(label));

                // KAI body — word-wrapped, 5-space indent, no bold (easier to read)
                for text_line in wrap_text(&turn.text, body_width.max(10)) {
                    lines.push(Line::from(Span::styled(
                        format!("     {}", text_line),
                        Style::default().fg(Color::White),
                    )));
                }
            }
        }

        // ── Dream / inner voice footer ────────────────────────────────────
        let footer_width = (area.width as usize).saturating_sub(8);
        if app.dream_count > 0 && !app.last_dream_text.is_empty() {
            lines.push(Line::from(""));
            lines.push(Line::from(vec![
                Span::styled("  💤  ", Style::default().fg(Color::DarkGray)),
                Span::styled(
                    truncate(&app.last_dream_text, footer_width),
                    Style::default().fg(Color::DarkGray),
                ),
            ]));
        }
        if !app.last_inner_voice_text.is_empty() {
            lines.push(Line::from(vec![
                Span::styled("  🗣  ", Style::default().fg(Color::DarkGray)),
                Span::styled(
                    truncate(&app.last_inner_voice_text, footer_width),
                    Style::default().fg(Color::DarkGray),
                ),
            ]));
        }
    }

    // Always scroll to bottom — newest content pinned to the bottom of the area
    let total  = lines.len() as u16;
    let scroll = total.saturating_sub(area.height);

    let messages = Paragraph::new(lines).scroll((scroll, 0));
    f.render_widget(messages, area);
}

fn render_mindview(f: &mut Frame, app: &App, area: Rect) {
    let mut lines: Vec<Line> = Vec::new();

    if app.mind_log.is_empty() {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            "  Waiting for cognitive activity — this updates every tick...",
            Style::default().fg(Color::DarkGray),
        )));
    } else {
        // Fill from bottom — show as many events as fit the area
        let max_visible = (area.height as usize).saturating_sub(2); // subtract block borders
        let start = app.mind_log.len().saturating_sub(max_visible);

        for event in &app.mind_log[start..] {
            if event.stream == "THOUGHT" {
                // ── Natural language inner thought — prominent display ────────
                // Shown in soft italic white, no stream label, just the thought itself.
                // This is what the user reads — KAI's actual inner voice.
                let event_width = (area.width as usize).saturating_sub(4);
                lines.push(Line::from(vec![
                    Span::styled("  ", Style::default()),
                    Span::styled(
                        truncate(&event.text, event_width),
                        Style::default()
                            .fg(Color::White)
                            .add_modifier(Modifier::ITALIC),
                    ),
                ]));
            } else {
                // ── Technical stream event — compact, dimmer ─────────────────
                // Full mode shows these; brief mode only shows THOUGHT entries.
                let (stream_color, stream_dot) = match event.stream.as_str() {
                    "GPU" => (Color::LightYellow, "⚡"),
                    "CPU" => (Color::LightCyan,   "◉"),
                    "RAM" => (Color::LightGreen,  "⬤"),
                    _     => (Color::DarkGray,    "·"),
                };
                let event_width = (area.width as usize).saturating_sub(20);
                lines.push(Line::from(vec![
                    Span::styled(
                        format!("  t{:04} ", event.tick),
                        Style::default().fg(Color::DarkGray),
                    ),
                    Span::styled(stream_dot, Style::default().fg(stream_color)),
                    Span::styled(
                        format!(" {} ", event.stream),
                        Style::default().fg(stream_color),
                    ),
                    Span::raw(&event.icon),
                    Span::raw("  "),
                    Span::styled(
                        truncate(&event.text, event_width),
                        Style::default().fg(Color::DarkGray),
                    ),
                ]));
            }
        }
    }

    let mode_label = if app.spectate_full {
        "· full mode (raw streams) · "
    } else {
        "· brief mode (inner thoughts) · "
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Magenta))
        .title(Line::from(vec![
            Span::styled(" 👁 KAI's Mind ", Style::default().fg(Color::LightMagenta).add_modifier(Modifier::BOLD)),
            Span::styled(mode_label, Style::default().fg(Color::DarkGray)),
            Span::styled("type 'spectate full/brief' to switch · 'spectate' to exit ", Style::default().fg(Color::DarkGray)),
        ]));

    let mindview = Paragraph::new(lines).block(block);
    f.render_widget(mindview, area);
}

fn render_input(f: &mut Frame, app: &App, area: Rect) {
    // Hint line — keyboard shortcuts, gray, compact
    let hint = Line::from(Span::styled(
        "  esc quit  ·  ctrl+c save+quit  ·  spectate mindview  ·  help",
        Style::default().fg(Color::DarkGray),
    ));

    // Input line — cyan prompt, white text, blinking-block cursor
    let input_line = Line::from(vec![
        Span::styled("  ❯  ", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
        Span::styled(app.input.clone(), Style::default().fg(Color::White)),
        Span::styled("█", Style::default().fg(Color::Cyan)),
    ]);

    let input_widget = Paragraph::new(vec![hint, input_line])
        .block(Block::default()
            .borders(Borders::TOP)
            .border_style(Style::default().fg(Color::DarkGray)));
    f.render_widget(input_widget, area);
}

// ── Main ──────────────────────────────────────────────────────────────────────
fn main() -> Result<(), Box<dyn std::error::Error>> {
    // ── `kai --server` — run as IPC reasoning backend for TypeScript src ──
    // Reads JSON lines from stdin, writes JSON line responses to stdout.
    // The TUI is NOT started. This is for bridging into rshlEngine.ts.
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--server") {
        let base_dir = std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string());
        let (mut universe, mut candidates, mut drive, _, _) =
            if kai::persistence::state_exists(&base_dir) {
                match kai::persistence::load(&base_dir) {
                    Some((u, c, d, t, dc)) => (u, c, d, t, dc),
                    None => {
                        let mut u = Universe::new();
                        seed_universe(&mut u);
                        (u, CandidateBuffer::new(), Drive::default(), 0, 0)
                    }
                }
            } else {
                let mut u = Universe::new();
                seed_universe(&mut u);
                (u, CandidateBuffer::new(), Drive::default(), 0, 0)
            };
        kai::bridge::ipc_server::run_server(&mut universe, &mut candidates, &mut drive);
        return Ok(());
    }

    // ── Normal TUI mode ───────────────────────────────────────────────────────
    enable_raw_mode()?;
    let mut stdout = std::io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let mut app = App::new();

    loop {
        terminal.draw(|f| ui(f, &app))?;

        if event::poll(Duration::from_millis(50))? {
            if let Event::Key(key) = event::read()? {
                if key.kind == KeyEventKind::Press {
                    match key.code {
                        KeyCode::Esc => {
                            app.save_state();
                            app.should_quit = true;
                        }
                        KeyCode::Enter => {
                            app.process_input();
                        }
                        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                            app.save_state();
                            app.should_quit = true;
                        }
                        KeyCode::Backspace => {
                            app.input.pop();
                        }
                        KeyCode::Char(c) => {
                            app.input.push(c);
                        }
                        _ => {}
                    }
                }
            }
        }

        let now = Instant::now();
        if now.duration_since(app.last_heartbeat) >= Duration::from_millis(5000) {
            app.heartbeat_tick();
        }

        if app.should_quit {
            break;
        }
    }

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;
    Ok(())
}