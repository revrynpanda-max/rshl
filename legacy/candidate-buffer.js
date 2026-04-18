"use strict";

/**
 * candidate-buffer.js — Dream Candidate Accumulation Layer
 *
 * Biology analog: Pre-synaptic holding zone before long-term potentiation.
 * A pattern must recur repeatedly with stable field quality before it earns
 * promotion into durable memory. This is the buffer between dream insight
 * and belief formation.
 *
 * Each candidate tracks:
 *   - seenCount       : how many dream cycles generated this insight
 *   - bestPhi_g       : best integrated goal-aligned emergence seen
 *   - bestC           : best commit readiness seen
 *   - bestConfidence  : best cleanup confidence seen
 *   - contradictionHistory : rolling contradiction values (stability check)
 *   - phiHistory      : rolling phi_g values (stability check)
 *   - sourceLinks     : which concept pairs generated this insight
 *   - nonSourceCount  : how many times insight was NOT just echoing a source
 *   - status          : 'candidate' | 'promoted' | 'rejected'
 */

const STATUS = {
    CANDIDATE: 'candidate',
    PROMOTED:  'promoted',
    REJECTED:  'rejected',
};

function _clamp01(n) {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

function _normalizeKey(text) {
    return String(text || '').trim().toLowerCase();
}

// _candidates: Map<normalizedText, candidateEntry>
const _candidates = new Map();

/**
 * observe(dreamResult)
 * Called after each consolidate() run. Feeds the dream output into the buffer.
 * Returns the updated/created candidate entry, or null if the result is ineligible.
 */
function observe(dreamResult) {
    if (!dreamResult) return null;
    if (dreamResult.duplicateEcho) return null;

    const text = dreamResult.insight;
    if (!text || text === 'no strong concept found') return null;

    const key = _normalizeKey(text);
    if (!key) return null;

    const now         = Date.now();
    const phi_g       = _clamp01(dreamResult.field ? dreamResult.field.phi_g  : 0);
    const C           = _clamp01(dreamResult.field ? dreamResult.field.C      : 0);
    const chi         = _clamp01(dreamResult.field ? dreamResult.field.chi    : 1);
    const confidence  = _clamp01(dreamResult.confidence || 0);
    const nonSource   = !!dreamResult.usedNonSourceInsight;

    const sourceLink = {
        conceptA: dreamResult.conceptA  || '',
        conceptB: dreamResult.conceptB  || '',
        resonance: _clamp01(dreamResult.resonance || 0),
        phi_g,
        C,
        ts: now,
    };

    if (_candidates.has(key)) {
        const entry = _candidates.get(key);
        entry.seenCount  += 1;
        entry.lastSeen    = now;

        if (phi_g      > entry.bestPhi_g)      entry.bestPhi_g      = phi_g;
        if (C          > entry.bestC)           entry.bestC          = C;
        if (confidence > entry.bestConfidence)  entry.bestConfidence = confidence;
        if (nonSource) entry.nonSourceCount += 1;

        entry.contradictionHistory.push(chi);
        if (entry.contradictionHistory.length > 20) entry.contradictionHistory.shift();

        entry.phiHistory.push(phi_g);
        if (entry.phiHistory.length > 20) entry.phiHistory.shift();

        entry.sourceLinks.push(sourceLink);
        if (entry.sourceLinks.length > 10) entry.sourceLinks.shift();

        return entry;
    }

    const entry = {
        key,
        text,
        seenCount:             1,
        bestPhi_g:             phi_g,
        bestC:                 C,
        bestConfidence:        confidence,
        contradictionHistory:  [chi],
        phiHistory:            [phi_g],
        sourceLinks:           [sourceLink],
        nonSourceCount:        nonSource ? 1 : 0,
        status:                STATUS.CANDIDATE,
        firstSeen:             now,
        lastSeen:              now,
        promotedAt:            null,
        rejectedReason:        null,
    };

    _candidates.set(key, entry);
    return entry;
}

/** Return all entries (any status). */
function getAll() {
    return Array.from(_candidates.values());
}

/** Return active candidates filtered by minimum thresholds. */
function getCandidates(minSeenCount, minC, minPhi_g) {
    return getAll().filter(c =>
        c.status      === STATUS.CANDIDATE &&
        c.seenCount   >= (minSeenCount || 1) &&
        c.bestC       >= (minC         || 0) &&
        c.bestPhi_g   >= (minPhi_g     || 0)
    );
}

/** Mark a candidate as promoted. */
function markPromoted(key) {
    const entry = _candidates.get(key);
    if (!entry) return;
    entry.status     = STATUS.PROMOTED;
    entry.promotedAt = Date.now();
}

/** Mark a candidate as rejected with an optional reason string. */
function markRejected(key, reason) {
    const entry = _candidates.get(key);
    if (!entry) return;
    entry.status         = STATUS.REJECTED;
    entry.rejectedReason = reason || 'threshold-fail';
}

/** Remove promoted/rejected entries older than maxAgeDays to prevent unbounded growth. */
function gc(maxAgeDays) {
    const cutoff = Date.now() - (maxAgeDays || 30) * 86400000;
    for (const [key, entry] of _candidates) {
        if (entry.status !== STATUS.CANDIDATE && entry.lastSeen < cutoff) {
            _candidates.delete(key);
        }
    }
}

function clear() {
    _candidates.clear();
}

function size() {
    return _candidates.size;
}

module.exports = {
    STATUS,
    observe,
    getAll,
    getCandidates,
    markPromoted,
    markRejected,
    gc,
    clear,
    size,
};
