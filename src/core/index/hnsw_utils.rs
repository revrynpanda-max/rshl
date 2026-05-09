use hnsw_rs::prelude::*;
use crate::core::SparseVec;

/// Custom distance metric for Sparse Ternary Vectors.
/// Uses 1.0 - cosine_similarity as the distance.
#[derive(Default, Clone)]
pub struct TernaryDistance;

impl<'a> Distance<SparseVec> for TernaryDistance {
    fn eval(&self, v1: &[SparseVec], v2: &[SparseVec]) -> f32 {
        // hnsw_rs passes slices, but for our HNSW<SparseVec>, 
        // each slice will have exactly 1 element.
        if v1.is_empty() || v2.is_empty() {
            return 1.0;
        }
        let sim = v1[0].cosine(&v2[0]);
        // Distance is 1.0 - similarity (0.0 means identical, 2.0 means opposite)
        1.0 - sim
    }
}
