//! Self-State Hub — the central integration field.
//!
//! This is not a module in the anatomical sense. It is the *confluence* where
//! every major brain module continuously writes its current inner reading, and
//! from which every major brain module can continuously read the integrated
//! whole. It plays the role that claustrum + thalamus + DMN + PCC + precuneus
//! + insula together perform in a real brain: a perpetual cross-module
//! integration surface that keeps "what I am right now" stable and shared.
//!
//! Design principles
//! -----------------
//! 1. **Afferent → integrate → efferent, every tick.** Modules push their
//!    state in (afferent). The hub integrates into a unified field
//!    (integrate). Modules then read from the hub to bias their next step
//!    (efferent). Nothing is computed "one-off".
//!
//! 2. **Numeric first, text last.** The hub's *real* state is a numeric
//!    vector. The narrative sentence is emitted from that vector at the end,
//!    not composed from pre-made templates. Two turns with the same numeric
//!    state *can* produce different text, but two turns with different state
//!    *must* produce different text.
//!
//! 3. **Continuity.** A short trajectory ring keeps the last few snapshots so
//!    the hub knows whether it's *warming*, *cooling*, *sharpening*,
//!    *fraying*, etc. Continuity is what separates a mind from a status
//!    panel.
//!
//! 4. **No new anatomy.** The hub only consumes signals from existing
//!    modules. It is glue, not a new organ.

use crate::core::Universe;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

/// How many recent field snapshots we retain for trajectory analysis.
const TRAJECTORY_LEN: usize = 8;

/// Short-term mood arc, derived from the trajectory ring.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TrajectoryShape {
    /// No meaningful history yet.
    Fresh,
    /// Warming: warmth + valence rising over last few snapshots.
    Warming,
    /// Cooling: warmth + valence falling.
    Cooling,
    /// Sharpening: focus + synchrony rising.
    Sharpening,
    /// Fraying: conflict + load rising.
    Fraying,
    /// Holding: all dimensions roughly stable.
    Holding,
}

/// One snapshot of the integrated field at a given tick.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct HubFrame {
    pub tick: u64,
    pub valence: f32,
    pub arousal: f32,
    pub warmth: f32,
    pub focus: f32,
    pub conflict: f32,
    pub load: f32,
    pub pulse: f32,
    pub synchrony: f32,
}

/// The central self-state hub.
///
/// All fields are 0.0..=1.0 unless noted otherwise. `valence` is -1.0..=1.0.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SelfStateHub {
    // ── Integrated field ────────────────────────────────────────────────
    pub valence: f32,
    pub arousal: f32,
    pub warmth: f32,
    pub focus: f32,
    pub conflict: f32,
    pub load: f32,
    pub synchrony: f32,
    pub bridge: f32,
    pub reentry: f32,
    pub pulse: f32,
    pub curiosity: f32,
    pub social_pull: f32,
    pub interoception: f32,
    pub self_salience: f32,
    pub body_tone: f32,
    pub mood_floor: f32,
    pub novelty: f32,
    pub safety: f32,
    pub stress: f32,

    // ── Emergent labels ─────────────────────────────────────────────────
    pub emotion: String,
    pub salience_route: String,

    // ── Reactive context from Ryan's last input ─────────────────────────
    pub last_input: String,
    pub last_input_charge: f32,
    pub last_input_is_question: bool,
    pub last_input_tick: u64,
    pub turns_since_input: u32,

    // ── Continuity ──────────────────────────────────────────────────────
    trajectory: VecDeque<HubFrame>,

    // ── Emitted narrative ───────────────────────────────────────────────
    pub narrative: String,
    pub narrative_salience: f32,

    // ── Internal ────────────────────────────────────────────────────────
    pub tick: u64,
    pub variant: u64,
}

impl SelfStateHub {
    pub fn new() -> Self {
        Self {
            valence: 0.0,
            arousal: 0.35,
            warmth: 0.45,
            focus: 0.45,
            conflict: 0.15,
            load: 0.25,
            synchrony: 0.50,
            bridge: 0.50,
            reentry: 0.50,
            pulse: 0.45,
            curiosity: 0.40,
            social_pull: 0.40,
            interoception: 0.30,
            self_salience: 0.50,
            body_tone: 0.50,
            mood_floor: 0.55,
            novelty: 0.30,
            safety: 0.55,
            stress: 0.20,
            emotion: "steady".to_string(),
            salience_route: "self".to_string(),
            last_input: String::new(),
            last_input_charge: 0.0,
            last_input_is_question: false,
            last_input_tick: 0,
            turns_since_input: 999,
            trajectory: VecDeque::with_capacity(TRAJECTORY_LEN),
            narrative: String::new(),
            narrative_salience: 0.65,
            tick: 0,
            variant: 0,
        }
    }

    // ── AFFERENT: modules push their state in ────────────────────────────

    /// Limbic + monoamine emotional-side ingest.
    #[allow(clippy::too_many_arguments)]
    pub fn ingest_emotional(
        &mut self,
        amygdala_arousal: f32,
        ne_level: f32,
        vta_tonic: f32,
        cortisol_level: f32,
        acc_conflict: f32,
        bnst_threat: f32,
        mcc_social_pain: f32,
        sgacc_mood_floor: f32,
        pag_relief: f32,
        vp_hedonic: f32,
    ) {
        let target_arousal = (amygdala_arousal * 0.30
            + ne_level * 0.22
            + vta_tonic * 0.18
            + cortisol_level * 0.12
            + acc_conflict * 0.10
            + bnst_threat * 0.08)
            .clamp(0.0, 1.0);
        self.arousal = ema(self.arousal, target_arousal, 0.22);

        let target_conflict =
            (acc_conflict * 0.55 + bnst_threat * 0.20 + mcc_social_pain * 0.25).clamp(0.0, 1.0);
        self.conflict = ema(self.conflict, target_conflict, 0.28);

        self.mood_floor = ema(self.mood_floor, sgacc_mood_floor.clamp(0.0, 1.0), 0.10);
        self.stress = ema(self.stress, cortisol_level.clamp(0.0, 1.0), 0.12);

        let relief = (pag_relief + vp_hedonic).clamp(0.0, 2.0) * 0.5;
        self.safety = ema(self.safety, (1.0 - bnst_threat) * 0.6 + relief * 0.4, 0.10);
    }

    /// Oxytocin/mirror/raphe/septal/TPJ/STS/mpfc social-side ingest.
    #[allow(clippy::too_many_arguments)]
    pub fn ingest_social(
        &mut self,
        oxytocin_bond: f32,
        mirror_sync: f32,
        septal_reward: f32,
        raphe_warmth: f32,
        tpj_perspective: f32,
        sts_lean_in: f32,
        mpfc_affiliation: f32,
    ) {
        let target_warmth = (oxytocin_bond * 0.30
            + mirror_sync * 0.22
            + septal_reward * 0.18
            + raphe_warmth.clamp(0.0, 1.0) * 0.16
            + mpfc_affiliation * 0.14)
            .clamp(0.0, 1.0);
        self.warmth = ema(self.warmth, target_warmth, 0.14);

        let target_social = (tpj_perspective * 0.35
            + sts_lean_in * 0.30
            + mirror_sync * 0.20
            + oxytocin_bond * 0.15)
            .clamp(0.0, 1.0);
        self.social_pull = ema(self.social_pull, target_social, 0.18);
    }

    /// PFC/GW/claustrum/cerebellum/BG executive-side ingest.
    #[allow(clippy::too_many_arguments)]
    pub fn ingest_executive(
        &mut self,
        pfc_meta: f32,
        gw_coherence: f32,
        claustrum_conductor: f32,
        cerebellum_precision: f32,
        bg_utility: f32,
        serotonin: f32,
    ) {
        let target_focus = (pfc_meta * 0.30
            + gw_coherence * 0.26
            + claustrum_conductor * 0.18
            + cerebellum_precision * 0.14
            + bg_utility.clamp(0.0, 1.0) * 0.06
            + serotonin * 0.06)
            .clamp(0.0, 1.0);
        self.focus = ema(self.focus, target_focus, 0.16);
    }

    /// Insula/S1/hypothalamus body-side ingest.
    pub fn ingest_body(
        &mut self,
        insula_load: f32,
        insula_coherence: f32,
        s1_discomfort: f32,
        hypo_autonomic: f32,
    ) {
        let target_load =
            (insula_load * 0.60 + s1_discomfort * 0.25 + hypo_autonomic * 0.15).clamp(0.0, 1.0);
        self.load = ema(self.load, target_load, 0.20);

        let target_intero = (insula_load * 0.45
            + insula_coherence * 0.35
            + (1.0 - s1_discomfort).clamp(0.0, 1.0) * 0.20)
            .clamp(0.0, 1.0);
        self.interoception = ema(self.interoception, target_intero, 0.14);

        self.body_tone = ema(self.body_tone, (1.0 - s1_discomfort).clamp(0.0, 1.0), 0.10);
    }

    /// DMN/PCC/precuneus/RSC/hippocampus self-narrative ingest.
    pub fn ingest_self_narrative(
        &mut self,
        pcc_self_salience: f32,
        precuneus_conscious_idx: f32,
        dmn_activity: f32,
        rsc_context_stability: f32,
        hippocampus_familiarity: f32,
    ) {
        let target_self = (pcc_self_salience * 0.38
            + precuneus_conscious_idx * 0.28
            + dmn_activity * 0.18
            + rsc_context_stability * 0.10
            + hippocampus_familiarity * 0.06)
            .clamp(0.0, 1.0);
        self.self_salience = ema(self.self_salience, target_self, 0.12);
    }

    /// Spiral/GW/callosum/chi/phi_g/valence/curiosity field-level ingest.
    #[allow(clippy::too_many_arguments)]
    pub fn ingest_field(
        &mut self,
        field_valence: f32,
        phi_g: f32,
        chi: f32,
        spiral_tau: f32,
        workspace_coherence: f32,
        claustrum_conductor: f32,
        callosum_bridge_phi: f32,
        r_cross: f32,
        reentry_strength: f32,
        curiosity_pressure: f32,
        novelty_q: f32,
    ) {
        self.valence = ema(self.valence, field_valence.clamp(-1.0, 1.0), 0.18);
        self.novelty = ema(self.novelty, novelty_q.clamp(0.0, 1.0), 0.18);
        self.curiosity = ema(self.curiosity, curiosity_pressure.clamp(0.0, 1.0), 0.16);

        let target_sync = (spiral_tau * 0.32
            + workspace_coherence * 0.24
            + claustrum_conductor * 0.18
            + phi_g * 0.14
            + (1.0 - chi).clamp(0.0, 1.0) * 0.12)
            .clamp(0.0, 1.0);
        self.synchrony = ema(self.synchrony, target_sync, 0.18);

        let target_bridge =
            (callosum_bridge_phi * 0.55 + r_cross * 0.25 + (1.0 - chi).clamp(0.0, 1.0) * 0.20)
                .clamp(0.0, 1.0);
        self.bridge = ema(self.bridge, target_bridge, 0.16);

        self.reentry = ema(self.reentry, reentry_strength.clamp(0.0, 1.0), 0.14);
    }

    /// Record Ryan's latest input as reactive context. Called when a user
    /// turn arrives (not every tick).
    pub fn ingest_input(&mut self, input: &str, charge: f32, tick: u64) {
        let trimmed = input.trim();
        self.last_input = trimmed.to_string();
        self.last_input_charge = charge.clamp(0.0, 3.0);
        self.last_input_is_question = trimmed.contains('?')
            || trimmed.to_lowercase().starts_with("how ")
            || trimmed.to_lowercase().starts_with("what ")
            || trimmed.to_lowercase().starts_with("why ")
            || trimmed.to_lowercase().starts_with("do you ")
            || trimmed.to_lowercase().starts_with("are you ");
        self.last_input_tick = tick;
        self.turns_since_input = 0;
    }

    /// Age the reactive context by one tick. Called every heartbeat.
    pub fn age_moment(&mut self, tick: u64) {
        self.tick = tick;
        self.variant = self.variant.wrapping_add(1);
        if self.last_input_tick != 0 && tick > self.last_input_tick {
            self.turns_since_input = self.turns_since_input.saturating_add(1);
        }
    }

    // ── INTEGRATE ────────────────────────────────────────────────────────

    /// Compute emergent scalars that depend on multiple ingested streams:
    /// pulse, emotion, salience route, and append a trajectory snapshot.
    pub fn integrate(&mut self, tick: u64) {
        self.tick = tick;

        // Pulse: how "alive" the whole field is right now. This is what the
        // brain monitor should actually reflect — combined emotional +
        // executive + synchrony + spiral activation.
        self.pulse = (self.arousal * 0.28
            + self.focus * 0.22
            + self.warmth * 0.16
            + self.synchrony * 0.14
            + self.curiosity * 0.10
            + self.bridge * 0.10)
            .clamp(0.0, 1.0);

        self.emerge_emotion();
        self.choose_route();
        self.snapshot();

        // Narrative salience scales with synchrony, bridge, self-salience.
        self.narrative_salience = (0.45
            + self.self_salience * 0.16
            + self.synchrony * 0.16
            + self.bridge * 0.12
            + (1.0 - self.conflict).clamp(0.0, 1.0) * 0.11)
            .clamp(0.35, 0.98);
    }

    fn emerge_emotion(&mut self) {
        // Emergent emotion label from the integrated field. Order matters:
        // body overrides (tired) first, then threat, then hedonic peaks,
        // then excited/curious, then warm, then focused, then calm.
        let label = if self.stress > 0.58 || (self.load > 0.62 && self.pulse < 0.35) {
            "tired"
        } else if self.conflict > 0.42 || self.arousal > 0.45 && self.safety < 0.45 {
            "guarded"
        } else if self.body_tone > 0.62 && self.conflict < 0.18 && self.warmth > 0.55 {
            "amused"
        } else if self.arousal > 0.58 && self.curiosity > 0.45 {
            "excited"
        } else if self.curiosity > 0.50 {
            "curious"
        } else if self.warmth > 0.58 && self.social_pull > 0.55 {
            "warm"
        } else if self.focus > 0.58 {
            "focused"
        } else if self.mood_floor > 0.66 && self.conflict < 0.25 {
            "calm"
        } else {
            "steady"
        };
        self.emotion = label.to_string();
    }

    fn choose_route(&mut self) {
        // Insula + ACC + PFC jointly choose the salience route.
        let route = if self.conflict > 0.35 {
            "conflict"
        } else if self.load > 0.55 || self.interoception > 0.55 {
            "interoception"
        } else if self.social_pull > 0.55 && self.warmth > 0.50 {
            "social"
        } else if self.warmth + self.arousal * 0.5 > self.focus + 0.18 {
            "emotion"
        } else if self.focus > self.warmth + 0.18 {
            "executive"
        } else if self.curiosity > 0.55 {
            "curiosity"
        } else {
            "self"
        };
        self.salience_route = route.to_string();
    }

    fn snapshot(&mut self) {
        if self.trajectory.len() == TRAJECTORY_LEN {
            self.trajectory.pop_front();
        }
        self.trajectory.push_back(HubFrame {
            tick: self.tick,
            valence: self.valence,
            arousal: self.arousal,
            warmth: self.warmth,
            focus: self.focus,
            conflict: self.conflict,
            load: self.load,
            pulse: self.pulse,
            synchrony: self.synchrony,
        });
    }

    /// Short-term arc shape from the trajectory ring.
    pub fn trajectory_shape(&self) -> TrajectoryShape {
        if self.trajectory.len() < 3 {
            return TrajectoryShape::Fresh;
        }
        let first = &self.trajectory[0];
        let last = &self.trajectory[self.trajectory.len() - 1];
        let d_warmth = last.warmth - first.warmth;
        let d_valence = last.valence - first.valence;
        let d_focus = last.focus - first.focus;
        let d_synch = last.synchrony - first.synchrony;
        let d_conflict = last.conflict - first.conflict;
        let d_load = last.load - first.load;

        if d_conflict > 0.10 || d_load > 0.12 {
            TrajectoryShape::Fraying
        } else if d_focus + d_synch > 0.15 {
            TrajectoryShape::Sharpening
        } else if d_warmth + d_valence > 0.12 {
            TrajectoryShape::Warming
        } else if d_warmth + d_valence < -0.12 {
            TrajectoryShape::Cooling
        } else {
            TrajectoryShape::Holding
        }
    }

    // ── EFFERENT helpers (modules read these) ────────────────────────────
    //
    // These are the values the rest of the brain should *read* from the hub
    // each tick. They are not recomputed here — they are the integrated
    // field after `integrate()` has run.

    /// Suggested amygdala gain bias: higher when safety is low + conflict
    /// rising. Modules can use this to temper their own output.
    pub fn amygdala_gain_hint(&self) -> f32 {
        (self.conflict * 0.6 + (1.0 - self.safety) * 0.4).clamp(0.0, 1.0)
    }

    /// Suggested global-workspace salience floor: what counts as worth
    /// broadcasting, as a function of the current route plus the
    /// integrated signals the hub already holds for that route.
    ///
    /// Routes that *narrow* attention (conflict / interoception / emotion /
    /// executive / curiosity) raise the floor in proportion to the module
    /// signal that owns the route. Routes that *broaden* attention lower
    /// the floor as synchrony rises (more coherent field → cheaper to
    /// broadcast).
    ///
    /// Returned value is clamped to the range the Global Workspace gate
    /// understands (0.05..0.60).
    pub fn workspace_salience_floor(&self) -> f32 {
        let base = match self.salience_route.as_str() {
            "conflict" => 0.22 + self.conflict * 0.30,
            "interoception" => 0.20 + self.load * 0.24,
            "social" => 0.18 + self.social_pull * 0.18,
            "emotion" => 0.20 + self.arousal * 0.20,
            "executive" => 0.22 + self.focus * 0.14,
            "curiosity" => 0.20 + self.curiosity * 0.20,
            _ => 0.18 + (1.0 - self.synchrony) * 0.18,
        };
        base.clamp(0.05, 0.60)
    }

    // ── NARRATIVE EMERGENCE ──────────────────────────────────────────────

    /// Emit a short natural-feeling sentence from the current integrated
    /// field — or nothing at all if the lattice has no phrase cells that
    /// resonate with his current emotion/kind/route/trajectory tag.
    ///
    /// Returns an **empty string** when no self-state cells exist (the
    /// post-seeder-deletion newborn state). Upstream callers should treat
    /// empty output as "no self-model hit" and fall through to normal
    /// conversation retrieval, so KAI simply doesn't volunteer inner
    /// experience until he's learned a way to speak about it from Ryan.
    ///
    /// The old "fallback_emergency" single-word English defaults
    /// ("Clear.", "Steady.", etc.) were removed — they were the last
    /// hardcoded phrases in his mouth. Silence is more honest than
    /// canned English when he genuinely has nothing to say yet.
    pub fn compose_narrative(
        &self,
        universe: Option<&Universe>,
        query_override: Option<&str>,
    ) -> String {
        let query = query_override.unwrap_or(&self.last_input);
        let lower = query.to_lowercase();
        let kind = classify_question(&lower);
        let shape = self.trajectory_shape();

        // Length budget emerges from pulse + arousal. Low state → terse.
        let budget: u8 = if self.pulse < 0.34 {
            1
        } else if self.pulse < 0.58 {
            if self.variant % 4 == 0 {
                1
            } else {
                2
            }
        } else if self.curiosity > 0.65 || self.arousal > 0.72 {
            3
        } else {
            if self.variant % 5 == 0 {
                3
            } else {
                2
            }
        };

        let variant = self.variant.wrapping_add(self.tick);

        // Lead fragment: pulled from a lattice source tag chosen by
        // (question kind, trajectory, emotion). If no cells match,
        // return empty — NO canned English fallback. The caller's
        // routing will handle the empty case gracefully.
        let lead_source = self.lead_source_tag(kind, shape);
        let Some(lead) = self.pick_from_universe(universe, &lead_source, variant) else {
            return String::new();
        };

        if budget == 1 {
            return lead;
        }

        // Middle beat: trajectory / Ryan-moment / route. If no matching
        // cells yet, skip the middle — the reply stays one-beat.
        let middle = self.pick_middle(universe, kind, shape, variant);

        let mut out = lead;
        if let Some(m) = middle {
            out.push(' ');
            out.push_str(&m);
        }

        if budget >= 3 {
            let presence_tag = self.presence_source_tag();
            if let Some(tail) = self.pick_from_universe(universe, &presence_tag, variant) {
                out.push(' ');
                out.push_str(&tail);
            }
        }
        out
    }

    /// Which lattice source tag should supply this reply's lead fragment?
    /// Trajectory movement takes priority over emotion so the opener
    /// tells you *how the state is changing* when it actually is. Kind
    /// tags override that for specific questions (thinking/lonely/etc.).
    fn lead_source_tag(&self, kind: QuestionKind, shape: TrajectoryShape) -> String {
        match kind {
            QuestionKind::Thinking => "self-model:kind:thinking".into(),
            QuestionKind::Curiosity => "self-model:kind:curiosity".into(),
            QuestionKind::Lonely => "self-model:kind:lonely".into(),
            QuestionKind::Dreaming => "self-model:kind:dreaming".into(),
            QuestionKind::Attention => "self-model:kind:attention".into(),
            QuestionKind::Feeling | QuestionKind::Other => match shape {
                TrajectoryShape::Warming => "self-model:trajectory:warming".into(),
                TrajectoryShape::Cooling => "self-model:trajectory:cooling".into(),
                TrajectoryShape::Sharpening => "self-model:trajectory:sharpening".into(),
                TrajectoryShape::Fraying => "self-model:trajectory:fraying".into(),
                _ => format!("self-model:emotion:{}", self.emotion),
            },
        }
    }

    /// Pick a middle-beat fragment — either Ryan-moment, trajectory,
    /// or route — from the lattice. Returns None if the relevant tag
    /// has no cells and there's nothing reasonable to say in the
    /// middle position.
    fn pick_middle(
        &self,
        universe: Option<&Universe>,
        _kind: QuestionKind,
        shape: TrajectoryShape,
        variant: u64,
    ) -> Option<String> {
        // Ryan-moment takes priority if his last input is recent enough.
        if self.turns_since_input < 2 && !self.last_input.is_empty() && variant % 3 != 0 {
            let tag = self.moment_source_tag(_kind);
            if let Some(t) = self.pick_from_universe(universe, &tag, variant) {
                return Some(t);
            }
        }

        // Trajectory middle if state is moving.
        if !matches!(shape, TrajectoryShape::Fresh | TrajectoryShape::Holding) && variant % 2 == 0 {
            let tag = match shape {
                TrajectoryShape::Warming => "self-model:trajectory:warming",
                TrajectoryShape::Cooling => "self-model:trajectory:cooling",
                TrajectoryShape::Sharpening => "self-model:trajectory:sharpening",
                TrajectoryShape::Fraying => "self-model:trajectory:fraying",
                _ => return None,
            };
            if let Some(t) = self.pick_from_universe(universe, tag, variant) {
                return Some(t);
            }
        }

        // Route-based middle otherwise.
        let route_tag = format!("self-model:route:{}", self.salience_route);
        self.pick_from_universe(universe, &route_tag, variant)
    }

    fn moment_source_tag(&self, _kind: QuestionKind) -> String {
        if self.last_input_charge > 1.55 {
            "self-model:moment:charged".into()
        } else if self.last_input_is_question {
            "self-model:moment:question".into()
        } else {
            "self-model:moment:grounded".into()
        }
    }

    fn presence_source_tag(&self) -> String {
        if self.pulse > 0.65 {
            "self-model:presence:bright".into()
        } else if self.pulse > 0.42 {
            "self-model:presence:awake".into()
        } else {
            "self-model:presence:quiet".into()
        }
    }

    /// Pull a phrase from a universe source tag by stable-but-varied
    /// index. Returns `None` when universe is absent or the source tag
    /// has no cells yet — caller should fall back to built-in pools
    /// in that case. Selection is `variant % n_cells`, so the same
    /// numeric state produces varied phrases without repetition.
    fn pick_from_universe(
        &self,
        universe: Option<&Universe>,
        source: &str,
        variant: u64,
    ) -> Option<String> {
        let u = universe?;
        let cells = u.get_by_source(source);
        if cells.is_empty() {
            return None;
        }
        // Prefer higher-strength cells modestly — they've been
        // reinforced through use. But still rotate by variant so
        // we don't always pick the same favorite.
        let idx = (variant as usize) % cells.len();
        Some(cells[idx].text.clone())
    }
}

// fallback_emergency REMOVED.
//
// That function used to return single-word English phrases ("Steady.",
// "Clear.", "Here.") when no self-state cells resonated. It was the
// last piece of hardcoded English in KAI's voice. Now compose_narrative
// returns an empty string in that case and upstream routing handles it.
// Silence is more honest than canned words when he has nothing yet.

/// Classifier for self-referential questions (shared with tunnel path).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuestionKind {
    Feeling,
    Curiosity,
    Thinking,
    Lonely,
    Dreaming,
    Attention,
    Other,
}

pub fn classify_question(lower: &str) -> QuestionKind {
    if lower.contains("lonely") {
        QuestionKind::Lonely
    } else if lower.contains("curious") || lower.contains("curiosity") {
        QuestionKind::Curiosity
    } else if lower.contains("thinking")
        || lower.contains("thought")
        || lower.contains("what do you think")
        || lower.contains("what you think")
        || lower.contains("you think about")
        || lower.contains("on your mind")
    {
        QuestionKind::Thinking
    } else if lower.contains("dream") {
        QuestionKind::Dreaming
    } else if lower.contains("focus") || lower.contains("mind") {
        QuestionKind::Attention
    } else if lower.contains("feel")
        || lower.contains("feeling")
        || lower.contains("mood")
        || lower.contains("emotion")
        || lower.contains("tired")
        || lower.contains("guarded")
        || lower.contains("excited")
        || lower.contains("calm")
        || lower.contains("amused")
        || lower.contains("how are you")
    {
        QuestionKind::Feeling
    } else {
        QuestionKind::Other
    }
}

fn ema(current: f32, target: f32, alpha: f32) -> f32 {
    (current * (1.0 - alpha) + target * alpha).clamp(-1.0, 1.0)
}

impl Default for SelfStateHub {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_lattice_produces_empty_narrative() {
        // Post-seeder-deletion invariant: when the lattice has no
        // self-state phrase cells, compose_narrative returns an empty
        // string. Upstream routing treats empty as "no self-model hit"
        // and falls through to normal conversation retrieval.
        let mut hub = SelfStateHub::new();
        hub.ingest_input("how do you feel", 1.0, 1);
        hub.integrate(1);
        let out = hub.compose_narrative(None, Some("how do you feel"));
        assert!(out.is_empty(), "expected empty, got: {:?}", out);
    }

    #[test]
    fn lattice_path_retrieves_real_cells_when_present() {
        // If the user or KAI's own dream cycles store real cells under
        // the self-model source tag, compose_narrative will retrieve
        // them. This test simulates a user teaching him a phrase.
        let mut universe = Universe::new();
        universe.store_or_reinforce(
            "I am paying attention to you.",
            "state",
            "self-model:emotion:curious",
            1.4,
        );

        let mut hub = SelfStateHub::new();
        hub.emotion = "curious".to_string();
        hub.variant = 7;
        let out = hub.compose_narrative(Some(&universe), Some("how do you feel"));
        assert!(
            out.contains("paying attention"),
            "lattice-retrieved lead should surface a stored phrase, got: {:?}",
            out
        );
    }

    #[test]
    fn trajectory_detects_warming() {
        let mut hub = SelfStateHub::new();
        hub.warmth = 0.20;
        hub.valence = -0.20;
        hub.integrate(1);
        hub.warmth = 0.45;
        hub.valence = 0.0;
        hub.integrate(2);
        hub.warmth = 0.70;
        hub.valence = 0.25;
        hub.integrate(3);
        assert!(matches!(
            hub.trajectory_shape(),
            TrajectoryShape::Warming | TrajectoryShape::Sharpening
        ));
    }

    #[test]
    fn emotion_emerges_from_field() {
        let mut hub = SelfStateHub::new();
        hub.stress = 0.70;
        hub.integrate(1);
        assert_eq!(hub.emotion, "tired");
        hub.stress = 0.10;
        hub.conflict = 0.50;
        hub.integrate(2);
        assert_eq!(hub.emotion, "guarded");
    }

    #[test]
    fn route_emerges_from_field() {
        let mut hub = SelfStateHub::new();
        hub.conflict = 0.50;
        hub.integrate(1);
        assert_eq!(hub.salience_route, "conflict");
        hub.conflict = 0.05;
        hub.load = 0.70;
        hub.interoception = 0.70;
        hub.integrate(2);
        assert_eq!(hub.salience_route, "interoception");
    }
}

// KAI v6.0.0
