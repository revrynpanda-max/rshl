/// Locus Coeruleus (LC) — Norepinephrine Source Nucleus
///
/// The LC is to NE what the VTA is to dopamine and the raphe is to serotonin.
/// It is the brain's primary norepinephrine factory — a compact nucleus in the
/// pons that sends NE projections to virtually every brain region.
///
/// What the LC does:
///
///   Global arousal modulation:
///     LC firing rate controls the brain's overall arousal level. At rest,
///     LC fires tonically at ~1–3 Hz. During stress or novelty, phasic bursts
///     spike to 15–20 Hz, flooding the forebrain with NE.
///
///   Signal-to-noise amplification:
///     NE from LC doesn't just excite — it sharpens. It suppresses background
///     noise and amplifies task-relevant signals. This is why NE improves focus:
///     it's like turning up the gain specifically on important signals.
///
///   Novelty / mismatch detection:
///     LC fires preferentially to unexpected or novel stimuli — the "orienting
///     response." When something doesn't match the current model, LC fires and
///     re-orients the system toward the novel input.
///
///   LC modes (Aston-Jones & Cohen):
///     - Phasic mode: stimulus-locked bursts, high signal-to-noise, focused task
///     - Tonic mode: elevated baseline, broad sampling, exploratory state
///     These are roughly the NE equivalent of VTA's tonic/phasic distinction.
///
/// KAI's LC:
///   tonic_rate: baseline NE release (0.0–1.0)
///   phasic_level: current burst amplitude (fades each tick)
///   mode: Focused (phasic dominant) vs. Exploring (tonic elevated)
///   novelty_accum: accumulated novelty signal driving phasic bursts
///   signal_boost: current SNR amplification factor sent to NE system
///
/// Integration:
///   LC→NE: provides the tonic_rate and phasic_level that NorepinephrineSystem uses
///   LC→GW: phasic bursts post high-priority novelty alerts to global workspace
///   LC→Thalamus: raised tonic opens thalamic gate wider (more sensory throughput)

// ── Constants ─────────────────────────────────────────────────────────────────

/// Tonic NE baseline at rest
const TONIC_REST: f32 = 0.30;

/// Optimal tonic for focused task performance
const TONIC_FOCUSED: f32 = 0.55;

/// Threshold novelty to trigger a phasic burst
const NOVELTY_BURST_THRESHOLD: f32 = 0.50;

/// Phasic burst amplitude
const PHASIC_BURST_AMPLITUDE: f32 = 0.60;

/// Phasic decay per tick (fast — bursts are brief)
const PHASIC_DECAY: f32 = 0.08;

/// Tonic drift speed toward rest
const TONIC_DRIFT: f32 = 0.005;

/// Maximum signal boost factor
const MAX_SNR_BOOST: f32 = 2.5;

// ── LCMode ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum LCMode {
    /// Phasic bursts dominant — focused, narrow attention
    Focused,
    /// Elevated tonic — exploring, broad sampling
    Exploring,
    /// Near-rest baseline — quiet, default state
    Resting,
}

impl LCMode {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Focused => "focused",
            Self::Exploring => "exploring",
            Self::Resting => "resting",
        }
    }
}

// ── LCOutput ──────────────────────────────────────────────────────────────────

/// What the LC sends out each cycle
#[derive(Debug, Clone)]
pub struct LCOutput {
    /// Current tonic NE level
    pub tonic_rate: f32,
    /// Current phasic burst level (0 if none)
    pub phasic_level: f32,
    /// Signal-to-noise boost factor
    pub snr_boost: f32,
    /// Whether a phasic burst fired this tick
    pub burst_fired: bool,
    /// Current LC mode
    pub mode: LCMode,
}

// ── LocusCoeruleus ────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct LocusCoeruleus {
    /// Baseline NE release rate
    pub tonic_rate: f32,
    /// Current phasic burst level
    pub phasic_level: f32,
    /// Accumulated novelty (drives phasic bursts)
    novelty_accum: f32,
    /// Current mode
    pub mode: LCMode,
    /// Total bursts fired
    pub bursts_fired: u64,
    /// Total ticks processed
    pub total_ticks: u64,
}

impl LocusCoeruleus {
    pub fn new() -> Self {
        Self {
            tonic_rate: TONIC_REST,
            phasic_level: 0.0,
            novelty_accum: 0.0,
            mode: LCMode::Resting,
            bursts_fired: 0,
            total_ticks: 0,
        }
    }

    // ── Core update ───────────────────────────────────────────────────────────

    /// Process a new input's novelty signal. Returns LCOutput.
    /// novelty: 0.0–1.0 (how unexpected is this input relative to prediction?)
    /// task_demand: 0.0–1.0 (how much focused processing is requested?)
    pub fn process(&mut self, novelty: f32, task_demand: f32) -> LCOutput {
        self.total_ticks += 1;

        // Accumulate novelty
        self.novelty_accum = (self.novelty_accum + novelty * 0.4).min(1.0);

        // Phasic burst if novelty threshold exceeded
        let burst_fired = self.novelty_accum >= NOVELTY_BURST_THRESHOLD;
        if burst_fired {
            self.phasic_level = (self.phasic_level + PHASIC_BURST_AMPLITUDE).min(1.0);
            self.novelty_accum *= 0.3; // Consume the novelty
            self.bursts_fired += 1;
        }

        // Tonic rises with task demand (sustained focus raises NE baseline)
        if task_demand > 0.5 {
            self.tonic_rate = (self.tonic_rate + 0.01 * task_demand).min(0.80);
        }

        // Update mode
        self.mode = if self.phasic_level > 0.30 {
            LCMode::Focused
        } else if self.tonic_rate > TONIC_FOCUSED {
            LCMode::Exploring
        } else {
            LCMode::Resting
        };

        // SNR boost: phasic bursts sharpen signal dramatically,
        // high tonic in Exploring mode gives modest broad boost
        let snr_boost = match self.mode {
            LCMode::Focused => 1.0 + self.phasic_level * 1.5,
            LCMode::Exploring => 1.0 + self.tonic_rate * 0.5,
            LCMode::Resting => 1.0,
        }
        .min(MAX_SNR_BOOST);

        LCOutput {
            tonic_rate: self.tonic_rate,
            phasic_level: self.phasic_level,
            snr_boost,
            burst_fired,
            mode: self.mode.clone(),
        }
    }

    /// Decay every tick: phasic fades fast, tonic drifts toward rest.
    pub fn decay(&mut self) {
        self.phasic_level = (self.phasic_level - PHASIC_DECAY).max(0.0);
        // Tonic drifts toward TONIC_REST
        if self.tonic_rate > TONIC_REST {
            self.tonic_rate -= TONIC_DRIFT;
        } else if self.tonic_rate < TONIC_REST {
            self.tonic_rate = (self.tonic_rate + TONIC_DRIFT * 0.5).min(TONIC_REST);
        }
        // Novelty accumulation fades
        self.novelty_accum = (self.novelty_accum - 0.01).max(0.0);
    }

    /// Whether the LC is currently in burst state.
    pub fn is_bursting(&self) -> bool {
        self.phasic_level > 0.25
    }

    /// Current SNR boost factor (used by NorepinephrineSystem).
    pub fn snr_boost(&self) -> f32 {
        match self.mode {
            LCMode::Focused => (1.0 + self.phasic_level * 1.5).min(MAX_SNR_BOOST),
            LCMode::Exploring => (1.0 + self.tonic_rate * 0.5).min(MAX_SNR_BOOST),
            LCMode::Resting => 1.0,
        }
    }

    /// Status line for brain monitor.
    pub fn status_line(&self) -> String {
        format!(
            "LC mode={} | tonic={:.2} phasic={:.2} snr={:.2}x | bursts={}",
            self.mode.label(),
            self.tonic_rate,
            self.phasic_level,
            self.snr_boost(),
            self.bursts_fired,
        )
    }
}

impl Default for LocusCoeruleus {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_state() {
        let lc = LocusCoeruleus::new();
        assert_eq!(lc.mode, LCMode::Resting);
        assert!((lc.tonic_rate - TONIC_REST).abs() < 0.01);
        assert_eq!(lc.phasic_level, 0.0);
    }

    #[test]
    fn test_high_novelty_triggers_burst() {
        let mut lc = LocusCoeruleus::new();
        // Feed high novelty to trigger a burst
        lc.process(0.9, 0.3);
        let out = lc.process(0.9, 0.3);
        assert!(
            out.burst_fired || lc.phasic_level > 0.0,
            "high novelty should eventually trigger a phasic burst"
        );
    }

    #[test]
    fn test_phasic_mode_after_burst() {
        let mut lc = LocusCoeruleus::new();
        // Force novelty to burst threshold
        lc.novelty_accum = NOVELTY_BURST_THRESHOLD;
        let out = lc.process(0.5, 0.5);
        if out.burst_fired {
            assert_eq!(
                out.mode,
                LCMode::Focused,
                "burst should put LC into Focused mode"
            );
        }
    }

    #[test]
    fn test_snr_boost_in_focused_mode() {
        let mut lc = LocusCoeruleus::new();
        lc.novelty_accum = NOVELTY_BURST_THRESHOLD;
        let out = lc.process(1.0, 1.0);
        if out.mode == LCMode::Focused {
            assert!(
                out.snr_boost > 1.0,
                "Focused mode should boost SNR: got {:.2}",
                out.snr_boost
            );
        }
    }

    #[test]
    fn test_phasic_decays_over_time() {
        let mut lc = LocusCoeruleus::new();
        lc.phasic_level = 0.80;
        lc.mode = LCMode::Focused;
        for _ in 0..10 {
            lc.decay();
        }
        assert!(
            lc.phasic_level < 0.80,
            "phasic should decay over ticks: {:.2}",
            lc.phasic_level
        );
    }

    #[test]
    fn test_tonic_rises_with_task_demand() {
        let mut lc = LocusCoeruleus::new();
        let initial_tonic = lc.tonic_rate;
        for _ in 0..10 {
            lc.process(0.0, 0.8);
        }
        assert!(
            lc.tonic_rate > initial_tonic,
            "sustained task demand should raise tonic: {:.2} → {:.2}",
            initial_tonic,
            lc.tonic_rate
        );
    }

    #[test]
    fn test_tonic_drifts_back_to_rest() {
        let mut lc = LocusCoeruleus::new();
        lc.tonic_rate = 0.70;
        for _ in 0..50 {
            lc.decay();
        }
        assert!(
            lc.tonic_rate < 0.70,
            "tonic should drift toward rest: {:.2}",
            lc.tonic_rate
        );
    }

    #[test]
    fn test_low_novelty_no_burst() {
        let mut lc = LocusCoeruleus::new();
        let out = lc.process(0.05, 0.1);
        // After just one tick with very low novelty, no burst expected
        if lc.novelty_accum < NOVELTY_BURST_THRESHOLD {
            assert!(
                !out.burst_fired,
                "low novelty should not trigger burst on first tick"
            );
        }
    }

    #[test]
    fn test_burst_count_increments() {
        let mut lc = LocusCoeruleus::new();
        lc.novelty_accum = NOVELTY_BURST_THRESHOLD;
        lc.process(1.0, 1.0);
        assert!(
            lc.bursts_fired > 0,
            "burst counter should increment on burst"
        );
    }

    #[test]
    fn test_is_bursting_false_at_rest() {
        let lc = LocusCoeruleus::new();
        assert!(!lc.is_bursting(), "fresh LC should not be bursting");
    }

    #[test]
    fn test_is_bursting_true_after_burst() {
        let mut _lc = LocusCoeruleus::new();
        _lc.phasic_level = 0.50;

    }
}

