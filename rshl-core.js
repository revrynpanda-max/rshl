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

// ── Token normalization ────────────────────────────────────────────────────────
// Applied in textVec before encoding — both stored text and queries go through
// the same pipeline, so "lives"/"location"/"city" collapse to the same vector,
// "job"/"occupation"/"employer" collapse, "allergic"/"restriction" collapse, etc.
//
// Two passes:
//   1. Stopword removal — drops function words present in queries but not facts
//   2. Pre-stem synonym map — maps domain synonyms to a canonical token
//   3. Suffix stemmer — collapses remaining inflections (lives→live, drives→drive)
//
// NOTE: Changing normalization changes the vector space. Re-encode stored memories
// when upgrading from a version without normalization.

const _STOPS = new Set([
  'a','an','the','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','could','should',
  'may','might','shall','can','need','used',
  'to','of','in','on','at','by','for','with','from','into','onto','upon','about',
  'and','or','but','if','as','that','than','then',
  'it','its','this','these','those',
  'what','where','who','when','how','which','why','whose',
]);

// Maps original word forms to a canonical token before stemming.
// Only unambiguous domain synonyms — no broad/ambiguous words.
const _SYNS = {
  // location
  'location':'live', 'city':'live', 'town':'live', 'home':'live',
  'reside':'live', 'resides':'live', 'resided':'live',
  'relocate':'live', 'relocates':'live', 'relocated':'live',
  // job / work
  'job':'work', 'occupation':'work', 'employer':'work', 'career':'work',
  'employed':'work', 'employment':'work', 'profession':'work',
  // food — "food" stays canonical, map alternatives to it
  'meal':'food', 'meals':'food', 'diet':'food',
  // allergy / restriction
  'allergic':'allerg', 'allergy':'allerg', 'allergies':'allerg',
  'intolerant':'allerg', 'intolerance':'allerg',
  'restriction':'allerg', 'restrictions':'allerg',
  // age
  'old':'age', 'years':'age', 'year':'age',
  // vehicle / transport
  'vehicle':'drive', 'vehicles':'drive', 'transport':'drive',
  'commute':'drive', 'commutes':'drive', 'commuting':'drive', 'commuted':'drive',
  'car':'drive', 'cars':'drive',
  // hobbies / activities
  'hobby':'enjoy', 'hobbies':'enjoy', 'activity':'enjoy', 'activities':'enjoy',
  'interest':'enjoy', 'interests':'enjoy', 'fun':'enjoy',
  // schedule / shifts
  'shift':'schedule', 'shifts':'schedule',
  // pets
  'dog':'pet', 'dogs':'pet', 'cat':'pet', 'cats':'pet',
  // goal / aim
  'aim':'goal', 'aims':'goal', 'target':'goal', 'targets':'goal',
  // music / audio
  'genre':'music', 'genres':'music', 'song':'music', 'songs':'music',
  'listen':'music', 'listens':'music', 'listening':'music', 'taste':'music',
  // language / speaking
  'speak':'language', 'speaks':'language', 'spoken':'language', 'speaking':'language',
  'fluent':'language', 'fluently':'language',
};

// Suffix rules — longest match first. [suffix, replacement]
const _STEM = [
  ['ization','ize'], ['isation','ize'],
  ['ational','ate'], ['iveness','ive'], ['ousness','ous'], ['fulness','ful'],
  ['ations','ate'],  ['ation','ate'],
  ['ments',''],      ['ment',''],
  ['ities',''],      ['iness',''],
  ['ings',''],       ['ing',''],
  ['ness',''],
  ['ists',''],       ['ist',''],
  ['iers','y'],      ['ied','y'],   ['ies','y'],
  ['ances',''],      ['ance',''],
  ['ences',''],      ['ence',''],
  ['ical',''],       ['ic',''],
  ['ers',''],        ['er',''],
  ['ous',''],        ['ive',''],    ['ful',''],   ['ity',''],
  ['ion',''],
  ['ants',''],       ['ant',''],    ['ents',''],  ['ent',''],
  ['ate',''],
  ['ly',''],
  ['ed',''],
  ['s',''],
];
const _MINSTEM = 3;

function _stem(w) {
  if (w.length <= _MINSTEM) return w;
  for (const [suf, rep] of _STEM) {
    const nlen = w.length - suf.length + rep.length;
    if (nlen >= _MINSTEM && w.endsWith(suf)) return w.slice(0, -suf.length) + rep;
  }
  return w;
}

function _normTok(tok) {
  if (tok.length < 2) return null;      // drop single chars (Ryan's → 's' artifact)
  if (_STOPS.has(tok)) return null;     // drop stopwords
  const syn = _SYNS[tok];
  if (syn) return syn;                  // pre-stem synonym — already canonical
  return _stem(tok);                    // stem remaining inflections
}

// ── Text → superposed ternary vector ─────────────────────────────────────────
// Splits on whitespace, normalizes tokens, superposes (majority vote).
function textVec(text) {
  const raw  = text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
  const toks = raw.map(_normTok).filter(Boolean);
  const eff  = toks.length > 0 ? toks : raw; // fallback: keep raw if all tokens stripped
  if (eff.length === 0) return tokenVec(text);
  if (eff.length === 1) return tokenVec(eff[0]);

  // Accumulate into a dense accumulator then threshold → sparse ternary
  const acc = new Int16Array(DIM);
  for (const tok of eff) {
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
