"use strict";
/**
 * RSHL Lattice - backward-compatible wrapper + dream consolidation
 */

const fs = require("fs");
const universe = require("./universe");
const { resonance } = require("./rshl-core");
const { unbind, threshold, cleanup } = require("./generative-core");

/**
 * Consolidate: geometric dreaming / subconscious synthesis
 */
function consolidate(plasma) {
    if (!plasma.cells || plasma.cells.length < 2) return null;

    const idxA = Math.floor(Math.random() * plasma.cells.length);
    let idxB = Math.floor(Math.random() * plasma.cells.length);
    while (idxA === idxB) {
        idxB = Math.floor(Math.random() * plasma.cells.length);
    }

    const cellA = plasma.cells[idxA];
    const cellB = plasma.cells[idxB];

    const cleanA = unbind(cellA.vec, cellA.region);
    const cleanB = unbind(cellB.vec, cellB.region);

    const overlap = resonance(cleanA, cleanB);

    if (overlap < 0.1 || overlap > 0.9) return null;

    const map = new Map(cleanA);
    for (const [idx, val] of cleanB) {
        map.set(idx, (map.get(idx) || 0) + val);
    }

    const synthetic = threshold(Array.from(map.entries()));
    const result = cleanup(synthetic);

    return {
        conceptA: cellA.text,
        conceptB: cellB.text,
        resonance: overlap,
        insight: result.text,
        vector: synthetic
    };
}

/**
 * Backward-compatible class wrapper so old tests still work
 */
class RSHLLattice {
    constructor(opts = {}) {
        this.userName = opts.userName || "User";
        this.records = [];
        universe.clear();
    }

    store(text, region = "memory", meta = {}) {
        this.records.push({
            text: String(text),
            region: region || "memory",
            meta: meta || {}
        });
        universe.store(text, region || "memory", meta || {});
    }

    recall(query, topK = 5) {
        return universe.query(query, topK).map(hit => ({
            ...hit,
            sim: hit.score
        }));
    }

    save(filepath) {
        const payload = {
            userName: this.userName,
            records: this.records
        };
        fs.writeFileSync(filepath, JSON.stringify(payload, null, 2), "utf8");
    }

    load(filepath) {
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
    RSHLLattice
};