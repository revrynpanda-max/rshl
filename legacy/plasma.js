"use strict";

const universe = require('./universe');

class Plasma {
    constructor(shouldClear = false) {
        if (shouldClear) universe.clear();
    }

    get cells() {
        return universe.getCells();
    }

    store(text, region, meta) {
        return universe.store(text, region, meta);
    }

    query(text, topK, options) {
        return universe.query(text, topK, options);
    }

    queryRegion(text, region, topK, options) {
        return universe.queryRegion(text, region, topK, options);
    }

    searchByCleanVector(vec, topK) {
        return universe.searchByCleanVector(vec, topK);
    }

    reinforceCell(id, delta, metaPatch) {
        return universe.reinforceCell(id, delta, metaPatch);
    }

    rankReplayCandidates(limit) {
        return universe.rankReplayCandidates(limit);
    }

    getCell(id) {
        return universe.getCell(id);
    }

    clear() {
        universe.clear();
    }
}

module.exports = { Plasma };