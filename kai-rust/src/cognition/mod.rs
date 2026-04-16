pub mod reasoner;
pub mod candidates;
pub mod promotion;
pub mod homeostasis;
pub mod lattice;
pub mod inner_voice;
pub mod working_memory;
pub mod compose;

pub use reasoner::Reasoner;
pub use candidates::CandidateBuffer;
pub use promotion::{run_promotion, PromotionThresholds};
pub use homeostasis::{run_homeostasis, HomeostasisConfig};
pub use lattice::{consolidate, observe_dream, reinforce_dream_sources};
pub use inner_voice::{validate_insight, explore_lexicon_binding, InsightVerdict};
pub use working_memory::WorkingMemory;
pub use compose::{compose_response, ComposedResponse};
