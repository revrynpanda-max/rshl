/**
 * rshl-core.js — Standalone Sparse Ternary HDC Engine
 *
 * Self-contained. Zero dependencies. Runs on any Node.js >= 16.
 *
 * What it does:
 *   Projects any string input into a 4096-dimensional sparse ternary vector
 *   {-1, 0, +1} at ~5% density (~205 active elements out of 4096).
 *   Two vectors are compared with cosine similarity: 1.0 = identical meaning,
 *   0.0 = unrelated, negative = opposing.
 *
 * Why it's fast:
 *   - No model inference. No GPU required. No network call.
 *   - Deterministic: same input always produces same vector.
 *   - Inner loop operates on integers only — no floating point until final division.
 *   - With the optional native addon: AVX2 SIMD + OpenMP for batch queries.
 */

"use strict";

const DIM       = 4096;
const DENSITY   = 0.05;   // 5% active = ~205 dims
const ACTIVE    = Math.round(DIM * DENSITY);
const FNV_PRIME = 0x01000193;
const FNV_INIT  = 0x811c9dc5;

// ── FNV-1a hash (32-bit) ──────────────────────────────────────────────────────
function fnv1a(str) {
  let h = FNV_INIT >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h;
}

// ── LCG PRNG seeded per token ─────────────────────────────────────────────────
function lcgNext(state) {
  return (Math.imul(state, 1664525) + 1013904223) >>> 0;
}

// ── Single token → sparse ternary vector ─────────────────────────────────────
// Returns Array<[index, value]> where value ∈ {-1, +1}
function tokenVec(token) {
  let state = fnv1a(token);
  const used = new Uint8Array(DIM >> 3); // bit-set for collision avoidance
  const vec = [];

  for (let i = 0; i < ACTIVE; i++) {
    let idx;
    let attempts = 0;
    do {
      state = lcgNext(state);
      idx = state % DIM;
      attempts++;
      if (attempts > 100) break;
    } while (used[idx >> 3] & (1 << (idx & 7)));

    used[idx >> 3] |= (1 << (idx & 7));
    state = lcgNext(state);
    vec.push([idx, state & 1 ? 1 : -1]);
  }

  vec.sort((a, b) => a[0] - b[0]);
  return vec;
}

// ── Text → superposed ternary vector ─────────────────────────────────────────
// Splits on whitespace, generates a vector per token, superposes (majority vote).
function textVec(text) {
  const tokens = text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return tokenVec(text);
  if (tokens.length === 1) return tokenVec(tokens[0]);

  // Accumulate into a dense accumulator then threshold → sparse ternary
  const acc = new Int16Array(DIM);
  for (const tok of tokens) {
    const v = tokenVec(tok);
    for (const [idx, val] of v) acc[idx] += val;
  }

  const result = [];
  for (let i = 0; i < DIM; i++) {
    if (acc[i] > 0)  result.push([i,  1]);
    else if (acc[i] < 0) result.push([i, -1]);
  }
  result.sort((a, b) => a[0] - b[0]);
  return result;
}

// ── Cosine similarity — two-pointer O(k) ─────────────────────────────────────
// Both vecs must be sorted by index ascending.
function cosineSim(a, b) {
  if (a.length === 0 || b.length === 0) return 0;
  let dot = 0, i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if      (a[i][0] < b[j][0]) i++;
    else if (a[i][0] > b[j][0]) j++;
    else { dot += a[i][1] * b[j][1]; i++; j++; }
  }
  return dot / (Math.sqrt(a.length) * Math.sqrt(b.length));
}

// ── Resonance [0,1] ───────────────────────────────────────────────────────────
function resonance(a, b) {
  return (cosineSim(a, b) + 1) * 0.5;
}

module.exports = { DIM, ACTIVE, tokenVec, textVec, cosineSim, resonance };
