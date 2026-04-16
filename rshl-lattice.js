"use strict";

const universe = require("./universe");
const { resonance } = require("./rshl-core");
const { bundleVectors, cleanup } = require("./generative-core");
const { computeFieldState, makeWinnerKey, clamp01 } = require("./field-state");

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

// ── Lattice Classification Helpers ──────────────────────────────────────────

// DELETE signal words — split into "pure delete" (commands) and "contextual" (might be false positives)
const PURE_DELETE_SIGNALS = [
    'forget that', 'remove the', 'delete the', 'erase the', 'scratch that',
    'disregard the', 'ignore that', 'cancel that', 'remove the fact',
    'forget about', 'never mind about', 'disregard',
];
const CONTEXTUAL_DELETE_WORDS = [
    'forget', 'remove', 'delete', 'erase', 'cancel', 'ignore', 'disregard',
    'scratch', 'never mind', 'undo',
];
// Words that look like delete signals but aren't
const DELETE_FALSE_POSITIVE_GUARDS = [
    'wants to remove', 'forgot his', 'forgot her', 'forgot my', 'forgot the',
    'never forgets', 'should not forget', 'not forget', "don't forget",
    'remove bugs', 'remove errors', 'no incorrect',
];

// UPDATE / change signal words
const CHANGE_SIGNALS = [
    'moved', 'relocated', 'changed', 'switched', 'left', 'joined',
    'got promoted', 'promoted', 'became', 'started', 'stopped',
    'no longer', 'now works', 'now lives', 'currently',
    'recently', 'new job', 'new home', 'delayed', 'turned',
    'bought', 'sold', 'upgraded', 'downgraded',
];

// First-person pronouns → normalize to generic entity marker
const FIRST_PERSON = ['i ', 'my ', 'me ', 'myself '];

/**
 * Extract entities (people names, first-person markers) from lowercase text.
 * Returns a Set of normalized entity tokens.
 */
function extractEntities(lower) {
    const ents = new Set();
    
    // Known common names — expand as needed
    const names = [
        'ryan', 'sarah', 'tom', 'alex', 'emily', 'john', 'jane',
        'alice', 'bob', 'carol', 'dave',
    ];
    for (const name of names) {
        if (lower.includes(name)) ents.add(name);
    }
    
    // First-person → "user" entity
    for (const fp of FIRST_PERSON) {
        if (lower.startsWith(fp) || lower.includes(' ' + fp.trim() + ' ')) {
            ents.add('user');
            break;
        }
    }
    
    // Topic entities (projects, things)
    const topics = ['alpha project', 'beta project', 'meeting', 'server', 'budget'];
    for (const t of topics) {
        if (lower.includes(t)) ents.add(t);
    }
    
    return ents;
}

/**
 * Check if two entity sets overlap (same person/subject).
 */
function entitiesOverlap(entsA, entsB) {
    if (entsA.size === 0 && entsB.size === 0) return true; // both generic
    for (const e of entsA) {
        if (entsB.has(e)) return true;
    }
    return false;
}

/**
 * Detect DELETE intent. Returns { pureDelete: bool } or null if no delete detected.
 */
function detectDelete(lower, rawVec, entities) {
    // Check false positive guards first
    for (const guard of DELETE_FALSE_POSITIVE_GUARDS) {
        if (lower.includes(guard)) return null;
    }
    
    // Check pure delete signals (strong commands)
    for (const signal of PURE_DELETE_SIGNALS) {
        if (lower.includes(signal)) {
            return { pureDelete: true };
        }
    }
    
    // Check contextual delete words (weaker)
    for (const word of CONTEXTUAL_DELETE_WORDS) {
        if (lower.includes(word)) {
            return { pureDelete: false };
        }
    }
    
    return null;
}

/**
 * Detect change/update signal words in text.
 */
function detectChangeSignal(lower) {
    for (const signal of CHANGE_SIGNALS) {
        if (lower.includes(signal)) return true;
    }
    return false;
}

/**
 * Compute topic word overlap between two lowercased strings.
 * Ignores stopwords, returns 0.0 - 1.0.
 */
function computeTopicOverlap(a, b) {
    const stops = new Set([
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'at', 'to',
        'of', 'for', 'and', 'or', 'but', 'not', 'with', 'has', 'had',
        'that', 'this', 'from', 'as', 'by', 'on', 'it', 'so',
    ]);
    
    const wordsA = a.split(/\s+/).filter(w => w.length > 1 && !stops.has(w));
    const wordsB = b.split(/\s+/).filter(w => w.length > 1 && !stops.has(w));
    
    if (wordsA.length === 0 || wordsB.length === 0) return 0;
    
    const setB = new Set(wordsB);
    const shared = wordsA.filter(w => setB.has(w)).length;
    return shared / Math.max(wordsA.length, wordsB.length);
}

class RSHLLattice {
    constructor(opts = {}) {
        this.userName = opts.userName || "User";
        this.records = [];
        universe.clear();
    }

    /**
     * Find the best matching cell that shares entities with the query.
     */
    _findBestEntityMatch(rawVec, entities, minSim) {
        // Get top matches from universe
        const { resonance } = require('./rshl-core');
        const cells = universe.allCells ? universe.allCells() : [];
        
        let best = null;
        for (const cell of cells) {
            if (!cell.raw) continue;
            const sim = clamp01(resonance(rawVec, cell.raw));
            if (sim < minSim) continue;
            
            const cellEntities = extractEntities(cell.text.toLowerCase());
            if (entitiesOverlap(entities, cellEntities)) {
                if (!best || sim > best.sim) {
                    best = { cell, sim };
                }
            }
        }
        return best;
    }

    store(text, region = "memory", meta = {}) {
        const { textVec } = require('./rshl-core');
        const rawVec = textVec(text);
        const lower = text.toLowerCase();

        // ── Step 1: Extract entities (proper nouns / first-person) ────────
        const entities = extractEntities(lower);

        // ── Step 2: Detect DELETE signals ─────────────────────────────────
        const deleteResult = detectDelete(lower, rawVec, entities);
        if (deleteResult) {
            // Delete signal detected — try to find a matching record to remove
            const bestMatch = this._findBestEntityMatch(rawVec, entities, 0.55);
            if (bestMatch) {
                universe.removeCell(bestMatch.cell.id);
                return { op: 'DELETE', match_score: bestMatch.sim, replaced: bestMatch.cell.text };
            }
            // Delete signal but nothing to delete — if it's purely a delete command, NOOP
            if (deleteResult.pureDelete) {
                return { op: 'NOOP', match_score: 0, replaced: null };
            }
            // Contains delete words but is really a statement (false positive) — fall through to ADD
        }

        // ── Step 3: Check for exact/near duplicates (NOOP) ───────────────
        const dup = universe.findSimilar(rawVec, 0.88);
        if (dup.found) {
            return { op: 'NOOP', match_score: dup.sim, replaced: null };
        }

        // ── Step 4: Entity-aware UPDATE check ────────────────────────────
        // Only UPDATE if the match shares the same entity AND has change signals
        const near = universe.findSimilar(rawVec, 0.62);
        if (near.found) {
            const nearEntities = extractEntities(near.cell.text.toLowerCase());
            const hasEntityOverlap = entitiesOverlap(entities, nearEntities);
            const hasChangeSignal = detectChangeSignal(lower);
            const topicOverlap = computeTopicOverlap(lower, near.cell.text.toLowerCase());

            // Case A: Very high similarity (0.78+) with same entity → UPDATE
            if (near.sim >= 0.78 && hasEntityOverlap) {
                if (hasChangeSignal) {
                    const replaced = near.cell.text;
                    universe.removeCell(near.cell.id);
                    this.records.push({ text: String(text), region: region || "memory", meta: meta || {} });
                    universe.store(text, region || "memory", meta || {});
                    return { op: 'UPDATE', match_score: near.sim, replaced };
                }
                // High sim + same entity but no change signal → NOOP (paraphrase)
                return { op: 'NOOP', match_score: near.sim, replaced: null };
            }

            // Case B: Medium similarity (0.62-0.78) with same entity + change signal → UPDATE
            if (hasEntityOverlap && hasChangeSignal && topicOverlap >= 0.25) {
                const replaced = near.cell.text;
                universe.removeCell(near.cell.id);
                this.records.push({ text: String(text), region: region || "memory", meta: meta || {} });
                universe.store(text, region || "memory", meta || {});
                return { op: 'UPDATE', match_score: near.sim, replaced };
            }

            // Case C: Similar but different entity → ADD (isolation)
            if (!hasEntityOverlap) {
                // Falls through to ADD
            }
        }

        // ── Step 5: Default → ADD ────────────────────────────────────────
        this.records.push({
            text:   String(text),
            region: region || "memory",
            meta:   meta || {},
        });
        universe.store(text, region || "memory", meta || {});
        return { op: 'ADD', match_score: near && near.found ? near.sim : 0, replaced: null };
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