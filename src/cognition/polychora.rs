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
/// We use 4 pseudo-random but deterministic orthogonal projection vectors.
pub fn project_to_4d(vec: &SparseTernaryVec) -> Quaternion {
    let mut w = 0.0;
    let mut x = 0.0;
    let mut y = 0.0;
    let mut z = 0.0;

    for (&idx, &sign) in vec.indices.iter().zip(vec.signs.iter()) {
        let s = sign as f32;
        // Deterministic pseudo-random projection based on index
        let phase1 = (idx as f32 * 0.12345).sin();
        let phase2 = (idx as f32 * 0.23456).cos();
        let phase3 = (idx as f32 * 0.34567).sin();
        let phase4 = (idx as f32 * 0.45678).cos();

        w += s * phase1;
        x += s * phase2;
        y += s * phase3;
        z += s * phase4;
    }

    Quaternion::new(w, x, y, z).normalize()
}

/// Find the closest 600-cell vertex to a given 4D quaternion
pub fn snap_to_600_cell(q: &Quaternion, vertices: &[Quaternion]) -> usize {
    let mut best_idx = 0;
    let mut best_dot = -1.0;

    for (i, v) in vertices.iter().enumerate() {
        let dot = q.dot(v);
        // We use absolute dot product because quaternions q and -q represent the same 3D rotation,
        // but since we are treating it as pure 4D geometry, we might want directional dot.
        if dot > best_dot {
            best_dot = dot;
            best_idx = i;
        }
    }

    best_idx
}

use std::sync::OnceLock;

pub fn get_600_cell_vertices() -> &'static [Quaternion] {
    static POLYTOPES_600: OnceLock<Vec<Quaternion>> = OnceLock::new();
    POLYTOPES_600.get_or_init(generate_600_cell_vertices)
}
