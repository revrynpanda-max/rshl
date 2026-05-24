//! Centralized timeout registry for the KAI RSHL core.
//! All blocking‑or‑async boundaries must respect these constants.

use std::time::Duration;

// ── Network (HTTP) ────────────────────────────────────────────────────────────
/// Maximum wait for any outgoing HTTP request (reqwest client).
pub const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

// ── Inter‑thread channels (crossbeam / tokio) ─────────────────────────────────
/// Maximum wait for a receiver to obtain a message before treating it as dead.
pub const CHANNEL_TIMEOUT: Duration = Duration::from_millis(200);

// ── GPU fence / device operations (wgpu) ──────────────────────────────────────
/// Maximum time to wait for a GPU fence before declaring a hang and restarting.
pub const GPU_TIMEOUT: Duration = Duration::from_secs(30);

// ── Lattice Boid stepping ─────────────────────────────────────────────────────
/// Hard deadline for one flock iteration (prevents UI freezes).
pub const BOID_STEP_TIMEOUT: Duration = Duration::from_millis(50);
