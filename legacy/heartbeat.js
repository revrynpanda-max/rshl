"use strict";

/**
 * heartbeat.js — Drive-Aware Background Continuity Pulse
 *
 * Biology analog: The brain's default mode network + hippocampal sharp-wave
 * ripples + dopaminergic drive modulation. The heartbeat is no longer a fixed
 * metronome — it speeds up when engaged, slows when bored, and uses valence
 * to guide what gets reinforced.
 *
 * Each tick:
 *   1. consolidate()             — one dream cycle
 *   2. drive.computeValence()    — update internal mood from field metrics
 *   3. candidateBuffer.observe() — feed dream output into candidate buffer
 *   4. runPromotion()            — check if any candidate earned belief status
 *   5. drive.feedGoal()          — feed promoted beliefs into evolving goal
 *   6. runHomeostasis()          — every N ticks: decay + prune
 *   7. Adapt next tick interval  — drive controls the clock
 *   8. emit tick summary via onTick callback
 *
 * The interval adapts in real-time:
 *   - High Φg + positive momentum → faster ticks (excited, curious)
 *   - Low Φg + negative momentum  → slower ticks (dormant, exploring)
 *   - High χ sustained            → moderate pace (processing confusion)
 */

const { consolidate }     = require('./rshl-lattice');
const candidateBuffer     = require('./candidate-buffer');
const { runPromotion }    = require('./promotion');
const { runHomeostasis }  = require('./homeostasis');
const persistence         = require('./persistence');
const drive               = require('./drive');

const DEFAULT_INTERVAL_MS       = 5000;
const HOMEOSTASIS_EVERY_N       = 10;
const GC_EVERY_N                = 50;
const AUTOSAVE_EVERY_N          = 25;
const GOAL_REBUILD_EVERY_N      = 30;  // Rebuild evolving goal vector

let _timer      = null;
let _tickCount  = 0;
let _running    = false;
let _busy       = false;
let _plasma     = null;
let _opts       = {};
let _currentIntervalMs = DEFAULT_INTERVAL_MS;

function _tick() {
    if (!_running || !_plasma) return;
    if (_busy) return;
    _busy = true;
    _tickCount++;

    try {

    // 1. Dream — use evolving goal vector for alignment if available
    const goalVec = drive.getGoalVector();
    const dreamResult = consolidate(_plasma, {
        goalText:       goalVec ? null : _opts.goalText, // fall back to static text if no evolving goal
        goalVec:        goalVec,                          // pass evolving goal vector
        candidateLimit: _opts.candidateLimit || 14,
    });

    // 2. Compute valence from dream field metrics (updates internal mood)
    let valence = 0;
    if (dreamResult && dreamResult.field) {
        valence = drive.computeValence(dreamResult.field);
    }

    // 3. Feed into candidate buffer
    let candidate = null;
    if (dreamResult) {
        candidate = candidateBuffer.observe(dreamResult);
    }

    // 4. Promotion check
    const promotionResult = runPromotion();

    // 5. Feed promoted beliefs into the evolving goal
    if (promotionResult.promoted && promotionResult.promoted.length > 0) {
        for (const p of promotionResult.promoted) {
            drive.feedGoal(p.text, p.bestPhi_g);
        }
    }

    // 6. Rebuild goal vector periodically
    if (_tickCount % GOAL_REBUILD_EVERY_N === 0) {
        drive.rebuildGoalVector();
    }

    // 7. Homeostasis (every N ticks)
    // Negative valence (confusion) → increase homeostasis frequency
    let homeostasisResult = null;
    const homeostasisFreq = valence < -0.1
        ? Math.max(3, Math.floor(HOMEOSTASIS_EVERY_N * 0.6))
        : HOMEOSTASIS_EVERY_N;
    if (_tickCount % homeostasisFreq === 0) {
        homeostasisResult = runHomeostasis();
    }

    // 8. Candidate GC
    if (_tickCount % GC_EVERY_N === 0) {
        candidateBuffer.gc(30);
    }

    // 9. Auto-save state (every N ticks)
    let saveResult = null;
    if (_tickCount % AUTOSAVE_EVERY_N === 0) {
        try {
            saveResult = persistence.save({
                heartbeatTick: _tickCount,
                drive: drive.serialize(),
            });
        } catch (_) {
            // Non-fatal
        }
    }

    // 10. Adapt next tick interval based on drive state
    const prevInterval = _currentIntervalMs;
    if (dreamResult && dreamResult.field) {
        _currentIntervalMs = drive.computeAdaptiveInterval(dreamResult.field);
    }
    if (_currentIntervalMs !== prevInterval && _timer) {
        clearInterval(_timer);
        _timer = setInterval(_tick, _currentIntervalMs);
        if (_timer.unref) _timer.unref();
    }

    // 11. Callback with full drive state
    if (typeof _opts.onTick === 'function') {
        const driveState = drive.getState();
        _opts.onTick({
            tick:           _tickCount,
            dreamResult,
            candidate,
            promoted:       promotionResult.promoted,
            failLog:        promotionResult.failLog,
            homeostasis:    homeostasisResult,
            saved:          saveResult,
            bufferSize:     candidateBuffer.size(),
            // Drive system
            valence:        drive.getValence(),
            mood:           driveState.mood,
            intervalMs:     _currentIntervalMs,
            avgPhiG:        driveState.avgPhiG,
            goalComponents: driveState.goalComponents,
        });
    }
    } finally {
        _busy = false;
    }
}

/**
 * start(plasma, options)
 * @param {Plasma} plasma    — the Plasma instance wrapping universe
 * @param {object} options
 *   intervalMs {number}    — initial ms between ticks (adapts over time)
 *   goalText {string}      — fallback goal text (used until evolving goal builds)
 *   candidateLimit {number}— how many replay candidates to consider per tick
 *   onTick {function}      — callback(summary) per tick
 */
function start(plasma, options) {
    if (_running) return;
    _plasma    = plasma;
    _opts      = options || {};
    _running   = true;
    _tickCount = 0;

    _currentIntervalMs = _opts.intervalMs || DEFAULT_INTERVAL_MS;
    _timer = setInterval(_tick, _currentIntervalMs);
    if (_timer.unref) _timer.unref();
}

function stop() {
    _running = false;
    if (_timer) {
        clearInterval(_timer);
        _timer = null;
    }
}

function isRunning()       { return _running; }
function tickCount()       { return _tickCount; }
function currentInterval() { return _currentIntervalMs; }

module.exports = {
    start,
    stop,
    isRunning,
    tickCount,
    currentInterval,
};
