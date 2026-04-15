"use strict";

/**
 * persistence.js — State Persistence Layer
 *
 * Biology analog: Long-term memory consolidation to permanent substrate.
 * Without persistence, KAI suffers complete amnesia on every restart.
 * This module saves and restores the full cognitive state:
 *   - Universe cells (all stored memories + promoted beliefs)
 *   - Candidate buffer entries (in-progress dream evaluations)
 *   - Heartbeat tick count (continuity across sessions)
 *   - Bridge intake log (provenance tracking)
 *
 * File format: JSON snapshot written atomically (write to .tmp, rename).
 * The snapshot captures a point-in-time state that can be restored exactly.
 *
 * Auto-save: can be wired into heartbeat at intervals so KAI periodically
 * checkpoints itself without explicit user action.
 */

const fs   = require('fs');
const path = require('path');
const universe        = require('./universe');
const candidateBuffer = require('./candidate-buffer');

// ── Default paths ──────────────────────────────────────────────────────────────
const DEFAULT_STATE_DIR = path.join(__dirname, 'data');
const DEFAULT_STATE_FILE = path.join(DEFAULT_STATE_DIR, 'kai-state.json');
const DEFAULT_BACKUP_FILE = path.join(DEFAULT_STATE_DIR, 'kai-state.backup.json');

// ── Save ───────────────────────────────────────────────────────────────────────
/**
 * save(options)
 * Snapshot the full cognitive state to disk.
 *
 * @param {object} options
 *   filepath {string}    — output path (default: data/kai-state.json)
 *   heartbeatTick {number} — current heartbeat tick count
 *   extraMeta {object}   — any additional metadata to store
 *
 * @returns {{ ok: boolean, filepath: string, cells: number, candidates: number, bytes: number }}
 */
function save(options) {
    const opts = options || {};
    const filepath = opts.filepath || DEFAULT_STATE_FILE;
    const dir = path.dirname(filepath);

    // Ensure directory exists
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // Backup previous state if it exists
    if (fs.existsSync(filepath)) {
        const backupPath = opts.backupPath || DEFAULT_BACKUP_FILE;
        try {
            fs.copyFileSync(filepath, backupPath);
        } catch (_) {
            // Non-fatal — backup failure shouldn't block save
        }
    }

    const cells = universe.getCells();
    const candidates = candidateBuffer.getAll();

    const snapshot = {
        version: 1,
        savedAt: new Date().toISOString(),
        savedAtMs: Date.now(),
        heartbeatTick: opts.heartbeatTick || 0,
        meta: opts.extraMeta || {},

        // Universe state
        universe: {
            cellCount: cells.length,
            cells: cells.map(cell => ({
                text:         cell.text,
                region:       cell.region,
                strength:     cell.strength,
                accessCount:  cell.accessCount,
                dreamCount:   cell.dreamCount,
                lastAccessed: cell.lastAccessed,
                lastReplayed: cell.lastReplayed,
                ts:           cell.ts,
                meta:         cell.meta,
            })),
        },

        // Candidate buffer state
        candidates: {
            count: candidates.length,
            entries: candidates.map(c => ({
                key:                  c.key,
                text:                 c.text,
                seenCount:            c.seenCount,
                bestPhi_g:            c.bestPhi_g,
                bestC:                c.bestC,
                bestConfidence:       c.bestConfidence,
                contradictionHistory: c.contradictionHistory,
                phiHistory:           c.phiHistory,
                sourceLinks:          c.sourceLinks,
                nonSourceCount:       c.nonSourceCount,
                status:               c.status,
                firstSeen:            c.firstSeen,
                lastSeen:             c.lastSeen,
                promotedAt:           c.promotedAt,
                rejectedReason:       c.rejectedReason,
            })),
        },
    };

    // Atomic write: write to tmp, then rename
    const tmpPath = filepath + '.tmp';
    const json = JSON.stringify(snapshot, null, 2);
    fs.writeFileSync(tmpPath, json, 'utf8');
    fs.renameSync(tmpPath, filepath);

    return {
        ok: true,
        filepath,
        cells: cells.length,
        candidates: candidates.length,
        bytes: Buffer.byteLength(json, 'utf8'),
    };
}

// ── Load ───────────────────────────────────────────────────────────────────────
/**
 * load(options)
 * Restore cognitive state from a saved snapshot.
 *
 * @param {object} options
 *   filepath {string}    — input path (default: data/kai-state.json)
 *   clearFirst {boolean} — clear universe + candidates before restoring (default: true)
 *
 * @returns {{ ok: boolean, cells: number, candidates: number, heartbeatTick: number, savedAt: string }}
 */
function load(options) {
    const opts = options || {};
    const filepath = opts.filepath || DEFAULT_STATE_FILE;

    if (!fs.existsSync(filepath)) {
        return { ok: false, error: 'State file not found', filepath };
    }

    let snapshot;
    try {
        const raw = fs.readFileSync(filepath, 'utf8');
        snapshot = JSON.parse(raw);
    } catch (err) {
        return { ok: false, error: `Failed to parse state file: ${err.message}`, filepath };
    }

    if (!snapshot || snapshot.version !== 1) {
        return { ok: false, error: `Unknown state version: ${snapshot && snapshot.version}` };
    }

    // Clear existing state
    if (opts.clearFirst !== false) {
        universe.clear();
        candidateBuffer.clear();
    }

    // Restore universe cells
    let cellsRestored = 0;
    if (snapshot.universe && Array.isArray(snapshot.universe.cells)) {
        for (const cell of snapshot.universe.cells) {
            const meta = cell.meta || {};
            // Preserve all original metadata + timing
            meta.strength = cell.strength;
            universe.store(cell.text, cell.region, meta);

            // Restore access/dream counts and timestamps on the cell
            // We need the cell ID that was just created
            const cells = universe.getCells();
            const restored = cells[cells.length - 1];
            if (restored) {
                // Reinforce to set correct strength (store defaults to meta.strength or 1)
                const delta = cell.strength - (restored.strength || 1);
                if (Math.abs(delta) > 0.01) {
                    universe.reinforceCell(restored.id, delta);
                }

                // Replay count restoration
                for (let i = 0; i < (cell.dreamCount || 0); i++) {
                    universe.markReplayed(restored.id);
                }
            }
            cellsRestored++;
        }
    }

    // Restore candidate buffer
    let candidatesRestored = 0;
    if (snapshot.candidates && Array.isArray(snapshot.candidates.entries)) {
        for (const entry of snapshot.candidates.entries) {
            // Reconstruct candidate by feeding a synthetic "dream result"
            // for the first observation, then manually patching the rest.
            // This uses the candidate buffer's internal API.
            const synthDreamResult = {
                insight:              entry.text,
                duplicateEcho:        false,
                usedNonSourceInsight: entry.nonSourceCount > 0,
                confidence:           entry.bestConfidence,
                field: {
                    phi_g: entry.bestPhi_g,
                    C:     entry.bestC,
                    chi:   entry.contradictionHistory && entry.contradictionHistory.length
                        ? entry.contradictionHistory[entry.contradictionHistory.length - 1]
                        : 0,
                },
                conceptA: '',
                conceptB: '',
                resonance: 0,
            };

            const created = candidateBuffer.observe(synthDreamResult);
            if (created) {
                // Patch fields that observe() doesn't capture from a single call
                created.seenCount             = entry.seenCount;
                created.bestPhi_g             = entry.bestPhi_g;
                created.bestC                 = entry.bestC;
                created.bestConfidence        = entry.bestConfidence;
                created.contradictionHistory  = entry.contradictionHistory || [];
                created.phiHistory            = entry.phiHistory || [];
                created.sourceLinks           = entry.sourceLinks || [];
                created.nonSourceCount        = entry.nonSourceCount;
                created.status                = entry.status;
                created.firstSeen             = entry.firstSeen;
                created.lastSeen              = entry.lastSeen;
                created.promotedAt            = entry.promotedAt;
                created.rejectedReason        = entry.rejectedReason;
                candidatesRestored++;
            }
        }
    }

    return {
        ok: true,
        cells: cellsRestored,
        candidates: candidatesRestored,
        heartbeatTick: snapshot.heartbeatTick || 0,
        savedAt: snapshot.savedAt,
        filepath,
    };
}

// ── Exists ─────────────────────────────────────────────────────────────────────
function stateExists(filepath) {
    return fs.existsSync(filepath || DEFAULT_STATE_FILE);
}

// ── Info ───────────────────────────────────────────────────────────────────────
/**
 * getStateInfo() — Returns metadata about the saved state without loading it.
 */
function getStateInfo(filepath) {
    const fp = filepath || DEFAULT_STATE_FILE;
    if (!fs.existsSync(fp)) return null;

    try {
        const stat = fs.statSync(fp);
        const raw = fs.readFileSync(fp, 'utf8');
        const snapshot = JSON.parse(raw);

        return {
            filepath: fp,
            savedAt: snapshot.savedAt,
            version: snapshot.version,
            cells: snapshot.universe ? snapshot.universe.cellCount : 0,
            candidates: snapshot.candidates ? snapshot.candidates.count : 0,
            heartbeatTick: snapshot.heartbeatTick || 0,
            fileSizeKb: Math.round(stat.size / 1024),
            meta: snapshot.meta || {},
        };
    } catch (_) {
        return null;
    }
}

module.exports = {
    save,
    load,
    stateExists,
    getStateInfo,
    DEFAULT_STATE_FILE,
    DEFAULT_BACKUP_FILE,
};
