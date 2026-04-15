"use strict";

/**
 * heartbeat.js — Background Continuity Pulse
 *
 * Biology analog: The brain's default mode network + hippocampal sharp-wave
 * ripples. During idle periods, the system replays, consolidates, evaluates
 * candidates, promotes beliefs, and prunes weak structure — without any
 * external input required. This is what keeps KAI alive between interactions.
 *
 * Each tick:
 *   1. consolidate()       — one dream cycle (pair selection → bundle → cleanup → field eval)
 *   2. candidateBuffer.observe()  — feed dream output into candidate buffer
 *   3. runPromotion()      — check if any candidate has earned belief status
 *   4. runHomeostasis()    — every N ticks: decay + prune weak structures
 *   5. candidateBuffer.gc() — every N ticks: clean up old promoted/rejected entries
 *   6. emit tick summary via onTick callback if provided
 *
 * The interval timer is unref'd so it won't keep the Node process alive if
 * nothing else is running. Call start() to activate, stop() to deactivate.
 *
 * Usage:
 *   const heartbeat = require('./heartbeat');
 *   heartbeat.start(plasma, {
 *       intervalMs: 4000,
 *       goalText: 'coherent world understanding with low contradiction',
 *       onTick: (summary) => console.log(summary),
 *   });
 *   // ... later ...
 *   heartbeat.stop();
 */

const { consolidate }     = require('./rshl-lattice');
const candidateBuffer     = require('./candidate-buffer');
const { runPromotion }    = require('./promotion');
const { runHomeostasis }  = require('./homeostasis');

const DEFAULT_INTERVAL_MS       = 5000;  // 5 seconds between ticks
const HOMEOSTASIS_EVERY_N       = 10;    // Run homeostasis every N ticks
const GC_EVERY_N                = 50;    // Run candidate GC every N ticks

let _timer      = null;
let _tickCount  = 0;
let _running    = false;
let _plasma     = null;
let _opts       = {};

function _tick() {
    if (!_running || !_plasma) return;
    _tickCount++;

    // 1. Dream
    const dreamResult = consolidate(_plasma, {
        goalText:       _opts.goalText,
        candidateLimit: _opts.candidateLimit || 14,
    });

    // 2. Feed into candidate buffer
    let candidate = null;
    if (dreamResult) {
        candidate = candidateBuffer.observe(dreamResult);
    }

    // 3. Promotion check
    const promotionResult = runPromotion();

    // 4. Homeostasis (every N ticks)
    let homeostasisResult = null;
    if (_tickCount % HOMEOSTASIS_EVERY_N === 0) {
        homeostasisResult = runHomeostasis();
    }

    // 5. Candidate GC (every N ticks)
    if (_tickCount % GC_EVERY_N === 0) {
        candidateBuffer.gc(30);
    }

    // 6. Callback
    if (typeof _opts.onTick === 'function') {
        _opts.onTick({
            tick:        _tickCount,
            dreamResult,
            candidate,
            promoted:    promotionResult.promoted,
            failLog:     promotionResult.failLog,
            homeostasis: homeostasisResult,
            bufferSize:  candidateBuffer.size(),
        });
    }
}

/**
 * start(plasma, options)
 * @param {Plasma} plasma    — the Plasma instance wrapping universe
 * @param {object} options
 *   intervalMs {number}    — ms between ticks (default 5000)
 *   goalText {string}      — goal alignment text for field scoring
 *   candidateLimit {number}— how many replay candidates to consider per tick
 *   onTick {function}      — callback(summary) per tick
 */
function start(plasma, options) {
    if (_running) return;
    _plasma    = plasma;
    _opts      = options || {};
    _running   = true;
    _tickCount = 0;

    const ms = _opts.intervalMs || DEFAULT_INTERVAL_MS;
    _timer = setInterval(_tick, ms);
    if (_timer.unref) _timer.unref(); // don't block process exit
}

function stop() {
    _running = false;
    if (_timer) {
        clearInterval(_timer);
        _timer = null;
    }
}

function isRunning() { return _running; }
function tickCount()  { return _tickCount; }

module.exports = {
    start,
    stop,
    isRunning,
    tickCount,
};
