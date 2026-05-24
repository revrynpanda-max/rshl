//! RSHL Ternary Lattice Engine (D=16384, Boid Flocking, Fibonacci Phase).
//! All heavy computations are chunked with yield points to prevent tokio lockup.
//! A global cancellation flag allows early exit on timeout.

use rand::Rng;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::time::Duration;

/// Global cancellation flag – set `true` when a timeout is detected.
pub static SHOULD_ABORT: AtomicBool = AtomicBool::new(false);

/// The primary lattice structure holding ternary vectors (+1, 0, -1) and boid state.
pub struct Lattice {
    vectors: Vec<Vec<i8>>,       // N vectors of dimension D
    velocities: Vec<Vec<f64>>,   // boid flocking velocities
    dimension: usize,
    chunk_size: usize,
}

pub struct LatticeStats {
    pub vector_count: usize,
    pub energy: f64,
    pub flock_cohesion: f64,
}

impl Lattice {
    pub fn new() -> Self {
        let dimension = 16384;
        let vector_count = 512;
        let mut rng = rand::thread_rng();

        let vectors: Vec<Vec<i8>> = (0..vector_count)
            .map(|_| (0..dimension).map(|_| rng.gen_range(-1..=1)).collect())
            .collect();
        let velocities: Vec<Vec<f64>> = (0..vector_count)
            .map(|_| vec![0.0; dimension])
            .collect();

        Self {
            vectors,
            velocities,
            dimension,
            chunk_size: dimension / 16, // ~1024 elements per chunk
        }
    }

    /// Main processing step: Hebbian update + boid flocking, with yield points.
    pub async fn process(&mut self, iterations: usize) {
        SHOULD_ABORT.store(false, Ordering::Relaxed);

        for _iter in 0..iterations {
            if SHOULD_ABORT.load(Ordering::Relaxed) {
                break;
            }

            // Phase I: Local plasticity (Hebbian)
            self.hebbian_update_chunked().await;

            // Phase II: Boid flocking
            self.boid_flocking_chunked().await;

            // Yield to allow the async runtime to handle other requests
            tokio::task::yield_now().await;
        }
    }

    /// Chunked Hebbian update with yield after each chunk.
    async fn hebbian_update_chunked(&mut self) {
        let n = self.vectors.len();
        // Process matrix in horizontal strips
        for (i, row) in self.vectors.iter_mut().enumerate() {
            for chunk in row.chunks_mut(self.chunk_size) {
                for el in chunk.iter_mut() {
                    // Simple Hebbian: strengthen coactive units
                    // (placehold – real implementation uses spike‑timing)
                    *el = (*el).saturating_add(1).clamp(-1, 1);
                }
                // Yield between chunks – allows the runtime to handle other tasks
                tokio::task::yield_now().await;
                if SHOULD_ABORT.load(Ordering::Relaxed) {
                    return;
                }
            }
        }
    }

    /// Chunked Boid flocking with check for abort.
    async fn boid_flocking_chunked(&mut self) {
        let alignment_weight = 0.01;
        let cohesion_weight = 0.005;
        let separation_distance = 50.0;

        // Process velocities in parallel (rayon is fine inside spawn_blocking if needed,
        // but here we use sequential + yield to keep it simple within async context)
        for i in 0..self.vectors.len() {
            if SHOULD_ABORT.load(Ordering::Relaxed) {
                return;
            }
            let mut alignment = vec![0.0; self.dimension];
            let mut cohesion = vec![0.0; self.dimension];

            for j in 0..self.vectors.len() {
                if i == j {
                    continue;
                }
                let diff: f64 = self.vectors[i]
                    .iter()
                    .zip(self.vectors[j].iter())
                    .map(|(a, b)| (a - b).abs() as f64)
                    .sum();

                // Alignment: steer toward average direction of neighbours
                for (d, &v) in self.velocities[j].iter().enumerate() {
                    alignment[d] += v;
                }
                // Cohesion: steer toward centre of mass
                if diff < 2000.0 {
                    for (d, &val) in self.vectors[j].iter().enumerate() {
                        cohesion[d] += val as f64;
                    }
                }
                // Separation: avoid very close neighbours (placeholder)
            }

            // Update velocity
            for d in 0..self.dimension {
                self.velocities[i][d] = alignment[d] * alignment_weight
                    + cohesion[d] * cohesion_weight;
            }

            // Once per 32 vectors, yield control
            if i % 32 == 0 {
                tokio::task::yield_now().await;
            }
        }

        // Apply velocities to positions (ternary clamp)
        for (vec, vel) in self.vectors.iter_mut().zip(self.velocities.iter()) {
            for (v, &vel_val) in vec.iter_mut().zip(vel.iter()) {
                let shift = (vel_val * 0.1).round() as i8;
                *v = (*v + shift).clamp(-1, 1);
            }
        }
    }

    /// Save partial state when timeout occurs.
    pub fn emergency_save(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        let path = "lattice_snapshot.bin";
        let bytes: Vec<u8> = self
            .vectors
            .iter()
            .flat_map(|v| v.iter().map(|&x| x as u8))
            .collect();
        std::fs::write(path, bytes)?;
        Ok(())
    }

    /// Return statistics.
    pub fn stats(&self) -> LatticeStats {
        let energy: f64 = self
            .vectors
            .iter()
            .flat_map(|v| v.iter())
            .map(|&x| x as f64)
            .sum();
        LatticeStats {
            vector_count: self.vectors.len(),
            energy,
            flock_cohesion: 0.0, // placeholder
        }
    }
}
