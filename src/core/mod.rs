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
pub mod lexicon;
pub mod memory;
pub mod mind_frame;
pub mod gpu_compute;
pub mod normalize;
pub mod oscillator;
pub mod predictive;
pub mod reasoning;
pub mod regions;
pub mod seed;
pub mod sparse_vec;
pub mod spiral;
pub mod stat_lexicon;
pub mod synapse;
pub mod universe;
pub mod index;
pub mod scale_manager;

pub use synapse::{SynapticLayer, NeuralBus};
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
pub use sparse_vec::SparseVec;
pub use stat_lexicon::StatLexicon;
pub use universe::{Cell, QueryHit, Universe, PredictiveScoreBreakdown};

