pub mod cpu_stream;
pub mod gpu_stream;
pub mod ram_stream;
/// 3-Stream Architecture — GPU + CPU + RAM working in parallel.
///
/// Each stream runs on its own dedicated thread. They communicate
/// through crossbeam lock-free channels and shared state via Arc<RwLock>.
///
/// Stream 1 (GPU/Math):  Batch cosine similarity, vector binding
/// Stream 2 (CPU/Logic): Reasoning, dreaming, drive, inner voice
/// Stream 3 (RAM/Memory): Cell storage, pruning, persistence, intake
pub mod shared_bus;

pub use shared_bus::SharedBus;
