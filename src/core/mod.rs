pub mod attention;
pub mod boid_engine;
pub mod calibration;
pub mod claim;
pub mod claimstore;
pub mod contradiction;
pub mod embeddings;
pub mod engine;
pub mod evidence;
pub mod field_state;
pub mod deep_vault;
pub mod lexicon;
pub mod memory;
pub mod mind_frame;
pub mod neural_memory;
#[cfg(feature = "gpu")]
pub mod gpu_compute;

#[cfg(not(feature = "gpu"))]
pub mod gpu_compute {
    use crate::core::sparse_vec::SparseVec;
    pub struct GpuCompute;
    pub struct BoidForceResult { pub bundle_sums: Vec<i32> }
    impl GpuCompute {
        pub async fn new() -> Option<Self> { None }
        pub async fn batch_cosine(&self, _query: &SparseVec, _targets: &[&SparseVec]) -> Vec<f32> { vec![] }
        pub async fn run_boid_forces(&self, _cell_vecs: &[SparseVec], _sep_weight: i32, _coh_weight: i32, _anchor_weight: i32) -> BoidForceResult { BoidForceResult { bundle_sums: vec![] } }
        pub fn update_active_region(&self, _region: u32) {}
    }
    pub fn threshold_bundle(_bundle: &[i32], _n: usize) -> Vec<i8> { vec![] }
}
#[cfg(feature = "gpu")]
pub mod gpu_kernel;
pub mod normalize;
pub mod oscillator;
pub mod pos_dict;
pub mod predictive;
pub mod reasoning;
pub mod regions;
pub mod seed;
pub mod sparse_vec;
pub mod spiral;
pub mod stat_lexicon;
pub mod hierarchy;
pub mod synapse;
pub mod text_store;
pub mod universe;
pub mod index;
pub mod scale_manager;
pub mod rshl_transformer;
pub mod interpret;

pub use synapse::{SynapticLayer, NeuralBus};
pub use rshl_transformer::{RshlHead, RshlFeedForward, RshlTransformerBlock, TransformerConfig};
pub use embeddings::Embeddings;
pub use field_state::FieldState;
pub use lexicon::Lexicon;
pub use mind_frame::{
    AttentionHeadScore, MindAction, MindFrame, MindIntent, ModuleContribution,
    ModuleContributionStatus,
};
pub use normalize::get_normalizer;
pub use oscillator::{NeuralOscillator, OscillatorOutput};
pub use predictive::ConversationTrace;
pub use reasoning::{ContextSlot, Reasoner};
pub use sparse_vec::{SparseVec, DenseMask, PackedMask};
#[cfg(feature = "gpu")]
pub use gpu_kernel::GpuKernel;
pub use stat_lexicon::StatLexicon;
pub use pos_dict::{PosDictionary, SemanticEntry};
pub use universe::{Cell, QueryHit, Universe, PredictiveScoreBreakdown};
pub use calibration::CalibrationEngine;
pub use text_store::TextStore;

