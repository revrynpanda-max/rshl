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

const { textVec, resonance, debugTokens } = require('./rshl-core');
const { bind, REGIONS, resolveRegion }    = require('./anchors');
const path = require('path');

// ── Native engine (optional) ──────────────────────────────────────────────────
// Compiled AVX2+POPCNT addon for batch resonance scans.
// Loaded once at startup; falls back to pure JS if not built.
let _native = null;
try {
    _native = require(path.join(__dirname, 'build', 'Release', 'rshl_native.node'));
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
