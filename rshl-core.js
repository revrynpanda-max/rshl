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
// Both stored text and queries go through the same map — so "occupation" and
// "works at" both normalize to "work", "training" and "marathon" → "run", etc.
const _SYNS = {
  // ── location ──────────────────────────────────────────────────────────────
  'location':'live','city':'live','town':'live','home':'live','address':'live',
  'neighborhood':'live','district':'live','street':'live','based':'live',
  'reside':'live','resides':'live','resided':'live',
  'relocate':'live','relocates':'live','relocated':'live',
  'move':'live','moves':'live','moving':'live','moved':'live',
  'settle':'live','settled':'live','settles':'live',

  // ── employment ────────────────────────────────────────────────────────────
  'job':'work','occupation':'work','employer':'work','career':'work',
  'employed':'work','employment':'work','profession':'work',
  'hire':'work','hired':'work','fired':'work','quit':'work',
  'resign':'work','resigned':'work','retire':'work','retired':'work',
  'role':'work','title':'work','position':'work',
  'boss':'work','manager':'work','company':'work','firm':'work',
  'office':'work','promoted':'work','promotion':'work',
  'remote':'work','remotely':'work','arrangement':'work',
  'nurse':'work','nurses':'work','doctor':'work','doctors':'work',
  'teacher':'work','teachers':'work','professor':'work','professors':'work',
  'engineer':'work','engineers':'work','programmer':'work',
  'developer':'work','developers':'work','designer':'work','designers':'work',
  'analyst':'work','consultant':'work','accountant':'work',
  'scientist':'work','researcher':'work','instructor':'work',
  'technician':'work','therapist':'work','chef':'work',

  // ── food / eating ─────────────────────────────────────────────────────────
  'meal':'food','meals':'food','diet':'food',
  'eat':'food','eats':'food','eating':'food','ate':'food',
  'cuisine':'food','dish':'food','dishes':'food','recipe':'food',
  'cook':'food','cooks':'food','cooking':'food',
  'prefer':'food','prefers':'food','preference':'food',
  'appetite':'food','hungry':'food','hunger':'food',
  'snack':'food','lunch':'food','dinner':'food','breakfast':'food',
  'vegan':'food','vegetarian':'food','pescatarian':'food',

  // ── allergy / health restriction ──────────────────────────────────────────
  'allergic':'allerg','allergy':'allerg','allergies':'allerg',
  'intolerant':'allerg','intolerance':'allerg',
  'restriction':'allerg','restrictions':'allerg',
  'sensitive':'allerg','sensitivity':'allerg',
  'avoid':'allerg','avoids':'allerg','avoiding':'allerg',
  'gluten':'allerg','lactose':'allerg','nut':'allerg','peanut':'allerg',

  // ── age ───────────────────────────────────────────────────────────────────
  'old':'age','years':'age','year':'age','born':'age','birthday':'age',

  // ── vehicle / transport ───────────────────────────────────────────────────
  'vehicle':'drive','vehicles':'drive','transport':'drive','transportation':'drive',
  'commute':'drive','commutes':'drive','commuting':'drive','commuted':'drive',
  'car':'drive','cars':'drive','bicycle':'drive','bike':'drive','bikes':'drive',
  'ride':'drive','rides':'drive','riding':'drive',

  // ── hobbies / leisure ─────────────────────────────────────────────────────
  'hobby':'enjoy','hobbies':'enjoy','activity':'enjoy','activities':'enjoy',
  'interest':'enjoy','interests':'enjoy','fun':'enjoy','leisure':'enjoy',
  'passion':'enjoy','pastime':'enjoy','pastimes':'enjoy',
  'play':'enjoy','plays':'enjoy','playing':'enjoy',
  'love':'enjoy','loves':'enjoy','loved':'enjoy','loving':'enjoy',

  // ── fitness / exercise ────────────────────────────────────────────────────
  'fitness':'run','exercise':'run','workout':'run','workouts':'run',
  'training':'run','train':'run','trains':'run',
  'marathon':'run','gym':'run','athletic':'run','athlete':'run',
  'sport':'run','sports':'run','jog':'run','jogging':'run',
  'hike':'run','hiking':'run','trail':'run','swim':'run','swimming':'run',
  'cycling':'run','cycle':'run',

  // ── schedule / time ───────────────────────────────────────────────────────
  'shift':'schedule','shifts':'schedule',
  'appointment':'schedule','appointments':'schedule','meeting':'schedule',

  // ── pets ──────────────────────────────────────────────────────────────────
  'dog':'pet','dogs':'pet','cat':'pet','cats':'pet',
  'animal':'pet','animals':'pet','puppy':'pet','kitten':'pet',
  'retriever':'pet','retrievers':'pet','labrador':'pet','poodle':'pet',
  'poodles':'pet','terrier':'pet','terriers':'pet','bulldog':'pet',
  'bulldogs':'pet','spaniel':'pet','shepherd':'pet','husky':'pet',
  'huskies':'pet','siamese':'pet','tabby':'pet',

  // ── goals / intentions ────────────────────────────────────────────────────
  'aim':'goal','aims':'goal','target':'goal','targets':'goal',
  'want':'goal','wants':'goal','wanted':'goal',
  'wish':'goal','wishes':'goal','hope':'goal','hopes':'goal',
  'aspire':'goal','aspires':'goal','aspiration':'goal',
  'plan':'goal','plans':'goal','planned':'goal',
  'dream':'goal','dreams':'goal',

  // ── financial / saving ────────────────────────────────────────────────────
  'financial':'save','finance':'save','finances':'save',
  'money':'save','saving':'save','savings':'save',
  'budget':'save','budgeting':'save','earn':'save','earns':'save',
  'income':'save','salary':'save','wage':'save','wages':'save',
  'invest':'save','investing':'save','investment':'save',
  'afford':'save','buy':'save','purchase':'save',

  // ── music / audio ─────────────────────────────────────────────────────────
  'genre':'music','genres':'music','song':'music','songs':'music',
  'listen':'music','listens':'music','listening':'music','taste':'music',
  'band':'music','artist':'music','album':'music','track':'music',
  'jazz':'music','rock':'music','pop':'music','hip':'music','hop':'music',
  'classical':'music','opera':'music',

  // ── language / speaking ───────────────────────────────────────────────────
  'speak':'language','speaks':'language','spoken':'language','speaking':'language',
  'fluent':'language','fluently':'language',
  'learn':'language','learns':'language','learning':'language','learned':'language',
  'study':'language','studying':'language',
  'french':'language','german':'language','spanish':'language',
  'mandarin':'language','japanese':'language',

  // ── relationships ─────────────────────────────────────────────────────────
  'spouse':'family','wife':'family','husband':'family','partner':'family',
  'parent':'family','parents':'family','mother':'family','father':'family',
  'child':'family','children':'family','sibling':'family',
  'friend':'friend','friends':'friend','colleague':'friend',
};

// ── Semantic category anchors ──────────────────────────────────────────────────
// After normalization, domain tokens also inject a category anchor token into
// the superposition at equal weight. This creates cluster-level overlap between
// texts that use different surface forms of the same concept:
//   "Ryan lives in Austin" → tokens: [ryan, live, #loc, austin]
//   "Ryan's location"      → tokens: [ryan, live, #loc]
//   Shared: [ryan, live, #loc] = 3 tokens  (was 1 before)
//
// Category tokens use '#' prefix to avoid colliding with real word hashes.
// They act as a "soft semantic cluster" — partial overlap even with no exact match.
const _CATS = {
  'live':    '#loc',   // location / place
  'work':    '#job',   // employment
  'food':    '#food',  // food / eating
  'allerg':  '#hlth',  // health / allergy
  'age':     '#age',   // age / time
  'drive':   '#trn',   // transport / vehicle
  'enjoy':   '#hby',   // hobbies / leisure
  'run':     '#fit',   // fitness / exercise
  'schedule':'#sched', // schedule / appointments
  'pet':     '#pet',   // pets / animals
  'goal':    '#goal',  // goals / intentions
  'save':    ['#fin', '#goal'],  // financial saving is goal-oriented
  'music':   '#mus',   // music / audio
  'language':'#lang',  // language / speaking
  'family':  '#rel',   // relationships
  'friend':  '#rel',   // relationships (same anchor as family)
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
// Normalizes tokens then superposes — including semantic category anchors.
function textVec(text) {
  const raw  = text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
  const toks = raw.map(_normTok).filter(Boolean);
  const eff  = toks.length > 0 ? toks : raw; // fallback: keep raw if all stripped
  if (eff.length === 0) return tokenVec(text);

  // Inject semantic category anchors alongside domain tokens.
  // "#loc", "#job" etc. are shared across all texts in the same domain —
  // creating overlap even when surface words differ completely.
  const enc = [];
  for (const tok of eff) {
    enc.push(tok);
    const cats = _CATS[tok];
    if (cats) {
      const arr = Array.isArray(cats) ? cats : [cats];
      for (const c of arr) enc.push(c);
    }
  }

  if (enc.length === 1) return tokenVec(enc[0]);

  // Accumulate into a dense accumulator then threshold → sparse ternary
  const acc = new Int16Array(DIM);
  for (const tok of enc) {
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
