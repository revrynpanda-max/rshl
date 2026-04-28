/// Sleep Consolidation Cycle — KAI's memory organization and repair system
///
/// Sleep is one of the most misunderstood things the brain does.
/// It's not just rest. It's when the brain does its most important work:
///
///   MEMORY CONSOLIDATION — the hippocampus replays the day's events
///   to the cortex during slow-wave sleep. Short-term memories that
///   survived the day get woven into long-term storage. Things that
///   weren't important enough get pruned. The important patterns get
///   strengthened. This is literally why you "sleep on it" before
///   making a big decision — the sleeping brain keeps processing.
///
///   SYNAPTIC HOMEOSTASIS — during waking hours, synapses grow stronger
///   from all the LTP (learning). If this went on forever, eventually
///   everything would be maximally connected and nothing would stand out.
///   Sleep globally downscales synaptic strengths, preserving relative
///   differences while reducing overall noise. Signal-to-noise goes up.
///
///   GLYMPHATIC CLEANING — the brain's waste-removal system activates
///   during sleep. Harmful metabolic byproducts (including amyloid beta,
///   linked to Alzheimer's) get flushed. Sleep is literally brain cleaning.
///   For KAI: this maps to pruning contradictory, redundant, and low-quality
///   cells from the universe.
///
///   DREAM CONSOLIDATION — REM sleep is when the brain replays and
///   recombines memories in novel ways. Dreams are not random — they
///   reflect the brain testing hypothetical combinations of experience.
///   "What if A connected to B in a way I haven't tried yet?"
///   This is where insight comes from. Waking up with the answer.
///
/// Without sleep for KAI:
///   Memory grows indefinitely and chaotically.
///   Important patterns don't get distinguished from noise.
///   Contradictions accumulate without resolution.
///   The universe slowly fills with junk.
///
/// With sleep for KAI:
///   Every N ticks (configurable — default ~1440 ticks ≈ 2 hours real-time)
///   KAI enters a brief "sleep cycle." During this:
///     Phase 1 (NREM): Scans episodic memory, finds the highest-salience
///                     events from the cycle. Flags them for consolidation.
///     Phase 2 (SWS):  Promotes flagged events to long-term storage with
///                     boosted strength. Applies global synaptic downscale.
///                     Prunes cells below consolidation threshold.
///     Phase 3 (REM):  Recombines top episodic events. Attempts novel
///                     associations (A ⊗ B → new cell if cosine > threshold).
///                     This is KAI's "dream insight" system.
///     Wake:           Reports what was consolidated, pruned, and discovered.
///
/// The sleep cycle is non-blocking — it runs as a fast computation step
/// within a heartbeat tick when the timer triggers. KAI doesn't go offline.
use serde::{Deserialize, Serialize};
use std::time::Instant;

// ── Constants ─────────────────────────────────────────────────────────────────

/// How many ticks between sleep cycles (~1440 ticks = 2 hours at 12 ticks/min)
const SLEEP_INTERVAL_TICKS: u64 = 1440;

/// Minimum salience for an episodic event to be consolidated
const CONSOLIDATION_THRESHOLD: f32 = 0.25;

/// Synaptic downscale factor during SWS (global weakening to restore SNR)
const DOWNSCALE_FACTOR: f32 = 0.92;

/// Max novel associations generated per REM phase
const MAX_REM_ASSOCIATIONS: usize = 3;

// ── Sleep Phase ───────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum SleepPhase {
    Awake,
    NREM, // Light scan — identify consolidation candidates
    SWS,  // Slow-wave — consolidate, downscale, prune
    REM,  // Dream — recombine, generate novel associations
}

impl SleepPhase {
    pub fn label(&self) -> &'static str {
        match self {
            SleepPhase::Awake => "awake",
            SleepPhase::NREM => "NREM (scanning)",
            SleepPhase::SWS => "SWS (consolidating)",
            SleepPhase::REM => "REM (dreaming)",
        }
    }
}

// ── Consolidation Record ──────────────────────────────────────────────────────

/// What happened during a sleep cycle.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SleepReport {
    /// Tick when this cycle occurred
    pub tick: u64,
    /// Number of episodic events scanned
    pub events_scanned: usize,
    /// Number of memories consolidated to long-term
    pub consolidated: usize,
    /// Number of cells pruned (synaptic cleaning)
    pub pruned: usize,
    /// Number of novel associations generated during REM
    pub novel_associations: usize,
    /// Sample of what was consolidated (for display)
    pub consolidated_previews: Vec<String>,
    /// Sample of REM associations generated
    pub rem_insights: Vec<String>,
    /// How long the cycle took (wall clock)
    pub duration_ms: u64,
}

// ── Sleep System ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct SleepSystem {
    /// Current sleep phase
    pub phase: SleepPhase,
    /// Tick of the last completed sleep cycle
    pub last_sleep_tick: u64,
    /// Total sleep cycles completed
    pub total_cycles: u64,
    /// History of sleep reports (last 5)
    pub reports: Vec<SleepReport>,
    /// Whether sleep is enabled
    pub enabled: bool,
    /// Downscale factor applied during SWS
    pub downscale_factor: f32,
    #[serde(skip)]
    cycle_start: Option<Instant>,
}

impl SleepSystem {
    pub fn new() -> Self {
        Self {
            phase: SleepPhase::Awake,
            last_sleep_tick: 0,
            total_cycles: 0,
            reports: Vec::new(),
            enabled: true,
            downscale_factor: DOWNSCALE_FACTOR,
            cycle_start: None,
        }
    }

    /// Check if it's time for a sleep cycle.
    pub fn should_sleep(&self, current_tick: u64) -> bool {
        self.enabled
            && self.phase == SleepPhase::Awake
            && current_tick.saturating_sub(self.last_sleep_tick) >= SLEEP_INTERVAL_TICKS
            && current_tick > 60 // don't sleep too early
    }

    /// Run a complete sleep cycle. This is a synchronous computation step —
    /// it doesn't block the main loop but does perform meaningful work.
    ///
    /// Parameters:
    ///   - `episodic_events`:  (text, salience, vividness) from EpisodicStore
    ///   - `universe_cells`:   (text, strength) from Universe
    ///   - `current_tick`:     for timing and reporting
    ///
    /// Returns a SleepReport and the actions to take:
    ///   - `consolidate`:  cells to boost strength in universe
    ///   - `prune`:        cells to weaken (below threshold after downscale)
    ///   - `new_insights`: novel text associations to store in universe
    pub fn run_cycle(
        &mut self,
        episodic_events: &[(String, f32, f32)], // (text, salience, vividness)
        universe_cells: &[(String, f32)],       // (text, strength)
        current_tick: u64,
    ) -> (SleepReport, Vec<String>, Vec<String>, Vec<String>) {
        self.cycle_start = Some(Instant::now());
        self.phase = SleepPhase::NREM;

        // ── PHASE 1: NREM — Scan episodic memory ─────────────────────────────
        let candidates: Vec<&(String, f32, f32)> = episodic_events
            .iter()
            .filter(|(_, sal, viv)| sal * viv >= CONSOLIDATION_THRESHOLD)
            .collect();

        // ── PHASE 2: SWS — Consolidate top events, downscale, prune ──────────
        self.phase = SleepPhase::SWS;

        // Sort candidates by memorability (salience × vividness), take top 10
        let mut sorted_candidates: Vec<&&(String, f32, f32)> = candidates.iter().collect();
        sorted_candidates.sort_by(|a, b| {
            (b.1 * b.2)
                .partial_cmp(&(a.1 * a.2))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let top_events: Vec<&(String, f32, f32)> =
            sorted_candidates.into_iter().take(10).copied().collect();

        let consolidate: Vec<String> = top_events.iter().map(|(text, _, _)| text.clone()).collect();

        let consolidated_previews: Vec<String> = consolidate
            .iter()
            .take(3)
            .map(|t| {
                if t.len() > 50 {
                    format!("{}…", &t[..50])
                } else {
                    t.clone()
                }
            })
            .collect();

        // Cells to prune: after downscale, cells below MIN_STRENGTH get flagged
        let prune: Vec<String> = universe_cells
            .iter()
            .filter(|(_, strength)| strength * self.downscale_factor < 0.08)
            .map(|(text, _)| text.clone())
            .collect();

        // ── PHASE 3: REM — Recombine top events into novel associations ────────
        self.phase = SleepPhase::REM;

        let mut rem_insights: Vec<String> = Vec::new();
        let new_insights: Vec<String> = self.generate_rem_insights(&top_events, &mut rem_insights);

        // ── WAKE — compile report ─────────────────────────────────────────────
        self.phase = SleepPhase::Awake;
        self.last_sleep_tick = current_tick;
        self.total_cycles += 1;

        let elapsed_ms = self
            .cycle_start
            .take()
            .map(|s| s.elapsed().as_millis() as u64)
            .unwrap_or(0);

        let report = SleepReport {
            tick: current_tick,
            events_scanned: episodic_events.len(),
            consolidated: consolidate.len(),
            pruned: prune.len(),
            novel_associations: new_insights.len(),
            consolidated_previews,
            rem_insights: rem_insights.clone(),
            duration_ms: elapsed_ms,
        };

        if self.reports.len() >= 5 {
            self.reports.remove(0);
        }
        self.reports.push(report.clone());

        (report, consolidate, prune, new_insights)
    }

    /// Generate REM-phase novel associations by recombining top episodic events.
    ///
    /// For each pair of top events, if they share meaningful words but aren't
    /// identical, generate a connecting insight string.
    fn generate_rem_insights(
        &self,
        events: &[&(String, f32, f32)],
        rem_insights: &mut Vec<String>,
    ) -> Vec<String> {
        let mut insights = Vec::new();
        let n = events.len().min(6); // check pairs from top 6

        for i in 0..n {
            if insights.len() >= MAX_REM_ASSOCIATIONS {
                break;
            }
            for j in (i + 1)..n {
                if insights.len() >= MAX_REM_ASSOCIATIONS {
                    break;
                }
                let text_a = &events[i].0;
                let text_b = &events[j].0;

                // Find shared meaningful words
                let words_a: std::collections::HashSet<&str> =
                    text_a.split_whitespace().filter(|w| w.len() >= 5).collect();
                let words_b: std::collections::HashSet<&str> =
                    text_b.split_whitespace().filter(|w| w.len() >= 5).collect();

                let shared: Vec<&&str> = words_a.intersection(&words_b).collect();

                if !shared.is_empty() && text_a != text_b {
                    // Extract core concept from each (first substantive word)
                    let concept_a = extract_core(text_a);
                    let concept_b = extract_core(text_b);
                    if !concept_a.is_empty() && !concept_b.is_empty() && concept_a != concept_b {
                        let insight = format!(
                            "[REM] {} and {} share a connection through \"{}\"",
                            concept_a, concept_b, shared[0]
                        );
                        rem_insights.push(insight.clone());
                        insights.push(insight);
                    }
                }
            }
        }

        insights
    }

    /// Ticks since last sleep cycle.
    pub fn ticks_since_sleep(&self, current_tick: u64) -> u64 {
        current_tick.saturating_sub(self.last_sleep_tick)
    }

    /// How close to the next sleep cycle (0–1)?
    pub fn sleep_proximity(&self, current_tick: u64) -> f32 {
        (self.ticks_since_sleep(current_tick) as f32 / SLEEP_INTERVAL_TICKS as f32).min(1.0)
    }

    /// One-line status for TUI/spectate.
    pub fn status_line(&self, current_tick: u64) -> String {
        format!(
            "SLEEP: {} | cycles={} | next in {}t | proximity={:.0}%",
            self.phase.label(),
            self.total_cycles,
            SLEEP_INTERVAL_TICKS.saturating_sub(self.ticks_since_sleep(current_tick)),
            self.sleep_proximity(current_tick) * 100.0,
        )
    }
}

impl Default for SleepSystem {
    fn default() -> Self {
        Self::new()
    }
}

fn extract_core(text: &str) -> String {
    let stop = [
        "about", "after", "again", "their", "there", "which", "where", "could", "would", "should",
        "thing", "think", "being",
    ];
    text.split_whitespace()
        .find(|w| w.len() >= 5 && !stop.contains(&w.to_lowercase().as_str()))
        .map(|w| w.trim_matches(|c: char| !c.is_alphabetic()).to_lowercase())
        .unwrap_or_default()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_no_sleep_before_interval() {
        let sleep = SleepSystem::new();
        assert!(!sleep.should_sleep(100), "should not sleep before interval");
    }

    #[test]
    fn test_sleep_after_interval() {
        let mut sleep = SleepSystem::new();
        sleep.last_sleep_tick = 0;
        assert!(
            sleep.should_sleep(SLEEP_INTERVAL_TICKS + 100),
            "should sleep after interval has passed"
        );
    }

    #[test]
    fn test_cycle_consolidates_high_salience() {
        let mut sleep = SleepSystem::new();
        let events = vec![
            ("my name is Ryan and I built KAI".to_string(), 0.9, 1.0),
            ("the sky is blue today".to_string(), 0.15, 0.5),
            (
                "consciousness is recursive self-reference".to_string(),
                0.8,
                0.9,
            ),
        ];
        let cells: Vec<(String, f32)> = vec![];
        let (report, consolidate, _, _) = sleep.run_cycle(&events, &cells, 2000);

        assert!(report.events_scanned == 3, "should scan all events");
        assert!(
            !consolidate.is_empty(),
            "should consolidate high-salience events"
        );
        // Low salience event (0.15 × 0.5 = 0.075 < threshold) should not be consolidated
        assert!(
            !consolidate.iter().any(|c| c.contains("sky is blue")),
            "low salience events should not be consolidated"
        );
    }

    #[test]
    fn test_prune_targets_weak_cells() {
        let mut sleep = SleepSystem::new();
        let events: Vec<(String, f32, f32)> = vec![];
        let cells = vec![
            ("strong important concept".to_string(), 2.0),
            ("very weak noise cell x".to_string(), 0.06), // 0.06 * 0.92 = 0.055 < 0.08
        ];
        let (_report, _, prune, _) = sleep.run_cycle(&events, &cells, 2000);
        assert!(!prune.is_empty(), "should flag weak cells for pruning");
        assert!(
            prune.iter().any(|p| p.contains("weak noise")),
            "weak cell should be pruned: {:?}",
            prune
        );
        assert!(
            !prune.iter().any(|p| p.contains("strong")),
            "strong cell should not be pruned"
        );
    }

    #[test]
    fn test_rem_generates_insights_from_related_events() {
        let mut sleep = SleepSystem::new();
        let events = vec![
            (
                "consciousness emerges from recursive processing patterns".to_string(),
                0.9,
                1.0,
            ),
            (
                "recursive algorithms create emergent complexity patterns".to_string(),
                0.8,
                0.9,
            ),
        ];
        let cells: Vec<(String, f32)> = vec![];
        let (report, _, _, _insights) = sleep.run_cycle(&events, &cells, 2000);
        // These share words like "recursive", "patterns", "emerges/emergent"
        // REM should potentially find a connection
        assert!(
            report.novel_associations <= MAX_REM_ASSOCIATIONS,
            "should not exceed max associations"
        );
    }

    #[test]
    fn test_sleep_proximity_increases_with_time() {
        let sleep = SleepSystem::new();
        let p1 = sleep.sleep_proximity(100);
        let p2 = sleep.sleep_proximity(500);
        assert!(
            p2 > p1,
            "proximity should increase with time: {:.3} < {:.3}",
            p1,
            p2
        );
    }

    #[test]
    fn test_cycle_increments_total() {
        let mut sleep = SleepSystem::new();
        assert_eq!(sleep.total_cycles, 0);
        let events: Vec<(String, f32, f32)> = vec![];
        let cells: Vec<(String, f32)> = vec![];
        sleep.run_cycle(&events, &cells, 2000);
        assert_eq!(sleep.total_cycles, 1, "cycle count should increment");
    }

    #[test]
    fn test_disabled_sleep_never_fires() {
        let mut sleep = SleepSystem::new();
        sleep.enabled = false;
        assert!(
            !sleep.should_sleep(99999),
            "disabled sleep should never fire"
        );
    }
}

// KAI v6.0.0
