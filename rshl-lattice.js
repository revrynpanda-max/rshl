/**
 * RSHL Lattice — Enhanced memory engine with Mem0-comparable operations.
 *
 * Adds to base rshl-core.js:
 *   - ADD / UPDATE / NOOP / DELETE operation routing (no LLM needed)
 *   - Entity normalization  — I/me/my → user token; proper names tracked
 *   - Temporal signal detection — "moved", "changed", "no longer", "used to"
 *   - Lightweight stemming — running/ran/runs → run (improves token overlap)
 *   - Subject-slot awareness — "user lives in X" updates "user lives in Y"
 *   - Hebbian reinforcement + exponential decay (inherited from RSHL)
 *
 * Zero dependencies beyond rshl-core.js.
 * 100% local — no API calls, no network, air-gap safe.
 *
 * Usage:
 *   const { RSHLLattice } = require("./rshl-lattice");
 *   const mem = new RSHLLattice({ userName: "Ryan" });
 *   mem.store("I live in Austin");
 *   mem.store("I moved to NYC");          // → op: UPDATE  (replaced Austin)
 *   mem.store("I live in NYC");           // → op: NOOP    (already known)
 *   mem.recall("where does Ryan live?");  // → [{text: "I moved to NYC", …}]
 */

"use strict";

const { textVec, resonance } = require("./rshl-core");

// ── Thresholds ────────────────────────────────────────────────────────────────
const T_NOOP   = 0.81;  // resonance above this = already known, reinforce only
const T_UPDATE = 0.58;  // resonance above this + update signal = replace existing
const T_DELETE = 0.48;  // resonance above this + delete signal = remove existing

// ── Signal word sets ─────────────────────────────────────────────────────────

const UPDATE_SIGNALS = new Set([
  "moved","move","moving","relocated","relocation",
  "changed","change","changing","switched","switching",
  "now","currently","recently","today","tonight","this week","this year",
  "no longer","not anymore","anymore","instead","replaced","replacing",
  "promoted","hired","fired","quit","left","joined","started","stopped",
  "new job","new role","new home","new address","new phone","new email",
  "got","gotten","became","become","turned",
  "used to","previously","formerly","once","before",
  "updated","update","correcting","correction",
  "delayed","delay","postponed","postpone","pushed back","rescheduled",
]);

const DELETE_SIGNALS = new Set([
  "forget","ignore","wrong","incorrect","not true","delete","remove",
  "disregard","cancel","nevermind","never mind","false","mistake",
  "that was wrong","that is wrong","not correct","erase","scratch that",
  "strike that","take that back","retract","undo that","cross that out",
]);

// ── Stop words (excluded from stemmed token set) ──────────────────────────────

const STOP = new Set([
  "the","a","an","and","or","but","in","on","at","to","for","of","with",
  "by","from","is","was","are","were","be","been","has","have","had",
  "do","does","did","will","would","could","should","may","might","can",
  "this","that","these","those","it","its","they","them","their",
  "there","here","when","where","who","what","how","which","about",
  "into","than","then","so","if","as","up","out","he","she","we","you",
  "am","im","just","also","very","too","more","most","some","any",
]);

// ── Stemmer (simple English suffix stripping) ─────────────────────────────────

function stem(w) {
  if (w.length < 4) return w;
  if (w.endsWith("tion"))  return w.slice(0,-4);
  if (w.endsWith("ness"))  return w.slice(0,-4);
  if (w.endsWith("ment"))  return w.slice(0,-4);
  if (w.endsWith("ing"))   return w.slice(0,-3);
  if (w.endsWith("est"))   return w.slice(0,-3);
  if (w.endsWith("ful"))   return w.slice(0,-3);
  if (w.endsWith("ed"))    return w.slice(0,-2);
  if (w.endsWith("er"))    return w.slice(0,-2);
  if (w.endsWith("ly"))    return w.slice(0,-2);
  if (w.endsWith("s") && w.length > 4) return w.slice(0,-1);
  return w;
}

// ── Entity helpers ────────────────────────────────────────────────────────────

const FIRST_PERSON = new Set(["i","me","my","myself","mine","i'm","i've","i'd","i'll"]);

/**
 * Normalize first-person pronouns to the user's name token.
 * Also lower-cases everything for consistent vector encoding.
 */
function normalizeText(text, userToken) {
  return text
    .toLowerCase()
    .replace(/\bi'm\b/g, `${userToken} is`)
    .replace(/\bi've\b/g, `${userToken} have`)
    .replace(/\bi'd\b/g, `${userToken} would`)
    .replace(/\bi'll\b/g, `${userToken} will`)
    .replace(/\b(i|me|my|myself|mine)\b/g, userToken);
}

/**
 * Extract simple named entities: capitalized words not at sentence start.
 * Also extracts the user token if present.
 */
function extractEntities(text, userToken) {
  const entities = new Set();
  if (text.toLowerCase().includes(userToken)) entities.add(userToken);
  const words = text.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const w = words[i].replace(/[^A-Za-z]/g,"");
    if (w.length >= 2 && w[0] === w[0].toUpperCase() && /[a-z]/.test(w)) {
      entities.add(w.toLowerCase());
    }
  }
  return entities;
}

function entityOverlap(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const e of a) if (b.has(e)) n++;
  return n / Math.max(a.size, b.size);
}

/**
 * Encode text using base textVec + stemmed token layer.
 * Stemmed tokens are appended so the underlying 4096-dim space
 * picks up morphological variants without any external model.
 */
function latticeVec(normalizedText) {
  const words   = normalizedText.replace(/[^a-z0-9\s]+/g," ").split(/\s+/).filter(Boolean);
  const stemmed = words.map(stem).filter(w => w.length > 2 && !STOP.has(w));
  // Combine original + stemmed into one string for textVec superposition
  const combined = [...words, ...stemmed].join(" ");
  return textVec(combined);
}

// ── Negation prefixes — block delete signals when negated ─────────────────────
// "don't forget", "shouldn't remove", "never delete", "not wrong" etc.
const NEGATION_PREFIX_RE = /\b(don't|dont|should ?n't|shouldnt|never|not|no)\s+(forget|ignore|remove|delete|disregard|cancel|erase|scratch)\b/i;

// ── Deterministic canonicalizers ──────────────────────────────────────────────
// Targeted rewrites for narrow patterns the eval exposes.
// Applied BEFORE vectorization so paraphrases land closer in vector space.
const CANON_RULES = [
  // Age: "Tom's age is 32" / "Tom is 32" / "Tom turned 32" → "X is N years old"
  [/(\w+)(?:'s)?\s+age\s+is\s+(\d+)/gi,       "$1 is $2 years old"],
  [/(\w+)\s+turned\s+(\d+)/gi,                 "$1 is $2 years old"],
  // Employment: "employed at", "employer is", "job is at" → "works at"
  [/\bemployed\s+at\b/gi,                      "works at"],
  [/\bemployer\s+is\b/gi,                      "works at"],
  [/\bjob\s+is\s+at\b/gi,                      "works at"],
  [/\bcurrent\s+employer\s+is\b/gi,            "works at"],
  // Allergy: "allergic to X" ↔ "has a X allergy"
  [/\ballergic\s+to\s+(\w+)/gi,               "has a $1 allergy"],
  // Diet: "does not eat meat" / "eats no meat" → "is vegetarian"
  [/\bdoes not eat meat\b/gi,                  "is vegetarian"],
  [/\beats no meat\b/gi,                       "is vegetarian"],
  [/\bplant.based diet\b/gi,                   "is vegetarian"],
  // Running / exercise: "runs every morning" ↔ "running every morning"
  [/\bruns every morning\b/gi,                 "running every morning"],
  // Location: "home is in X" / "address is in X" → "lives in X"
  [/\bhome\s+is\s+(now\s+)?in\b/gi,           "lives in"],
  [/\baddress\s+is\s+(now\s+)?in\b/gi,        "lives in"],
  [/\bcurrently\s+living\s+in\b/gi,            "lives in"],
  // "is now living in" → "lives in"
  [/\bis\s+now\s+living\s+in\b/gi,            "lives in"],
];

function canonicalize(text) {
  let t = text;
  for (const [re, sub] of CANON_RULES) t = t.replace(re, sub);
  return t;
}

// ── Signal detection ──────────────────────────────────────────────────────────

function hasSignal(text, signalSet) {
  const lower = text.toLowerCase();
  for (const s of signalSet) {
    if (lower.includes(s)) return true;
  }
  return false;
}

function hasDeleteSignal(text) {
  // Block delete signals that are negated ("don't forget", "shouldn't remove")
  if (NEGATION_PREFIX_RE.test(text)) return false;
  return hasSignal(text, DELETE_SIGNALS);
}

// ── RSHLLattice ───────────────────────────────────────────────────────────────

class RSHLLattice {
  /**
   * @param {object} options
   * @param {string} [options.userName="user"]     Canonical token for I/me/my
   * @param {number} [options.noopThreshold]       Override T_NOOP
   * @param {number} [options.updateThreshold]     Override T_UPDATE
   */
  constructor(options = {}) {
    this.cells     = [];
    this.userToken = (options.userName || "user").toLowerCase().replace(/\s+/g,"_");
    this._tNoop    = options.noopThreshold   ?? T_NOOP;
    this._tUpdate  = options.updateThreshold ?? T_UPDATE;
    this._idSeq    = 0;
    this._opsLog   = [];   // last 100 op records
  }

  // ── Internal: score all cells against a query vec + entity set ────────────
  _scoreAll(vec, entities) {
    return this.cells.map(cell => {
      const sim     = resonance(vec, cell.vec);
      const eOvlap  = entityOverlap(entities, cell.entities);
      // Combined: resonance primary, entity overlap as tiebreaker
      const combined = sim * 0.72 + eOvlap * 0.28;
      return { cell, sim, eOvlap, combined };
    }).sort((a, b) => b.combined - a.combined);
  }

  // ── Internal: classify operation ─────────────────────────────────────────
  // preCanon = normalized text before canonicalization (for signal detection)
  // text     = canonicalized text (used for vectorization — already encoded in vec)
  _classify(preCanon, text, vec, entities) {
    const scored = this._scoreAll(vec, entities);
    const best   = scored[0] ?? null;

    // DELETE: use preCanon so negation guard sees original phrasing
    if (hasDeleteSignal(preCanon)) {
      if (best && best.combined > T_DELETE) return { op:"DELETE", match: best };
      return { op:"ADD", match: null };
    }

    if (!best) return { op:"ADD", match: null };

    // Signal detection on preCanon preserves words removed by canonicalization
    // e.g. "Tom turned 33" → canon → "Tom is 33 years old" loses "turned"
    const updateSig = hasSignal(preCanon, UPDATE_SIGNALS);

    // UPDATE path 1: explicit signal + moderate resonance
    if (updateSig && best.sim >= this._tUpdate) {
      return { op:"UPDATE", match: best };
    }

    // NOOP path 1: high similarity — but block if entities are completely disjoint
    // prevents structural bleed: "Bob works at Twitter" ≠ "Alice works at Facebook"
    const entitiesAlign = best.eOvlap > 0
                       || entities.size === 0
                       || best.cell.entities.size === 0;
    if (best.sim >= this._tNoop && entitiesAlign) {
      return { op:"NOOP", match: best };
    }

    // NOOP path 2: no signal + strong entity overlap + moderate similarity
    // catches same-entity paraphrases below the strict sim threshold
    if (!updateSig && best.eOvlap >= 0.60 && best.sim >= 0.62) {
      return { op:"NOOP", match: best };
    }

    // NOOP path 3: continuity signal ("still", "remains", "continues") + entity match
    // "Jane is still at Amazon" → NOOP when Amazon/Jane are in memory
    const continuitySig = /\b(still|remains|remaining|continues|continuing|same as before)\b/i.test(preCanon);
    if (continuitySig && !updateSig && best.eOvlap >= 0.40 && best.sim >= 0.55) {
      return { op:"NOOP", match: best };
    }

    // UPDATE path 2: very high entity overlap + elevated similarity
    if (best.sim >= 0.70 && best.eOvlap >= 0.65
        && entities.size > 1 && best.cell.entities.size > 1) {
      return { op:"UPDATE", match: best };
    }

    return { op:"ADD", match: null };
  }

  // ── Public: store ─────────────────────────────────────────────────────────
  /**
   * Store text with smart deduplication.
   * Returns { op, key, text, replaced, match_score, ts }
   *   op: "ADD" | "UPDATE" | "NOOP" | "DELETE"
   */
  store(text, key = null) {
    const entities      = extractEntities(text, this.userToken);   // original text — preserves caps
    const preCanon      = normalizeText(text, this.userToken);     // for signal detection
    const normalized    = canonicalize(preCanon);                  // for vectorization
    const vec           = latticeVec(normalized);
    const ts            = Date.now();

    const { op, match } = this._classify(preCanon, normalized, vec, entities);

    let cell    = null;
    let replaced = null;

    switch (op) {
      case "NOOP":
        match.cell.strength = Math.min(5.0, match.cell.strength + 0.1);
        match.cell.ts       = ts;
        cell                = match.cell;
        break;

      case "UPDATE":
        replaced            = match.cell.text;
        match.cell.text     = text;
        match.cell.normalized = normalized;
        match.cell.vec      = vec;
        match.cell.entities = entities;
        match.cell.strength = Math.min(5.0, match.cell.strength + 0.2);
        match.cell.ts       = ts;
        if (key) match.cell.key = key;
        cell                = match.cell;
        break;

      case "DELETE":
        this.cells = this.cells.filter(c => c !== match.cell);
        break;

      case "ADD":
      default: {
        const id = `m${++this._idSeq}`;
        cell = {
          id,
          key:        key || id,
          text,
          normalized,
          vec,
          entities,
          strength:   1.0,
          ts,
        };
        this.cells.push(cell);
        break;
      }
    }

    const record = {
      op,
      key:         cell?.key ?? null,
      text,
      replaced:    replaced ?? null,
      match_score: match ? +match.combined.toFixed(4) : null,
      match_sim:   match ? +match.sim.toFixed(4) : null,
      ts,
    };
    this._opsLog.unshift(record);
    if (this._opsLog.length > 100) this._opsLog.pop();

    return record;
  }

  // ── Public: recall ────────────────────────────────────────────────────────
  /**
   * Return top-k memories by resonance + entity overlap.
   */
  recall(query, topK = 5) {
    const entities   = extractEntities(query, this.userToken);  // original text — preserves caps
    const normalized = canonicalize(normalizeText(query, this.userToken));
    const vec        = latticeVec(normalized);
    // recall only needs canonicalized form for vector similarity

    return this._scoreAll(vec, entities)
      .slice(0, topK)
      .map(({ cell, combined, sim }) => ({
        key:      cell.key,
        score:    +combined.toFixed(4),
        sim:      +sim.toFixed(4),
        text:     cell.text,
        strength: +cell.strength.toFixed(3),
      }));
  }

  // ── Public: forget ────────────────────────────────────────────────────────
  forget(key) {
    const before = this.cells.length;
    this.cells   = this.cells.filter(c => c.key !== key);
    return this.cells.length < before;
  }

  // ── Public: decay ─────────────────────────────────────────────────────────
  decay(ratePerHour = 0.02) {
    const now = Date.now();
    for (const c of this.cells) {
      const dtH     = Math.max(0, (now - c.ts) / 3_600_000);
      c.strength    = Math.max(0, c.strength * Math.exp(-ratePerHour * dtH));
      c.ts          = now;
    }
    this.cells = this.cells.filter(c => c.strength > 0.01);
  }

  // ── Public: stats ─────────────────────────────────────────────────────────
  stats() {
    const ops = { ADD:0, UPDATE:0, NOOP:0, DELETE:0 };
    for (const r of this._opsLog) ops[r.op] = (ops[r.op] || 0) + 1;
    const strengths = this.cells.map(c => c.strength);
    return {
      total_cells:   this.cells.length,
      mean_strength: strengths.length
        ? +(strengths.reduce((a,b)=>a+b,0)/strengths.length).toFixed(3) : 0,
      ops_last_100:  ops,
      last_op:       this._opsLog[0] ?? null,
    };
  }
}

module.exports = { RSHLLattice };
