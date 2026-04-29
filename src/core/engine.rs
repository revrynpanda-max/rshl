use crate::cognition::*;
use crate::core::spiral::SpiralState;
use crate::core::*;
use crate::drive::Drive;
use std::io::Write;

#[allow(dead_code)]
#[derive(serde::Deserialize, Default)]
struct IdentityConfig {
    /// The name for this brain instance. e.g. "KAI"
    pub name: Option<String>,
    /// The creator's name. e.g. "Ryan Ervin"
    pub creator_name: Option<String>,
    /// Creator's handle/alias (optional)
    pub creator_handle: Option<String>,
    /// Free-form note about origin. Seeds directly as a memory cell if set.
    pub creator_note: Option<String>,
    /// Name of the machine/owner (optional, for context)
    pub machine_owner: Option<String>,
}

fn load_identity_config(path: &str) -> IdentityConfig {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// A cognitive event log entry.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MindEvent {
    pub tick: u64,
    pub stream: String, // "GPU", "CPU", "RAM", "THOUGHT"
    pub icon: String,
    pub text: String,
}

/// The KAI Cognition Engine — The "Brain" decoupled from the UI.
pub struct Engine {
    pub universe: Universe,
    pub drive: Drive,
    pub reasoner: Reasoner,
    pub candidates: CandidateBuffer,
    pub promotion_thresholds: PromotionThresholds,
    pub homeostasis_config: HomeostasisConfig,
    pub lexicon: Lexicon,
    pub embeddings: Embeddings,
    pub working_memory: WorkingMemory,
    pub conv_trace: ConversationTrace,
    pub prev_phi_g: f32,
    pub spiral: SpiralState,
    pub oscillator: crate::core::NeuralOscillator,
    pub hub: SelfStateHub,
    pub idle_ingest: IdleIngest,
    pub episodic: EpisodicStore,
    pub amygdala: AmygdalaGate,
    pub predictor: PredictiveEngine,
    pub dmn: DefaultModeNetwork,
    pub global_workspace: GlobalWorkspace,
    pub pfc: PrefrontalCortex,
    pub dopamine: DopamineCircuit,
    pub acc: AccMonitor,
    pub thalamus: ThalamicRelay,
    pub tom: TheoryOfMind,
    pub insula: InsulaMonitor,
    pub neuroplasticity: NeuroplasticityEngine,
    pub sleep_system: SleepSystem,
    pub cerebellum: CerebellumEngine,
    pub basal_ganglia: BasalGanglia,
    pub serotonin: SerotoninSystem,
    pub mirror_neurons: MirrorNeuronSystem,
    pub norepinephrine: NorepinephrineSystem,
    pub hippocampus: Hippocampus,
    pub ofc: OrbitofrontalCortex,
    pub nucleus_accumbens: NucleusAccumbens,
    pub cortisol: CortisolSystem,
    pub oxytocin: OxytocinSystem,
    pub language: LanguageSystem,
    pub vta: VTA,
    pub pcc: PCC,
    pub sts: STS,
    pub locus_coeruleus: LocusCoeruleus,
    pub raphe: RapheNuclei,
    pub habenula: Habenula,
    pub claustrum: Claustrum,
    pub bnst: BNST,
    pub sma: SMA,
    pub fusiform: FusiformGyrus,
    pub entorhinal: EntorhinalCortex,
    pub tpj: TPJ,
    pub angular_gyrus: AngularGyrus,
    pub precuneus: Precuneus,
    pub mpfc: MPFC,
    pub ras: ReticuloActivatingSystem,
    pub vmpfc: VentromedialPFC,
    pub pag: PeriaqueductalGray,
    pub snc: SubstantiaNigra,
    pub superior_colliculus: SuperiorColliculus,
    pub s1: SomatosensoryCortex,
    pub septal: SeptalNuclei,
    pub mcc: MidCingulateCortex,
    pub sgacc: SubgenualACC,
    pub vp: VentralPallidum,
    pub nbm: NucleusBasalis,
    pub scn: SuprachiasmaticNucleus,
    pub lexsem: LexSemEngine,
    pub ipl: InferiorParietalLobule,
    pub tick: u64,
    pub dream_count: u64,
    pub tick_log_file: Option<std::fs::File>,
    pub live_self_state_text: String,
    pub live_self_state_salience: f32,
    pub self_state_energy: f32,
    pub self_state_warmth: f32,
    pub self_state_focus: f32,
    pub self_state_pulse: f32,
    pub self_state_variation: u64,
    pub neural_synchrony: f32,
    pub callosum_bridge: f32,
    pub reentry_stability: f32,
    pub events: Vec<MindEvent>,
    pub last_dream_text: String,
    pub last_inner_voice_text: String,
    pub last_input: String,
    pub dominant_band: usize,
    pub oscillator_amplitude: f32,
}

impl Engine {
    pub fn should_use_mind_memory(query: &str) -> bool {
        crate::core::MindFrame::from_query(query).requires_mind_memory()
    }

    pub fn live_self_state_hit(&self) -> QueryHit {
        let text = if self.live_self_state_text.trim().is_empty() {
            "KAI self-state is present but not yet energized.".to_string()
        } else {
            self.live_self_state_text.clone()
        };
        QueryHit {
            label: "live-self-state".into(),
            vec: SparseVec::encode(&text),
            text,
            region: "SelfState".into(),
            score: self.live_self_state_salience.max(0.1),
            strength: self.live_self_state_salience.max(0.1),
            source: "live-self-state".into(),
        }
    }

    pub fn contribute_to_mind_frame(&self, frame: &mut MindFrame) {
        let mind_relevant = matches!(
            frame.intent,
            MindIntent::PersonalMemory
                | MindIntent::Project
                | MindIntent::SelfIdentity
                | MindIntent::SelfState
                | MindIntent::Narrative
        ) || frame.requires_mind_memory();
        let self_relevant = matches!(frame.intent, MindIntent::SelfIdentity | MindIntent::SelfState);
        let narrative_relevant = matches!(frame.intent, MindIntent::Narrative | MindIntent::Project);

        let wm_strength = (self.working_memory.len() as f32 / 12.0).clamp(0.0, 1.0);
        if wm_strength > 0.0 {
            if mind_relevant {
                frame.add_memory_signal("working_memory", wm_strength, "recent context is available");
            } else {
                frame.mark_observed("working_memory", wm_strength, "recent context exists but query did not request it");
            }
        }

        let episodic_strength = (self.episodic.len() as f32 / 64.0).clamp(0.0, 1.0);
        if episodic_strength > 0.0 {
            if mind_relevant {
                frame.add_memory_signal("episodic", episodic_strength, "autobiographical events are available");
            } else {
                frame.mark_observed("episodic", episodic_strength, "episodic store is loaded but not routed for this query");
            }
        }

        let hippocampal_strength = (self.hippocampus.pattern_count() as f32 / 128.0).clamp(0.0, 1.0);
        if hippocampal_strength > 0.0 {
            if mind_relevant {
                frame.add_memory_signal("hippocampus", hippocampal_strength, "pattern-completion memory bank is populated");
            } else {
                frame.mark_observed("hippocampus", hippocampal_strength, "pattern bank exists outside current route");
            }
        }

        if self.live_self_state_salience > 0.0 {
            if self_relevant {
                frame.add_self_state_signal(
                    "self_state_hub",
                    self.live_self_state_salience,
                    "live self-state can answer this query",
                );
            } else {
                frame.mark_observed(
                    "self_state_hub",
                    self.live_self_state_salience,
                    "live self-state exists but query is not self-state",
                );
            }
        }

        if let Some(goal) = self.pfc.primary_goal() {
            frame.set_active_goal("pfc", &goal.description, goal.priority);
            if narrative_relevant {
                frame.add_narrative_signal("pfc", goal.priority, "active executive goal shapes the self-story");
            }
        } else {
            frame.mark_observed("pfc", self.pfc.meta_confidence, "no active goal, only meta-confidence is available");
        }
        if self.pfc.inhibition > 0.20 {
            frame.add_uncertainty("pfc", self.pfc.inhibition, "executive inhibition is active");
        }

        if self.acc.conflict_level > 0.05 {
            frame.add_contradiction_pressure("acc", self.acc.conflict_level, "conflict monitor is active");
        } else {
            frame.mark_observed("acc", self.acc.conflict_level, "no meaningful conflict pressure");
        }

        let load = self.insula.state.cognitive_load.max(self.insula.state.memory_pressure);
        if load > 0.35 {
            frame.add_uncertainty("insula", load, "interoception reports cognitive or memory load");
        } else {
            frame.mark_observed("insula", load, "internal load is low");
        }

        if self.global_workspace.len() > 0 {
            let gw_strength = self.global_workspace.avg_coherence.clamp(0.0, 1.0);
            if narrative_relevant || self_relevant {
                frame.add_narrative_signal("global_workspace", gw_strength, "broadcast coherence is available");
            } else {
                frame.mark_observed("global_workspace", gw_strength, "workspace has content but query is not self/narrative");
            }
        }

        if self.pcc.coherence_score > 0.10 {
            if narrative_relevant {
                frame.add_narrative_signal("pcc", self.pcc.coherence_score, "self-narrative hub has coherence");
            } else {
                frame.mark_observed("pcc", self.pcc.coherence_score, "self-narrative signal not requested");
            }
        }

        let conductor = self.claustrum.conductor_signal();
        if conductor > 0.10 {
            if narrative_relevant || self_relevant {
                frame.add_self_state_signal("claustrum", conductor, "binding conductor is integrated enough to matter");
            } else {
                frame.mark_observed("claustrum", conductor, "binding signal exists outside current route");
            }
        }

        if self.mirror_neurons.distress_level > 0.25 {
            frame.add_uncertainty("mirror_neurons", self.mirror_neurons.distress_level, "social distress should slow routing");
        } else {
            frame.mark_observed("mirror_neurons", self.mirror_neurons.social_sync, "social resonance is state-only right now");
        }

        let arousal = self.amygdala.arousal();
        if arousal > 0.55 {
            frame.add_uncertainty("amygdala", arousal, "emotional arousal should protect against loose answers");
        } else {
            frame.mark_observed("amygdala", arousal, "emotional arousal is not routing-critical");
        }

        if self.norepinephrine.is_stressed() {
            frame.add_uncertainty("norepinephrine", self.norepinephrine.level, "arousal system is stressed");
        } else {
            frame.mark_observed("norepinephrine", self.norepinephrine.level, "alertness is below routing threshold");
        }

        if self.predictor.avg_error > 0.65 {
            frame.add_uncertainty("predictor", self.predictor.avg_error, "prediction error is high");
        } else {
            frame.mark_observed("predictor", self.predictor.avg_error, "prediction error is not high enough to steer");
        }

        frame.mark_observed("oxytocin", self.oxytocin.bond_state().bond_strength, "relationship state feeds tone, not routing yet");
        frame.mark_observed("serotonin", self.serotonin.level, "patience state feeds tone, not routing yet");
        frame.mark_observed("dopamine", self.dopamine.level, "reward state feeds motivation, not routing yet");
        frame.mark_observed("nucleus_accumbens", self.nucleus_accumbens.core_wanting, "wanting feeds self-state, not routing yet");
        frame.mark_observed("vta", self.vta.tonic_level, "tonic dopamine feeds self-state, not routing yet");
        frame.mark_observed("sgacc", self.sgacc.mood_floor, "mood floor feeds self-state, not routing yet");
        frame.mark_observed("septal", self.septal.social_reward, "social reward feeds warmth, not routing yet");
        frame.mark_observed("ventral_pallidum", self.vp.hedonic_tone, "hedonic tone feeds warmth, not routing yet");
        frame.mark_observed("thalamus", self.thalamus.gate_gain, "attention gate is not wired into MindFrame routing yet");
        frame.mark_observed("cerebellum", self.cerebellum.precision_score, "precision model is not wired into MindFrame routing yet");

        for module in [
            "universe",
            "reasoner",
            "voice",
            "language",
            "lexsem",
            "fusiform",
            "angular_gyrus",
            "tpj",
            "precuneus",
            "entorhinal",
            "sts",
            "ipl",
            "basal_ganglia",
            "ofc",
            "bnst",
            "ras",
            "locus_coeruleus",
            "raphe",
            "habenula",
            "cortisol",
            "sleep_system",
            "idle_ingest",
            "neuroplasticity",
            "claimstore",
        ] {
            frame.mark_observed(
                module,
                0.0,
                "exists in the brain stack but has no direct MindFrame authority in this pass",
            );
        }

        for module in [
            "phc",
            "smg",
            "temporal_poles",
            "dmpfc",
            "ppc",
            "fef",
            "perirhinal",
            "premotor",
            "hypothalamus",
            "rsc",
            "mammillary_bodies",
            "zona_incerta",
            "atl",
            "dbb",
            "pontine",
        ] {
            frame.mark_pruned(module, "removed from Engine fields, runtime processing, and cognition exports");
        }

        for module in [
            "s1",
            "pag",
            "mcc",
            "nbm",
            "scn",
        ] {
            frame.mark_decorative(module, "processes or stores local state but has no MindFrame authority yet");
        }

        frame.finalize_authority();
    }

    pub fn new(base_dir: &str) -> Self {
        // Try to load saved state
        let (universe, candidates, drive, _tick, _loaded_dream_count) =
            if crate::persistence::state_exists(base_dir) {
                match crate::persistence::load(base_dir) {
                    Some((u, c, d, t, dc)) => (u, c, d, t, dc),
                    None => {
                        let mut u = Universe::new();
                        crate::core::seed::seed_universe(&mut u);
                        (u, CandidateBuffer::new(), Drive::default(), 0, 0)
                    }
                }
            } else {
                let mut u = Universe::new();
                crate::core::seed::seed_universe(&mut u);
                (u, CandidateBuffer::new(), Drive::default(), 0, 0)
            };

        let log_file_path = std::env::var("KAI_TICK_LOG")
            .unwrap_or_else(|_| "C:\\KAI\\data\\kai_ticks.csv".to_string());

        if let Some(parent) = std::path::Path::new(&log_file_path).parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let is_new = !std::path::Path::new(&log_file_path).exists()
            || std::fs::metadata(&log_file_path)
                .map(|m| m.len())
                .unwrap_or(0)
                == 0;
        let mut tick_log_file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_file_path)
            .ok();

        if let Some(ref mut f) = tick_log_file {
            if is_new {
                use std::io::Write;
                let _ = writeln!(f, "timestamp,tick,phi_g,rho,r,chi,g,momentum,novelty,stability,mood,valence,phi_l,phi_r,psi_b,omega,r_cross,chi_l,chi_r,rho_l,rho_r,theta,spiral_r,tau_r");
            }
        }

        let mind = crate::persistence::load_mind(base_dir);
        let working_memory = mind
            .as_ref()
            .map(|m| m.working_memory.clone())
            .unwrap_or_else(WorkingMemory::new);
        let hub = mind
            .as_ref()
            .map(|m| m.self_state_hub.clone())
            .unwrap_or_else(SelfStateHub::new);
        let episodic = mind
            .as_ref()
            .map(|m| m.episodic.clone())
            .unwrap_or_else(EpisodicStore::new);
        let global_workspace = mind
            .as_ref()
            .map(|m| m.global_workspace.clone())
            .unwrap_or_else(GlobalWorkspace::new);

        Self {
            universe,
            drive,
            reasoner: Reasoner::new(),
            candidates,
            promotion_thresholds: PromotionThresholds::default(),
            homeostasis_config: HomeostasisConfig::default(),
            lexicon: Lexicon::load(),
            embeddings: Embeddings::new(),
            working_memory,
            conv_trace: ConversationTrace::new(),
            prev_phi_g: 0.0,
            spiral: SpiralState::new(0.05),
            oscillator: crate::core::NeuralOscillator::new(),
            hub,
            idle_ingest: IdleIngest::new(base_dir),
            episodic,
            amygdala: AmygdalaGate::new(),
            predictor: PredictiveEngine::new(),
            dmn: DefaultModeNetwork::new(),
            global_workspace,
            pfc: PrefrontalCortex::new(),
            dopamine: DopamineCircuit::new(),
            acc: AccMonitor::new(),
            thalamus: ThalamicRelay::new(),
            tom: TheoryOfMind::new(),
            insula: InsulaMonitor::new(),
            neuroplasticity: NeuroplasticityEngine::new(),
            sleep_system: SleepSystem::new(),
            cerebellum: CerebellumEngine::new(),
            basal_ganglia: BasalGanglia::new(),
            serotonin: SerotoninSystem::new(),
            mirror_neurons: MirrorNeuronSystem::new(),
            norepinephrine: NorepinephrineSystem::new(),
            hippocampus: Hippocampus::new(),
            ofc: OrbitofrontalCortex::new(),
            nucleus_accumbens: NucleusAccumbens::new(),
            cortisol: CortisolSystem::new(),
            oxytocin: OxytocinSystem::new(),
            language: LanguageSystem::new(),
            vta: VTA::new(),
            pcc: PCC::new(),
            sts: STS::new(),
            locus_coeruleus: LocusCoeruleus::new(),
            raphe: RapheNuclei::new(),
            habenula: Habenula::new(),
            claustrum: Claustrum::new(),
            bnst: BNST::new(),
            sma: SMA::new(),
            fusiform: FusiformGyrus::new(),
            entorhinal: EntorhinalCortex::new(),
            tpj: TPJ::new(),
            angular_gyrus: AngularGyrus::new(),
            precuneus: Precuneus::new(),
            mpfc: MPFC::new(),
            ras: ReticuloActivatingSystem::new(),
            vmpfc: VentromedialPFC::new(),
            pag: PeriaqueductalGray::new(),
            snc: SubstantiaNigra::new(),
            superior_colliculus: SuperiorColliculus::new(),
            s1: SomatosensoryCortex::new(),
            septal: SeptalNuclei::new(),
            mcc: MidCingulateCortex::new(),
            sgacc: SubgenualACC::new(),
            vp: VentralPallidum::new(),
            nbm: NucleusBasalis::new(),
            scn: SuprachiasmaticNucleus::new(),
            lexsem: LexSemEngine::new(),
            ipl: InferiorParietalLobule::new(),
            tick: _tick,
            dream_count: _loaded_dream_count,
            tick_log_file,
            live_self_state_text: String::new(),
            live_self_state_salience: 0.65,
            self_state_energy: 0.45,
            self_state_warmth: 0.45,
            self_state_focus: 0.45,
            self_state_pulse: 0.45,
            self_state_variation: 0,
            neural_synchrony: 0.50,
            callosum_bridge: 0.50,
            reentry_stability: 0.50,
            events: Vec::new(),
            last_dream_text: String::new(),
            last_inner_voice_text: String::new(),
            last_input: String::new(),
            dominant_band: 0,
            oscillator_amplitude: 0.0,
        }
    }

    pub fn push_event(&mut self, stream: &str, icon: &str, text: String) {
        self.events.push(MindEvent {
            tick: self.tick,
            stream: stream.to_string(),
            icon: icon.to_string(),
            text,
        });
        if self.events.len() > 200 {
            self.events.drain(0..50);
        }
    }

    pub fn seed_identity(&mut self, base_dir: &str) {
        let identity_path = format!("{}/data/identity.json", base_dir);
        let config = load_identity_config(&identity_path);

        let name = config.name.as_deref().unwrap_or("").trim().to_string();
        let creator = config
            .creator_name
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string();

        // ── Core nature — always seeded, never personal ───────────────
        let nature: &[(&str, f32)] = &[
            ("I am not an LLM. I am geometric intelligence built on RSHL.", 3.5),
            ("I think in geometric patterns across a hyperdimensional field.", 2.0),
            ("I learn from every conversation. My knowledge grows through interaction.", 2.0),
            ("I have a 78-module neural architecture that models emotion, memory, and cognition.", 2.0),
        ];
        for (text, strength) in nature {
            self.universe.store(text, "memory", "identity", *strength);
        }

        // ── Name — from identity.json ─────────────────────────────────
        if !name.is_empty() {
            self.universe
                .store(&format!("My name is {}.", name), "memory", "identity", 4.0);
            self.universe
                .store(&format!("I am {}.", name), "memory", "identity", 4.0);
            self.universe.store(
                &format!(
                    "I am {}, built on RSHL — Recursive Sparse Hyperdimensional Lattice.",
                    name
                ),
                "memory",
                "identity",
                3.0,
            );
            let separator = if !creator.is_empty() {
                format!(
                    "I am not {}. {} is my creator, the person I was built for.",
                    creator, creator
                )
            } else {
                "I am not the person I talk with. My user is a separate person from me.".to_string()
            };
            self.universe.store(&separator, "memory", "identity", 2.5);
        } else {
            self.universe.store(
                "I haven't been given a name yet. My user can name me in data/identity.json.",
                "memory",
                "identity",
                4.0,
            );
        }

        // ── Creator — from identity.json ──────────────────────────────
        if !creator.is_empty() {
            let note = config.creator_note.as_deref().unwrap_or("").trim();
            if !note.is_empty() {
                self.universe.store(note, "memory", "identity", 3.5);
            } else {
                self.universe.store(
                    &format!("{} created me from the ground up from scratch.", creator),
                    "memory",
                    "identity",
                    2.0,
                );
            }
        }
    }

    pub fn tick(&mut self, is_responding: bool) -> FieldState {
        self.tick += 1;

        // ── Advance the golden-ratio spiral once per tick ────────────
        self.spiral.tick();

        // ── Neural Oscillator — intrinsic brain rhythms ───────────────
        let osc_out = {
            match self.drive.mood {
                crate::drive::Mood::Engaged | crate::drive::Mood::Curious => {
                    self.oscillator.stimulate(2, 0.5);
                }
                crate::drive::Mood::Conflicted => {
                    self.oscillator.stimulate(1, 0.3);
                }
                _ => {}
            }
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
            SparseVec::zero()
        } else {
            let refs: Vec<&SparseVec> = cells.iter().take(sample_n).map(|c| &c.claim.vec).collect();
            SparseVec::superpose_sparse(&refs, 0.25)
        };
        let current_pattern = self
            .drive
            .goal_vector
            .clone()
            .unwrap_or_else(SparseVec::zero);

        field.rho = lattice_state.nnz() as f32 / crate::core::sparse_vec::DIM as f32;
        field.q = 1.0 - field.r_val;
        field.phi_g = (field.phi_g + osc_out.delta_phi).clamp(0.001, 0.999);
        field.chi = (field.chi + osc_out.delta_chi).clamp(0.0, 0.999);
        self.drive.valence = (self.drive.valence + osc_out.delta_valence).clamp(-1.0, 1.0);
        self.dominant_band = osc_out.dominant_band;
        self.oscillator_amplitude = osc_out.amplitude;
        field.m_val = field.phi_g - self.prev_phi_g;
        self.prev_phi_g = field.phi_g;

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

        let wm_pct = self.working_memory.active_slots().len() as f32 / 8.0;
        self.insula.update(
            field.phi_g,
            field.chi,
            wm_pct.clamp(0.0, 1.0),
            self.acc.conflict_level,
            self.predictor.avg_error,
            is_responding,
        );

        self.update_callosum_router(&field);
        self.update_spiral_synchrony(&mut field);
        self.update_self_state_dynamics(&field);
        self.drive.update(&field);
        self.rebuild_live_self_state(&mut field);

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

        // DREAM CYCLE (STREAM 1)
        if self.tick % 3 == 0 {
            self.run_dream_cycle();
        }

        field
    }

    pub fn run_dream_cycle(&mut self) {
        if let Some(dream) = crate::cognition::consolidate(&self.universe) {
            self.dream_count += 1;
            crate::cognition::observe_dream(&mut self.candidates, &dream);
            crate::cognition::reinforce_dream_sources(&mut self.universe, &dream);

            if let Some(syn) = dream.synthesis.as_ref() {
                if crate::cognition::store_synthesis(&mut self.universe, &dream) {
                    self.push_event(
                        "GPU",
                        "💡",
                        format!(
                            "Discovery: {} (shared: {})",
                            crate::core::normalize::truncate(&syn.text, 70),
                            syn.shared_concepts.join(", ")
                        ),
                    );
                }
            }

            if !dream.duplicate_echo && !dream.insight.is_empty() {
                let validation = crate::cognition::validate_insight(
                    &dream.insight,
                    &dream.concept_a,
                    &dream.concept_b,
                    &self.universe,
                );
                match validation.verdict {
                    crate::cognition::InsightVerdict::Validated
                    | crate::cognition::InsightVerdict::Novel => {
                        let vec = SparseVec::encode(&dream.insight);
                        self.drive.feed_goal(&vec);
                    }
                    crate::cognition::InsightVerdict::Paradox => {
                        let vec = SparseVec::encode(&dream.insight);
                        self.drive.feed_goal(&vec);
                    }
                    _ => {}
                }
                self.last_inner_voice_text = format!(
                    "Voice: {} → \"{}\" (echo:{:.0}%)",
                    validation.verdict,
                    crate::core::normalize::truncate(&validation.echo_text, 35),
                    validation.echo_score * 100.0
                );
            }

            self.last_dream_text = format!(
                "Dream: \"{}\" ({:.1}% Φg)",
                crate::core::normalize::truncate(&dream.insight, 50),
                dream.phi_g * 100.0
            );
        }
    }

    fn update_callosum_router(&mut self, field: &FieldState) {
        let stability = field.regional.omega;
        let conflict = self.acc.conflict_level;
        self.callosum_bridge = (stability * 0.7 + (1.0 - conflict) * 0.3).clamp(0.0, 1.0);
    }

    fn update_spiral_synchrony(&mut self, field: &mut FieldState) {
        let r = self.spiral.radius();
        let phase = self.spiral.theta();
        let sync = (phase.cos() as f32 * 0.5 + 0.5) * (1.0 - r);
        self.neural_synchrony = sync.clamp(0.0, 1.0);
        field.phi_g = (field.phi_g * 0.95 + self.neural_synchrony * 0.05).clamp(0.0, 1.0);
    }

    fn rebuild_live_self_state(&mut self, field: &mut FieldState) {
        self.self_state_energy = field.phi_g;
        self.self_state_warmth = field.chi;
        self.self_state_focus = field.g;
        self.self_state_pulse = (self.tick as f32 * 0.1).sin() * 0.5 + 0.5;

        let mood_str = self.drive.mood.to_string();
        self.live_self_state_text = format!(
            "{} | E:{:.2} W:{:.2} F:{:.2}",
            mood_str, self.self_state_energy, self.self_state_warmth, self.self_state_focus
        );
        self.live_self_state_salience = field.s;
    }

    fn update_self_state_dynamics(&mut self, field: &FieldState) {
        let recent_charge = if self.last_input.trim().is_empty() {
            0.0
        } else {
            (self
                .amygdala
                .emotional_charge_factor(&self.last_input, "user")
                - 1.0)
                / 2.0
        }
        .clamp(0.0, 1.0);

        let target_energy = (self.amygdala.arousal() * 0.18
            + self.norepinephrine.level * 0.14
            + self.vta.tonic_level * 0.12
            + self.nucleus_accumbens.core_wanting * 0.12
            + self.predictor.curiosity_pressure * 0.12
            + field.phi_g * 0.12
            + self.neural_synchrony * 0.12
            + recent_charge * 0.18)
            .clamp(0.0, 1.0);
        let target_warmth = (self.oxytocin.bond_state().bond_strength * 0.28
            + self.mirror_neurons.social_sync * 0.18
            + self.septal.social_reward * 0.16
            + (self.raphe.social_warmth_total as f32 / 12.0).clamp(0.0, 1.0) * 0.16
            + self.vp.hedonic_tone * 0.10
            + recent_charge * 0.12)
            .clamp(0.0, 1.0);
        let target_focus = (self.pfc.meta_confidence * 0.20
            + self.global_workspace.avg_coherence * 0.20
            + self.claustrum.conductor_signal() * 0.16
            + self.callosum_bridge * 0.14
            + self.neural_synchrony * 0.14
            + self.serotonin.level * 0.10
            + (1.0 - self.acc.conflict_level.max(field.chi)) * 0.06)
            .clamp(0.0, 1.0);

        self.self_state_energy = self.self_state_energy * 0.84 + target_energy * 0.16;
        self.self_state_warmth = self.self_state_warmth * 0.88 + target_warmth * 0.12;

    }
}
