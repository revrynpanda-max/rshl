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
  /**
   * @param {Int8Array} data  dense ternary buffer (-1/0/+1), length DIM
   * @param {number[]} [nz]   optional precomputed nonzero index list. encode()
   *                          already knows these, so passing them avoids a
   *                          second full O(DIM) scan at construction time.
   */
  constructor(data, nz) {
    this.data = data || new Int8Array(DIM);
    if (nz) {
      this.nz = nz;
    } else {
      const list = [];
      for (let i = 0; i < DIM; i++) {
        if (this.data[i] !== 0) list.push(i);
      }
      this.nz = list;
    }
    this.cachedNorm = Math.sqrt(this.nz.length); // ||v||2 = sqrt(nnz) for ternary
  }

  computeNorm() {
    return Math.sqrt(this.nz.length);
  }

  /**
   * Sparse cosine: iterate the sparser operand's active dims and look up the
   * other vector densely (O(1) each). Numerically identical to the full dense
   * loop because zero dims contribute nothing — it just skips the wasted work.
   */
  cosine(other) {
    if (this.cachedNorm === 0 || other.cachedNorm === 0) return 0;
    const sparse = this.nz.length <= other.nz.length ? this : other;
    const dense  = sparse === this ? other : this;
    const idx = sparse.nz, sd = sparse.data, dd = dense.data;
    let dot = 0;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      dot += sd[i] * dd[i];
    }
    return dot / (this.cachedNorm * other.cachedNorm);
  }

  /** Original full-width dense loop — kept for benchmarking / reference. */
  cosineDense(other) {
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
    const weight = 3;

    for (let k = 0; k < n_active; k++) {
      const idx = (base + k * 2654435761) % DIM;
      const sign = ((base + k * 1442695040) % 2 === 0) ? weight : -weight;
      const rotated = (idx + 0) % DIM;
      v[rotated] += sign;
    }
  }

  // Sparsification: keep the top TARGET_NNZ magnitudes.
  // Fast path — when the accumulator already has <= TARGET_NNZ nonzeros (the
  // normal case for real cells), every nonzero survives and the threshold is
  // 1, so we skip sorting 16,384 mostly-zero values entirely. Output is
  // byte-identical to the original Array.from(v).sort() version: when
  // nnz > TARGET_NNZ the top-(TARGET_NNZ+1) values are all nonzero, so the
  // nonzero-only sort yields the same threshold; when nnz <= TARGET_NNZ the
  // original sort's element at TARGET_NNZ was 0, giving threshold 1 as well.
  let nnz = 0;
  for (let i = 0; i < DIM; i++) if (v[i] !== 0) nnz++;

  let threshold = 1;
  if (nnz > TARGET_NNZ) {
    const mags = new Array(nnz);
    let m = 0;
    for (let i = 0; i < DIM; i++) if (v[i] !== 0) mags[m++] = Math.abs(v[i]);
    mags.sort((a, b) => b - a);
    threshold = mags[TARGET_NNZ] || 1;
  }

  const data = new Int8Array(DIM);
  const nz = [];
  for (let i = 0; i < DIM; i++) {
    if (Math.abs(v[i]) >= threshold) {
      data[i] = v[i] > 0 ? 1 : -1;
      nz.push(i);
    }
  }

  return new SparseVec(data, nz);
}
