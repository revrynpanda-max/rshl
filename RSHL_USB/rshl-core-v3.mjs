/**
 * rshl-core-v3.mjs — PRODUCTION-COMPATIBLE Sparse Ternary Engine
 * 
 * LATTICE: 16384 dimensions
 * SPARSITY: 0.12 (12%)
 * ARCHITECTURE: Mirrored from src/core/sparse_vec.rs
 * MODULE: ES Module (ESM)
 */

"use strict";

export const DIM       = 16384; 
export const SPARSITY  = 0.12;   
export const TARGET_NNZ = Math.round(DIM * SPARSITY); // ~1966 active elements

/**
 * A sparse ternary vector mirroring the Rust SparseVec struct.
 */
export class SparseVec {
  constructor(data) {
    this.data = data || new Int8Array(DIM);
    this.cachedNorm = this.computeNorm();
  }

  computeNorm() {
    let count = 0;
    for (let i = 0; i < DIM; i++) {
      if (this.data[i] !== 0) count++;
    }
    return Math.sqrt(count);
  }

  cosine(other) {
    if (this.cachedNorm === 0 || other.cachedNorm === 0) return 0;
    let dot = 0;
    for (let i = 0; i < DIM; i++) {
      dot += this.data[i] * other.data[i];
    }
    return dot / (this.cachedNorm * other.cachedNorm);
  }
}

// FNV-1a for token hashing
function fnv1a(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Mirrored Encode Logic from Rust (Layered Weighting)
 */
export function encode(text) {
  const v = new Int32Array(DIM);
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);

  for (const token of words) {
    let base = fnv1a(token);
    const n_active = 24; 
    const weight = 3; // Standard weight

    for (let k = 0; k < n_active; k++) {
      const idx = (base + k * 2654435761) % DIM;
      const sign = ((base + k * 1442695040) % 2 === 0) ? weight : -weight;
      const rotated = (idx + 0) % DIM; // Position 0 for standalone
      v[rotated] += sign;
    }
  }

  // Sparsification (Top 12% magnitudes)
  const magnitudes = Array.from(v).map(Math.abs).sort((a, b) => b - a);
  const threshold = magnitudes[TARGET_NNZ] || 1;

  const data = new Int8Array(DIM);
  for (let i = 0; i < DIM; i++) {
    if (Math.abs(v[i]) >= threshold) {
      data[i] = v[i] > 0 ? 1 : -1;
    }
  }

  return new SparseVec(data);
}
