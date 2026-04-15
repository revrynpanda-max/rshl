"use strict";

const { textVec, resonance, debugTokens } = require('./rshl-core');
const { bind, REGIONS } = require('./anchors');

// ── One unified RSHL space ─────────────────────────────────────────────────────
// No classes. No routing. Just a flat array and two functions.
// Data lives in one single space. Regions are holographic phase masks.
// Queries scan all 4 fluids and the correct region wins naturally.

const _cells = [];
let _id = 0;

// Pre-compute normalized token set for each stored item (for tie-breaking)
function _tokenSet(text) {
    return new Set(debugTokens(text).map(t => t.tok).filter(t => !t.startsWith('#')));
}

// store(text, region, meta?) — phase-bind the vector into the region's fluid
function store(text, region, meta) {
    const r = String(region).toLowerCase();
    const raw = textVec(text);
    const vec = bind(raw, r);

    _cells.push({
        id: ++_id,
        text,
        region: r,
        vec,
        size: vec.length,
        tokens: _tokenSet(text),
        meta: meta || {},
        ts: Date.now(),
    });

    return _id;
}

// Count shared normalized tokens between a token set and a text
function _tokenOverlap(queryTokens, cellTokens) {
    let count = 0;
    for (const t of queryTokens) { if (cellTokens.has(t)) count++; }
    return count;
}

// query(text, topK?) — scan all 4 fluids, best match wins naturally
// Uses token overlap as tie-breaker to defeat hash collisions.
function query(text, topK) {
    const raw = textVec(text);
    const qTokens = _tokenSet(text);
    const k = topK || 5;
    const results = [];

    for (const region of REGIONS) {
        const q = bind(raw, region);
        for (const cell of _cells) {
            // Only score items living in the fluid we're scanning
            if (cell.region !== region) continue;
            const score = resonance(q, cell.vec);
            const overlap = _tokenOverlap(qTokens, cell.tokens);
            results.push({
                id:      cell.id,
                text:    cell.text,
                region:  cell.region,
                score,
                overlap,
                meta:    cell.meta,
            });
        }
    }

    // Sort by: resonance score first, token overlap as tie-breaker
    results.sort((a, b) => {
        // If scores are within 0.15 of each other, prefer more token overlap
        if (Math.abs(a.score - b.score) < 0.12 && a.overlap !== b.overlap) {
            return b.overlap - a.overlap;
        }
        return b.score - a.score;
    });

    return results.slice(0, k);
}

// queryRegion(text, region, topK?) — explicit region override when you know it
function queryRegion(text, region, topK) {
    const raw = textVec(text);
    const q = bind(raw, region);
    const k = topK || 5;

    return _cells
        .map(cell => ({
            id:     cell.id,
            text:   cell.text,
            region: cell.region,
            score:  resonance(q, cell.vec),
            meta:   cell.meta,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
}

// clear — reset the space
function clear() {
    _cells.length = 0;
    _id = 0;
}

module.exports = { store, query, queryRegion, clear };