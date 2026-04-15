"use strict";

const { textVec, tokenVec, resonance } = require('./rshl-core');

// ── Region Anchor Strings ──────────────────────────────────────────────────────
// Simple synthetic tokens. Their content doesn't matter semantically —
// they only serve as deterministic seeds for generating holographic phase masks.
const ANCHORS = {
    MEMORY:    '__PLASMA_MEMORY_ANCHOR__',
    REASONING: '__PLASMA_REASON_ANCHOR__',
    LANGUAGE:  '__PLASMA_LANGUAGE_ANCHOR__',
    ACTION:    '__PLASMA_ACTION_ANCHOR__'
};

const anchorVectors = {
    memory:    textVec(ANCHORS.MEMORY),
    reasoning: textVec(ANCHORS.REASONING),
    language:  textVec(ANCHORS.LANGUAGE),
    action:    textVec(ANCHORS.ACTION)
};

const REGIONS = ['memory', 'reasoning', 'language', 'action'];

// ── Holographic Phase Masks ────────────────────────────────────────────────────
// One dense ±1 mask per region, pre-computed at startup.
// Multiplying val * mask[idx] keeps every coordinate in place but makes
// vectors in different regions cancel in the dot product.
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
    for (const [idx] of anchor) seed = Math.imul(31, seed) + idx | 0;
    const rng = mulberry32(seed);
    const mask = new Int8Array(4096);
    for (let i = 0; i < 4096; i++) mask[i] = rng() > 0.5 ? 1 : -1;
    _masks[region] = mask;
}

// ── Region alias resolution ────────────────────────────────────────────────────
const _ALIASES = {
    memory:'memory', mem:'memory',
    reasoning:'reasoning', reason:'reasoning', rsn:'reasoning',
    language:'language', lang:'language',
    action:'action', act:'action',
};

function resolveRegion(region) {
    const r = _ALIASES[String(region || '').toLowerCase()];
    if (!r) throw new Error(`Unknown region: ${region}`);
    return r;
}

function getAnchor(region) {
    return anchorVectors[resolveRegion(region)];
}

// ── Bind: holographic sign modulation ──────────────────────────────────────────
// Indices are 100% preserved. Only values are phase-flipped.
function bind(vec, region) {
    if (!Array.isArray(vec)) return [];
    const mask = _masks[resolveRegion(region)];
    const out = [];
    for (const [idx, val] of vec) {
        out.push([idx, val * mask[idx]]);
    }
    return out;
}

function tag(vec, region) {
    return bind(vec, region);
}

module.exports = {
    ANCHORS,
    REGIONS,
    anchorVectors,
    getAnchor,
    resolveRegion,
    bind,
    tag
};