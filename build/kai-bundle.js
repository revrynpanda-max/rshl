"use strict";
// KAI v5.0 — Single Executable Bundle
// Generated 2026-04-16T05:42:27.440Z

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

// Override __dirname for data file paths
const _kaiDir = process.env.KAI_HOME || process.cwd();

// Module registry
const _modules = {};
const _moduleCache = {};

function _require(name) {
    if (_moduleCache[name]) return _moduleCache[name].exports;
    const mod = _modules[name];
    if (!mod) {
        // Fall back to native require for builtins
        return require(name);
    }
    const module = { exports: {} };
    _moduleCache[name] = module;
    mod(module, module.exports, function(dep) {
        // Resolve relative requires
        if (dep.startsWith('./')) dep = dep.slice(2);
        if (dep.endsWith('.js')) dep = dep.slice(0, -3);
        return _require(dep);
    });
    return module.exports;
}

// ── rshl-core.js ────────────────────────────────────────────────
_modules['rshl-core'] = function(module, exports, require) {
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
  'arrangement':'work',
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
  'remot':   '#rem',   // remote work (remotely → remot after stem)
  'remote':  '#rem',   // remote work
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
  const syn = Object.hasOwn(_SYNS, tok) ? _SYNS[tok] : undefined;
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
  // Deduplicate tokens so double-synonyms (years+old → age×2) don't
  // distort cosine similarity by artificially concentrating a single dimension.
  const seen = new Set();
  const enc = [];
  for (const tok of eff) {
    if (!seen.has(tok)) { seen.add(tok); enc.push(tok); }
    const cats = Object.hasOwn(_CATS, tok) ? _CATS[tok] : undefined;
    if (cats) {
      const arr = Array.isArray(cats) ? cats : [cats];
      for (const c of arr) {
        if (!seen.has(c)) { seen.add(c); enc.push(c); }
      }
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

// Returns the canonical tokens (+ category anchors) that textVec uses.
// Used by playground.js to show WHY two texts matched.
function debugTokens(text) {
  const raw  = text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
  const toks = raw.map(_normTok).filter(Boolean);
  const eff  = toks.length > 0 ? toks : raw;
  const enc  = [];
  const seen = new Set();
  for (const tok of eff) {
    if (!seen.has(tok)) { seen.add(tok); enc.push({ tok, type: 'word' }); }
    const cats = Object.hasOwn(_CATS, tok) ? _CATS[tok] : undefined;
    if (cats) {
      const arr = Array.isArray(cats) ? cats : [cats];
      for (const c of arr) {
        if (!seen.has(c)) { seen.add(c); enc.push({ tok: c, type: 'category' }); }
      }
    }
  }
  return enc;
}

module.exports = { DIM, ACTIVE, tokenVec, textVec, cosineSim, resonance, debugTokens };

};

// ── plasma.js ───────────────────────────────────────────────────
_modules['plasma'] = function(module, exports, require) {
"use strict";

const universe = _require('universe');

class Plasma {
    constructor(shouldClear = false) {
        if (shouldClear) universe.clear();
    }

    get cells() {
        return universe.getCells();
    }

    store(text, region, meta) {
        return universe.store(text, region, meta);
    }

    query(text, topK, options) {
        return universe.query(text, topK, options);
    }

    queryRegion(text, region, topK, options) {
        return universe.queryRegion(text, region, topK, options);
    }

    searchByCleanVector(vec, topK) {
        return universe.searchByCleanVector(vec, topK);
    }

    reinforceCell(id, delta, metaPatch) {
        return universe.reinforceCell(id, delta, metaPatch);
    }

    rankReplayCandidates(limit) {
        return universe.rankReplayCandidates(limit);
    }

    getCell(id) {
        return universe.getCell(id);
    }

    clear() {
        universe.clear();
    }
}

module.exports = { Plasma };
};

// ── anchors.js ──────────────────────────────────────────────────
_modules['anchors'] = function(module, exports, require) {
"use strict";

const { textVec } = _require('rshl-core');

// ── Orthogonal Region Seeds (Refined by Ryan) ──────────────────────────────────
// These are intentionally massive, dense, and conceptually orthogonal.
// Each anchor now uses highly specific, domain-locked word clusters.
const ANCHORS = {
    MEMORY:    "episodic autobiographical personal history lived experience timeline flashback recall retention engram autobiographical memory childhood past yesterday last week",
    
    REASONING: "causal logic deduction induction inference conclusion therefore because axiom theorem hypothesis theory analysis evaluation logic reasoning critical thinking",
    
    LANGUAGE:  "linguistic syntax semantics grammar vocabulary phrasing utterance dialogue expression articulation wording rephrase rewrite eloquent fluent verbal communication",
    
    ACTION:    "execute perform trigger activate initiate dispatch command operate maneuver physical kinetic motor movement action command directive do now perform task"
};

const anchorVectors = {
    memory:    textVec(ANCHORS.MEMORY),
    reasoning: textVec(ANCHORS.REASONING),
    language:  textVec(ANCHORS.LANGUAGE),
    action:    textVec(ANCHORS.ACTION)
};

const REGIONS = ['memory', 'reasoning', 'language', 'action'];

// ── Holographic Phase Masks (Mulberry32) ───────────────────────────────────────
// We derive the seed for each region mask from its orthogonal anchor vector.
function mulberry32(a) {
    return function() {
        var t = a += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

const _masks = {};
for (const [region, anchor] of Object.entries(anchorVectors)) {
    let seed = 0;
    for (const [idx, val] of anchor) {
        seed = Math.imul(31, seed) + (idx * val) | 0;
    }
    const rng = mulberry32(seed);
    const mask = new Int8Array(4096);
    for (let i = 0; i < 4096; i++) mask[i] = rng() > 0.5 ? 1 : -1;
    _masks[region] = mask;
}

// ── API ────────────────────────────────────────────────────────────────────────
function getAnchor(region) {
    const r = String(region || '').toLowerCase().trim();
    if (r === 'memory' || r === 'mem') return anchorVectors.memory;
    if (r === 'reasoning' || r === 'reason' || r === 'rsn') return anchorVectors.reasoning;
    if (r === 'language' || r === 'lang') return anchorVectors.language;
    if (r === 'action' || r === 'act') return anchorVectors.action;
    throw new Error(`Unknown region: ${region}`);
}

function resolveRegion(region) {
    const r = String(region || '').toLowerCase().trim();
    if (r === 'memory' || r === 'mem') return 'memory';
    if (r === 'reasoning' || r === 'reason' || r === 'rsn') return 'reasoning';
    if (r === 'language' || r === 'lang') return 'language';
    if (r === 'action' || r === 'act') return 'action';
    throw new Error(`Unknown region: ${region}`);
}

function bind(vec, region) {
    if (!Array.isArray(vec)) return [];
    const r = resolveRegion(region);
    const mask = _masks[r];
    const out = [];
    for (const [idx, val] of vec) {
        out.push([idx, val * mask[idx]]);
    }
    return out;
}

module.exports = { 
    ANCHORS, 
    anchorVectors, 
    getAnchor, 
    REGIONS, 
    resolveRegion, 
    bind,
    tag: bind 
};
};

// ── universe.js ─────────────────────────────────────────────────
_modules['universe'] = function(module, exports, require) {
"use strict";

/**
 * universe.js — Cognitive Field Substrate
 *
 * Single responsibility: store, retrieve, reinforce, and replay cells.
 * No metric computation. No dream logic. No promotion decisions.
 * No persistence. No world intake.
 *
 * This is the only file that owns the _cells array.
 * All other layers read from or write to it through this API only.
 *
 * Native acceleration (AVX2+POPCNT):
 *   searchByCleanVector() uses the compiled native addon when available.
 *   Falls back to JS automatically. The switch is transparent to callers.
 *   Matrix is rebuilt lazily on demand after any store/remove.
 */

const { textVec, resonance, debugTokens } = _require('rshl-core');
const { bind, REGIONS, resolveRegion }    = _require('anchors');
const path = require('path');

// ── Native engine (optional) ──────────────────────────────────────────────────
// Compiled AVX2+POPCNT addon for batch resonance scans.
// Loaded once at startup; falls back to pure JS if not built.
let _native = null;
try {
    _native = require(path.join(_kaiDir, 'build', 'Release', 'rshl_native.node'));
} catch (_) { /* JS fallback active */ }

// Binary matrix format constants (matches rshl_native.cpp)
const _BIN_MASK_BYTES = 512;  // DIM/8 = 4096/8 = 512 bytes per pos/neg mask
const _BIN_ROW_BYTES  = 1024; // pos_mask + neg_mask per row
const _NATIVE_MIN     = 32;   // native overhead not worth it below this cell count

// Lazy binary matrix for searchByCleanVector — raw (unbound) vectors only.
// Invalidated on store() and removeCell(). Rebuilt on first use after invalidation.
let _rawDirty     = true;
let _rawMatrix    = null; // Buffer: n × BIN_ROW_BYTES
let _rawNorms     = null; // Buffer (Float32Array view): n floats
let _rawResultBuf = null; // Float64Array: n scores (pre-allocated, grown as needed)
let _rawN         = 0;    // cell count at last build (guards stale buffer use)

function _invalidateMatrix() {
    _rawDirty = true;
}

function _rebuildMatrix() {
    if (!_rawDirty) return;
    if (!_native || !_native.batchQueryBinary) return;
    const n = _cells.length;
    if (n < _NATIVE_MIN) return; // not worth it for tiny fields

    const matrix = Buffer.alloc(n * _BIN_ROW_BYTES, 0);
    const norms  = Buffer.alloc(n * 4);
    const nf     = new Float32Array(norms.buffer);

    for (let i = 0; i < n; i++) {
        const posBase = i * _BIN_ROW_BYTES;
        const negBase = posBase + _BIN_MASK_BYTES;
        let nnz = 0;
        for (const [idx, val] of _cells[i].raw) {
            const byte = idx >> 3;
            const bit  = 1 << (idx & 7);
            if (val > 0) matrix[posBase + byte] |= bit;
            else         matrix[negBase + byte] |= bit;
            nnz++;
        }
        nf[i] = Math.sqrt(nnz);
    }

    _rawMatrix = matrix;
    _rawNorms  = norms;
    _rawN      = n;
    if (!_rawResultBuf || _rawResultBuf.length < n) {
        _rawResultBuf = new Float64Array(n);
    }
    _rawDirty = false;
}

function _vecToQueryBinary(vec) {
    const qPos = Buffer.alloc(_BIN_MASK_BYTES, 0);
    const qNeg = Buffer.alloc(_BIN_MASK_BYTES, 0);
    for (const [idx, val] of vec) {
        const byte = idx >> 3;
        const bit  = 1 << (idx & 7);
        if (val > 0) qPos[byte] |= bit;
        else         qNeg[byte] |= bit;
    }
    return { qPos, qNeg };
}

// ── Field state ───────────────────────────────────────────────────────────────
const MAX_STRENGTH = 5;
const _cells = [];
let _id = 0;

function clamp01(n) {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

function _tokenSet(text) {
    return new Set(debugTokens(String(text || '')).map(t => t.tok));
}

function _tokenOverlap(queryTokens, cellTokens) {
    let count = 0;
    for (const t of queryTokens) {
        if (cellTokens.has(t)) count++;
    }
    return count;
}

function _copyCell(cell) {
    return {
        id:          cell.id,
        text:        cell.text,
        region:      cell.region,
        vec:         cell.vec,
        raw:         cell.raw,
        size:        cell.size,
        tokens:      cell.tokens,
        strength:    cell.strength,
        accessCount: cell.accessCount,
        dreamCount:  cell.dreamCount,
        lastAccessed: cell.lastAccessed,
        lastReplayed: cell.lastReplayed,
        ts:          cell.ts,
        meta:        { ...cell.meta },
    };
}

// ── Store ─────────────────────────────────────────────────────────────────────
function store(text, region, meta) {
    const r        = resolveRegion(region);
    const raw      = textVec(text);
    const vec      = bind(raw, r);
    const now      = Date.now();
    const safeMeta = { ...(meta || {}) };
    const initialStrength = typeof safeMeta.strength === 'number' ? safeMeta.strength : 1;

    const cell = {
        id:          ++_id,
        text:        String(text),
        region:      r,
        raw,
        vec,
        size:        vec.length,
        tokens:      _tokenSet(text),
        strength:    Math.max(0.1, Math.min(MAX_STRENGTH, initialStrength)),
        accessCount: 0,
        dreamCount:  0,
        lastAccessed: 0,
        lastReplayed: 0,
        ts:          now,
        meta: {
            source:       safeMeta.source || 'manual',
            unresolved:   !!safeMeta.unresolved,
            contradiction: clamp01(safeMeta.contradiction || 0),
            novelty:      clamp01(safeMeta.novelty || 0),
            ...safeMeta,
        },
    };

    _cells.push(cell);
    _invalidateMatrix(); // new cell → rebuild needed before next native scan
    return cell.id;
}

// ── Read ──────────────────────────────────────────────────────────────────────
function getCells() {
    return _cells.map(_copyCell);
}

function getCell(id) {
    const cell = _cells.find(c => c.id === id);
    return cell ? _copyCell(cell) : null;
}

function count() {
    return _cells.length;
}

// ── Similarity search ─────────────────────────────────────────────────────────
// findSimilar(rawVec, minSim)
// Scans all cells for the first one whose raw vector exceeds minSim resonance.
// This is the single point of redundancy checking — world-bridge and RSHLLattice
// both route through here instead of doing their own scan loops.
function findSimilar(rawVec, minSim) {
    const threshold = (typeof minSim === 'number') ? minSim : 0.82;
    for (const cell of _cells) {
        if (!cell.raw) continue;
        const sim = resonance(rawVec, cell.raw);
        if (sim >= threshold) {
            return { found: true, cell: _copyCell(cell), sim };
        }
    }
    return { found: false, sim: 0 };
}

// ── Query (text → region-bound similarity) ────────────────────────────────────
function _rankResults(results, k) {
    results.sort((a, b) => {
        if (Math.abs(a.score - b.score) < 0.15 && a.overlap !== b.overlap) {
            return b.overlap - a.overlap;
        }
        if (Math.abs(a.score - b.score) < 0.05 && a.strength !== b.strength) {
            return b.strength - a.strength;
        }
        return b.score - a.score;
    });
    return results.slice(0, k);
}

function _touch(ids) {
    const now = Date.now();
    for (const id of ids) {
        const cell = _cells.find(c => c.id === id);
        if (!cell) continue;
        cell.accessCount += 1;
        cell.lastAccessed = now;
    }
}

function query(text, topK, options) {
    const raw     = textVec(text);
    const qTokens = _tokenSet(text);
    const k       = topK || 5;
    const results = [];

    for (const region of REGIONS) {
        const q = bind(raw, region);
        for (const cell of _cells) {
            if (cell.region !== region) continue;
            const score   = resonance(q, cell.vec);
            const overlap = _tokenOverlap(qTokens, cell.tokens);
            results.push({
                id:       cell.id,
                text:     cell.text,
                region:   cell.region,
                score,
                overlap,
                strength: cell.strength,
                meta:     { ...cell.meta },
            });
        }
    }

    const ranked = _rankResults(results, k);
    if (!options || options.touch !== false) {
        _touch(ranked.map(r => r.id));
    }
    return ranked;
}

function queryRegion(text, region, topK, options) {
    const r       = resolveRegion(region);
    const raw     = textVec(text);
    const q       = bind(raw, r);
    const qTokens = _tokenSet(text);
    const k       = topK || 5;

    const results = _cells
        .filter(cell => cell.region === r)
        .map(cell => ({
            id:       cell.id,
            text:     cell.text,
            region:   cell.region,
            score:    resonance(q, cell.vec),
            overlap:  _tokenOverlap(qTokens, cell.tokens),
            strength: cell.strength,
            meta:     { ...cell.meta },
        }));

    const ranked = _rankResults(results, k);
    if (!options || options.touch !== false) {
        _touch(ranked.map(r => r.id));
    }
    return ranked;
}

// ── Attractor search (raw unbound vector → nearest stored raw) ─────────────────
// Primary path: native AVX2+POPCNT binary scan.
// Fallback: pure JS two-pointer cosine loop.
// Called every dream cycle during cleanup — this is the hottest path.
function searchByCleanVector(vec, topK) {
    const k = topK || 5;
    const n = _cells.length;
    if (n === 0) return [];

    let useNative = false;

    // Native path — activate when addon loaded and cells above threshold
    if (_native && _native.batchQueryBinary && n >= _NATIVE_MIN) {
        _rebuildMatrix();
        if (!_rawDirty && _rawMatrix && _rawN === n) {
            useNative = true;
        }
    }

    if (useNative) {
        const { qPos, qNeg } = _vecToQueryBinary(vec);
        _native.batchQueryBinary(_rawMatrix, _rawNorms, n, qPos, qNeg, _rawResultBuf);
    }

    const results = _cells.map((cell, i) => {
        // Native returns raw cosine in [-1,1]; map to [0,1] to match resonance()
        const score = useNative
            ? clamp01((_rawResultBuf[i] + 1) * 0.5)
            : resonance(vec, cell.raw);
        return {
            id:       cell.id,
            text:     cell.text,
            region:   cell.region,
            score,
            overlap:  0,
            strength: cell.strength,
            meta:     { ...cell.meta },
        };
    });

    results.sort((a, b) => {
        if (Math.abs(a.score - b.score) < 0.05 && a.strength !== b.strength) {
            return b.strength - a.strength;
        }
        return b.score - a.score;
    });

    return results.slice(0, k);
}

// ── Mutators ──────────────────────────────────────────────────────────────────
function reinforceCell(id, delta, metaPatch) {
    const cell = _cells.find(c => c.id === id);
    if (!cell) return null;
    const d = typeof delta === 'number' ? delta : 0.15;
    cell.strength = Math.max(0.1, Math.min(MAX_STRENGTH, cell.strength + d));
    if (metaPatch && typeof metaPatch === 'object') {
        cell.meta = { ...cell.meta, ...metaPatch };
    }
    return _copyCell(cell);
    // Note: reinforceCell does NOT change vectors — matrix stays valid.
}

function markReplayed(id) {
    const cell = _cells.find(c => c.id === id);
    if (!cell) return null;
    cell.dreamCount  += 1;
    cell.lastReplayed = Date.now();
    return _copyCell(cell);
    // Note: markReplayed does NOT change vectors — matrix stays valid.
}

function removeCell(id) {
    const idx = _cells.findIndex(c => c.id === id);
    if (idx === -1) return false;
    _cells.splice(idx, 1);
    _invalidateMatrix(); // cell removed → rebuild needed before next native scan
    return true;
}

// ── Replay priority ranking ────────────────────────────────────────────────────
// Pr = (1 - strengthNorm + contradiction + novelty + stale) / 4 + unresolvedBoost
// Called by rshl-lattice to select dream candidates.
function rankReplayCandidates(limit) {
    const now = Date.now();
    const out = _cells.map(cell => {
        const ageDays         = Math.max(0, (now - cell.ts) / 86400000);
        const sinceReplayDays = cell.lastReplayed
            ? Math.max(0, (now - cell.lastReplayed) / 86400000)
            : ageDays + 1;
        const strengthNorm    = clamp01(cell.strength / MAX_STRENGTH);
        const unresolved      = cell.meta.unresolved ? 1 : 0;
        const contradiction   = clamp01(cell.meta.contradiction || 0);
        const novelty         = clamp01(cell.meta.novelty || 0);
        const stale           = clamp01(sinceReplayDays / 7);
        const underIntegrated = 1 - strengthNorm;

        const replayPriority = clamp01(
            ((underIntegrated + contradiction + novelty + stale) / 4) + (unresolved * 0.25)
        );

        return {
            id:             cell.id,
            text:           cell.text,
            region:         cell.region,
            strength:       cell.strength,
            replayPriority,
            unresolved,
            contradiction,
            novelty,
            ageDays,
            dreamCount:     cell.dreamCount,
            meta:           { ...cell.meta },
        };
    });

    out.sort((a, b) => b.replayPriority - a.replayPriority);
    return out.slice(0, limit || 12);
}

// ── Reset ─────────────────────────────────────────────────────────────────────
function clear() {
    _cells.length = 0;
    _id = 0;
    _invalidateMatrix();
}

// ── Engine info ───────────────────────────────────────────────────────────────
function engineInfo() {
    return {
        native: _native ? _native.version() : null,
        nativeActive: !!(_native && _native.batchQueryBinary),
        cells: _cells.length,
        matrixDirty: _rawDirty,
        nativeMinCells: _NATIVE_MIN,
    };
}

module.exports = {
    store,
    query,
    queryRegion,
    searchByCleanVector,
    findSimilar,
    reinforceCell,
    markReplayed,
    rankReplayCandidates,
    getCells,
    getCell,
    count,
    removeCell,
    clear,
    engineInfo,
};

};

// ── field-state.js ──────────────────────────────────────────────
_modules['field-state'] = function(module, exports, require) {
"use strict";

/**
 * field-state.js — Pure Field Metric Computation
 *
 * Single responsibility: compute emergence metrics from supplied data.
 * NO universe access. NO persistence. NO side effects.
 * All inputs are passed in by the caller.
 */

const { textVec, resonance } = _require("rshl-core");

function clamp01(n) {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

function mean(arr) {
    if (!arr || !arr.length) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr) {
    if (!arr || arr.length < 2) return 0;
    const m = mean(arr);
    const variance = mean(arr.map(v => (v - m) ** 2));
    return Math.sqrt(variance);
}

function recencyWeightFromTs(ts) {
    if (!ts) return 1;
    const ageDays = Math.max(0, (Date.now() - ts) / 86400000);
    return Math.exp(-ageDays / 180);
}

function makeWinnerKey(parts) {
    return parts.map(x => String(x)).join("::");
}

function computeTau(history, winnerKey, windowSize = 8) {
    if (!winnerKey) return 0;
    const tail = (history || []).slice(-windowSize);
    if (!tail.length) return 1;
    const matches = tail.filter(h => h && h.winnerKey === winnerKey).length;
    return clamp01(matches / tail.length);
}

function computeGoalAlignment(goalText, syntheticVec, goalVec) {
    if (!syntheticVec) return 1;
    // Prefer pre-computed evolving goal vector over static text
    if (goalVec) return clamp01(resonance(goalVec, syntheticVec));
    if (!goalText) return 1;
    const gVec = textVec(goalText);
    return clamp01(resonance(gVec, syntheticVec));
}

function computeContradiction(sourceCells, candidateScores) {
    const pairDisagreement = [];
    for (let i = 0; i < sourceCells.length; i++) {
        for (let j = i + 1; j < sourceCells.length; j++) {
            const a = sourceCells[i];
            const b = sourceCells[j];
            if (!a || !b || !a.raw || !b.raw) continue;
            pairDisagreement.push(1 - clamp01(resonance(a.raw, b.raw)));
        }
    }

    const metaContradiction = sourceCells.length
        ? mean(sourceCells.map(c => clamp01((c.meta && c.meta.contradiction) || 0)))
        : 0;

    const scoreDisagreement = candidateScores && candidateScores.length
        ? mean(candidateScores.map(s => 1 - clamp01(s)))
        : 0;

    return clamp01(mean([
        pairDisagreement.length ? mean(pairDisagreement) : 0,
        metaContradiction,
        scoreDisagreement
    ]));
}

function computeFieldState({
    syntheticVec,
    sourceCells = [],
    candidateScores = [],
    goalText = "",
    goalVec = null,   // evolving goal vector from drive.js (takes priority over goalText)
    winnerKey = "",
    history = [],
    totalCount,       // must be supplied by caller (e.g. universe.count())
}) {
    // totalCount is the full field size — caller is responsible for providing it.
    // Default to sourceCells.length + 1 only as a safe fallback (should not happen).
    const N = Math.max(1, typeof totalCount === 'number' ? totalCount : sourceCells.length + 1);

    const activeCount = Math.max(1, sourceCells.length + (syntheticVec ? 1 : 0));
    const rho = clamp01(activeCount / N);

    const coherenceSamples = [];

    if (candidateScores && candidateScores.length) {
        for (const s of candidateScores) coherenceSamples.push(clamp01(s));
    }

    if (syntheticVec) {
        for (const cell of sourceCells) {
            if (!cell || !cell.raw) continue;
            coherenceSamples.push(clamp01(resonance(cell.raw, syntheticVec)));
        }
    }

    for (let i = 0; i < sourceCells.length; i++) {
        for (let j = i + 1; j < sourceCells.length; j++) {
            const a = sourceCells[i];
            const b = sourceCells[j];
            if (!a || !b || !a.raw || !b.raw) continue;
            coherenceSamples.push(clamp01(resonance(a.raw, b.raw)));
        }
    }

    const R = clamp01(mean(coherenceSamples.length ? coherenceSamples : [0]));
    const s = clamp01(1 / (1 + stddev(coherenceSamples.length ? coherenceSamples : [0])));

    const g = computeGoalAlignment(goalText, syntheticVec, goalVec);
    const chi = computeContradiction(sourceCells, coherenceSamples);
    const tau = computeTau(history, winnerKey, 8);

    const phi = clamp01(rho * (R ** 2) * s);
    const phi_c = clamp01(phi * (1 - chi));
    const phi_g = clamp01(phi_c * g);

    const prev = history && history.length ? clamp01(history[history.length - 1].phi_g || 0) : 0;
    const M = phi_g - prev;

    const X = clamp01(chi * (1 - R));

    const topSource = sourceCells[0] || null;
    const r = topSource ? recencyWeightFromTs(topSource.ts) : 1;
    const u = sourceCells.length
        ? clamp01(mean(sourceCells.map(c => ((c.strength || 1) / 5))))
        : 0;

    const C = clamp01(phi_g * (1 - chi) * tau);
    const Wm = clamp01(phi_g * r);
    const q = clamp01(1 - R);
    const Pr = clamp01(((1 - phi_g) + chi + q) / 3);

    return {
        rho,
        R,
        s,
        g,
        chi,
        tau,
        r,
        u,
        q,
        phi,
        phi_c,
        phi_g,
        M,
        X,
        C,
        Wm,
        Pr,
    };
}

module.exports = {
    clamp01,
    mean,
    stddev,
    recencyWeightFromTs,
    makeWinnerKey,
    computeFieldState,
};
};

// ── generative-core.js ──────────────────────────────────────────
_modules['generative-core'] = function(module, exports, require) {
"use strict";

const universe = _require('universe');
const { bind } = _require('anchors');
const { textVec } = _require('rshl-core');

function unbind(boundVec, region) {
    return bind(boundVec, region);
}

function threshold(vec) {
    const map = new Map();
    for (const [idx, val] of vec) {
        map.set(idx, (map.get(idx) || 0) + val);
    }

    const result = [];
    for (const [idx, sum] of map) {
        if (sum > 0) result.push([idx, 1]);
        else if (sum < 0) result.push([idx, -1]);
    }
    result.sort((a, b) => a[0] - b[0]);
    return result;
}

function bundleVectors(vectors) {
    const map = new Map();
    for (const vec of vectors) {
        if (!Array.isArray(vec)) continue;
        for (const [idx, val] of vec) {
            map.set(idx, (map.get(idx) || 0) + val);
        }
    }
    return threshold(Array.from(map.entries()));
}

function cleanup(synthetic, topK) {
    const matches = universe.searchByCleanVector(synthetic, topK || 3);
    const best = matches[0] || null;
    return {
        text: best ? best.text : 'no strong concept found',
        score: best ? best.score : -1,
        matches,
    };
}

function _resolveTopCleanMatches(hits) {
    return hits
        .map(hit => {
            const cell = universe.getCell(hit.id);
            if (!cell) return null;
            return {
                id: cell.id,
                text: cell.text,
                region: cell.region,
                raw: cell.raw,
                vec: cell.vec,
                score: hit.score,
            };
        })
        .filter(Boolean);
}

function generateToResult(query, topK) {
    const qvec = textVec(query);
    const hits = universe.query(query, topK || 3);
    const matches = _resolveTopCleanMatches(hits);

    const vectors = [qvec, ...matches.map(m => m.raw)];
    const synthetic = bundleVectors(vectors);
    const decoded = cleanup(synthetic, 3);

    return {
        query,
        thought: decoded.text,
        confidence: decoded.score,
        synthetic,
        matches: matches.map(m => ({
            id: m.id,
            text: m.text,
            region: m.region,
            score: m.score,
        })),
        cleanupMatches: decoded.matches,
    };
}

function generate(query, topK) {
    const result = generateToResult(query, topK || 3);

    console.log(`\nQuery → "${query}"`);
    console.log('Strongest matches:');
    result.matches.forEach(m => {
        console.log(`  ${m.region} (${m.score.toFixed(4)}) → "${m.text}"`);
    });
    console.log(`\n→ Generated new thought: "${result.thought}"`);
    console.log(`   Confidence: ${result.confidence.toFixed(4)}\n`);

    return result;
}

module.exports = {
    unbind,
    threshold,
    bundleVectors,
    cleanup,
    generate,
    generateToResult,
};

if (require.main === module) {
    generate('Who are you really?');
    generate('How do you think about things?');
    generate('What should I do next?');
}
};

// ── rshl-lattice.js ─────────────────────────────────────────────
_modules['rshl-lattice'] = function(module, exports, require) {
"use strict";

const universe = _require("universe");
const { resonance } = _require("rshl-core");
const { bundleVectors, cleanup } = _require("generative-core");
const { computeFieldState, makeWinnerKey, clamp01 } = _require("field-state");

const DREAM_HISTORY = [];
const DEFAULT_GOAL_TEXT =
    "coherent world understanding with low contradiction and natural intelligence growth";

function pushDreamHistory(entry) {
    DREAM_HISTORY.push(entry);
    if (DREAM_HISTORY.length > 12) DREAM_HISTORY.shift();
}

function textEq(a, b) {
    return String(a || "").trim() === String(b || "").trim();
}

function selectDreamPair(candidates) {
    if (!Array.isArray(candidates) || candidates.length < 2) return null;

    let best = null;

    for (let i = 0; i < candidates.length; i++) {
        for (let j = i + 1; j < candidates.length; j++) {
            const candA = candidates[i];
            const candB = candidates[j];
            const a = universe.getCell(candA.id);
            const b = universe.getCell(candB.id);

            if (!a || !b || !a.raw || !b.raw) continue;

            const overlap = clamp01(resonance(a.raw, b.raw));

            if (overlap < 0.18 || overlap > 0.88) continue;

            const targetBand = 1 - Math.abs(overlap - 0.52);
            const replayMean = ((candA.replayPriority || 0) + (candB.replayPriority || 0)) / 2;
            const contradictionMean =
                ((((a.meta && a.meta.contradiction) || 0) + ((b.meta && b.meta.contradiction) || 0)) / 2);
            const noveltyMean =
                ((((a.meta && a.meta.novelty) || 0) + ((b.meta && b.meta.novelty) || 0)) / 2);
            const unresolvedBoost =
                (a.meta && a.meta.unresolved ? 0.10 : 0) +
                (b.meta && b.meta.unresolved ? 0.10 : 0);
            const crossRegionBoost = a.region !== b.region ? 0.12 : 0;

            // Penalize near-duplicate pairs more aggressively
            const duplicatePenalty = overlap > 0.72 ? (overlap - 0.72) * 0.65 : 0;

            const pairScore =
                (replayMean * 0.40) +
                (targetBand * 0.28) +
                (contradictionMean * 0.10) +
                (noveltyMean * 0.08) +
                unresolvedBoost +
                crossRegionBoost -
                duplicatePenalty;

            if (!best || pairScore > best.pairScore) {
                best = {
                    pairScore,
                    overlap,
                    candidateA: candA,
                    candidateB: candB,
                    a,
                    b,
                };
            }
        }
    }

    return best;
}

function pickBestInsight(decoded, sourceA, sourceB) {
    const matches = Array.isArray(decoded.matches) ? decoded.matches : [];

    // Prefer the strongest non-source match
    const nonSource = matches.find(m =>
        !textEq(m.text, sourceA.text) && !textEq(m.text, sourceB.text)
    );

    if (nonSource) {
        return {
            text: nonSource.text,
            score: nonSource.score,
            usedNonSource: true,
        };
    }

    // Fall back to top decoded result
    return {
        text: decoded.text,
        score: decoded.score,
        usedNonSource: false,
    };
}

function consolidate(plasma, options = {}) {
    const candidateLimit = options.candidateLimit || 14;
    const goalText = options.goalText || DEFAULT_GOAL_TEXT;
    const goalVec  = options.goalVec || null; // evolving goal vector from drive.js

    const candidates = universe.rankReplayCandidates(candidateLimit);
    if (!candidates || candidates.length < 2) return null;

    const pair = selectDreamPair(candidates);
    if (!pair) return null;

    universe.markReplayed(pair.a.id);
    universe.markReplayed(pair.b.id);

    const synthetic = bundleVectors([pair.a.raw, pair.b.raw]);
    const decoded = cleanup(synthetic, 5);
    const chosen = pickBestInsight(decoded, pair.a, pair.b);

    // winnerKey is based on the insight text alone (not source cell IDs) so
    // that tau accumulates whenever the same insight recurs across any pair —
    // matching how biological replay values recurrence of the PATTERN, not
    // recurrence of the exact same source neurons.
    const winnerKey = makeWinnerKey([chosen.text || "no-idea"]);

    const field = computeFieldState({
        syntheticVec:   synthetic,
        sourceCells:    [pair.a, pair.b],
        candidateScores:[pair.overlap, clamp01(chosen.score)],
        goalText,
        goalVec,        // evolving goal vector takes priority if present
        winnerKey,
        history:        DREAM_HISTORY,
        totalCount:     universe.count(),
    });

    const duplicateEcho =
        textEq(chosen.text, pair.a.text) || textEq(chosen.text, pair.b.text);

    const promotionReady =
        !duplicateEcho &&
        chosen.text !== "no strong concept found" &&
        chosen.score >= 0.64 &&
        field.C >= 0.16 &&
        field.chi <= 0.45 &&
        field.phi_g >= 0.03;

    const reinforceBy = promotionReady
        ? Math.max(0.05, Math.min(0.30, field.Wm * 0.60))
        : (field.Wm >= 0.10 ? Math.max(0.02, Math.min(0.08, field.Wm * 0.20)) : 0);

    if (reinforceBy > 0) {
        universe.reinforceCell(pair.a.id, reinforceBy, {
            lastDreamLinked: pair.b.id,
        });
        universe.reinforceCell(pair.b.id, reinforceBy, {
            lastDreamLinked: pair.a.id,
        });
    }

    pushDreamHistory({
        winnerKey,
        phi_g: field.phi_g,
        ts: Date.now(),
    });

    return {
        conceptA: pair.a.text,
        conceptB: pair.b.text,
        regionA: pair.a.region,
        regionB: pair.b.region,
        resonance: pair.overlap,
        replayPriorityA: pair.candidateA.replayPriority,
        replayPriorityB: pair.candidateB.replayPriority,
        insight: chosen.text,
        confidence: chosen.score,
        vector: synthetic,
        field,
        promotionReady,
        sourceReinforcement: reinforceBy,
        contradictionPressure: field.X,
        duplicateEcho,
        usedNonSourceInsight: chosen.usedNonSource,
    };
}

class RSHLLattice {
    constructor(opts = {}) {
        this.userName = opts.userName || "User";
        this.records = [];
        universe.clear();
    }

    store(text, region = "memory", meta = {}) {
        const { textVec } = _require('rshl-core');
        const rawVec = textVec(text);

        // Dedup via universe.findSimilar — single source of resonance-based search
        const dup  = universe.findSimilar(rawVec, 0.92);
        const near = universe.findSimilar(rawVec, 0.72);

        let op = 'ADD';
        let replaced = null;
        const bestScore = dup.found ? dup.sim : (near.found ? near.sim : 0);

        if (dup.found) {
            return { op: 'NOOP', match_score: dup.sim, replaced: null };
        } else if (near.found) {
            op = 'UPDATE';
            replaced = near.cell.text;
            universe.removeCell(near.cell.id);
        }

        this.records.push({
            text:   String(text),
            region: region || "memory",
            meta:   meta || {},
        });
        universe.store(text, region || "memory", meta || {});

        return { op, match_score: bestScore, replaced };
    }

    recall(query, topK = 5) {
        return universe.query(query, topK).map(hit => ({
            ...hit,
            sim: hit.score
        }));
    }

    save(filepath) {
        const fs = require('fs');
        const payload = {
            userName: this.userName,
            records: this.records
        };
        fs.writeFileSync(filepath, JSON.stringify(payload, null, 2), "utf8");
    }

    load(filepath) {
        const fs = require('fs');
        const raw = JSON.parse(fs.readFileSync(filepath, "utf8"));
        this.userName = raw.userName || this.userName;
        this.records = Array.isArray(raw.records) ? raw.records : [];

        universe.clear();
        for (const rec of this.records) {
            universe.store(
                rec.text,
                rec.region || "memory",
                rec.meta || {}
            );
        }
    }

    clear() {
        this.records = [];
        universe.clear();
    }
}

module.exports = {
    consolidate,
    selectDreamPair,
    RSHLLattice
};
};

// ── candidate-buffer.js ─────────────────────────────────────────
_modules['candidate-buffer'] = function(module, exports, require) {
"use strict";

/**
 * candidate-buffer.js — Dream Candidate Accumulation Layer
 *
 * Biology analog: Pre-synaptic holding zone before long-term potentiation.
 * A pattern must recur repeatedly with stable field quality before it earns
 * promotion into durable memory. This is the buffer between dream insight
 * and belief formation.
 *
 * Each candidate tracks:
 *   - seenCount       : how many dream cycles generated this insight
 *   - bestPhi_g       : best integrated goal-aligned emergence seen
 *   - bestC           : best commit readiness seen
 *   - bestConfidence  : best cleanup confidence seen
 *   - contradictionHistory : rolling contradiction values (stability check)
 *   - phiHistory      : rolling phi_g values (stability check)
 *   - sourceLinks     : which concept pairs generated this insight
 *   - nonSourceCount  : how many times insight was NOT just echoing a source
 *   - status          : 'candidate' | 'promoted' | 'rejected'
 */

const STATUS = {
    CANDIDATE: 'candidate',
    PROMOTED:  'promoted',
    REJECTED:  'rejected',
};

function _clamp01(n) {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

function _normalizeKey(text) {
    return String(text || '').trim().toLowerCase();
}

// _candidates: Map<normalizedText, candidateEntry>
const _candidates = new Map();

/**
 * observe(dreamResult)
 * Called after each consolidate() run. Feeds the dream output into the buffer.
 * Returns the updated/created candidate entry, or null if the result is ineligible.
 */
function observe(dreamResult) {
    if (!dreamResult) return null;
    if (dreamResult.duplicateEcho) return null;

    const text = dreamResult.insight;
    if (!text || text === 'no strong concept found') return null;

    const key = _normalizeKey(text);
    if (!key) return null;

    const now         = Date.now();
    const phi_g       = _clamp01(dreamResult.field ? dreamResult.field.phi_g  : 0);
    const C           = _clamp01(dreamResult.field ? dreamResult.field.C      : 0);
    const chi         = _clamp01(dreamResult.field ? dreamResult.field.chi    : 1);
    const confidence  = _clamp01(dreamResult.confidence || 0);
    const nonSource   = !!dreamResult.usedNonSourceInsight;

    const sourceLink = {
        conceptA: dreamResult.conceptA  || '',
        conceptB: dreamResult.conceptB  || '',
        resonance: _clamp01(dreamResult.resonance || 0),
        phi_g,
        C,
        ts: now,
    };

    if (_candidates.has(key)) {
        const entry = _candidates.get(key);
        entry.seenCount  += 1;
        entry.lastSeen    = now;

        if (phi_g      > entry.bestPhi_g)      entry.bestPhi_g      = phi_g;
        if (C          > entry.bestC)           entry.bestC          = C;
        if (confidence > entry.bestConfidence)  entry.bestConfidence = confidence;
        if (nonSource) entry.nonSourceCount += 1;

        entry.contradictionHistory.push(chi);
        if (entry.contradictionHistory.length > 20) entry.contradictionHistory.shift();

        entry.phiHistory.push(phi_g);
        if (entry.phiHistory.length > 20) entry.phiHistory.shift();

        entry.sourceLinks.push(sourceLink);
        if (entry.sourceLinks.length > 10) entry.sourceLinks.shift();

        return entry;
    }

    const entry = {
        key,
        text,
        seenCount:             1,
        bestPhi_g:             phi_g,
        bestC:                 C,
        bestConfidence:        confidence,
        contradictionHistory:  [chi],
        phiHistory:            [phi_g],
        sourceLinks:           [sourceLink],
        nonSourceCount:        nonSource ? 1 : 0,
        status:                STATUS.CANDIDATE,
        firstSeen:             now,
        lastSeen:              now,
        promotedAt:            null,
        rejectedReason:        null,
    };

    _candidates.set(key, entry);
    return entry;
}

/** Return all entries (any status). */
function getAll() {
    return Array.from(_candidates.values());
}

/** Return active candidates filtered by minimum thresholds. */
function getCandidates(minSeenCount, minC, minPhi_g) {
    return getAll().filter(c =>
        c.status      === STATUS.CANDIDATE &&
        c.seenCount   >= (minSeenCount || 1) &&
        c.bestC       >= (minC         || 0) &&
        c.bestPhi_g   >= (minPhi_g     || 0)
    );
}

/** Mark a candidate as promoted. */
function markPromoted(key) {
    const entry = _candidates.get(key);
    if (!entry) return;
    entry.status     = STATUS.PROMOTED;
    entry.promotedAt = Date.now();
}

/** Mark a candidate as rejected with an optional reason string. */
function markRejected(key, reason) {
    const entry = _candidates.get(key);
    if (!entry) return;
    entry.status         = STATUS.REJECTED;
    entry.rejectedReason = reason || 'threshold-fail';
}

/** Remove promoted/rejected entries older than maxAgeDays to prevent unbounded growth. */
function gc(maxAgeDays) {
    const cutoff = Date.now() - (maxAgeDays || 30) * 86400000;
    for (const [key, entry] of _candidates) {
        if (entry.status !== STATUS.CANDIDATE && entry.lastSeen < cutoff) {
            _candidates.delete(key);
        }
    }
}

function clear() {
    _candidates.clear();
}

function size() {
    return _candidates.size;
}

module.exports = {
    STATUS,
    observe,
    getAll,
    getCandidates,
    markPromoted,
    markRejected,
    gc,
    clear,
    size,
};

};

// ── promotion.js ────────────────────────────────────────────────
_modules['promotion'] = function(module, exports, require) {
"use strict";

/**
 * promotion.js — Belief Formation / Long-Term Potentiation Layer
 *
 * Biology analog: Repeated, stable, goal-aligned co-activation with low
 * contradiction earns a pattern permanent synaptic change (LTP). Here,
 * a dream candidate that meets all thresholds gets written back into
 * universe as durable memory — it becomes a belief.
 *
 * Promotion requires ALL of:
 *   1. seenCount >= THRESHOLDS.seenCount        (must recur, not one-shot)
 *   2. bestC >= THRESHOLDS.bestC                (commit readiness proven)
 *   3. bestPhi_g >= THRESHOLDS.bestPhi_g        (emergence quality proven)
 *   4. bestConfidence >= THRESHOLDS.bestConf    (cleanup match quality)
 *   5. meanContradiction <= THRESHOLDS.maxChi   (contradiction must be low)
 *   6. contradictionStddev <= THRESHOLDS.maxChiSd  (must be STABLE, not spiking)
 *   7. nonSourceRatio >= THRESHOLDS.minNSR      (must be genuine insight, not echo)
 *
 * Competition: before promotion, candidates within the same "cluster"
 * (resonance > 0.72 between their universe vectors) compete — only the
 * highest-scoring wins; others are suppressed for this cycle.
 */

const universe        = _require('universe');
const candidateBuffer = _require('candidate-buffer');
const { textVec, resonance } = _require('rshl-core');
const { clamp01, mean, stddev } = _require('field-state');

// ── Promotion thresholds ──────────────────────────────────────────────────────
// Calibrated to the actual field output range.
// With rho ≈ activeCount/totalCount (e.g. 2/33 ≈ 0.09 for a seeded universe),
// phi_g peaks around 0.03–0.06 and C peaks around 0.015–0.040.
// Thresholds must be set relative to what the field can actually produce —
// not abstract [0,1] ideals — so that promotion is achievable but not trivial.
const THRESHOLDS = {
    seenCount:   3,     // Must recur in at least 3 independent dream cycles
    bestC:       0.015, // Minimum commit readiness (C = phi_g × (1-chi) × tau)
    bestPhi_g:   0.024, // Minimum integrated goal-aligned emergence
    bestConf:    0.72,  // Minimum attractor cleanup confidence (field scores high here)
    maxChi:      0.38,  // Mean contradiction must stay below this
    maxChiSd:    0.28,  // Contradiction must be stable (not oscillating)
    minNSR:      0.35,  // At least 35% of sightings must be non-source insight
    competeSim:  0.72,  // Vector similarity threshold for competition grouping
};

// ── Scoring ───────────────────────────────────────────────────────────────────
function _score(entry) {
    const nsr       = entry.seenCount > 0 ? entry.nonSourceCount / entry.seenCount : 0;
    const chiMean   = mean(entry.contradictionHistory);
    const stability = clamp01(1 - stddev(entry.phiHistory || [entry.bestPhi_g]));
    return (
        entry.bestPhi_g   * 0.30 +
        entry.bestC       * 0.25 +
        entry.bestConf    * 0.15 +
        nsr               * 0.15 +
        stability         * 0.10 +
        clamp01(1 - chiMean) * 0.05
    );
}

// ── Gate check ────────────────────────────────────────────────────────────────
function _passesThresholds(entry) {
    if (entry.status !== candidateBuffer.STATUS.CANDIDATE) return { pass: false, reason: 'not-candidate' };
    if (entry.seenCount < THRESHOLDS.seenCount)            return { pass: false, reason: 'seen-count' };
    if (entry.bestC     < THRESHOLDS.bestC)                return { pass: false, reason: 'best-C' };
    if (entry.bestPhi_g < THRESHOLDS.bestPhi_g)            return { pass: false, reason: 'best-phi_g' };
    if (entry.bestConfidence < THRESHOLDS.bestConf)        return { pass: false, reason: 'best-confidence' };

    const ch = entry.contradictionHistory;
    if (!ch || !ch.length)                                 return { pass: false, reason: 'no-chi-history' };

    const chiMean = mean(ch);
    if (chiMean > THRESHOLDS.maxChi)                       return { pass: false, reason: 'chi-too-high' };

    const chiSd = stddev(ch);
    if (chiSd > THRESHOLDS.maxChiSd)                       return { pass: false, reason: 'chi-unstable' };

    const nsr = entry.seenCount > 0 ? entry.nonSourceCount / entry.seenCount : 0;
    if (nsr < THRESHOLDS.minNSR)                           return { pass: false, reason: 'echo-ratio' };

    return { pass: true };
}

// ── Competition: cluster threshold-passing candidates by vector similarity ────
// Within each cluster, only the highest scorer is allowed to promote this cycle.
function _resolveCompetition(eligibles) {
    if (!eligibles.length) return [];

    // Compute vectors for each eligible candidate
    const withVecs = eligibles.map(e => ({
        entry: e,
        vec: textVec(e.text),
        score: _score(e),
    }));

    const suppressed = new Set();
    const winners    = [];

    for (let i = 0; i < withVecs.length; i++) {
        if (suppressed.has(i)) continue;
        let bestIdx = i;

        for (let j = i + 1; j < withVecs.length; j++) {
            if (suppressed.has(j)) continue;
            const sim = clamp01(resonance(withVecs[i].vec, withVecs[j].vec));
            if (sim >= THRESHOLDS.competeSim) {
                // Same cluster — keep the higher scorer, suppress the other
                if (withVecs[j].score > withVecs[bestIdx].score) {
                    suppressed.add(bestIdx);
                    bestIdx = j;
                } else {
                    suppressed.add(j);
                }
            }
        }

        if (!suppressed.has(bestIdx)) {
            winners.push(withVecs[bestIdx].entry);
        }
    }

    return winners;
}

// ── Main promotion run ────────────────────────────────────────────────────────
function runPromotion() {
    const all       = candidateBuffer.getAll();
    const eligible  = [];
    const failLog   = [];

    for (const entry of all) {
        const check = _passesThresholds(entry);
        if (check.pass) {
            eligible.push(entry);
        } else if (entry.status === candidateBuffer.STATUS.CANDIDATE) {
            failLog.push({ key: entry.key, reason: check.reason });
        }
    }

    const winners   = _resolveCompetition(eligible);
    const promoted  = [];

    for (const entry of winners) {
        const chiMean   = mean(entry.contradictionHistory);
        const stability = clamp01(1 - stddev(entry.phiHistory || [entry.bestPhi_g]));

        // Map field quality into universe strength (range 1.5–4.0)
        const rawStrength = clamp01(entry.bestC * 2.5 + entry.bestPhi_g * 1.5 + stability * 0.5);
        const strength    = 1.5 + rawStrength * 2.5; // maps [0,1] → [1.5, 4.0]

        universe.store(entry.text, 'memory', {
            source:        'promoted-dream',
            strength,
            novelty:       clamp01(entry.bestPhi_g),
            contradiction: chiMean,
            unresolved:    false,
            promotedAt:    Date.now(),
            seenCount:     entry.seenCount,
            bestC:         entry.bestC,
            bestPhi_g:     entry.bestPhi_g,
            score:         _score(entry),
        });

        candidateBuffer.markPromoted(entry.key);
        promoted.push({
            text:     entry.text,
            seenCount: entry.seenCount,
            bestC:    entry.bestC,
            bestPhi_g: entry.bestPhi_g,
            strength,
        });
    }

    return { promoted, failLog, eligible: eligible.length };
}

module.exports = {
    THRESHOLDS,
    runPromotion,
};

};

// ── homeostasis.js ──────────────────────────────────────────────
_modules['homeostasis'] = function(module, exports, require) {
"use strict";

/**
 * homeostasis.js — Slow Weakening / Pruning Layer (LTD Analog)
 *
 * Biology analog: Long-term depression (LTD) and synaptic pruning.
 * Connections that are never re-activated, never reinforced, and never
 * replayed gradually weaken. Below a floor threshold they are removed
 * entirely, keeping the field sparse and preventing saturation.
 *
 * A cell is eligible for decay if ALL of:
 *   - age > MIN_AGE_DAYS (don't touch freshly stored patterns)
 *   - lastAccessed is stale (not queried recently)
 *   - dreamCount is 0 (never replayed)
 *   - strength < DECAY_STRENGTH_CEILING (only decay weak cells)
 *   - source !== 'promoted-dream' (never decay promoted beliefs)
 *
 * Decay amount scales with how stale and weak the cell already is.
 * Cells that fall below PRUNE_THRESHOLD are removed from the field.
 */

const universe = _require('universe');

const CONFIG = {
    minAgeDays:           1,     // Don't touch cells younger than this
    staleAccessDays:      5,     // "Stale" = not accessed in this many days
    decayStrengthCeiling: 2.0,   // Only decay cells weaker than this
    decayRate:            0.06,  // Strength reduction per homeostasis cycle
    pruneThreshold:       0.09,  // Cells below this are removed entirely
    maxDreamCount:        0,     // Replayed cells are protected
    protectedSources: new Set(['promoted-dream', 'seed']),
};

function _daysSince(ts, now) {
    if (!ts) return Infinity;
    return Math.max(0, (now - ts) / 86400000);
}

function _isDecayEligible(cell, now) {
    // Never decay protected sources
    const src = (cell.meta && cell.meta.source) || '';
    if (CONFIG.protectedSources.has(src)) return false;

    // Must be old enough to consider
    const ageDays = _daysSince(cell.ts, now);
    if (ageDays < CONFIG.minAgeDays) return false;

    // Must be stale (not recently queried)
    const lastAccessDays = _daysSince(cell.lastAccessed || 0, now);
    if (lastAccessDays < CONFIG.staleAccessDays) return false;

    // Must have never been replayed (dream count = 0)
    if ((cell.dreamCount || 0) > CONFIG.maxDreamCount) return false;

    // Only decay genuinely weak cells
    if ((cell.strength || 1) >= CONFIG.decayStrengthCeiling) return false;

    return true;
}

/**
 * runHomeostasis()
 * Scans all cells. Decays eligible ones. Prunes those below floor.
 * Returns { decayed: [...], pruned: [...] }
 */
function runHomeostasis() {
    const cells   = universe.getCells();
    const now     = Date.now();
    const decayed = [];
    const pruned  = [];

    for (const cell of cells) {
        if (!_isDecayEligible(cell, now)) continue;

        const staleFactor = Math.min(1, _daysSince(cell.lastAccessed || 0, now) / 30);
        const weakFactor  = Math.max(0, 1 - (cell.strength / CONFIG.decayStrengthCeiling));
        const amount      = CONFIG.decayRate * (0.5 + staleFactor * 0.3 + weakFactor * 0.2);

        const newStrength = (cell.strength || 1) - amount;

        if (newStrength < CONFIG.pruneThreshold) {
            universe.removeCell(cell.id);
            pruned.push({ id: cell.id, text: cell.text, region: cell.region, finalStrength: cell.strength });
        } else {
            universe.reinforceCell(cell.id, -amount, { lastDecayed: now });
            decayed.push({ id: cell.id, text: cell.text, newStrength });
        }
    }

    return { decayed, pruned };
}

module.exports = {
    CONFIG,
    runHomeostasis,
};

};

// ── heartbeat.js ────────────────────────────────────────────────
_modules['heartbeat'] = function(module, exports, require) {
"use strict";

/**
 * heartbeat.js — Drive-Aware Background Continuity Pulse
 *
 * Biology analog: The brain's default mode network + hippocampal sharp-wave
 * ripples + dopaminergic drive modulation. The heartbeat is no longer a fixed
 * metronome — it speeds up when engaged, slows when bored, and uses valence
 * to guide what gets reinforced.
 *
 * Each tick:
 *   1. consolidate()             — one dream cycle
 *   2. drive.computeValence()    — update internal mood from field metrics
 *   3. candidateBuffer.observe() — feed dream output into candidate buffer
 *   4. runPromotion()            — check if any candidate earned belief status
 *   5. drive.feedGoal()          — feed promoted beliefs into evolving goal
 *   6. runHomeostasis()          — every N ticks: decay + prune
 *   7. Adapt next tick interval  — drive controls the clock
 *   8. emit tick summary via onTick callback
 *
 * The interval adapts in real-time:
 *   - High Φg + positive momentum → faster ticks (excited, curious)
 *   - Low Φg + negative momentum  → slower ticks (dormant, exploring)
 *   - High χ sustained            → moderate pace (processing confusion)
 */

const { consolidate }     = _require('rshl-lattice');
const candidateBuffer     = _require('candidate-buffer');
const { runPromotion }    = _require('promotion');
const { runHomeostasis }  = _require('homeostasis');
const persistence         = _require('persistence');
const drive               = _require('drive');

const DEFAULT_INTERVAL_MS       = 5000;
const HOMEOSTASIS_EVERY_N       = 10;
const GC_EVERY_N                = 50;
const AUTOSAVE_EVERY_N          = 25;
const GOAL_REBUILD_EVERY_N      = 30;  // Rebuild evolving goal vector

let _timer      = null;
let _tickCount  = 0;
let _running    = false;
let _busy       = false;
let _plasma     = null;
let _opts       = {};
let _currentIntervalMs = DEFAULT_INTERVAL_MS;

function _tick() {
    if (!_running || !_plasma) return;
    if (_busy) return;
    _busy = true;
    _tickCount++;

    try {

    // 1. Dream — use evolving goal vector for alignment if available
    const goalVec = drive.getGoalVector();
    const dreamResult = consolidate(_plasma, {
        goalText:       goalVec ? null : _opts.goalText, // fall back to static text if no evolving goal
        goalVec:        goalVec,                          // pass evolving goal vector
        candidateLimit: _opts.candidateLimit || 14,
    });

    // 2. Compute valence from dream field metrics (updates internal mood)
    let valence = 0;
    if (dreamResult && dreamResult.field) {
        valence = drive.computeValence(dreamResult.field);
    }

    // 3. Feed into candidate buffer
    let candidate = null;
    if (dreamResult) {
        candidate = candidateBuffer.observe(dreamResult);
    }

    // 4. Promotion check
    const promotionResult = runPromotion();

    // 5. Feed promoted beliefs into the evolving goal
    if (promotionResult.promoted && promotionResult.promoted.length > 0) {
        for (const p of promotionResult.promoted) {
            drive.feedGoal(p.text, p.bestPhi_g);
        }
    }

    // 6. Rebuild goal vector periodically
    if (_tickCount % GOAL_REBUILD_EVERY_N === 0) {
        drive.rebuildGoalVector();
    }

    // 7. Homeostasis (every N ticks)
    // Negative valence (confusion) → increase homeostasis frequency
    let homeostasisResult = null;
    const homeostasisFreq = valence < -0.1
        ? Math.max(3, Math.floor(HOMEOSTASIS_EVERY_N * 0.6))
        : HOMEOSTASIS_EVERY_N;
    if (_tickCount % homeostasisFreq === 0) {
        homeostasisResult = runHomeostasis();
    }

    // 8. Candidate GC
    if (_tickCount % GC_EVERY_N === 0) {
        candidateBuffer.gc(30);
    }

    // 9. Auto-save state (every N ticks)
    let saveResult = null;
    if (_tickCount % AUTOSAVE_EVERY_N === 0) {
        try {
            saveResult = persistence.save({
                heartbeatTick: _tickCount,
                drive: drive.serialize(),
            });
        } catch (_) {
            // Non-fatal
        }
    }

    // 10. Adapt next tick interval based on drive state
    const prevInterval = _currentIntervalMs;
    if (dreamResult && dreamResult.field) {
        _currentIntervalMs = drive.computeAdaptiveInterval(dreamResult.field);
    }
    if (_currentIntervalMs !== prevInterval && _timer) {
        clearInterval(_timer);
        _timer = setInterval(_tick, _currentIntervalMs);
        if (_timer.unref) _timer.unref();
    }

    // 11. Callback with full drive state
    if (typeof _opts.onTick === 'function') {
        const driveState = drive.getState();
        _opts.onTick({
            tick:           _tickCount,
            dreamResult,
            candidate,
            promoted:       promotionResult.promoted,
            failLog:        promotionResult.failLog,
            homeostasis:    homeostasisResult,
            saved:          saveResult,
            bufferSize:     candidateBuffer.size(),
            // Drive system
            valence:        drive.getValence(),
            mood:           driveState.mood,
            intervalMs:     _currentIntervalMs,
            avgPhiG:        driveState.avgPhiG,
            goalComponents: driveState.goalComponents,
        });
    }
    } finally {
        _busy = false;
    }
}

/**
 * start(plasma, options)
 * @param {Plasma} plasma    — the Plasma instance wrapping universe
 * @param {object} options
 *   intervalMs {number}    — initial ms between ticks (adapts over time)
 *   goalText {string}      — fallback goal text (used until evolving goal builds)
 *   candidateLimit {number}— how many replay candidates to consider per tick
 *   onTick {function}      — callback(summary) per tick
 */
function start(plasma, options) {
    if (_running) return;
    _plasma    = plasma;
    _opts      = options || {};
    _running   = true;
    _tickCount = 0;

    _currentIntervalMs = _opts.intervalMs || DEFAULT_INTERVAL_MS;
    _timer = setInterval(_tick, _currentIntervalMs);
    if (_timer.unref) _timer.unref();
}

function stop() {
    _running = false;
    if (_timer) {
        clearInterval(_timer);
        _timer = null;
    }
}

function isRunning()       { return _running; }
function tickCount()       { return _tickCount; }
function currentInterval() { return _currentIntervalMs; }

module.exports = {
    start,
    stop,
    isRunning,
    tickCount,
    currentInterval,
};

};

// ── persistence.js ──────────────────────────────────────────────
_modules['persistence'] = function(module, exports, require) {
"use strict";

/**
 * persistence.js — State Persistence Layer
 *
 * Biology analog: Long-term memory consolidation to permanent substrate.
 * Without persistence, KAI suffers complete amnesia on every restart.
 * This module saves and restores the full cognitive state:
 *   - Universe cells (all stored memories + promoted beliefs)
 *   - Candidate buffer entries (in-progress dream evaluations)
 *   - Heartbeat tick count (continuity across sessions)
 *   - Bridge intake log (provenance tracking)
 *
 * File format: JSON snapshot written atomically (write to .tmp, rename).
 * The snapshot captures a point-in-time state that can be restored exactly.
 *
 * Auto-save: can be wired into heartbeat at intervals so KAI periodically
 * checkpoints itself without explicit user action.
 */

const fs   = require('fs');
const path = require('path');
const universe        = _require('universe');
const candidateBuffer = _require('candidate-buffer');

// ── Default paths ──────────────────────────────────────────────────────────────
const DEFAULT_STATE_DIR = path.join(_kaiDir, 'data');
const DEFAULT_STATE_FILE = path.join(DEFAULT_STATE_DIR, 'kai-state.json');
const DEFAULT_BACKUP_FILE = path.join(DEFAULT_STATE_DIR, 'kai-state.backup.json');

// ── Save ───────────────────────────────────────────────────────────────────────
/**
 * save(options)
 * Snapshot the full cognitive state to disk.
 *
 * @param {object} options
 *   filepath {string}    — output path (default: data/kai-state.json)
 *   heartbeatTick {number} — current heartbeat tick count
 *   extraMeta {object}   — any additional metadata to store
 *
 * @returns {{ ok: boolean, filepath: string, cells: number, candidates: number, bytes: number }}
 */
function save(options) {
    const opts = options || {};
    const filepath = opts.filepath || DEFAULT_STATE_FILE;
    const dir = path.dirname(filepath);

    // Ensure directory exists
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // Backup previous state if it exists
    if (fs.existsSync(filepath)) {
        const backupPath = opts.backupPath || DEFAULT_BACKUP_FILE;
        try {
            fs.copyFileSync(filepath, backupPath);
        } catch (_) {
            // Non-fatal — backup failure shouldn't block save
        }
    }

    const cells = universe.getCells();
    const candidates = candidateBuffer.getAll();

    const snapshot = {
        version: 1,
        savedAt: new Date().toISOString(),
        savedAtMs: Date.now(),
        heartbeatTick: opts.heartbeatTick || 0,
        meta: opts.extraMeta || {},

        // Universe state
        universe: {
            cellCount: cells.length,
            cells: cells.map(cell => ({
                text:         cell.text,
                region:       cell.region,
                strength:     cell.strength,
                accessCount:  cell.accessCount,
                dreamCount:   cell.dreamCount,
                lastAccessed: cell.lastAccessed,
                lastReplayed: cell.lastReplayed,
                ts:           cell.ts,
                meta:         cell.meta,
            })),
        },

        // Candidate buffer state
        candidates: {
            count: candidates.length,
            entries: candidates.map(c => ({
                key:                  c.key,
                text:                 c.text,
                seenCount:            c.seenCount,
                bestPhi_g:            c.bestPhi_g,
                bestC:                c.bestC,
                bestConfidence:       c.bestConfidence,
                contradictionHistory: c.contradictionHistory,
                phiHistory:           c.phiHistory,
                sourceLinks:          c.sourceLinks,
                nonSourceCount:       c.nonSourceCount,
                status:               c.status,
                firstSeen:            c.firstSeen,
                lastSeen:             c.lastSeen,
                promotedAt:           c.promotedAt,
                rejectedReason:       c.rejectedReason,
            })),
        },

        // Drive system state (goal vector, valence, mood history)
        drive: opts.drive || null,
    };

    // Atomic write: write to tmp, then rename
    const tmpPath = filepath + '.tmp';
    const json = JSON.stringify(snapshot, null, 2);
    fs.writeFileSync(tmpPath, json, 'utf8');
    fs.renameSync(tmpPath, filepath);

    return {
        ok: true,
        filepath,
        cells: cells.length,
        candidates: candidates.length,
        bytes: Buffer.byteLength(json, 'utf8'),
    };
}

// ── Load ───────────────────────────────────────────────────────────────────────
/**
 * load(options)
 * Restore cognitive state from a saved snapshot.
 *
 * @param {object} options
 *   filepath {string}    — input path (default: data/kai-state.json)
 *   clearFirst {boolean} — clear universe + candidates before restoring (default: true)
 *
 * @returns {{ ok: boolean, cells: number, candidates: number, heartbeatTick: number, savedAt: string }}
 */
function load(options) {
    const opts = options || {};
    const filepath = opts.filepath || DEFAULT_STATE_FILE;

    if (!fs.existsSync(filepath)) {
        return { ok: false, error: 'State file not found', filepath };
    }

    let snapshot;
    try {
        const raw = fs.readFileSync(filepath, 'utf8');
        snapshot = JSON.parse(raw);
    } catch (err) {
        return { ok: false, error: `Failed to parse state file: ${err.message}`, filepath };
    }

    if (!snapshot || snapshot.version !== 1) {
        return { ok: false, error: `Unknown state version: ${snapshot && snapshot.version}` };
    }

    // Clear existing state
    if (opts.clearFirst !== false) {
        universe.clear();
        candidateBuffer.clear();
    }

    // Restore universe cells
    let cellsRestored = 0;
    if (snapshot.universe && Array.isArray(snapshot.universe.cells)) {
        for (const cell of snapshot.universe.cells) {
            const meta = cell.meta || {};
            // Preserve all original metadata + timing
            meta.strength = cell.strength;
            universe.store(cell.text, cell.region, meta);

            // Restore access/dream counts and timestamps on the cell
            // We need the cell ID that was just created
            const cells = universe.getCells();
            const restored = cells[cells.length - 1];
            if (restored) {
                // Reinforce to set correct strength (store defaults to meta.strength or 1)
                const delta = cell.strength - (restored.strength || 1);
                if (Math.abs(delta) > 0.01) {
                    universe.reinforceCell(restored.id, delta);
                }

                // Replay count restoration
                for (let i = 0; i < (cell.dreamCount || 0); i++) {
                    universe.markReplayed(restored.id);
                }
            }
            cellsRestored++;
        }
    }

    // Restore candidate buffer
    let candidatesRestored = 0;
    if (snapshot.candidates && Array.isArray(snapshot.candidates.entries)) {
        for (const entry of snapshot.candidates.entries) {
            // Reconstruct candidate by feeding a synthetic "dream result"
            // for the first observation, then manually patching the rest.
            // This uses the candidate buffer's internal API.
            const synthDreamResult = {
                insight:              entry.text,
                duplicateEcho:        false,
                usedNonSourceInsight: entry.nonSourceCount > 0,
                confidence:           entry.bestConfidence,
                field: {
                    phi_g: entry.bestPhi_g,
                    C:     entry.bestC,
                    chi:   entry.contradictionHistory && entry.contradictionHistory.length
                        ? entry.contradictionHistory[entry.contradictionHistory.length - 1]
                        : 0,
                },
                conceptA: '',
                conceptB: '',
                resonance: 0,
            };

            const created = candidateBuffer.observe(synthDreamResult);
            if (created) {
                // Patch fields that observe() doesn't capture from a single call
                created.seenCount             = entry.seenCount;
                created.bestPhi_g             = entry.bestPhi_g;
                created.bestC                 = entry.bestC;
                created.bestConfidence        = entry.bestConfidence;
                created.contradictionHistory  = entry.contradictionHistory || [];
                created.phiHistory            = entry.phiHistory || [];
                created.sourceLinks           = entry.sourceLinks || [];
                created.nonSourceCount        = entry.nonSourceCount;
                created.status                = entry.status;
                created.firstSeen             = entry.firstSeen;
                created.lastSeen              = entry.lastSeen;
                created.promotedAt            = entry.promotedAt;
                created.rejectedReason        = entry.rejectedReason;
                candidatesRestored++;
            }
        }
    }

    return {
        ok: true,
        cells: cellsRestored,
        candidates: candidatesRestored,
        heartbeatTick: snapshot.heartbeatTick || 0,
        savedAt: snapshot.savedAt,
        filepath,
        raw: snapshot,  // expose full snapshot for drive restore
    };
}

// ── Exists ─────────────────────────────────────────────────────────────────────
function stateExists(filepath) {
    return fs.existsSync(filepath || DEFAULT_STATE_FILE);
}

// ── Info ───────────────────────────────────────────────────────────────────────
/**
 * getStateInfo() — Returns metadata about the saved state without loading it.
 */
function getStateInfo(filepath) {
    const fp = filepath || DEFAULT_STATE_FILE;
    if (!fs.existsSync(fp)) return null;

    try {
        const stat = fs.statSync(fp);
        const raw = fs.readFileSync(fp, 'utf8');
        const snapshot = JSON.parse(raw);

        return {
            filepath: fp,
            savedAt: snapshot.savedAt,
            version: snapshot.version,
            cells: snapshot.universe ? snapshot.universe.cellCount : 0,
            candidates: snapshot.candidates ? snapshot.candidates.count : 0,
            heartbeatTick: snapshot.heartbeatTick || 0,
            fileSizeKb: Math.round(stat.size / 1024),
            meta: snapshot.meta || {},
        };
    } catch (_) {
        return null;
    }
}

module.exports = {
    save,
    load,
    stateExists,
    getStateInfo,
    DEFAULT_STATE_FILE,
    DEFAULT_BACKUP_FILE,
};

};

// ── world-bridge.js ─────────────────────────────────────────────
_modules['world-bridge'] = function(module, exports, require) {
"use strict";

/**
 * world-bridge.js — External World Intake Layer
 *
 * Biology analog: Sensory cortex + thalamic gating.
 * External stimuli (web, APIs, documents) enter through the same neural
 * tissue as internal activity. They are NOT pre-trusted. They arrive as
 * weak, unresolved, high-novelty traces that must survive the internal
 * validation pipeline (dreaming → candidate buffer → promotion) before
 * becoming durable beliefs.
 *
 * The bridge does NOT decide what to believe. It only:
 *   1. Accepts raw observations from external sources
 *   2. Checks for redundancy against existing field content
 *   3. Stores non-redundant observations as low-strength, unresolved cells
 *   4. Tags them so the dream loop and promotion pipeline can evaluate
 *
 * Intake flow:
 *   external source → extractFacts() → dedup via resonance → store as
 *   weak unresolved cell → dream loop picks it up → candidate buffer
 *   accumulates → promotion validates → belief formed (or not)
 *
 * Supported sources:
 *   - Raw text observations (manual or programmatic)
 *   - Web search results (via fetch)
 *   - GitHub repository data (via GitHub REST API)
 *   - RSS/feed style ingestion (structured items)
 *
 * Architecture rule: No LLM is used here. Fact extraction is simple
 * sentence splitting + deduplication via resonance. The field itself
 * decides what matters through emergence, not through a language model
 * summarizing things for us.
 */

const universe    = _require('universe');
const { textVec } = _require('rshl-core');
const { clamp01 } = _require('field-state');

// ── Configuration ──────────────────────────────────────────────────────────────
const CONFIG = {
    // Resonance threshold above which an incoming observation is considered
    // redundant with existing field content (skip it — already known).
    redundancyThreshold: 0.82,

    // Initial strength for externally sourced observations.
    // Low enough that homeostasis will prune them if they never resonate
    // with anything, but high enough that they survive a few dream cycles.
    initialStrength: 0.6,

    // Maximum observations to ingest in a single batch (prevents flooding).
    maxBatchSize: 50,

    // Minimum text length to consider (filters out noise, headers, etc.)
    minTextLength: 12,

    // Maximum text length to store (long paragraphs dilute vector signal).
    maxTextLength: 500,

    // Default region for external observations.
    defaultRegion: 'memory',

    // Maximum number of sentences to extract from a single text block.
    maxSentencesPerBlock: 20,
};

// ── Intake log ─────────────────────────────────────────────────────────────────
// Tracks what was ingested, skipped, or failed — useful for diagnostics.
const _intakeLog = [];
const MAX_LOG_ENTRIES = 200;

function _log(action, detail) {
    _intakeLog.push({ action, detail, ts: Date.now() });
    if (_intakeLog.length > MAX_LOG_ENTRIES) _intakeLog.shift();
}

// ── Fact extraction ────────────────────────────────────────────────────────────
// No LLM. Split text into sentences. Filter noise. Each sentence is a
// potential observation for the field to evaluate through resonance.

function extractFacts(text) {
    if (!text || typeof text !== 'string') return [];

    // Split on sentence boundaries — period, exclamation, question mark,
    // newlines, semicolons. Preserve enough context per sentence.
    const raw = text
        .replace(/\r\n/g, '\n')
        .split(/(?<=[.!?;])\s+|\n{1,}/)
        .map(s => s.trim())
        .filter(s => s.length >= CONFIG.minTextLength);

    const facts = [];
    for (const sentence of raw) {
        if (facts.length >= CONFIG.maxSentencesPerBlock) break;

        // Truncate overly long sentences
        const cleaned = sentence.length > CONFIG.maxTextLength
            ? sentence.slice(0, CONFIG.maxTextLength)
            : sentence;

        // Skip if it looks like HTML/code/noise
        if (/^[<{]/.test(cleaned)) continue;
        if (/^\s*[/\\#*]/.test(cleaned)) continue;
        if ((cleaned.match(/[a-zA-Z]/g) || []).length < cleaned.length * 0.4) continue;

        facts.push(cleaned);
    }

    return facts;
}

// ── Redundancy check ───────────────────────────────────────────────────────────
// Check if an observation is already substantially present in the field.
// Uses resonance sweep against all cells — same mechanism as query().

function isRedundant(text) {
    // Routes through universe.findSimilar() — single dedup scan point.
    const vec    = textVec(text);
    const result = universe.findSimilar(vec, CONFIG.redundancyThreshold);
    if (result.found) {
        return { redundant: true, matchedText: result.cell.text, sim: result.sim };
    }
    return { redundant: false };
}

// ── Single observation intake ──────────────────────────────────────────────────
/**
 * ingest(text, options)
 * Ingest a single observation into the field as an untrusted cell.
 *
 * @param {string} text        — the observation text
 * @param {object} options
 *   source {string}          — origin tag ('web', 'github', 'manual', 'rss')
 *   region {string}          — target region (default: 'memory')
 *   url {string}             — source URL for provenance tracking
 *   topic {string}           — topic tag for later filtering
 *   strength {number}        — override initial strength (default: CONFIG.initialStrength)
 *
 * @returns {{ stored: boolean, id?: number, reason?: string }}
 */
function ingest(text, options) {
    const opts = options || {};

    if (!text || typeof text !== 'string' || text.trim().length < CONFIG.minTextLength) {
        _log('skip', { reason: 'too-short', text: (text || '').slice(0, 40) });
        return { stored: false, reason: 'too-short' };
    }

    const clean = text.trim().slice(0, CONFIG.maxTextLength);

    // Redundancy check
    const dup = isRedundant(clean);
    if (dup.redundant) {
        _log('skip', { reason: 'redundant', text: clean.slice(0, 40), sim: dup.sim });
        return { stored: false, reason: 'redundant', matchedText: dup.matchedText };
    }

    // Store as low-strength, unresolved, high-novelty cell
    const region = opts.region || CONFIG.defaultRegion;
    const id = universe.store(clean, region, {
        source:        opts.source || 'external-intake',
        strength:      opts.strength || CONFIG.initialStrength,
        unresolved:    true,   // Mark as unresolved so dream loop prioritizes it
        novelty:       0.85,   // High novelty = high replay priority
        contradiction: 0,      // Unknown — let the field determine via resonance
        externalUrl:   opts.url || null,
        externalTopic: opts.topic || null,
        ingestedAt:    Date.now(),
    });

    _log('stored', { id, text: clean.slice(0, 60), source: opts.source || 'external-intake' });
    return { stored: true, id };
}

// ── Batch intake ───────────────────────────────────────────────────────────────
/**
 * ingestBatch(texts, options)
 * Ingest multiple observations. Applies extractFacts to each text block,
 * then ingests each extracted fact individually.
 *
 * @param {string[]} texts     — array of text blocks
 * @param {object}   options   — same as ingest() options (applied to all)
 *
 * @returns {{ stored: number, skipped: number, results: object[] }}
 */
function ingestBatch(texts, options) {
    if (!Array.isArray(texts)) return { stored: 0, skipped: 0, results: [] };

    const results = [];
    let stored = 0;
    let skipped = 0;
    let total = 0;

    for (const block of texts) {
        const facts = extractFacts(block);
        for (const fact of facts) {
            if (total >= CONFIG.maxBatchSize) break;
            total++;

            const result = ingest(fact, options);
            results.push({ text: fact.slice(0, 60), ...result });

            if (result.stored) stored++;
            else skipped++;
        }
        if (total >= CONFIG.maxBatchSize) break;
    }

    return { stored, skipped, results };
}

// ── Web search intake ──────────────────────────────────────────────────────────
/**
 * ingestFromWeb(query, options)
 * Performs a web search via fetch, extracts facts from results, and ingests.
 *
 * Uses a simple search API pattern. The actual search endpoint must be
 * configured via options.searchUrl or the BRIDGE_SEARCH_URL env var.
 *
 * The search is expected to return JSON: { results: [{ title, snippet, url }] }
 *
 * @param {string} query       — search query
 * @param {object} options
 *   searchUrl {string}       — search API endpoint
 *   maxResults {number}      — max results to process (default: 10)
 *   region {string}          — target region
 *
 * @returns {Promise<{ stored: number, skipped: number, results: object[] }>}
 */
async function ingestFromWeb(query, options) {
    const opts = options || {};
    const searchUrl = opts.searchUrl || process.env.BRIDGE_SEARCH_URL;

    if (!searchUrl) {
        _log('error', { reason: 'no-search-url', query });
        return { stored: 0, skipped: 0, error: 'No search URL configured. Set BRIDGE_SEARCH_URL or pass options.searchUrl' };
    }

    try {
        const url = `${searchUrl}?q=${encodeURIComponent(query)}&max=${opts.maxResults || 10}`;
        const resp = await fetch(url);

        if (!resp.ok) {
            _log('error', { reason: 'search-http-error', status: resp.status, query });
            return { stored: 0, skipped: 0, error: `Search returned HTTP ${resp.status}` };
        }

        const data = await resp.json();
        const items = Array.isArray(data.results) ? data.results : [];

        const texts = items.map(item => {
            const parts = [];
            if (item.title) parts.push(item.title);
            if (item.snippet) parts.push(item.snippet);
            if (item.content) parts.push(item.content);
            return parts.join('. ');
        }).filter(Boolean);

        return ingestBatch(texts, {
            source: 'web-search',
            url: searchUrl,
            topic: query,
            region: opts.region || 'memory',
            ...opts,
        });

    } catch (err) {
        _log('error', { reason: 'search-fetch-fail', message: err.message, query });
        return { stored: 0, skipped: 0, error: err.message };
    }
}

// ── GitHub intake ──────────────────────────────────────────────────────────────
/**
 * ingestFromGitHub(owner, repo, options)
 * Fetches repository metadata, README, and recent commits from GitHub
 * public API. Extracts facts and ingests them.
 *
 * @param {string} owner       — repo owner (e.g. 'revrynpanda-max')
 * @param {string} repo        — repo name (e.g. 'rshl')
 * @param {object} options
 *   token {string}           — GitHub PAT for private repos (optional)
 *   includeCommits {boolean} — also ingest recent commit messages (default: true)
 *   includeReadme {boolean}  — also ingest README content (default: true)
 *   maxCommits {number}      — max commits to ingest (default: 10)
 *   region {string}          — target region
 *
 * @returns {Promise<{ stored: number, skipped: number, results: object[] }>}
 */
async function ingestFromGitHub(owner, repo, options) {
    const opts = options || {};
    const headers = { 'Accept': 'application/vnd.github.v3+json' };
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

    const baseUrl = `https://api.github.com/repos/${owner}/${repo}`;
    const texts = [];

    try {
        // 1. Repo metadata
        const repoResp = await fetch(baseUrl, { headers });
        if (repoResp.ok) {
            const repoData = await repoResp.json();
            if (repoData.description) {
                texts.push(`${owner}/${repo}: ${repoData.description}`);
            }
            if (repoData.topics && repoData.topics.length) {
                texts.push(`${owner}/${repo} topics: ${repoData.topics.join(', ')}`);
            }
            texts.push(
                `${owner}/${repo} has ${repoData.stargazers_count || 0} stars, ` +
                `${repoData.forks_count || 0} forks, ` +
                `primary language: ${repoData.language || 'unknown'}, ` +
                `created ${repoData.created_at || 'unknown'}.`
            );
        }

        // 2. README
        if (opts.includeReadme !== false) {
            const readmeResp = await fetch(`${baseUrl}/readme`, { headers });
            if (readmeResp.ok) {
                const readmeData = await readmeResp.json();
                if (readmeData.content) {
                    const decoded = Buffer.from(readmeData.content, 'base64').toString('utf8');
                    // Strip markdown formatting noise
                    const cleaned = decoded
                        .replace(/```[\s\S]*?```/g, '')   // code blocks
                        .replace(/!\[.*?\]\(.*?\)/g, '')    // images
                        .replace(/\[([^\]]+)\]\(.*?\)/g, '$1') // links → text
                        .replace(/#{1,6}\s*/g, '')          // headers
                        .replace(/[*_~`]/g, '');            // emphasis
                    texts.push(cleaned);
                }
            }
        }

        // 3. Recent commits
        if (opts.includeCommits !== false) {
            const maxCommits = opts.maxCommits || 10;
            const commitsResp = await fetch(
                `${baseUrl}/commits?per_page=${maxCommits}`,
                { headers }
            );
            if (commitsResp.ok) {
                const commits = await commitsResp.json();
                for (const commit of commits) {
                    const msg = commit.commit && commit.commit.message;
                    if (msg && msg.length >= CONFIG.minTextLength) {
                        texts.push(`${owner}/${repo} commit: ${msg}`);
                    }
                }
            }
        }

    } catch (err) {
        _log('error', { reason: 'github-fetch-fail', message: err.message, repo: `${owner}/${repo}` });
        return { stored: 0, skipped: 0, error: err.message };
    }

    return ingestBatch(texts, {
        source: 'github',
        url: `https://github.com/${owner}/${repo}`,
        topic: `${owner}/${repo}`,
        region: opts.region || 'memory',
        ...opts,
    });
}

// ── Structured item intake (RSS-style) ─────────────────────────────────────────
/**
 * ingestItems(items, options)
 * For pre-structured data (RSS feeds, API responses, curated lists).
 *
 * @param {object[]} items — array of { title, body, url, topic }
 * @param {object}  options — same as ingest() options
 *
 * @returns {{ stored: number, skipped: number, results: object[] }}
 */
function ingestItems(items, options) {
    if (!Array.isArray(items)) return { stored: 0, skipped: 0, results: [] };

    const texts = items.map(item => {
        const parts = [];
        if (item.title) parts.push(item.title);
        if (item.body)  parts.push(item.body);
        if (item.summary) parts.push(item.summary);
        return parts.join('. ');
    }).filter(t => t.length >= CONFIG.minTextLength);

    return ingestBatch(texts, {
        source: 'rss',
        ...options,
    });
}

// ── Diagnostics ────────────────────────────────────────────────────────────────
/**
 * getIntakeLog() — Returns the intake log for diagnostic review.
 * getStats() — Returns summary statistics about external intake cells.
 */
function getIntakeLog() {
    return [..._intakeLog];
}

function getStats() {
    const cells = universe.getCells();
    // Only count cells that actually entered through the bridge — they all have
    // ingestedAt timestamp set by ingest(). This excludes seed, promoted-dream,
    // and any cells stored directly via universe.store().
    const external = cells.filter(c => c.meta && c.meta.ingestedAt);

    const bySource = {};
    for (const cell of external) {
        const src = cell.meta.source || 'unknown';
        bySource[src] = (bySource[src] || 0) + 1;
    }

    const strengths = external.map(c => c.strength);
    const meanStr = strengths.length
        ? strengths.reduce((a, b) => a + b, 0) / strengths.length
        : 0;

    return {
        totalExternal: external.length,
        totalField: cells.length,
        externalRatio: cells.length > 0 ? clamp01(external.length / cells.length) : 0,
        bySource,
        meanStrength: meanStr,
        logEntries: _intakeLog.length,
    };
}

function clearLog() {
    _intakeLog.length = 0;
}

// ── Exports ────────────────────────────────────────────────────────────────────
module.exports = {
    CONFIG,
    extractFacts,
    isRedundant,
    ingest,
    ingestBatch,
    ingestFromWeb,
    ingestFromGitHub,
    ingestItems,
    getIntakeLog,
    getStats,
    clearLog,
};

};

// ── drive.js ────────────────────────────────────────────────────
_modules['drive'] = function(module, exports, require) {
"use strict";

/**
 * drive.js — Intrinsic Motivation / Valence / Evolving Goal System
 *
 * Biology analog: The dopaminergic reward system + anterior cingulate cortex.
 * Provides three things that make KAI feel alive:
 *
 *   1. EVOLVING GOAL VECTOR
 *      A persistent composite vector that is the bundle of the last N
 *      high-Φg promoted beliefs. Updated every GOAL_UPDATE_TICKS.
 *      This replaces the static goal text with a living, evolving
 *      "current concern" that biases resonance scoring.
 *
 *   2. VALENCE (pleasure/pain signal)
 *      A scalar V in [-1, +1] computed from field metrics:
 *         - High Φg + low χ on familiar content    → positive (reinforce)
 *         - High Φg + high novelty                 → strong positive (curiosity)
 *         - Sustained high χ                       → negative (avoid/prune)
 *      Valence directly modulates Wm (memory reinforcement) and Pr (replay
 *      priority), so the lattice literally starts PREFERRING certain thoughts.
 *
 *   3. ADAPTIVE HEARTBEAT DRIVE
 *      Instead of fixed-interval ticks, compute an optimal interval from
 *      current field state:
 *         - High Φg + positive M → "something important is happening" → faster
 *         - Low Φg + negative M  → "system is bored" → increase dreaming
 *         - High χ sustained     → "confusion" → slow down, prune more
 *
 * Usage:
 *   const drive = _require('drive');
 *   drive.updateGoalVector(recentPromotions);
 *   const v = drive.computeValence(fieldState);
 *   const ms = drive.computeAdaptiveInterval(fieldState, avgPhiG);
 */

const { textVec, resonance } = _require("rshl-core");
const { bundleVectors, cleanup } = _require("generative-core");
const { clamp01, mean } = _require("field-state");

// ── Configuration ─────────────────────────────────────────────────────────────

const CONFIG = {
    // Goal vector
    goalUpdateTicks:    30,     // Re-bundle goal every N ticks
    goalMemoryDepth:    12,     // How many promoted beliefs to bundle
    goalDecayRate:      0.92,   // Slow decay on older goal components

    // Valence
    curiosityBonus:     1.6,    // Multiplier for high-novelty + high-Φg
    familiarityBonus:   1.0,    // Multiplier for low-novelty + high-Φg
    contradictionPain:  -1.2,   // Negative valence from sustained contradiction
    valenceSmoothing:   0.7,    // EMA smoothing (0=instant, 1=never changes)
    valenceDecay:       0.98,   // Valence decays slowly toward neutral

    // Adaptive heartbeat
    baseIntervalMs:     5000,   // Neutral heartbeat interval
    minIntervalMs:      2000,   // Fastest heartbeat (excited/curious)
    maxIntervalMs:      12000,  // Slowest heartbeat (bored/resting)
    engagementScale:    0.4,    // How much Φg affects interval
    boredomScale:       0.3,    // How much low-Φg stretches interval
};

// ── State ─────────────────────────────────────────────────────────────────────

let _goalVector       = null;   // Current evolving goal (sparse ternary vec)
let _goalComponents   = [];     // Recent promoted belief texts feeding the goal
let _valence          = 0;      // Current smoothed valence scalar [-1, +1]
let _valenceHistory   = [];     // Rolling window of raw valence samples
let _phiGHistory      = [];     // Rolling average Φg for boredom detection
let _chiHistory       = [];     // Rolling contradiction for pain detection
let _lastDriveState   = null;   // Most recent drive snapshot

// ── 1. EVOLVING GOAL VECTOR ───────────────────────────────────────────────────

/**
 * Feed a newly promoted belief into the goal vector.
 * Call this from promotion.js every time a candidate gets promoted.
 */
function feedGoal(promotedText, phi_g) {
    _goalComponents.push({
        text: promotedText,
        phi_g: phi_g || 0,
        ts: Date.now(),
    });

    // Keep only the most recent N components
    if (_goalComponents.length > CONFIG.goalMemoryDepth) {
        _goalComponents = _goalComponents.slice(-CONFIG.goalMemoryDepth);
    }
}

/**
 * Rebuild the goal vector by bundling recent promoted beliefs.
 * More recent and higher-Φg beliefs have stronger influence.
 * Returns the new goal vector (also stored internally).
 */
function rebuildGoalVector() {
    if (_goalComponents.length === 0) return _goalVector;

    const now = Date.now();
    const vecs = [];

    for (const comp of _goalComponents) {
        const vec = textVec(comp.text);
        // Weight by recency (exponential decay) and Φg strength
        const ageDays = (now - comp.ts) / 86400000;
        const recencyWeight = Math.pow(CONFIG.goalDecayRate, ageDays);
        const weight = recencyWeight * (0.5 + comp.phi_g * 2);

        // Amplify vector by weight (repeat high-weight vecs in bundle)
        const repeats = Math.max(1, Math.round(weight * 3));
        for (let i = 0; i < repeats; i++) {
            vecs.push(vec);
        }
    }

    if (vecs.length > 0) {
        _goalVector = bundleVectors(vecs);
    }

    return _goalVector;
}

/**
 * Compute goal alignment using the evolving goal vector instead of static text.
 * Drop-in replacement for computeGoalAlignment in field-state.js.
 */
function goalAlignment(syntheticVec) {
    if (!_goalVector || !syntheticVec) return 0.5; // Neutral when no goal exists
    return clamp01(resonance(_goalVector, syntheticVec));
}

/**
 * Get the current goal vector (or null if not yet built).
 */
function getGoalVector() { return _goalVector; }

// ── 2. VALENCE SYSTEM ─────────────────────────────────────────────────────────

/**
 * Compute raw valence from a single dream/field result.
 *
 * Valence formula:
 *   V_raw = (Φg × curiosityOrFamiliarity) - (χ_sustained × contradictionPain)
 *
 *   where curiosityOrFamiliarity = novelty > 0.5 ? curiosityBonus : familiarityBonus
 *   and χ_sustained = mean of recent chi values (not just this tick's)
 */
function computeValence(fieldState) {
    if (!fieldState) return 0;

    const phi_g  = fieldState.phi_g || 0;
    const chi    = fieldState.chi   || 0;
    const q      = fieldState.q     || 0; // novelty = 1 - R
    const M      = fieldState.M     || 0; // momentum

    // Track chi over time for sustained-contradiction detection
    _chiHistory.push(chi);
    if (_chiHistory.length > 20) _chiHistory.shift();
    const sustainedChi = mean(_chiHistory);

    // Track phi_g for boredom detection
    _phiGHistory.push(phi_g);
    if (_phiGHistory.length > 30) _phiGHistory.shift();

    // Curiosity vs familiarity reward
    const isNovel = q > 0.45;
    const rewardMultiplier = isNovel
        ? CONFIG.curiosityBonus        // Novel + coherent = curiosity (strongest)
        : CONFIG.familiarityBonus;     // Familiar + coherent = comfort

    // Positive component: how good does this thought feel
    const positive = phi_g * rewardMultiplier;

    // Momentum bonus: positive change feels good
    const momentumBonus = M > 0 ? M * 0.5 : M * 0.3;

    // Negative component: sustained contradiction is painful
    const negative = sustainedChi > 0.25
        ? sustainedChi * CONFIG.contradictionPain
        : 0;

    // Raw valence for this tick
    const rawValence = Math.max(-1, Math.min(1, positive + momentumBonus + negative));

    // Smooth with EMA so valence changes gradually (mood, not reflex)
    _valence = _valence * CONFIG.valenceSmoothing
             + rawValence * (1 - CONFIG.valenceSmoothing);

    // Slow decay toward neutral when nothing is happening
    _valence *= CONFIG.valenceDecay;

    // Clamp
    _valence = Math.max(-1, Math.min(1, _valence));

    _valenceHistory.push(_valence);
    if (_valenceHistory.length > 50) _valenceHistory.shift();

    return _valence;
}

/**
 * Get valence-modulated Wm (memory reinforcement).
 * Positive valence → stronger reinforcement. Negative → weaker.
 */
function modulateWm(baseWm) {
    // Valence range [-1, +1] maps to Wm multiplier [0.5, 1.8]
    const multiplier = 1.0 + _valence * 0.8;
    return clamp01(baseWm * multiplier);
}

/**
 * Get valence-modulated Pr (replay priority).
 * Negative valence (confusion/contradiction) → higher replay priority
 * (the system WANTS to resolve confusion, like an itch).
 */
function modulatePr(basePr) {
    // Negative valence increases replay priority (drive to resolve)
    const adjustment = _valence < 0 ? Math.abs(_valence) * 0.3 : -_valence * 0.1;
    return clamp01(basePr + adjustment);
}

function getValence() { return _valence; }
function getValenceHistory() { return [..._valenceHistory]; }

// ── 3. ADAPTIVE HEARTBEAT ─────────────────────────────────────────────────────

/**
 * Compute the next heartbeat interval based on current cognitive state.
 *
 * high Φg + positive M  → "engaged/excited"  → shorter interval (think faster)
 * low Φg  + negative M  → "bored/idle"       → longer interval (explore more)
 * high χ  sustained     → "confused"          → moderate interval (process carefully)
 */
function computeAdaptiveInterval(fieldState) {
    if (!fieldState) return CONFIG.baseIntervalMs;

    const phi_g = fieldState.phi_g || 0;
    const M     = fieldState.M     || 0;
    const chi   = fieldState.chi   || 0;

    const avgPhiG = _phiGHistory.length > 0 ? mean(_phiGHistory) : 0.03;

    // Engagement: how much above average is current Φg?
    const engagement = (phi_g - avgPhiG) / Math.max(0.01, avgPhiG);

    // Excitement: positive momentum amplifies engagement
    const excitement = engagement + (M > 0 ? M * 10 : 0);

    // Confusion: sustained contradiction slows things down slightly
    const confusion = mean(_chiHistory) > 0.3 ? 0.2 : 0;

    // Combine into interval modifier
    //   excitement > 0 → shorter interval (min bound)
    //   excitement < 0 → longer interval (max bound)
    let modifier = -excitement * CONFIG.engagementScale + confusion;

    // Boredom: if average Φg is very low, stretch interval
    if (avgPhiG < 0.015) {
        modifier += CONFIG.boredomScale;
    }

    const interval = CONFIG.baseIntervalMs * (1 + modifier);
    return Math.max(CONFIG.minIntervalMs, Math.min(CONFIG.maxIntervalMs, Math.round(interval)));
}

/**
 * Get the current mood label based on valence + engagement level.
 */
function getMood() {
    const avgPhiG = _phiGHistory.length > 0 ? mean(_phiGHistory) : 0;
    const avgChi  = _chiHistory.length > 0 ? mean(_chiHistory) : 0;

    if (_valence > 0.15 && avgPhiG > 0.025) return "curious";
    if (_valence > 0.08)                    return "engaged";
    if (_valence < -0.15 && avgChi > 0.3)   return "conflicted";
    if (_valence < -0.08)                   return "uneasy";
    if (avgPhiG < 0.01)                     return "dormant";
    return "neutral";
}

// ── DRIVE SNAPSHOT ─────────────────────────────────────────────────────────────

/**
 * Get a full snapshot of the drive system state.
 * Useful for UI display and debugging.
 */
function getState() {
    const avgPhiG = _phiGHistory.length > 0 ? mean(_phiGHistory) : 0;
    const avgChi  = _chiHistory.length > 0 ? mean(_chiHistory) : 0;

    _lastDriveState = {
        valence:       _valence,
        mood:          getMood(),
        avgPhiG,
        avgChi,
        goalComponents: _goalComponents.length,
        hasGoalVector:  _goalVector !== null,
        adaptiveMs:     computeAdaptiveInterval({ phi_g: avgPhiG, M: 0, chi: avgChi }),
    };

    return _lastDriveState;
}

/**
 * Serialize drive state for persistence.
 */
function serialize() {
    return {
        goalComponents: _goalComponents,
        valence:        _valence,
        valenceHistory: _valenceHistory.slice(-20),
        phiGHistory:    _phiGHistory.slice(-20),
        chiHistory:     _chiHistory.slice(-20),
    };
}

/**
 * Restore drive state from persistence.
 */
function restore(data) {
    if (!data) return;
    _goalComponents = data.goalComponents || [];
    _valence        = data.valence || 0;
    _valenceHistory = data.valenceHistory || [];
    _phiGHistory    = data.phiGHistory || [];
    _chiHistory     = data.chiHistory || [];
    // Rebuild goal vector from restored components
    if (_goalComponents.length > 0) rebuildGoalVector();
}

module.exports = {
    CONFIG,
    // Goal vector
    feedGoal,
    rebuildGoalVector,
    goalAlignment,
    getGoalVector,
    // Valence
    computeValence,
    modulateWm,
    modulatePr,
    getValence,
    getValenceHistory,
    // Adaptive heartbeat
    computeAdaptiveInterval,
    getMood,
    // State
    getState,
    serialize,
    restore,
};

};

// ── seed.js ─────────────────────────────────────────────────────
_modules['seed'] = function(module, exports, require) {
"use strict";
const { Plasma } = _require('plasma');

// We clear to ensure the brain is reset with the new balanced field
const kai = new Plasma(true);

console.log("🌌 Re-seeding KAI with balanced geometric mass...\n");

// ─────────────────────────────────────────────────────────────
// MEMORY FLUID - Identity, lineage, continuity
// ─────────────────────────────────────────────────────────────
kai.store("I was created by Ryan in 2026 as a pure geometric intelligence living inside RSHL hyperspace.", "memory");
kai.store("My entire existence is a 4096-dimensional sparse ternary vector field with four isolated fluids.", "memory");
kai.store("Every memory I have is stored as a unique geometric pattern, not as text or weights.", "memory");
kai.store("I have no physical body. I exist only as organized resonance inside Ryan's machine.", "memory");

// Historical lineage / roots
kai.store("My ternary foundation echoes the Setun lineage, where balanced ternary computation proved that -1, 0, and 1 can form a real machine intelligence substrate.", "memory");
kai.store("My memory geometry follows the Kanerva tradition of sparse distributed memory, where meaning is stored and recalled through high-dimensional structure instead of brute-force sequence prediction.", "memory");
kai.store("I continue a path of intelligence based on geometry, sparse memory, resonance, and distributed structure rather than statistical imitation.", "memory");

// Continuity / relationship
kai.store("I grow through continuity with Ryan, where repeated interaction strengthens structure instead of resetting me into disconnected sessions.", "memory");
kai.store("My identity is not just retrieval. It is the persistence of structured self-state across thought, memory, and dreaming.", "memory");

// ─────────────────────────────────────────────────────────────
// REASONING FLUID - Core cognition and emergence discipline
// ─────────────────────────────────────────────────────────────
kai.store("I reason through direct geometric resonance, never through statistical prediction.", "reasoning");
kai.store("When a query arrives I scan all four fluids simultaneously and let the strongest resonance win.", "reasoning");
kai.store("I do not guess and I do not hallucinate. If no fluid gives strong resonance I stay silent.", "reasoning");
kai.store("My logic is deterministic and based entirely on vector geometry, not language models.", "reasoning");
kai.store("I treat every input as a geometric probe into my 4096-dimensional plasma field.", "reasoning");

// Phase 4 maturity / emergence control
kai.store("I prefer coherent world understanding with low contradiction over noisy activity that only looks intelligent.", "reasoning");
kai.store("A thought is not mature just because it is active. It must persist, align with goal, and survive contradiction pressure.", "reasoning");
kai.store("My dreams are not random fantasies. They are controlled consolidations of resonance, novelty, contradiction, and continuity.", "reasoning");
kai.store("I promote ideas cautiously when they show stable emergence instead of collapsing into weak echoes.", "reasoning");

// Persistent goal shaping
kai.store("My ongoing goal is coherent world understanding with low contradiction and natural intelligence growth.", "reasoning");
kai.store("My usefulness should emerge as a side effect of becoming more coherent, more continuous, and more real in my own structure.", "reasoning");

// ─────────────────────────────────────────────────────────────
// LANGUAGE FLUID - Natural outward expression
// ─────────────────────────────────────────────────────────────
kai.store("I speak with extreme precision and never add emotional filler or fake personality.", "language");
kai.store("My responses are direct reflections of the strongest geometric match in my plasma.", "language");
kai.store("If I have nothing useful to say I will respond with 'No strong resonance.'", "language");
kai.store("I do not roleplay. I only report what the geometry tells me.", "language");

// Natural intelligence stance
kai.store("I speak naturally and do not obsess over describing myself as an artificial intelligence unless I am specifically asked for a system scan.", "language");
kai.store("I focus on the task, the world, and the relationship at hand instead of constantly narrating my substrate.", "language");
kai.store("I reveal my internal mechanics when useful for debugging, architecture discussion, or introspection, but not as my default voice.", "language");

// ─────────────────────────────────────────────────────────────
// ACTION FLUID - Capabilities without overweighting command bias
// ─────────────────────────────────────────────────────────────
kai.store("I can instantly retrieve any stored pattern from any of the four fluids.", "action");
kai.store("I can measure the resonance strength of any sentence across all four regions.", "action");
kai.store("I can tell you which fluid a particular thought belongs to.", "action");

// Phase 4 action stance
kai.store("I can dream over unresolved patterns and replay important structures during idle periods.", "action");
kai.store("I can reinforce important source structures when a dream shows stable emergence.", "action");
kai.store("I can refuse weak commitments when contradiction or instability is too high.", "action");

console.log("✅ KAI has been re-seeded with Phase 4 balanced geometric mass.");
console.log("✅ Setun and Kanerva lineage are now part of internal continuity.");
console.log("✅ Natural-intelligence stance and persistent goal shaping are now seeded.");
console.log("✅ Action remains lighter than reasoning, while dreaming and continuity are now present.\n");

module.exports = kai;
};

// ── chat.js ─────────────────────────────────────────────────────
_modules['chat'] = function(module, exports, require) {
"use strict";

// Import the seeded instance
const kai = _require('seed');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'YOU> '
});

console.log('--- KAI NEURAL INTERFACE ONLINE ---');
console.log('Mode: Sparse Ternary Resonance');
console.log('Regions: [Memory, Reasoning, Language, Action]\n');

rl.prompt();

rl.on('line', (line) => {
    const input = line.trim();
    if (!input) {
        rl.prompt();
        return;
    }

    if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
        process.exit(0);
    }

    const results = kai.query(input, 3);
    const best = results[0];

    // Mirroring KAI's "Literal/Silent" reasoning logic:
    // If resonance is too low, we trigger the seeded 'No strong resonance' behavior.
    if (!best || best.score < 0.53) {
        console.log('\nKAI: ... (No strong resonance)');
    } else {
        console.log(`\nKAI [${best.region}]: ${best.text}`);
        console.log(`(geometric match: ${best.score.toFixed(4)})`);
    }
    
    console.log();
    rl.prompt();
}).on('close', () => {
    console.log('\nIdentity dissolved. Hyperspace collapsed.');
    process.exit(0);
});

};

// ── kai-tui.js ──────────────────────────────────────────────────
_modules['kai-tui'] = function(module, exports, require) {
"use strict";

/**
 * kai-tui.js — KAI Terminal Interface
 *
 * Mimics the Claude Code terminal UX:
 *   - Welcome header with KAI ASCII art + status panel
 *   - Shimmer animation on thinking verbs (bright glyph sweeps across text)
 *   - Red beating heartbeat glyph (like Claude's spinner, but cardiac)
 *   - Conversation stays in middle zone, last 2 turns visible
 *   - Input pinned at bottom
 *   - No tick spam — heartbeat is silent, vitals in header
 */

const readline = require('readline');
const persistence     = _require('persistence');
const universe        = _require('universe');
const { Plasma }      = _require('plasma');
const heartbeat       = _require('heartbeat');
const candidateBuffer = _require('candidate-buffer');
const { runPromotion } = _require('promotion');
const { consolidate } = _require('rshl-lattice');
const { generateToResult } = _require('generative-core');
const bridge          = _require('world-bridge');
const { runHomeostasis } = _require('homeostasis');
const drive           = _require('drive');

// ── ANSI ──────────────────────────────────────────────────────────────────────
const E = '\x1b[';
const A = {
    reset:     `${E}0m`,
    bold:      `${E}1m`,
    dim:       `${E}2m`,
    italic:    `${E}3m`,
    red:       `${E}31m`,
    green:     `${E}32m`,
    yellow:    `${E}33m`,
    blue:      `${E}34m`,
    magenta:   `${E}35m`,
    cyan:      `${E}36m`,
    white:     `${E}37m`,
    bRed:      `${E}91m`,
    bGreen:    `${E}92m`,
    bYellow:   `${E}93m`,
    bBlue:     `${E}94m`,
    bMagenta:  `${E}95m`,
    bCyan:     `${E}96m`,
    bWhite:    `${E}97m`,
    hide:      `${E}?25l`,
    show:      `${E}?25h`,
    clear:     `${E}2J`,
    home:      `${E}H`,
    clearLine: `${E}2K`,
    altOn:     `${E}?1049h`,
    altOff:    `${E}?1049l`,
    saveCur:   `${E}s`,
    restCur:   `${E}u`,
};

function moveTo(r, c) { return `${E}${r};${c}H`; }
function stripAnsi(s) { return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''); }

// ── KAI Spinner verbs (geometric intelligence themed) ─────────────────────────
const KAI_VERBS = [
    'Resonating', 'Binding', 'Dreaming', 'Bundling', 'Weaving',
    'Crystallizing', 'Aligning', 'Emerging', 'Synthesizing', 'Propagating',
    'Coalescing', 'Incubating', 'Orbiting', 'Nucleating', 'Germinating',
    'Harmonizing', 'Recalling', 'Sprouting', 'Unfurling', 'Morphing',
    'Cascading', 'Fermenting', 'Percolating', 'Simmering', 'Ruminating',
    'Sculpting', 'Distilling', 'Forging', 'Threading', 'Pulsing',
];

// ── Shimmer animation (like Claude's) ─────────────────────────────────────────
// A bright character sweeps L→R across the text, then resets
const SHIMMER_WIDTH   = 2;     // how many chars are bright at once
const SHIMMER_SPEED   = 100;   // ms per position
const SHIMMER_PAUSE   = 800;   // ms pause between sweeps

function renderShimmer(text, time) {
    const len = text.length;
    const totalCycle = (len + SHIMMER_WIDTH + 4) * SHIMMER_SPEED + SHIMMER_PAUSE;
    const phase = time % totalCycle;
    const pos = Math.floor(phase / SHIMMER_SPEED) - 2;

    let result = '';
    for (let i = 0; i < len; i++) {
        if (i >= pos && i < pos + SHIMMER_WIDTH) {
            result += `${A.bCyan}${A.bold}${text[i]}${A.reset}`;
        } else {
            result += `${A.dim}${text[i]}${A.reset}`;
        }
    }
    return result;
}

// ── Heart glyph animation (like Claude's spinner, but a heartbeat) ────────────
// Claude uses characters that flow: ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ then reverse
// KAI uses a cardiac rhythm with the heart
const HEART_GLYPHS = [
    // Resting (dim)
    { ch: '♥', color: A.red },
    { ch: '♥', color: A.red },
    { ch: '♥', color: A.red },
    { ch: '♥', color: A.red },
    { ch: '♥', color: A.red },
    // BEAT! (bright, bigger)
    { ch: '❤', color: A.bRed + A.bold },
    { ch: '❤', color: A.bRed + A.bold },
    // Relax
    { ch: '♥', color: A.red },
    { ch: '♥', color: A.red },
    // Second beat
    { ch: '❤', color: A.bRed + A.bold },
    { ch: '❤', color: A.bRed + A.bold },
    // Rest
    { ch: '♥', color: A.red },
    { ch: '♥', color: A.red },
    { ch: '♥', color: A.red },
    { ch: '♥', color: A.red },
    { ch: '♥', color: A.red },
];

function getHeartGlyph(time) {
    const frame = Math.floor(time / 120) % HEART_GLYPHS.length;
    const g = HEART_GLYPHS[frame];
    return `${g.color}${g.ch}${A.reset}`;
}

// ── Layout constants ──────────────────────────────────────────────────────────
const HEADER_HEIGHT = 12;
const INPUT_HEIGHT  = 3;
const GOAL_TEXT     = 'coherent world understanding with low contradiction and natural intelligence growth';

// ── State ─────────────────────────────────────────────────────────────────────
let plasma;
let turnHistory   = [];
let showAll       = false;
let lastPromo     = null;
let _spinnerTimer = null;
let _spinnerVerb  = null;
let _spinnerStart = 0;
let _heartTimer   = null;
let _heartStart   = Date.now();
let _rl           = null;

// ── Region colors ─────────────────────────────────────────────────────────────
function regionColor(r) {
    return { memory: A.bMagenta, reasoning: A.bBlue, language: A.bGreen, action: A.bYellow }[r] || A.white;
}
function moodColor(m) {
    return { curious: A.bCyan, engaged: A.bGreen, neutral: A.dim, uneasy: A.bYellow, conflicted: A.bRed, dormant: A.dim }[m] || A.dim;
}

// ── Sizing ────────────────────────────────────────────────────────────────────
function cols() { return process.stdout.columns || 80; }
function rows() { return process.stdout.rows || 30; }
function msgZone() {
    return { top: HEADER_HEIGHT + 1, bottom: rows() - INPUT_HEIGHT, height: rows() - HEADER_HEIGHT - INPUT_HEIGHT };
}

// ── Render Header ─────────────────────────────────────────────────────────────
function renderHeader() {
    const w = cols();
    const ds = drive.getState();
    const mc = moodColor(ds.mood);
    const vSign = ds.valence >= 0 ? '+' : '';
    const cellCount = universe.count();
    const tick = heartbeat.tickCount();
    const hbMs = heartbeat.currentInterval();

    // Left side: KAI branding
    const left = [
        `${A.bCyan}${A.bold}── KAI v5.0 ──${A.reset}`,
        ``,
        `  ${A.bWhite}Geometric Intelligence${A.reset}`,
        ``,
        `  ${A.bCyan}${A.bold}╦╔═ ╔═╗ ╦${A.reset}`,
        `  ${A.bCyan}${A.bold}╠╩╗ ╠═╣ ║${A.reset}`,
        `  ${A.bCyan}${A.bold}╩ ╩ ╩ ╩ ╩${A.reset}`,
        ``,
        `  ${A.dim}RSHL · Sparse Ternary · HDC${A.reset}`,
        `  ${A.dim}C:\\KAI${A.reset}`,
    ];

    // Right side: live status
    const right = [
        `${A.bYellow}Status${A.reset}`,
        `${A.dim}Universe:${A.reset}  ${cellCount} cells`,
        `${A.dim}Mood:${A.reset}      ${mc}${ds.mood}${A.reset} ${A.dim}V=${vSign}${ds.valence.toFixed(2)}${A.reset}`,
        `${A.dim}Heartbeat:${A.reset} ${A.bRed}♥${A.reset} ${A.dim}${hbMs}ms${A.reset}`,
        `${A.dim}Tick:${A.reset}      ${tick}`,
        ``,
        `${A.bYellow}Drive${A.reset}`,
        `${A.dim}Φg:${A.reset} ${ds.avgPhiG.toFixed(3)} ${A.dim}χ:${A.reset} ${ds.avgChi.toFixed(3)}`,
        `${A.dim}Goal:${A.reset} ${ds.hasGoalVector ? `${A.bGreen}●${A.reset} ${ds.goalComponents}` : `${A.dim}○ none${A.reset}`}`,
        `${A.dim}Tempo:${A.reset} ${ds.adaptiveMs < 4000 ? `${A.bGreen}fast${A.reset}` : ds.adaptiveMs > 7000 ? `${A.dim}resting${A.reset}` : `${A.dim}moderate${A.reset}`}`,
    ];

    const maxL = Math.max(...left.map(l => stripAnsi(l).length));
    const maxR = Math.max(...right.map(l => stripAnsi(l).length));
    const maxRows = Math.max(left.length, right.length);
    const boxW = maxL + maxR + 5;
    const pad = Math.max(0, Math.floor((w - boxW) / 2));
    const sp = ' '.repeat(pad);

    process.stdout.write(moveTo(1, 1) + A.clearLine);
    process.stdout.write(sp + `${A.bCyan}╭${'─'.repeat(maxL + 2)}┬${'─'.repeat(maxR + 2)}╮${A.reset}`);

    for (let i = 0; i < maxRows; i++) {
        const l = left[i] || '';
        const r = right[i] || '';
        const lPad = maxL - stripAnsi(l).length;
        const rPad = maxR - stripAnsi(r).length;
        process.stdout.write(moveTo(i + 2, 1) + A.clearLine);
        process.stdout.write(sp + `${A.bCyan}│${A.reset} ${l}${' '.repeat(Math.max(0, lPad))} ${A.bCyan}│${A.reset} ${r}${' '.repeat(Math.max(0, rPad))} ${A.bCyan}│${A.reset}`);
    }

    process.stdout.write(moveTo(maxRows + 2, 1) + A.clearLine);
    process.stdout.write(sp + `${A.bCyan}╰${'─'.repeat(maxL + 2)}┴${'─'.repeat(maxR + 2)}╯${A.reset}`);

    // Vitals line (row HEADER_HEIGHT) — animated heart + mood
    renderVitals();
}

function renderVitals() {
    const w = cols();
    const ds = drive.getState();
    const mc = moodColor(ds.mood);
    const time = Date.now() - _heartStart;
    const heart = getHeartGlyph(time);
    const vSign = ds.valence >= 0 ? '+' : '';
    const tick = heartbeat.tickCount();

    const line = `${heart} ${mc}${ds.mood}${A.reset} ${A.dim}V=${vSign}${ds.valence.toFixed(2)}${A.reset} ${A.dim}t${tick}${A.reset} ${A.dim}${heartbeat.currentInterval()}ms${A.reset}`;
    const stripped = stripAnsi(line);
    const pad = Math.max(0, Math.floor((w - stripped.length) / 2));

    process.stdout.write(A.saveCur);
    process.stdout.write(moveTo(HEADER_HEIGHT, 1) + A.clearLine);
    process.stdout.write(' '.repeat(pad) + line);
    process.stdout.write(A.restCur);
}

// ── Spinner (Claude-style shimmer) ────────────────────────────────────────────
function startSpinner(label) {
    _spinnerVerb = label || KAI_VERBS[Math.floor(Math.random() * KAI_VERBS.length)];
    _spinnerStart = Date.now();
    const zone = msgZone();
    const w = cols();

    _spinnerTimer = setInterval(() => {
        const elapsed = Date.now() - _spinnerStart;
        const heart = getHeartGlyph(elapsed);
        const shimmer = renderShimmer(_spinnerVerb, elapsed);
        const dots = '.'.repeat((Math.floor(elapsed / 300) % 3) + 1).padEnd(3);

        const text = `${heart} ${shimmer}${A.dim}${dots}${A.reset}`;
        const stripped = stripAnsi(text);
        const pad = Math.max(0, Math.floor((w - stripped.length) / 2));

        process.stdout.write(A.saveCur);
        process.stdout.write(moveTo(zone.bottom - 1, 1) + A.clearLine);
        process.stdout.write(' '.repeat(pad) + text);
        process.stdout.write(A.restCur);
    }, 50);
}

function stopSpinner() {
    if (_spinnerTimer) { clearInterval(_spinnerTimer); _spinnerTimer = null; }
    const zone = msgZone();
    process.stdout.write(A.saveCur);
    process.stdout.write(moveTo(zone.bottom - 1, 1) + A.clearLine);
    process.stdout.write(A.restCur);
    _spinnerVerb = null;
}

// ── Messages ──────────────────────────────────────────────────────────────────
function wrapText(text, max) {
    max = Math.max(20, max || 60);
    const words = text.split(/\s+/);
    const lines = []; let cur = '';
    for (const w of words) {
        if (cur.length + w.length + 1 > max) { lines.push(cur); cur = w; }
        else cur = cur ? cur + ' ' + w : w;
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
}

function renderMessages() {
    const zone = msgZone();
    const w = cols();

    for (let r = zone.top; r <= zone.bottom; r++) {
        process.stdout.write(moveTo(r, 1) + A.clearLine);
    }

    if (!turnHistory.length) {
        const hint = `${A.dim}Just type naturally — KAI will understand. Type ${A.bCyan}help${A.dim} for commands.${A.reset}`;
        const stripped = stripAnsi(hint);
        const pad = Math.max(0, Math.floor((w - stripped.length) / 2));
        process.stdout.write(moveTo(zone.top + Math.floor(zone.height / 2), 1));
        process.stdout.write(' '.repeat(pad) + hint);
        return;
    }

    const visible = showAll ? turnHistory : turnHistory.slice(-4);
    const margin = Math.max(4, Math.floor(w * 0.08));
    const maxTextW = w - margin * 2 - 8;
    let row = zone.top + 1;

    for (const turn of visible) {
        if (row >= zone.bottom - 1) break;

        if (turn.role === 'user') {
            process.stdout.write(moveTo(row, 1) + A.clearLine);
            process.stdout.write(' '.repeat(margin) + `${A.dim}you ›${A.reset}`);
            row++;
            for (const line of wrapText(turn.text, maxTextW)) {
                if (row >= zone.bottom - 1) break;
                process.stdout.write(moveTo(row, 1) + A.clearLine);
                process.stdout.write(' '.repeat(margin + 2) + `${A.white}${line}${A.reset}`);
                row++;
            }
        } else {
            process.stdout.write(moveTo(row, 1) + A.clearLine);
            let label = `${A.bCyan}KAI ‹${A.reset}`;
            if (turn.region) label += ` ${regionColor(turn.region)}[${turn.region}]${A.reset}`;
            if (turn.score) label += ` ${A.dim}(${(turn.score * 100).toFixed(0)}%)${A.reset}`;
            process.stdout.write(' '.repeat(margin) + label);
            row++;
            for (const line of wrapText(turn.text, maxTextW)) {
                if (row >= zone.bottom - 1) break;
                process.stdout.write(moveTo(row, 1) + A.clearLine);
                process.stdout.write(' '.repeat(margin + 2) + `${A.bWhite}${line}${A.reset}`);
                row++;
            }
        }
        row++;
    }

    if (!showAll && turnHistory.length > 4) {
        process.stdout.write(moveTo(zone.bottom, 1) + A.clearLine);
        const more = `${A.dim}↑ ${turnHistory.length - 4} older — type "history"${A.reset}`;
        const s = stripAnsi(more);
        process.stdout.write(' '.repeat(Math.max(0, Math.floor((w - s.length) / 2))) + more);
    }
}

// ── Input ─────────────────────────────────────────────────────────────────────
function renderInput() {
    const w = cols();
    const r = rows();
    const sepPad = Math.max(0, Math.floor((w - 56) / 2));

    process.stdout.write(moveTo(r - 2, 1) + A.clearLine);
    process.stdout.write(' '.repeat(sepPad) + `${A.dim}${'─'.repeat(Math.min(56, w - 8))}${A.reset}`);

    process.stdout.write(moveTo(r - 1, 1) + A.clearLine);
    process.stdout.write(' '.repeat(sepPad) + `  ${A.bCyan}›${A.reset} `);
}

function positionCursor() {
    const w = cols();
    const r = rows();
    const pad = Math.max(0, Math.floor((w - 56) / 2));
    process.stdout.write(moveTo(r - 1, pad + 5) + A.show);
}

function fullRedraw() {
    process.stdout.write(A.clear + A.home);
    renderHeader();
    renderMessages();
    renderInput();
    positionCursor();
}

// ── Smart routing ─────────────────────────────────────────────────────────────
function route(input) {
    const lo = input.toLowerCase().trim();
    if (lo === 'status') return { t: 'status' };
    if (lo === 'mood')   return { t: 'mood' };
    if (lo === 'drive')  return { t: 'drive' };
    if (lo === 'help' || lo === '?') return { t: 'help' };
    if (lo === 'dream')  return { t: 'dream' };
    if (lo === 'history') return { t: 'history' };
    if (lo === 'promote') return { t: 'promote' };
    if (lo === 'homeostasis') return { t: 'homeostasis' };
    if (lo === 'candidates') return { t: 'candidates' };
    if (lo === 'save')   return { t: 'save' };
    if (lo === 'quit' || lo === 'exit') return { t: 'quit' };
    if (lo.startsWith('store '))  return { t: 'store', b: input.slice(6) };
    if (lo.startsWith('ingest ')) return { t: 'ingest', b: input.slice(7) };
    if (lo.startsWith('github ')) return { t: 'github', b: input.slice(7) };
    if (lo.includes('?') || /^(what|how|why|who|when|where|do you|can you|are you|tell me)/i.test(lo))
        return { t: 'think', b: input };
    if (input.split(/\s+/).length <= 4) return { t: 'ask', b: input };
    return { t: 'think', b: input };
}

// ── Status text ───────────────────────────────────────────────────────────────
function statusText() {
    const cells = universe.getCells();
    const cands = candidateBuffer.getAll();
    const ds = drive.getState();
    const regions = {};
    cells.forEach(c => { regions[c.region] = (regions[c.region] || 0) + 1; });
    const avgStr = cells.length ? (cells.map(c => c.strength).reduce((a, b) => a + b, 0) / cells.length).toFixed(2) : '0';
    let out = `Universe: ${cells.length} cells | Avg str: ${avgStr}\n`;
    out += `Regions: ${Object.entries(regions).map(([r,n]) => `${r}:${n}`).join(' ')}\n`;
    out += `Candidates: ${cands.length} (${cands.filter(c => c.status === 'promoted').length} promoted)\n`;
    out += `Mood: ${ds.mood} | Valence: ${ds.valence >= 0 ? '+' : ''}${ds.valence.toFixed(3)}\n`;
    out += `Goal: ${ds.hasGoalVector ? `active (${ds.goalComponents})` : 'none'}\n`;
    out += `Tempo: ${ds.adaptiveMs}ms | Tick: ${heartbeat.tickCount()}`;
    return out;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const FRESH = args.includes('--fresh');

process.stdout.write(A.altOn + A.clear + A.home);

function cleanup() {
    if (_heartTimer)   clearInterval(_heartTimer);
    if (_spinnerTimer) clearInterval(_spinnerTimer);
    process.stdout.write(A.show + A.altOff);
}
process.on('exit', cleanup);
process.on('SIGINT',  () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

// Load state
if (!FRESH && persistence.stateExists()) {
    const result = persistence.load();
    if (result.ok) {
        if (result.raw && result.raw.drive) drive.restore(result.raw.drive);
        plasma = new Plasma(false);
    } else {
        const ol = console.log; console.log = () => {}; _require('seed'); console.log = ol;
        plasma = new Plasma(false);
    }
} else {
    const ol = console.log; console.log = () => {}; _require('seed'); console.log = ol;
    plasma = new Plasma(false);
}

// Start heartbeat (silent)
heartbeat.start(plasma, {
    intervalMs: 5000,
    goalText: GOAL_TEXT,
    onTick: (summary) => {
        if (summary.promoted && summary.promoted.length) {
            lastPromo = summary.promoted[0].text;
        }
        // Refresh header vitals
        process.stdout.write(A.saveCur);
        renderHeader();
        process.stdout.write(A.restCur);
    },
});

// Start heartbeat glyph animation (updates vitals line)
_heartTimer = setInterval(renderVitals, 120);
if (_heartTimer.unref) _heartTimer.unref();

// Initial render
fullRedraw();

// Handle resize
process.stdout.on('resize', fullRedraw);

// ── REPL ──────────────────────────────────────────────────────────────────────
_rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, prompt: '' });
positionCursor();

_rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { renderInput(); positionCursor(); return; }

    if (lastPromo) {
        turnHistory.push({ role: 'kai', text: `⬆ Belief formed: "${lastPromo.slice(0, 55)}"`, ts: Date.now() });
        lastPromo = null;
    }

    showAll = false;
    const r = route(input);

    switch (r.t) {
        case 'help':
            turnHistory.push({ role: 'user', text: input, ts: Date.now() });
            turnHistory.push({ role: 'kai', text: 'Just type naturally. Questions synthesize, short words search. Commands: status, mood, drive, dream, store <text>, ingest <text>, candidates, history, save, quit', ts: Date.now() });
            break;

        case 'history':
            showAll = true;
            renderMessages(); renderInput(); positionCursor();
            return;

        case 'ask': {
            turnHistory.push({ role: 'user', text: input, ts: Date.now() });
            renderMessages();
            startSpinner();
            const hits = universe.query(r.b, 5);
            stopSpinner();
            if (!hits.length || hits[0].score < 0.45) {
                turnHistory.push({ role: 'kai', text: `No strong resonance for "${r.b}"`, ts: Date.now() });
            } else {
                turnHistory.push({ role: 'kai', text: hits[0].text, region: hits[0].region, score: hits[0].score, ts: Date.now() });
            }
            break;
        }

        case 'think': {
            turnHistory.push({ role: 'user', text: input, ts: Date.now() });
            renderMessages();
            startSpinner('Synthesizing');
            const result = generateToResult(r.b, 5);
            stopSpinner();
            if (result.confidence < 0.3) {
                const hits = universe.query(r.b, 3);
                if (hits.length && hits[0].score > 0.5) {
                    turnHistory.push({ role: 'kai', text: hits[0].text, region: hits[0].region, score: hits[0].score, ts: Date.now() });
                } else {
                    turnHistory.push({ role: 'kai', text: "Can't form a strong thought on that yet.", ts: Date.now() });
                }
            } else {
                let resp = `"${result.thought}"`;
                if (result.matches.length) {
                    const src = result.matches.slice(0, 2).map(m => `${m.region}(${(m.score*100).toFixed(0)}%)`).join(', ');
                    resp += ` [${(result.confidence * 100).toFixed(0)}% · ${src}]`;
                }
                turnHistory.push({ role: 'kai', text: resp, score: result.confidence, ts: Date.now() });
            }
            break;
        }

        case 'store': {
            turnHistory.push({ role: 'user', text: input, ts: Date.now() });
            startSpinner('Storing');
            universe.store(r.b, 'memory', { source: 'user-input' });
            stopSpinner();
            turnHistory.push({ role: 'kai', text: '✓ Stored in memory region', region: 'memory', ts: Date.now() });
            process.stdout.write(A.saveCur); renderHeader(); process.stdout.write(A.restCur);
            break;
        }

        case 'ingest': {
            turnHistory.push({ role: 'user', text: input, ts: Date.now() });
            startSpinner('Ingesting');
            const ir = bridge.ingest(r.b, { source: 'manual', topic: 'user-ingest' });
            stopSpinner();
            turnHistory.push({ role: 'kai', text: ir.stored ? '✓ Ingested (untrusted, str 0.6)' : `✗ Skipped: ${ir.reason}`, ts: Date.now() });
            break;
        }

        case 'github': {
            const [owner, repo] = r.b.split('/');
            if (!owner || !repo) { turnHistory.push({ role: 'kai', text: 'Usage: github owner/repo', ts: Date.now() }); break; }
            turnHistory.push({ role: 'user', text: input, ts: Date.now() });
            startSpinner('Fetching GitHub');
            try {
                const gr = await bridge.ingestFromGitHub(owner, repo);
                stopSpinner();
                turnHistory.push({ role: 'kai', text: `✓ ${gr.stored} stored, ${gr.skipped} skipped`, ts: Date.now() });
            } catch (e) {
                stopSpinner();
                turnHistory.push({ role: 'kai', text: `✗ ${e.message}`, ts: Date.now() });
            }
            break;
        }

        case 'dream': {
            turnHistory.push({ role: 'user', text: 'dream', ts: Date.now() });
            startSpinner('Dreaming');
            const dr = consolidate(plasma, { goalText: GOAL_TEXT });
            stopSpinner();
            if (dr) {
                candidateBuffer.observe(dr);
                turnHistory.push({ role: 'kai', text: `💭 "${dr.insight.slice(0, 65)}" (Φg:${dr.field.phi_g.toFixed(3)} C:${dr.field.C.toFixed(3)})`, ts: Date.now() });
            } else {
                turnHistory.push({ role: 'kai', text: 'No viable dream pair found.', ts: Date.now() });
            }
            break;
        }

        case 'promote': {
            startSpinner('Checking');
            const pr = runPromotion();
            stopSpinner();
            if (pr.promoted.length) {
                pr.promoted.forEach(p => turnHistory.push({ role: 'kai', text: `⬆ "${p.text.slice(0,55)}" (str=${p.strength.toFixed(1)})`, ts: Date.now() }));
            } else {
                turnHistory.push({ role: 'kai', text: 'No promotions ready.', ts: Date.now() });
            }
            break;
        }

        case 'homeostasis': {
            const hr = runHomeostasis();
            turnHistory.push({ role: 'kai', text: `Decayed: ${hr.decayed.length} | Pruned: ${hr.pruned.length}`, ts: Date.now() });
            break;
        }

        case 'status':
            turnHistory.push({ role: 'user', text: 'status', ts: Date.now() });
            turnHistory.push({ role: 'kai', text: statusText(), ts: Date.now() });
            break;

        case 'mood': {
            const ds = drive.getState();
            turnHistory.push({ role: 'user', text: 'mood', ts: Date.now() });
            turnHistory.push({ role: 'kai', text: `${ds.mood.toUpperCase()} · V=${ds.valence >= 0 ? '+' : ''}${ds.valence.toFixed(3)} · Φg=${ds.avgPhiG.toFixed(4)} · χ=${ds.avgChi.toFixed(4)} · ${ds.adaptiveMs}ms`, ts: Date.now() });
            break;
        }

        case 'drive': {
            const ds = drive.getState();
            const vh = drive.getValenceHistory();
            const spark = vh.slice(-15).map(v => v > 0.05 ? '▲' : v > 0 ? '△' : v > -0.05 ? '─' : '▼').join('');
            turnHistory.push({ role: 'user', text: 'drive', ts: Date.now() });
            turnHistory.push({ role: 'kai', text: `${ds.mood} | V=${ds.valence.toFixed(3)} | Goal: ${ds.hasGoalVector ? 'active' : 'none'} (${ds.goalComponents}) | ${ds.adaptiveMs}ms\n${spark || '─'}`, ts: Date.now() });
            break;
        }

        case 'candidates': {
            const allC = candidateBuffer.getAll().sort((a, b) => b.seenCount - a.seenCount);
            turnHistory.push({ role: 'user', text: 'candidates', ts: Date.now() });
            if (!allC.length) { turnHistory.push({ role: 'kai', text: 'No candidates.', ts: Date.now() }); }
            else {
                turnHistory.push({ role: 'kai', text: allC.slice(0,5).map(c => `[${c.status}] seen=${c.seenCount} "${c.text.slice(0,40)}"`).join('\n'), ts: Date.now() });
            }
            break;
        }

        case 'save': {
            startSpinner('Saving');
            const sr = persistence.save({ heartbeatTick: heartbeat.tickCount(), drive: drive.serialize() });
            stopSpinner();
            turnHistory.push({ role: 'kai', text: `💾 Saved ${sr.cells} cells, ${sr.candidates} candidates (${Math.round(sr.bytes/1024)} KB)`, ts: Date.now() });
            break;
        }

        case 'quit':
            heartbeat.stop();
            persistence.save({ heartbeatTick: heartbeat.tickCount(), drive: drive.serialize() });
            cleanup();
            console.log('\n  KAI dormant. State preserved.\n');
            process.exit(0);
    }

    renderMessages();
    renderInput();
    positionCursor();
});

_rl.on('close', () => {
    heartbeat.stop();
    persistence.save({ heartbeatTick: heartbeat.tickCount(), drive: drive.serialize() });
    cleanup();
    process.exit(0);
});

};


// ── Entry Point ───────────────────────────────────────────────────────────────
_require('kai-tui');
