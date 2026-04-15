"use strict";

const { textVec, resonance, debugTokens } = require('./rshl-core');
const { bind, REGIONS, resolveRegion } = require('./anchors');

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
        id: cell.id,
        text: cell.text,
        region: cell.region,
        vec: cell.vec,
        raw: cell.raw,
        size: cell.size,
        tokens: cell.tokens,
        strength: cell.strength,
        accessCount: cell.accessCount,
        dreamCount: cell.dreamCount,
        lastAccessed: cell.lastAccessed,
        lastReplayed: cell.lastReplayed,
        ts: cell.ts,
        meta: { ...cell.meta },
    };
}

function store(text, region, meta) {
    const r = resolveRegion(region);
    const raw = textVec(text);
    const vec = bind(raw, r);
    const now = Date.now();
    const safeMeta = { ...(meta || {}) };
    const initialStrength = typeof safeMeta.strength === 'number' ? safeMeta.strength : 1;

    const cell = {
        id: ++_id,
        text: String(text),
        region: r,
        raw,
        vec,
        size: vec.length,
        tokens: _tokenSet(text),
        strength: Math.max(0.1, Math.min(MAX_STRENGTH, initialStrength)),
        accessCount: 0,
        dreamCount: 0,
        lastAccessed: 0,
        lastReplayed: 0,
        ts: now,
        meta: {
            source: safeMeta.source || 'manual',
            unresolved: !!safeMeta.unresolved,
            contradiction: clamp01(safeMeta.contradiction || 0),
            novelty: clamp01(safeMeta.novelty || 0),
            ...safeMeta,
        },
    };

    _cells.push(cell);
    return cell.id;
}

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
    const raw = textVec(text);
    const qTokens = _tokenSet(text);
    const k = topK || 5;
    const results = [];

    for (const region of REGIONS) {
        const q = bind(raw, region);
        for (const cell of _cells) {
            if (cell.region !== region) continue;
            const score = resonance(q, cell.vec);
            const overlap = _tokenOverlap(qTokens, cell.tokens);
            results.push({
                id: cell.id,
                text: cell.text,
                region: cell.region,
                score,
                overlap,
                strength: cell.strength,
                meta: { ...cell.meta },
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
    const r = resolveRegion(region);
    const raw = textVec(text);
    const q = bind(raw, r);
    const qTokens = _tokenSet(text);
    const k = topK || 5;

    const results = _cells
        .filter(cell => cell.region === r)
        .map(cell => ({
            id: cell.id,
            text: cell.text,
            region: cell.region,
            score: resonance(q, cell.vec),
            overlap: _tokenOverlap(qTokens, cell.tokens),
            strength: cell.strength,
            meta: { ...cell.meta },
        }));

    const ranked = _rankResults(results, k);
    if (!options || options.touch !== false) {
        _touch(ranked.map(r => r.id));
    }
    return ranked;
}

function searchByCleanVector(vec, topK) {
    const k = topK || 5;
    const results = _cells.map(cell => ({
        id: cell.id,
        text: cell.text,
        region: cell.region,
        score: resonance(vec, cell.raw),
        overlap: 0,
        strength: cell.strength,
        meta: { ...cell.meta },
    }));

    results.sort((a, b) => {
        if (Math.abs(a.score - b.score) < 0.05 && a.strength !== b.strength) {
            return b.strength - a.strength;
        }
        return b.score - a.score;
    });

    return results.slice(0, k);
}

function reinforceCell(id, delta, metaPatch) {
    const cell = _cells.find(c => c.id === id);
    if (!cell) return null;
    const d = typeof delta === 'number' ? delta : 0.15;
    cell.strength = Math.max(0.1, Math.min(MAX_STRENGTH, cell.strength + d));
    if (metaPatch && typeof metaPatch === 'object') {
        cell.meta = { ...cell.meta, ...metaPatch };
    }
    return _copyCell(cell);
}

function markReplayed(id) {
    const cell = _cells.find(c => c.id === id);
    if (!cell) return null;
    cell.dreamCount += 1;
    cell.lastReplayed = Date.now();
    return _copyCell(cell);
}

function rankReplayCandidates(limit) {
    const now = Date.now();
    const out = _cells.map(cell => {
        const ageDays = Math.max(0, (now - cell.ts) / 86400000);
        const sinceReplayDays = cell.lastReplayed ? Math.max(0, (now - cell.lastReplayed) / 86400000) : ageDays + 1;
        const strengthNorm = clamp01(cell.strength / MAX_STRENGTH);
        const unresolved = cell.meta.unresolved ? 1 : 0;
        const contradiction = clamp01(cell.meta.contradiction || 0);
        const novelty = clamp01(cell.meta.novelty || 0);
        const stale = clamp01(sinceReplayDays / 7);
        const underIntegrated = 1 - strengthNorm;

        const replayPriority = clamp01(
            ((underIntegrated + contradiction + novelty + stale) / 4) + (unresolved * 0.25)
        );

        return {
            id: cell.id,
            text: cell.text,
            region: cell.region,
            strength: cell.strength,
            replayPriority,
            unresolved,
            contradiction,
            novelty,
            ageDays,
            dreamCount: cell.dreamCount,
            meta: { ...cell.meta },
        };
    });

    out.sort((a, b) => b.replayPriority - a.replayPriority);
    return out.slice(0, limit || 12);
}

function clear() {
    _cells.length = 0;
    _id = 0;
}

module.exports = {
    store,
    query,
    queryRegion,
    searchByCleanVector,
    reinforceCell,
    markReplayed,
    rankReplayCandidates,
    getCells,
    getCell,
    count,
    clear,
};