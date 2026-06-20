use super::SparseVec;
use serde::{Deserialize, Serialize};

const HIDDEN_DIM: usize = 128;
const INPUT_DIM: usize = 16384;
const LEARNING_RATE: f32 = 0.05;

/// Synaptic Retraining Neural Memory (Test-Time Training MLP)
/// This replaces static memory lists by compressing memory into structural weights.
#[derive(Clone, Serialize, Deserialize)]
pub struct NeuralMemory {
    // W1: hidden_dim x input_dim
    pub w1: Vec<f32>,
    // W2: input_dim x hidden_dim
    pub w2: Vec<f32>,
}

impl NeuralMemory {
    pub fn new() -> Self {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        // Xavier/Glorot initialization
        let limit1 = (6.0 / (INPUT_DIM as f32 + HIDDEN_DIM as f32)).sqrt();
        let w1 = (0..(HIDDEN_DIM * INPUT_DIM))
            .map(|_| rng.gen_range(-limit1..limit1))
            .collect();

        let limit2 = (6.0 / (HIDDEN_DIM as f32 + INPUT_DIM as f32)).sqrt();
        let w2 = (0..(INPUT_DIM * HIDDEN_DIM))
            .map(|_| rng.gen_range(-limit2..limit2))
            .collect();

        Self { w1, w2 }
    }
}

impl Default for NeuralMemory {
    fn default() -> Self {
        Self::new()
    }
}

impl NeuralMemory {
    /// Forward pass: query the neural memory with a sparse key to get a dense representation.
    pub fn recall(&self, key: &SparseVec) -> Vec<f32> {
        let mut h = vec![0.0; HIDDEN_DIM];
        // Sparse matrix-vector multiplication (W1 * x)
        for (idx, &dim_idx) in key.nz.iter().enumerate() {
            let val = key.vals[idx] as f32;
            for i in 0..HIDDEN_DIM {
                h[i] += self.w1[i * INPUT_DIM + (dim_idx as usize)] * val;
            }
        }

        // Activation (e.g., SiLU or simply ReLU)
        for val in h.iter_mut() {
            *val = val.max(0.0);
        }

        let mut out = vec![0.0; INPUT_DIM];
        // Dense matrix-vector multiplication (W2 * h)
        for i in 0..INPUT_DIM {
            let mut sum = 0.0;
            for j in 0..HIDDEN_DIM {
                sum += self.w2[i * HIDDEN_DIM + j] * h[j];
            }
            out[i] = sum;
        }

        out
    }

    /// Learn at test time: Update the neural memory using gradient descent (surprise).
    /// Target is ideally the dense vector of the value cell.
    pub fn memorize(&mut self, key: &SparseVec, target: &SparseVec, surprise: f32) {
        // Forward pass
        let mut h = vec![0.0; HIDDEN_DIM];
        let mut h_pre = vec![0.0; HIDDEN_DIM];
        for (idx, &dim_idx) in key.nz.iter().enumerate() {
            let val = key.vals[idx] as f32;
            for i in 0..HIDDEN_DIM {
                h_pre[i] += self.w1[i * INPUT_DIM + (dim_idx as usize)] * val;
            }
        }
        for i in 0..HIDDEN_DIM {
            h[i] = h_pre[i].max(0.0); // ReLU
        }

        let mut out = vec![0.0; INPUT_DIM];
        for i in 0..INPUT_DIM {
            let mut sum = 0.0;
            for j in 0..HIDDEN_DIM {
                sum += self.w2[i * HIDDEN_DIM + j] * h[j];
            }
            out[i] = sum;
        }

        // Calculate error (out - target)
        // Since target is sparse, we subtract the sparse values from the dense output.
        let mut error = out; // e = y_pred
        for (idx, &dim_idx) in target.nz.iter().enumerate() {
            let val = target.vals[idx] as f32;
            error[dim_idx as usize] -= val; // e = y_pred - y_true
        }

        // Scale learning rate by surprise (Titan's test-time training concept)
        let lr = LEARNING_RATE * surprise;

        // Backprop W2: dW2 = error * h^T
        // error is INPUT_DIM, h is HIDDEN_DIM
        let mut d_h = vec![0.0; HIDDEN_DIM];
        for i in 0..INPUT_DIM {
            let e = error[i];
            for j in 0..HIDDEN_DIM {
                let w_idx = i * HIDDEN_DIM + j;
                let old_w = self.w2[w_idx];
                self.w2[w_idx] -= lr * e * h[j];
                // Accumulate gradient for hidden layer using OLD weights
                d_h[j] += e * old_w;
            }
        }

        // Backprop W1: dW1 = d_h * x^T (with ReLU derivative)
        for i in 0..HIDDEN_DIM {
            if h_pre[i] > 0.0 {
                let d = d_h[i];
                for (idx, &dim_idx) in key.nz.iter().enumerate() {
                    let val = key.vals[idx] as f32;
                    self.w1[i * INPUT_DIM + (dim_idx as usize)] -= lr * d * val;
                }
            }
        }
    }
}
