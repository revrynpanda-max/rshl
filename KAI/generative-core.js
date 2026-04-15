"use strict";

const universe = require('./universe');
const { bind } = require('./anchors');
const { textVec } = require('./rshl-core');

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