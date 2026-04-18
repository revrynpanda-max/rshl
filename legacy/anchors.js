"use strict";

const { textVec } = require('./rshl-core');

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