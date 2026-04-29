use crossbeam_channel::{unbounded, Receiver, Sender};
/// Shared Bus — The nervous system connecting all 3 streams.
///
/// Each stream publishes its state to the bus. Any stream can read
/// any other stream's state at any time (read-optimized via RwLock).
/// Commands between streams use crossbeam lock-free channels (<1ms).
use std::sync::{Arc, RwLock};
use std::time::Instant;

// ── Stream State Snapshots ─────────────────────────────────────────────────

/// GPU stream state — what the math engine is doing right now.
#[derive(Clone, Debug, Default)]
pub struct GpuState {
    pub last_batch_size: usize,
    pub last_batch_duration_us: u64,
    pub cosines_per_second: f64,
    pub utilization: f32,
    pub last_tick: Option<Instant>,
}

/// CPU stream state — what the logic engine is doing right now.
#[derive(Clone, Debug, Default)]
pub struct CpuState {
    pub mood: String,
    pub valence: f32,
    pub phi_g: f32,
    pub chi: f32,
    pub dream_count: u64,
    pub reasoning_depth: usize,
    pub last_insight: String,
    pub last_tick: Option<Instant>,
}

/// RAM stream state — what the memory manager is doing right now.
#[derive(Clone, Debug, Default)]
pub struct RamState {
    pub cell_count: usize,
    pub candidate_count: usize,
    pub memory_bytes: usize,
    pub cells_per_hour: f32,
    pub last_save: Option<Instant>,
    pub last_prune: Option<Instant>,
    pub last_tick: Option<Instant>,
}

// ── Events between streams ─────────────────────────────────────────────────

/// Events that streams send to each other through the bus.
#[derive(Clone, Debug)]
pub enum StreamEvent {
    // GPU → CPU: "Here are the cosine results you asked for"
    BatchCosineResult {
        query_id: u64,
        scores: Vec<(usize, f32)>, // (cell_index, score)
    },

    // CPU → GPU: "Compute cosine of this vector against all cells"
    BatchCosineRequest {
        query_id: u64,
        query_vec: Vec<i8>, // serialized SparseVec data
    },

    // CPU → RAM: "Store this new cell"
    StoreCell {
        text: String,
        region: String,
        source: String,
        strength: f32,
    },

    // CPU → RAM: "Reinforce cell at this index"
    ReinforceCell {
        cell_text: String,
        delta: f32,
    },

    // RAM → CPU: "Cell count changed, here's the new count"
    CellCountUpdate {
        count: usize,
    },

    // Any → Any: "Heartbeat tick"
    Tick {
        stream: String,
        tick_number: u64,
    },

    // Control: "Shutdown all streams"
    Shutdown,
}

// ── The Shared Bus ─────────────────────────────────────────────────────────

/// The shared bus that connects all three streams.
/// Each stream gets its own sender for publishing events,
/// and a receiver for reading events from the other streams.
pub struct SharedBus {
    // State snapshots — read by any stream, written by the owning stream
    pub gpu_state: Arc<RwLock<GpuState>>,
    pub cpu_state: Arc<RwLock<CpuState>>,
    pub ram_state: Arc<RwLock<RamState>>,

    // Event channels — one per stream direction
    // These are multi-producer, multi-consumer
    pub gpu_tx: Sender<StreamEvent>,
    pub gpu_rx: Receiver<StreamEvent>,
    pub cpu_tx: Sender<StreamEvent>,
    pub cpu_rx: Receiver<StreamEvent>,
    pub ram_tx: Sender<StreamEvent>,
    pub ram_rx: Receiver<StreamEvent>,
}

impl SharedBus {
    /// Create a new shared bus with all channels and state initialized.
    pub fn new() -> Self {
        let (gpu_tx, gpu_rx) = unbounded();
        let (cpu_tx, cpu_rx) = unbounded();
        let (ram_tx, ram_rx) = unbounded();

        Self {
            gpu_state: Arc::new(RwLock::new(GpuState::default())),
            cpu_state: Arc::new(RwLock::new(CpuState::default())),
            ram_state: Arc::new(RwLock::new(RamState::default())),
            gpu_tx,
            gpu_rx,
            cpu_tx,
            cpu_rx,
            ram_tx,
            ram_rx,
        }
    }

    /// Get a snapshot of all three stream states (for UI display).
    pub fn snapshot(&self) -> (GpuState, CpuState, RamState) {
        let gpu = self.gpu_state.read().unwrap().clone();
        let cpu = self.cpu_state.read().unwrap().clone();
        let ram = self.ram_state.read().unwrap().clone();
        (gpu, cpu, ram)
    }
}
