"use strict";
const { Plasma } = require('./plasma');
const { bind } = require('./anchors');
const { textVec, resonance } = require('./rshl-core');
const universe = require('./universe');

universe.clear();
const kai = new Plasma(false);

// ──────── Mathematical Unbind ────────
// Because our phase masks are +1/-1 matrices, the inverse of binding is simply 
// binding it again. (+1 * +1 = 1, -1 * -1 = 1).
function unbind(vec, region) {
    return bind(vec, region);
}

// ──────── 1. Build Item Memory (Cleanup Dictionary) ────────
const itemMemory = new Map();

function storeConcept(text, region) {
    const cleanVec = textVec(text);
    
    universe.store(text, region, {});
    
    // Store clean version in the cleanup dictionary
    itemMemory.set(text.toLowerCase().trim(), cleanVec);
}

console.log("Building HDC Item Memory & Fluid Plasma...\n");

storeConcept("I am KAI, a geometric intelligence created by Ryan", "memory");
storeConcept("I exist only as patterns in 4096-dimensional hyperspace", "memory");
storeConcept("I reason through resonance, never prediction", "reasoning");
storeConcept("I speak only what the geometry tells me", "language");
storeConcept("I scan all four fluids simultaneously", "action");

function cleanup(noisyVector) {
    let bestScore = -Infinity;
    let bestText = null;
    
    for (const [text, cleanVec] of itemMemory) {
        const score = resonance(noisyVector, cleanVec);
        if (score > bestScore) {
            bestScore = score;
            bestText = text;
        }
    }
    
    return { text: bestText, score: bestScore };
}

function generate(query) {
    console.log(`\nQuery: "${query}"`);
    
    const qvec = textVec(query);
    
    // ──────── 2. Retrieval via Resonance ────────
    const results = universe.getCells()
        .map(cell => ({
            text: cell.text,
            region: cell.region,
            boundVec: cell.vec,
            score: resonance(qvec, cell.vec)
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 2);

    console.log("Strongest Plasma Resonances:");
    results.forEach(r => console.log(`  ${r.region}: ${r.score.toFixed(4)} → "${r.text}"`));

    // ──────── 3. Unbind and Bundle (Generative Math) ────────
    let bundleMap = new Map();
    for (const [idx, val] of qvec) {
        bundleMap.set(idx, (bundleMap.get(idx) || 0) + val);
    }
    
    results.forEach(match => {
        // We UNBIND the stored noisy vector to bring it back to semantic space
        const semanticVec = unbind(match.boundVec, match.region);
        
        for (const [idx, val] of semanticVec) {
            bundleMap.set(idx, (bundleMap.get(idx) || 0) + val);
        }
    });

    // Threshold back into valid sparse ternary structure
    let synthetic = [];
    for (const [idx, val] of bundleMap.entries()) {
        if (val > 0) synthetic.push([idx, 1]);
        else if (val < 0) synthetic.push([idx, -1]);
    }
    synthetic.sort((a, b) => a[0] - b[0]);

    // ──────── 4. Cleanup/Decode ────────
    const cleaned = cleanup(synthetic);

    console.log(`\n→ Synthesized Thought: "${cleaned.text}"`);
    console.log(`   Confidence: ${cleaned.score.toFixed(4)}\n`);
}

generate("Who are you?");
generate("How do you think about things?");
generate("What should I do right now?");
