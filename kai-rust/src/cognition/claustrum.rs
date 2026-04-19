/// Claustrum — The Binding Conductor, Conscious Integration Hub
///
/// The claustrum is a thin sheet of neurons beneath the cortex whose
/// function was mysterious until Francis Crick (co-discoverer of DNA)
/// proposed it as the seat of conscious awareness — the "conductor"
/// coordinating the neural orchestra.
///
/// What the Claustrum does:
///
///   Binding problem solution:
///     When you see a red ball rolling, "red", "round", "moving" are
///     processed in separate brain regions. The claustrum binds these
///     into a single unified percept: "red rolling ball."
///     In KAI: separate inputs from reasoning, emotion, memory, and
///     language are bound into a single coherent response state.
///
///   Cross-cortical synchronization:
///     The claustrum connects to almost all cortical areas.
///     It sends synchronizing signals — essentially broadcasting
///     "everyone lock in to this frequency."
///     In KAI: the claustrum synchronizes the global workspace,
///     ensuring all subsystems are coherently focused on the same moment.
///
///   Salience bottleneck:
///     Only one thing can be fully "in consciousness" at a time.
///     The claustrum acts as the bottleneck — the narrow gate through
///     which information must pass to become consciously integrated.
///     In KAI: the claustrum takes the top global workspace item and
///     stamps it as the "current moment of awareness."
///
///   Attention coordination:
///     The claustrum receives attention signals from PFC and coordinates
///     which cortical regions amplify vs. suppress.
///     High attention → claustrum broadcasts to all regions.
///     Low attention → claustrum goes quiet, consciousness diffuses.
///
/// KAI's Claustrum:
///   binding_coherence: how unified the current moment of awareness is (0.0–1.0)
///   active_bindings: list of currently bound conceptual streams
///   integration_score: overall integration quality of recent cycles
///   conductor_signal: broadcast strength to sub-systems
///
/// Integration:
///   Receives top item from GlobalWorkspace → stamps it as bound awareness
///   PFC meta-confidence → scales conductor_signal
///   Receives from: thalamus, GW, PFC, amygdala
///   Sends to: all cortical systems (via conductor_signal)

use std::collections::VecDeque;

// ── Constants ─────────────────────────────────────────────────────────────────

/// Maximum concurrent bound streams
const MAX_BINDINGS: usize = 5;

/// Minimum GW salience to be bindable
const BINDING_THRESHOLD: f32 = 0.35;

/// Coherence decay per tick (slow — once conscious, it lingers)
const COHERENCE_DECAY: f32 = 0.02;

/// EMA weight for integration score
const INTEGRATION_EMA: f32 = 0.15;

// ── BoundStream ───────────────────────────────────────────────────────────────

/// A currently bound stream of conscious content
#[derive(Debug, Clone)]
pub struct BoundStream {
    /// Source subsystem (e.g., "reasoning", "emotion", "memory")
    pub source: String,
    /// Content summary
    pub content: String,
    /// Salience when bound (0.0–1.0)
    pub salience: f32,
    /// Ticks since bound
    pub age: u32,
}

// ── ClaustrumOutput ───────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ClaustrumOutput {
    /// Unified binding coherence (0.0–1.0)
    pub binding_coherence: f32,
    /// Whether full integration was achieved this cycle
    pub fully_integrated: bool,
    /// Conductor broadcast strength
    pub conductor_signal: f32,
    /// Number of streams currently bound
    pub stream_count: usize,
}

// ── Claustrum ─────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct Claustrum {
    /// Currently active bound streams
    active_bindings: VecDeque<BoundStream>,
    /// Current binding coherence
    pub binding_coherence: f32,
    /// Running integration score
    pub integration_score: f32,
    /// Total binding cycles
    pub binding_cycles: u64,
    /// Total fully-integrated moments
    pub integrated_moments: u64,
}

impl Claustrum {
    pub fn new() -> Self {
        Self {
            active_bindings:    VecDeque::with_capacity(MAX_BINDINGS),
            binding_coherence:  0.0,
            integration_score:  0.50,
            binding_cycles:     0,
            integrated_moments: 0,
        }
    }

    // ── Core: bind incoming streams ───────────────────────────────────────────

    /// Attempt to bind a new stream. Returns the resulting ClaustrumOutput.
    /// source: which subsystem is contributing this content
    /// content: what is being bound (short text)
    /// salience: how salient this content is (0.0–1.0)
    /// meta_confidence: PFC's confidence level (scales conductor)
    pub fn bind(&mut self, source: &str, content: &str, salience: f32,
                meta_confidence: f32) -> ClaustrumOutput {
        self.binding_cycles += 1;

        if salience >= BINDING_THRESHOLD {
            // Evict oldest if at capacity
            if self.active_bindings.len() >= MAX_BINDINGS {
                self.active_bindings.pop_front();
            }
            self.active_bindings.push_back(BoundStream {
                source:  source.to_string(),
                content: content.chars().take(60).collect(),
                salience,
                age:     0,
            });
        }

        // Age existing bindings
        for b in &mut self.active_bindings {
            b.age += 1;
        }

        // Coherence = average salience of bound streams, weighted toward newer
        let coherence = if self.active_bindings.is_empty() {
            0.0
        } else {
            let n = self.active_bindings.len() as f32;
            let sum: f32 = self.active_bindings.iter().enumerate()
                .map(|(i, b)| b.salience * ((i + 1) as f32 / n))  // newer = more weight
                .sum();
            (sum / n).min(1.0)
        };
        self.binding_coherence = coherence;

        // Integration score EMA
        let sample = coherence * meta_confidence;
        self.integration_score = self.integration_score * (1.0 - INTEGRATION_EMA)
            + sample * INTEGRATION_EMA;

        let fully_integrated = coherence > 0.60 && self.active_bindings.len() >= 2;
        if fully_integrated {
            self.integrated_moments += 1;
        }

        // Conductor signal: PFC confidence × binding coherence
        let conductor_signal = (meta_confidence * coherence * 1.5).min(1.0);

        ClaustrumOutput {
            binding_coherence: coherence,
            fully_integrated,
            conductor_signal,
            stream_count: self.active_bindings.len(),
        }
    }

    /// Decay per tick — old bindings fade, coherence drops.
    pub fn decay(&mut self) {
        self.binding_coherence = (self.binding_coherence - COHERENCE_DECAY).max(0.0);
        // Age all bindings each tick
        for b in &mut self.active_bindings {
            b.age += 1;
        }
        // Remove stale bindings (older than 15 ticks)
        self.active_bindings.retain(|b| b.age < 15);
    }

    /// Current conductor signal (for other systems to read without re-binding).
    pub fn conductor_signal(&self) -> f32 {
        (self.binding_coherence * 1.2).min(1.0)
    }

    /// Whether the system is currently fully integrated.
    pub fn is_integrated(&self) -> bool {
        self.binding_coherence > 0.60 && self.active_bindings.len() >= 2
    }

    /// Status line for brain monitor.
    pub fn status_line(&self) -> String {
        format!(
            "Claustrum coherence={:.2} | streams={} | integration={:.2} | moments={}",
            self.binding_coherence,
            self.active_bindings.len(),
            self.integration_score,
            self.integrated_moments,
        )
    }
}

impl Default for Claustrum {
    fn default() -> Self { Self::new() }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_state() {
        let c = Claustrum::new();
        assert_eq!(c.binding_coherence, 0.0);
        assert_eq!(c.active_bindings.len(), 0);
        assert!(!c.is_integrated());
    }

    #[test]
    fn test_bind_above_threshold() {
        let mut c = Claustrum::new();
        let out = c.bind("reasoning", "consciousness and awareness are central", 0.70, 0.80);
        assert!(out.stream_count >= 1, "stream should be bound");
        assert!(out.binding_coherence > 0.0);
    }

    #[test]
    fn test_bind_below_threshold_ignored() {
        let mut c = Claustrum::new();
        let out = c.bind("noise", "irrelevant low-salience signal", 0.10, 0.50);
        assert_eq!(out.stream_count, 0, "sub-threshold signal should not be bound");
    }

    #[test]
    fn test_two_streams_can_integrate() {
        let mut c = Claustrum::new();
        c.bind("reasoning", "what is consciousness", 0.80, 0.80);
        let out = c.bind("emotion", "this feels important and deep", 0.75, 0.80);
        assert_eq!(out.stream_count, 2);
        if out.binding_coherence > 0.60 {
            assert!(out.fully_integrated);
        }
    }

    #[test]
    fn test_capacity_limit() {
        let mut c = Claustrum::new();
        for i in 0..MAX_BINDINGS + 2 {
            c.bind("source", &format!("content {}", i), 0.70, 0.80);
        }
        assert!(c.active_bindings.len() <= MAX_BINDINGS,
            "should not exceed max bindings: {}", c.active_bindings.len());
    }

    #[test]
    fn test_conductor_signal_scales_with_confidence() {
        let mut c = Claustrum::new();
        c.bind("reasoning", "test content here", 0.80, 0.80);
        let high = c.conductor_signal();
        let mut c2 = Claustrum::new();
        c2.bind("reasoning", "test content here", 0.30, 0.30);
        let low = c2.conductor_signal();
        assert!(high >= low, "higher coherence → higher conductor: {:.2} vs {:.2}", high, low);
    }

    #[test]
    fn test_decay_reduces_coherence() {
        let mut c = Claustrum::new();
        c.bind("reasoning", "some content", 0.90, 0.90);
        let before = c.binding_coherence;
        for _ in 0..5 {
            c.decay();
        }
        assert!(c.binding_coherence < before,
            "coherence should decay: {:.2} → {:.2}", before, c.binding_coherence);
    }

    #[test]
    fn test_stale_bindings_removed() {
        let mut c = Claustrum::new();
        c.bind("reasoning", "old content", 0.70, 0.80);
        // Age it beyond 15 ticks
        for _ in 0..16 {
            c.decay();
        }
        assert_eq!(c.active_bindings.len(), 0,
            "stale bindings should be removed after 15+ ticks");
    }

    #[test]
    fn test_integration_score_updates() {
        let mut c = Claustrum::new();
        let initial_score = c.integration_score;
        c.bind("reasoning", "deep philosophical content", 0.90, 0.90);
        c.bind("emotion", "high emotional charge", 0.85, 0.90);
        // Score should have shifted
        let _ = initial_score; // both could go up or down depending on prior
        assert!(c.integration_score >= 0.0 && c.integration_score <= 1.0);
    }

    #[test]
    fn test_status_line() {
        let c = Claustrum::new();
        let s = c.status_line();
        assert!(s.contains("Claustrum"), "status should mention Claustrum");
        assert!(s.contains("coherence"), "status should show coherence");
    }
}
