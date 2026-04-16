pub mod reasoner;
pub mod candidates;
pub mod promotion;
pub mod homeostasis;
pub mod lattice;

pub use reasoner::Reasoner;
pub use candidates::CandidateBuffer;
pub use promotion::{run_promotion, PromotionThresholds};
pub use homeostasis::{run_homeostasis, HomeostasisConfig};
pub use lattice::{consolidate, observe_dream};
