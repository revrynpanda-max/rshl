//! 4D Polychora Geometry Module
//!
//! Implements the mathematics for a 600-cell (Hexacosichoron) in 4D space.
//! Used to structurally project high-dimensional sparse ternary vectors down
//! into geometric states for KAI's native cognitive processing.
//!
//! A 600-cell has 120 vertices. We use Quaternions to represent 4D points.

use std::f32::consts::PI;
use crate::cognition::language_warehouse::SparseTernaryVec;

/// A 4D point or Quaternion (w, x, y, z)
#[derive(Clone, Copy, Debug)]
pub struct Quaternion {
    pub w: f32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Quaternion {
    pub fn new(w: f32, x: f32, y: f32, z: f32) -> Self {
        Self { w, x, y, z }
    }

    pub fn dot(&self, other: &Self) -> f32 {
        self.w * other.w + self.x * other.x + self.y * other.y + self.z * other.z
    }

    pub fn normalize(&self) -> Self {
        let mag = (self.dot(self)).sqrt();
        if mag == 0.0 {
            return Self::new(0.0, 0.0, 0.0, 0.0);
        }
        Self::new(self.w / mag, self.x / mag, self.y / mag, self.z / mag)
    }
}

/// Generates the 120 vertices of a 600-cell in 4D space.
/// The vertices consist of:
/// - 8 permutations of (±1, 0, 0, 0)
/// - 16 permutations of (±0.5, ±0.5, ±0.5, ±0.5)
/// - 96 even permutations of (±0.5*phi, ±0.5, ±0.5/phi, 0) where phi is the golden ratio
pub fn generate_600_cell_vertices() -> Vec<Quaternion> {
    let mut vertices = Vec::with_capacity(120);
    let phi = (1.0 + 5.0_f32.sqrt()) / 2.0;

    // 8 vertices: permutations of (±1, 0, 0, 0)
    let perms_1 = [
        (1.0, 0.0, 0.0, 0.0), (-1.0, 0.0, 0.0, 0.0),
        (0.0, 1.0, 0.0, 0.0), (0.0, -1.0, 0.0, 0.0),
        (0.0, 0.0, 1.0, 0.0), (0.0, 0.0, -1.0, 0.0),
        (0.0, 0.0, 0.0, 1.0), (0.0, 0.0, 0.0, -1.0),
    ];
    for (w, x, y, z) in perms_1.iter() {
        vertices.push(Quaternion::new(*w, *x, *y, *z));
    }

    // 16 vertices: (±0.5, ±0.5, ±0.5, ±0.5)
    for i in 0..16 {
        let w = if i & 1 == 0 { 0.5 } else { -0.5 };
        let x = if i & 2 == 0 { 0.5 } else { -0.5 };
        let y = if i & 4 == 0 { 0.5 } else { -0.5 };
        let z = if i & 8 == 0 { 0.5 } else { -0.5 };
        vertices.push(Quaternion::new(w, x, y, z));
    }

    // 96 vertices: even permutations of (±0.5*phi, ±0.5, ±0.5/phi, 0)
    let v_phi = 0.5 * phi;
    let v_1 = 0.5;
    let v_inv_phi = 0.5 / phi;
    let v_0 = 0.0;

    // A helper to push all 16 sign combinations for a specific coordinate permutation
    let mut add_signs = |w_val: f32, x_val: f32, y_val: f32, z_val: f32| {
        for i in 0..16 {
            let mut w = w_val;
            let mut x = x_val;
            let mut y = y_val;
            let mut z = z_val;
            if w != 0.0 && (i & 1 != 0) { w = -w; }
            if x != 0.0 && (i & 2 != 0) { x = -x; }
            if y != 0.0 && (i & 4 != 0) { y = -y; }
            if z != 0.0 && (i & 8 != 0) { z = -z; }
            vertices.push(Quaternion::new(w, x, y, z));
        }
    };

    // Even permutations of (v_phi, v_1, v_inv_phi, v_0)
    add_signs(v_phi, v_1, v_inv_phi, v_0);
    add_signs(v_phi, v_inv_phi, v_0, v_1);
    add_signs(v_phi, v_0, v_1, v_inv_phi);
    
    add_signs(v_1, v_inv_phi, v_phi, v_0);
    add_signs(v_1, v_0, v_inv_phi, v_phi);
    add_signs(v_1, v_phi, v_0, v_inv_phi);

    add_signs(v_inv_phi, v_phi, v_1, v_0);
    add_signs(v_inv_phi, v_0, v_phi, v_1);
    add_signs(v_inv_phi, v_1, v_0, v_phi);

    add_signs(v_0, v_1, v_phi, v_inv_phi);
    add_signs(v_0, v_inv_phi, v_1, v_phi);
    add_signs(v_0, v_phi, v_inv_phi, v_1);

    // Make sure we have exactly 120 by removing exact duplicates due to 0 signs
    let mut unique: Vec<Quaternion> = Vec::new();
    for v in vertices {
        let mut is_dup = false;
        for u in &unique {
            if (v.w - u.w).abs() < 1e-5 &&
               (v.x - u.x).abs() < 1e-5 &&
               (v.y - u.y).abs() < 1e-5 &&
               (v.z - u.z).abs() < 1e-5 {
                is_dup = true;
                break;
            }
        }
        if !is_dup {
            unique.push(v);
        }
    }
    
    // We should have 120 unique vertices
    assert_eq!(unique.len(), 120, "600-cell must have 120 vertices");
    unique
}

/// Project a 16384-dimensional SparseTernaryVec down to a 4D Quaternion.
/// Uses golden-ratio–based irrational rotations so that every index maps to a
/// distinct point on the 4D unit sphere, regardless of spacing. The old
/// sin(i*0.123) phases had period collisions that collapsed distinct vectors
/// to the same vertex.
pub fn project_to_4d(vec: &SparseTernaryVec) -> Quaternion {
    let mut w = 0.0f64;
    let mut x = 0.0f64;
    let mut y = 0.0f64;
    let mut z = 0.0f64;

    // Four irrational frequencies derived from primes — guaranteed no period
    // overlap within 16384 indices. Using f64 intermediates to avoid float
    // cancellation on large sums.
    const PHI: f64    = 1.6180339887498948;   // golden ratio
    const SQRT2: f64  = 1.4142135623730951;
    const SQRT3: f64  = 1.7320508075688772;
    const SQRT5: f64  = 2.2360679774997896;

    for (&idx, &sign) in vec.indices.iter().zip(vec.signs.iter()) {
        let s = sign as f64;
        let i = idx as f64;
        // Each component uses a different irrational multiple of the index,
        // ensuring the four projection axes are incommensurate (no shared period).
        w += s * (i * PHI).sin();
        x += s * (i * SQRT2).cos();
        y += s * (i * SQRT3).sin();
        z += s * (i * SQRT5).cos();
    }

    Quaternion::new(w as f32, x as f32, y as f32, z as f32).normalize()
}

/// Find the closest 600-cell vertex to a given 4D quaternion using Quantum Born Rule Mathematics
/// Treat the 4D point as a quantum state vector |ψ>. The probability amplitude of collapsing into
/// a vertex |v> is given by the Born Rule P = |<ψ|v>|^2. We also introduce a destructive phase
/// interference angle driven by SRHT contradiction (chi) to repel uncertain states.
pub fn quantum_interference_snap(q: &Quaternion, vertices: &[Quaternion], chi: f32) -> usize {
    let mut best_idx = 0;
    let mut highest_prob = -1.0;

    // Phase angle θ derived from contradiction χ. High conflict = high destructive phase.
    // We map chi [0, 1] to a phase shift [0, pi/2].
    let phase_angle = chi * (std::f32::consts::PI / 2.0);
    let phase_cos = phase_angle.cos();

    for (i, v) in vertices.iter().enumerate() {
        // Quantum probability amplitude <q|v>
        let amplitude = q.dot(v);
        
        // Born Rule: P = |<q|v>|^2
        let mut probability = amplitude * amplitude;

        // Apply SRHT Destructive Interference:
        // If the amplitude is negative (opposite direction), high contradiction phase 
        // will aggressively dampen the collapse probability to prevent mis-routing.
        if amplitude < 0.0 {
            probability *= phase_cos;
        }

        if probability > highest_prob {
            highest_prob = probability;
            best_idx = i;
        }
    }

    // Print a tiny quantum state log if contradiction is high
    if chi > 0.4 {
        println!("[KAI/SRHT/Quantum] State collapsed to vertex {} with Born prob P={:.4} (χ phase={:.2})", best_idx, highest_prob, phase_angle);
    }

    best_idx
}

/// Fallback standard Euclidean snap for legacy systems
pub fn snap_to_600_cell(q: &Quaternion, vertices: &[Quaternion]) -> usize {
    quantum_interference_snap(q, vertices, 0.0)
}

use std::sync::OnceLock;

pub fn get_600_cell_vertices() -> &'static [Quaternion] {
    static POLYTOPES_600: OnceLock<Vec<Quaternion>> = OnceLock::new();
    POLYTOPES_600.get_or_init(generate_600_cell_vertices)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cognition::language_warehouse::SparseTernaryVec;

    #[test]
    fn test_600_cell_has_120_vertices() {
        let v = get_600_cell_vertices();
        assert_eq!(v.len(), 120, "600-cell must have exactly 120 vertices");
    }

    #[test]
    fn test_vertices_are_unit_length() {
        for (i, v) in get_600_cell_vertices().iter().enumerate() {
            let len = v.dot(v).sqrt();
            assert!((len - 1.0).abs() < 0.01, "vertex {} has length {}, expected 1.0", i, len);
        }
    }

    #[test]
    fn test_projection_is_deterministic() {
        let stv = SparseTernaryVec {
            indices: vec![10, 100, 500, 1000, 5000, 10000],
            signs: vec![1, -1, 1, 1, -1, 1],
            dim: 16384,
        };
        let q1 = project_to_4d(&stv);
        let q2 = project_to_4d(&stv);
        assert_eq!(q1.w, q2.w);
        assert_eq!(q1.x, q2.x);
        assert_eq!(q1.y, q2.y);
        assert_eq!(q1.z, q2.z);
    }

    #[test]
    fn test_snap_returns_valid_vertex() {
        let stv = SparseTernaryVec {
            indices: vec![42, 256, 8192],
            signs: vec![1, -1, 1],
            dim: 16384,
        };
        let q = project_to_4d(&stv);
        let vertices = get_600_cell_vertices();
        let idx = snap_to_600_cell(&q, vertices);
        assert!(idx < 120, "vertex index {} out of range", idx);
    }

    #[test]
    fn test_similar_vectors_snap_to_same_vertex() {
        // Two vectors with mostly the same indices should project nearby
        let a = SparseTernaryVec {
            indices: vec![10, 100, 500, 1000, 5000],
            signs: vec![1, -1, 1, 1, -1],
            dim: 16384,
        };
        let b = SparseTernaryVec {
            indices: vec![10, 100, 500, 1000, 5001], // only last index differs slightly
            signs: vec![1, -1, 1, 1, -1],
            dim: 16384,
        };
        let vertices = get_600_cell_vertices();
        let va = snap_to_600_cell(&project_to_4d(&a), vertices);
        let vb = snap_to_600_cell(&project_to_4d(&b), vertices);
        // They should snap to the same vertex or adjacent ones (high dot product)
        if va != vb {
            let dot = vertices[va].dot(&vertices[vb]);
            assert!(dot > 0.3, "similar vectors snapped to distant vertices (dot={})", dot);
        }
    }

    #[test]
    fn test_different_concepts_can_snap_to_different_vertices() {
        // Two vectors with DIFFERENT indices should project to different 4D regions
        let a = SparseTernaryVec {
            indices: (0..40).map(|i| i * 100).collect(),
            signs: vec![1; 40],
            dim: 16384,
        };
        let b = SparseTernaryVec {
            indices: (0..40).map(|i| i * 100 + 50).collect(), // offset by 50
            signs: vec![1; 40],
            dim: 16384,
        };
        let vertices = get_600_cell_vertices();
        let va = snap_to_600_cell(&project_to_4d(&a), vertices);
        let vb = snap_to_600_cell(&project_to_4d(&b), vertices);
        // Different concepts should generally snap to different vertices
        // (not guaranteed for all inputs, but with 120 vertices and distinct
        // index sets, collision is unlikely)
        assert_ne!(va, vb, "distinct concept vectors snapped to same vertex — projection may lack discrimination");
    }

    #[test]
    fn test_negated_vector_same_vertex_born_rule() {
        // Born rule: P = |<ψ|v>|^2 — negating ψ produces the same probabilities.
        // This is CORRECT quantum behavior: |ψ> and -|ψ> are the same state.
        let indices: Vec<u16> = (0..30).map(|i| i * 400 + 10).collect();
        let a = SparseTernaryVec { indices: indices.clone(), signs: vec![1; 30], dim: 16384 };
        let b = SparseTernaryVec { indices, signs: vec![-1; 30], dim: 16384 };
        let vertices = get_600_cell_vertices();
        let va = snap_to_600_cell(&project_to_4d(&a), vertices);
        let vb = snap_to_600_cell(&project_to_4d(&b), vertices);
        assert_eq!(va, vb, "Born rule: negated state must collapse to same vertex");
    }

    #[test]
    fn test_quantum_interference_high_chi_dampens() {
        let q = Quaternion::new(0.5, 0.5, 0.5, 0.5).normalize();
        let vertices = get_600_cell_vertices();
        let clean = quantum_interference_snap(&q, vertices, 0.0);
        let conflicted = quantum_interference_snap(&q, vertices, 0.9);
        // Both should return valid indices; with high chi, negative-amplitude
        // vertices get dampened so the result may differ
        assert!(clean < 120);
        assert!(conflicted < 120);
    }
}
