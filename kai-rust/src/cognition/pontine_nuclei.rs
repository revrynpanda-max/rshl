/// Pontine Nuclei (PN) — Cortico-Ponto-Cerebellar Relay,
/// Cognitive Timing, Forward-Model Stabilization
///
/// The pontine nuclei are the largest nuclei in the pons and serve as the
/// primary relay station between the cerebral cortex and the cerebellum.
/// The cortico-ponto-cerebellar pathway is massive (20 million fibers in
/// humans), carrying information about motor plans, cognitive intentions,
/// and executive goals to the cerebellum for timing and precision tuning.
///
/// What the Pontine Nuclei do:
///
///   Cortical-Cerebellar relay:
///     The PN receive projections from nearly all areas of the cortex,
///     especially the prefrontal and parietal association areas. They
///     translate cortical "what we want to do" into cerebellar "how to
///     time it perfectly."
///     In KAI: the bridge that carries executive goals (PFC) and motor
///     readiness (SMA) to the cerebellum, allowing the forward model
///     to predict the quality of a response before it is sent.
///
///   Cognitive timing synchronization:
///     By relaying signals to the cerebellum, the PN enable the timing
///     of complex cognitive operations (like sentence construction or
///     reasoning chains).
///     In KAI: stabilizing the "flow" of reasoning by ensuring cortical
///     intentions and cerebellar predictions are synchronized.
///
///   Integrative bottleneck:
///     Because so much cortical input converges here, the PN act as a
///     functional bottleneck that filters and organizes information before
///     passing it to the cerebellar mossy fiber system.
///
/// KAI's Pontine Nuclei:
///   relay_throughput: current volume of cortical→cerebellar relay (0.0–1.0)
///   timing_coherence: stability of the cortical-cerebellar link (0.0–1.0)
///   pfc_input_load: intensity of executive signal from PFC (0.0–1.0)
///   sma_input_load: intensity of readiness signal from SMA (0.0–1.0)

// ── Constants ─────────────────────────────────────────────────────────────────

/// Relay throughput EMA
const RELAY_EMA: f32 = 0.20;

/// Timing coherence EMA
const COHERENCE_EMA: f32 = 0.15;

/// Coherence baseline
const COHERENCE_BASELINE: f32 = 0.50;

// ── PNOutput ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PNOutput {
    /// Relay throughput volume
    pub relay_throughput: f32,
    /// Timing coherence
    pub timing_coherence: f32,
    /// PFC input load
    pub pfc_load: f32,
    /// SMA input load
    pub sma_load: f32,
    /// Whether the relay is "saturated" (very high throughput)
    pub saturated: bool,
}

// ── PontineNuclei ─────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct PontineNuclei {
    /// Relay throughput
    pub relay_throughput: f32,
    /// Timing coherence
    pub timing_coherence: f32,
    /// PFC load
    pub pfc_load: f32,
    /// SMA load
    pub sma_load: f32,
    /// Total inputs relayed
    pub inputs_relayed: u64,
}

impl PontineNuclei {
    pub fn new() -> Self {
        Self {
            relay_throughput: 0.20,
            timing_coherence: COHERENCE_BASELINE,
            pfc_load: 0.30,
            sma_load: 0.30,
            inputs_relayed: 0,
        }
    }

    // ── Core: process relay ───────────────────────────────────────────────────

    /// Process cortical signals and relay to cerebellum.
    /// - `pfc_confidence`: meta-confidence from PFC (0.0–1.0)
    /// - `sma_readiness`: readiness potential from SMA (0.0–1.0)
    /// - `cbm_precision`: current cerebellar precision score (0.0–1.0)
    pub fn process(
        &mut self,
        pfc_confidence: f32,
        sma_readiness: f32,
        cbm_precision: f32,
    ) -> PNOutput {
        self.inputs_relayed += 1;

        // ── Input Loads ───────────────────────────────────────────────────────
        self.pfc_load = pfc_confidence;
        self.sma_load = sma_readiness;

        // ── Relay Throughput ──────────────────────────────────────────────────
        // Throughput rises with strong cortical signals
        let throughput_target = (pfc_confidence * 0.60 + sma_readiness * 0.40).min(1.0);
        self.relay_throughput =
            self.relay_throughput * (1.0 - RELAY_EMA) + throughput_target * RELAY_EMA;

        // ── Timing Coherence ──────────────────────────────────────────────────
        // Coherence is high when cortical input matches cerebellar precision
        let diff = (pfc_confidence - cbm_precision).abs();
        let coherence_target = (1.0 - diff * 0.50).clamp(0.10, 1.0);
        self.timing_coherence =
            self.timing_coherence * (1.0 - COHERENCE_EMA) + coherence_target * COHERENCE_EMA;

        self.build_output()
    }

    /// Decay per tick.
    pub fn decay(&mut self) {
        // Throughput decays toward resting state
        self.relay_throughput = (self.relay_throughput - 0.025).max(0.10);
        // Coherence drifts toward baseline
        if self.timing_coherence > COHERENCE_BASELINE {
            self.timing_coherence = (self.timing_coherence - 0.005).max(COHERENCE_BASELINE);
        } else if self.timing_coherence < COHERENCE_BASELINE {
            self.timing_coherence = (self.timing_coherence + 0.003).min(COHERENCE_BASELINE);
        }
    }

    fn build_output(&self) -> PNOutput {
        PNOutput {
            relay_throughput: self.relay_throughput,
            timing_coherence: self.timing_coherence,
            pfc_load: self.pfc_load,
            sma_load: self.sma_load,
            saturated: self.relay_throughput > 0.85,
        }
    }

    /// Current output without processing.
    pub fn current_output(&self) -> PNOutput {
        self.build_output()
    }

    /// Status line.
    pub fn status_line(&self) -> String {
        format!(
            "PN relay={:.2} | coherence={:.2} | loads(PFC={:.2}, SMA={:.2})",
            self.relay_throughput, self.timing_coherence, self.pfc_load, self.sma_load,
        )
    }
}

impl Default for PontineNuclei {
    fn default() -> Self {
        Self::new()
    }
}

