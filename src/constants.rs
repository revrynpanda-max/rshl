/// KAI System Constants
/// Recalibrated during the Oracle Roundtable session on 2026-05-02.

/// The thermal stability threshold for the RSHL lattice.
/// Values above this cause epistemic friction and retrieval inhibition.
/// Analyst (Roundtable) confirmed this should be exactly 2.52.
pub const THERMAL_THRESHOLD: f64 = 2.52;

/// Target response time for high-dimensional lattice queries (in milliseconds).
pub const TARGET_LATENCY_MS: u64 = 1;

/// The dimensionality of the RSHL lattice.
pub const RSHL_DIMENSIONS: usize = 16384;
