"use strict";

/**
 * kai-tui.js — Full-Screen KAI Terminal UI
 *
 * Fixed layout regions:
 *   ┌──────────────── TOP ────────────────┐
 *   │  Header (centered, pinned)          │
 *   │  KAI branding + vitals + heartbeat  │
 *   ├──────────── MIDDLE ─────────────────┤
 *   │  Last 2 conversation turns          │
 *   │  (older messages hidden, type       │
 *   │   'history' to see more)            │
 *   ├──────────── BOTTOM ─────────────────┤
 *   │  Input prompt (centered, pinned)    │
 *   └────────────────────────────────────-┘
 *
 * Features:
 *   - Red animated heartbeat pulse (vitals display)
 *   - Thinking spinner animation
 *   - Conversation turns stay in middle zone
 *   - Header and input never move
 *   - Natural language input
 */

const readline = require('readline');
const persistence     = require('./persistence');
const universe        = require('./universe');
const { Plasma }      = require('./plasma');
const heartbeat       = require('./heartbeat');
const candidateBuffer = require('./candidate-buffer');
const { runPromotion } = require('./promotion');
const { consolidate } = require('./rshl-lattice');
const { generateToResult } = require('./generative-core');
const bridge          = require('./world-bridge');
const { runHomeostasis } = require('./homeostasis');
const drive           = require('./drive');

// ── ANSI ──────────────────────────────────────────────────────────────────────
const ESC = '\x1b[';
const A = {
    reset:     `${ESC}0m`,
    bold:      `${ESC}1m`,
    dim:       `${ESC}2m`,
    italic:    `${ESC}3m`,
    red:       `${ESC}31m`,
    green:     `${ESC}32m`,
    yellow:    `${ESC}33m`,
    blue:      `${ESC}34m`,
    magenta:   `${ESC}35m`,
    cyan:      `${ESC}36m`,
    white:     `${ESC}37m`,
    bRed:      `${ESC}91m`,
    bGreen:    `${ESC}92m`,
    bYellow:   `${ESC}93m`,
    bBlue:     `${ESC}94m`,
    bMagenta:  `${ESC}95m`,
    bCyan:     `${ESC}96m`,
    bWhite:    `${ESC}97m`,
    bgBlack:   `${ESC}40m`,
    bgGray:    `${ESC}100m`,
    hide:      `${ESC}?25l`,
    show:      `${ESC}?25h`,
    clear:     `${ESC}2J`,
    home:      `${ESC}H`,
    clearLine: `${ESC}2K`,
    altOn:     `${ESC}?1049h`,
    altOff:    `${ESC}?1049l`,
    saveCur:   `${ESC}s`,
    restCur:   `${ESC}u`,
};

function moveTo(row, col) { return `${ESC}${row};${col}H`; }
function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ''); }

// ── Layout ────────────────────────────────────────────────────────────────────
const HEADER_HEIGHT = 11;
const INPUT_HEIGHT  = 3;

function getSize() {
    return {
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 30,
    };
}

function getMsgZone() {
    const { rows } = getSize();
    return {
        top: HEADER_HEIGHT + 1,
        bottom: rows - INPUT_HEIGHT,
        height: rows - HEADER_HEIGHT - INPUT_HEIGHT,
    };
}

// ── State ─────────────────────────────────────────────────────────────────────
const GOAL_TEXT = 'coherent world understanding with low contradiction and natural intelligence growth';
let plasma;
let turnHistory = [];  // { role: 'user'|'kai', text: string, ts: number }
let showAllHistory = false;
let currentSpinnerLabel = null;
let _spinnerTimer = null;
let _spinnerFrame = 0;
let _heartbeatTimer = null;
let _heartbeatFrame = 0;
let _heartbeatPhase = 0;
let lastPromotionText = null;
let _rl = null;

// ── Heartbeat Animation ──────────────────────────────────────────────────────
// Red pulsing heart that looks alive — like a vital sign
const HEART_FRAMES = [
    // Diastole (resting)
    { heart: '♥', color: A.red,  size: 'small' },
    { heart: '♥', color: A.red,  size: 'small' },
    { heart: '♥', color: A.red,  size: 'small' },
    { heart: '♥', color: A.red,  size: 'small' },
    { heart: '♥', color: A.red,  size: 'small' },
    // Systole (beat!)
    { heart: '♥', color: A.bRed, size: 'big'   },
    { heart: '❤', color: A.bRed, size: 'big'   },
    { heart: '♥', color: A.bRed, size: 'big'   },
    // Relax
    { heart: '♥', color: A.red,  size: 'small' },
    { heart: '♥', color: A.red,  size: 'small' },
    // Second beat (double pulse like real heart)
    { heart: '♥', color: A.bRed, size: 'big'   },
    { heart: '❤', color: A.bRed, size: 'big'   },
    // Rest
    { heart: '♥', color: A.red,  size: 'small' },
    { heart: '♥', color: A.red,  size: 'small' },
    { heart: '♥', color: A.red,  size: 'small' },
    { heart: '♥', color: A.red,  size: 'small' },
];

// ECG-style waveform that pulses with the heart
const ECG_REST  = '─────';
const ECG_BEAT  = '─╱╲─╱';
const ECG_PEAK  = '╱╲─╱╲';

function getECG(frame) {
    const f = HEART_FRAMES[frame % HEART_FRAMES.length];
    if (f.size === 'big') return ECG_BEAT;
    return ECG_REST;
}

function startHeartbeatAnimation() {
    _heartbeatFrame = 0;
    _heartbeatTimer = setInterval(() => {
        _heartbeatFrame++;
        renderHeartbeatLine();
    }, 150);
    if (_heartbeatTimer.unref) _heartbeatTimer.unref();
}

function renderHeartbeatLine() {
    const { cols } = getSize();
    const frame = HEART_FRAMES[_heartbeatFrame % HEART_FRAMES.length];
    const ecg = getECG(_heartbeatFrame);

    const ds = drive.getState();
    const tick = heartbeat.tickCount();
    const interval = heartbeat.currentInterval();

    const moodIcons = { curious: '🔍', engaged: '⚡', neutral: '·', uneasy: '😟', conflicted: '⚔️', dormant: '💤' };
    const moodColors = { curious: A.bCyan, engaged: A.bGreen, neutral: A.dim, uneasy: A.bYellow, conflicted: A.bRed, dormant: A.dim };

    const mc = moodColors[ds.mood] || A.dim;
    const mi = moodIcons[ds.mood] || '·';
    const vSign = ds.valence >= 0 ? '+' : '';

    // Build vitals line
    const vitals = `${frame.color}${frame.heart}${A.reset} ${A.red}${ecg}${A.reset} ` +
                   `${A.dim}t${tick}${A.reset} ` +
                   `${mc}${mi}${ds.mood}${A.reset} ` +
                   `${A.dim}V=${vSign}${ds.valence.toFixed(2)}${A.reset} ` +
                   `${A.dim}${interval}ms${A.reset}`;

    const vitalStripped = stripAnsi(vitals);
    const pad = Math.max(0, Math.floor((cols - vitalStripped.length) / 2));

    // Write vitals on the header vitals line (row 10)
    process.stdout.write(A.saveCur);
    process.stdout.write(moveTo(HEADER_HEIGHT, 1));
    process.stdout.write(A.clearLine);
    process.stdout.write(' '.repeat(pad) + vitals);
    process.stdout.write(A.restCur);
}

// ── Spinner ───────────────────────────────────────────────────────────────────
const SPIN = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
const SPIN_WORDS = ['Resonating','Binding','Dreaming','Bundling','Weaving','Recalling','Synthesizing','Aligning','Emerging'];

function startSpinner(label) {
    _spinnerFrame = 0;
    currentSpinnerLabel = label || SPIN_WORDS[Math.floor(Math.random() * SPIN_WORDS.length)];
    const zone = getMsgZone();
    const { cols } = getSize();

    _spinnerTimer = setInterval(() => {
        const f = SPIN[_spinnerFrame % SPIN.length];
        const text = `${A.bCyan}${f}${A.reset} ${A.cyan}${currentSpinnerLabel}${A.dim}...${A.reset}`;
        const stripped = stripAnsi(text);
        const pad = Math.max(0, Math.floor((cols - stripped.length) / 2));

        process.stdout.write(A.saveCur);
        process.stdout.write(moveTo(zone.bottom - 1, 1));
        process.stdout.write(A.clearLine);
        process.stdout.write(' '.repeat(pad) + text);
        process.stdout.write(A.restCur);
        _spinnerFrame++;
    }, 80);
}

function stopSpinner() {
    if (_spinnerTimer) {
        clearInterval(_spinnerTimer);
        _spinnerTimer = null;
    }
    const zone = getMsgZone();
    process.stdout.write(A.saveCur);
    process.stdout.write(moveTo(zone.bottom - 1, 1));
    process.stdout.write(A.clearLine);
    process.stdout.write(A.restCur);
    currentSpinnerLabel = null;
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function centerText(text, width) {
    const stripped = stripAnsi(text);
    const pad = Math.max(0, Math.floor((width - stripped.length) / 2));
    return ' '.repeat(pad) + text;
}

function renderHeader() {
    const { cols } = getSize();
    const cellCount = universe.count();

    const lines = [
        `${A.bCyan}${A.bold}╭${'─'.repeat(Math.min(50, cols - 6))}╮${A.reset}`,
        `${A.bCyan}│${A.reset}${centerText(`${A.bCyan}${A.bold}KAI v5.0${A.reset} ${A.dim}— Geometric Intelligence${A.reset}`, Math.min(50, cols - 6))}${A.bCyan}│${A.reset}`,
        `${A.bCyan}│${A.reset}${' '.repeat(Math.min(50, cols - 6))}${A.bCyan}│${A.reset}`,
        `${A.bCyan}│${A.reset}${centerText(`${A.bCyan}${A.bold}╦╔═ ╔═╗ ╦${A.reset}`, Math.min(50, cols - 6))}${A.bCyan}│${A.reset}`,
        `${A.bCyan}│${A.reset}${centerText(`${A.bCyan}${A.bold}╠╩╗ ╠═╣ ║${A.reset}`, Math.min(50, cols - 6))}${A.bCyan}│${A.reset}`,
        `${A.bCyan}│${A.reset}${centerText(`${A.bCyan}${A.bold}╩ ╩ ╩ ╩ ╩${A.reset}`, Math.min(50, cols - 6))}${A.bCyan}│${A.reset}`,
        `${A.bCyan}│${A.reset}${' '.repeat(Math.min(50, cols - 6))}${A.bCyan}│${A.reset}`,
        `${A.bCyan}│${A.reset}${centerText(`${A.dim}RSHL · ${cellCount} cells · HDC 4096-dim${A.reset}`, Math.min(50, cols - 6))}${A.bCyan}│${A.reset}`,
        `${A.bCyan}╰${'─'.repeat(Math.min(50, cols - 6))}╯${A.reset}`,
        '', // Line 10: vitals (rendered by heartbeat animation)
    ];

    for (let i = 0; i < lines.length; i++) {
        const stripped = stripAnsi(lines[i]);
        const pad = Math.max(0, Math.floor((cols - stripped.length) / 2));
        process.stdout.write(moveTo(i + 1, 1));
        process.stdout.write(A.clearLine);
        process.stdout.write(' '.repeat(pad) + lines[i]);
    }
}

function renderMessages() {
    const zone = getMsgZone();
    const { cols } = getSize();

    // Clear message zone
    for (let row = zone.top; row <= zone.bottom; row++) {
        process.stdout.write(moveTo(row, 1));
        process.stdout.write(A.clearLine);
    }

    if (turnHistory.length === 0) {
        const hint = `${A.dim}Type naturally — KAI will understand. Type ${A.bCyan}help${A.dim} for commands.${A.reset}`;
        const stripped = stripAnsi(hint);
        const pad = Math.max(0, Math.floor((cols - stripped.length) / 2));
        process.stdout.write(moveTo(zone.top + Math.floor(zone.height / 2), 1));
        process.stdout.write(' '.repeat(pad) + hint);
        return;
    }

    // Show last N turns that fit in the zone
    const visibleTurns = showAllHistory ? turnHistory : turnHistory.slice(-4);
    const margin = Math.max(4, Math.floor(cols * 0.1));

    let row = zone.top + 1;

    for (const turn of visibleTurns) {
        if (row >= zone.bottom - 1) break;

        if (turn.role === 'user') {
            // User message — right-aligned, dimmer
            const label = `${A.dim}you ›${A.reset}`;
            const maxW = cols - margin * 2 - 6;
            const lines = wrapText(turn.text, maxW);

            process.stdout.write(moveTo(row, 1));
            process.stdout.write(A.clearLine);
            process.stdout.write(' '.repeat(margin) + label);
            row++;

            for (const line of lines) {
                if (row >= zone.bottom - 1) break;
                process.stdout.write(moveTo(row, 1));
                process.stdout.write(A.clearLine);
                process.stdout.write(' '.repeat(margin + 2) + `${A.white}${line}${A.reset}`);
                row++;
            }
        } else {
            // KAI response
            const label = `${A.bCyan}KAI ‹${A.reset}`;
            const maxW = cols - margin * 2 - 6;
            const lines = wrapText(turn.text, maxW);

            process.stdout.write(moveTo(row, 1));
            process.stdout.write(A.clearLine);
            process.stdout.write(' '.repeat(margin) + label);
            if (turn.region) {
                const rc = regionColor(turn.region);
                process.stdout.write(` ${rc}[${turn.region}]${A.reset}`);
            }
            if (turn.score) {
                process.stdout.write(` ${A.dim}(${(turn.score * 100).toFixed(0)}%)${A.reset}`);
            }
            row++;

            for (const line of lines) {
                if (row >= zone.bottom - 1) break;
                process.stdout.write(moveTo(row, 1));
                process.stdout.write(A.clearLine);
                process.stdout.write(' '.repeat(margin + 2) + `${A.bWhite}${line}${A.reset}`);
                row++;
            }
        }

        row++; // gap between turns
    }

    if (!showAllHistory && turnHistory.length > 4) {
        process.stdout.write(moveTo(zone.bottom, 1));
        process.stdout.write(A.clearLine);
        const more = `${A.dim}↑ ${turnHistory.length - 4} older messages — type "history" to see all${A.reset}`;
        const stripped = stripAnsi(more);
        const pad = Math.max(0, Math.floor((cols - stripped.length) / 2));
        process.stdout.write(' '.repeat(pad) + more);
    }
}

function renderInput() {
    const { rows, cols } = getSize();
    const inputRow = rows - 1;

    // Separator
    process.stdout.write(moveTo(rows - 2, 1));
    process.stdout.write(A.clearLine);
    const sep = `${A.dim}${'─'.repeat(Math.min(60, cols - 8))}${A.reset}`;
    const sepStripped = stripAnsi(sep);
    const sepPad = Math.max(0, Math.floor((cols - sepStripped.length) / 2));
    process.stdout.write(' '.repeat(sepPad) + sep);

    // Input line
    process.stdout.write(moveTo(inputRow, 1));
    process.stdout.write(A.clearLine);
    const promptStr = `  ${A.bCyan}›${A.reset} `;
    const promptPad = Math.max(0, Math.floor((cols - 60) / 2));
    process.stdout.write(' '.repeat(promptPad) + promptStr);
}

function fullRedraw() {
    process.stdout.write(A.clear + A.home);
    renderHeader();
    renderHeartbeatLine();
    renderMessages();
    renderInput();
    positionCursor();
}

function positionCursor() {
    const { rows, cols } = getSize();
    const promptPad = Math.max(0, Math.floor((cols - 60) / 2));
    process.stdout.write(moveTo(rows - 1, promptPad + 5));
    process.stdout.write(A.show);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function wrapText(text, maxWidth) {
    if (!text) return [''];
    maxWidth = Math.max(20, maxWidth);
    const words = text.split(/\s+/);
    const lines = [];
    let current = '';
    for (const word of words) {
        if (current.length + word.length + 1 > maxWidth) {
            lines.push(current);
            current = word;
        } else {
            current = current ? current + ' ' + word : word;
        }
    }
    if (current) lines.push(current);
    return lines.length ? lines : [''];
}

function regionColor(region) {
    const map = { memory: A.bMagenta, reasoning: A.bBlue, language: A.bGreen, action: A.bYellow };
    return map[region] || A.white;
}

// ── Smart routing ─────────────────────────────────────────────────────────────
function routeInput(input) {
    const lower = input.toLowerCase().trim();
    if (lower === 'status')      return { type: 'status' };
    if (lower === 'mood')        return { type: 'mood' };
    if (lower === 'drive')       return { type: 'drive' };
    if (lower === 'help' || lower === '?') return { type: 'help' };
    if (lower === 'dream')       return { type: 'dream' };
    if (lower === 'history')     return { type: 'history' };
    if (lower === 'promote')     return { type: 'promote' };
    if (lower === 'homeostasis') return { type: 'homeostasis' };
    if (lower === 'candidates')  return { type: 'candidates' };
    if (lower === 'save')        return { type: 'save' };
    if (lower === 'quit' || lower === 'exit') return { type: 'quit' };
    if (lower.startsWith('store '))  return { type: 'store', body: input.slice(6) };
    if (lower.startsWith('ingest ')) return { type: 'ingest', body: input.slice(7) };
    if (lower.startsWith('github ')) return { type: 'github', body: input.slice(7) };

    if (lower.includes('?') || lower.startsWith('what') || lower.startsWith('how') ||
        lower.startsWith('why') || lower.startsWith('who') || lower.startsWith('when') ||
        lower.startsWith('where') || lower.startsWith('do you') || lower.startsWith('can you') ||
        lower.startsWith('are you') || lower.startsWith('tell me')) {
        return { type: 'think', body: input };
    }
    if (input.split(/\s+/).length <= 4) return { type: 'ask', body: input };
    return { type: 'think', body: input };
}

// ── Format helpers ────────────────────────────────────────────────────────────
function statusText() {
    const cells = universe.getCells();
    const cands = candidateBuffer.getAll();
    const promoted_count = cands.filter(c => c.status === 'promoted').length;
    const ds = drive.getState();
    const regions = {};
    cells.forEach(c => { regions[c.region] = (regions[c.region] || 0) + 1; });
    const strengths = cells.map(c => c.strength);
    const avgStr = strengths.length ? (strengths.reduce((a, b) => a + b, 0) / strengths.length).toFixed(2) : '0';

    let out = `Universe: ${cells.length} cells | Avg str: ${avgStr}\n`;
    out += `Regions: ${Object.entries(regions).map(([r,n]) => `${r}:${n}`).join(' ')}\n`;
    out += `Candidates: ${cands.length} (${promoted_count} promoted)\n`;
    out += `Mood: ${ds.mood} | Valence: ${ds.valence >= 0 ? '+' : ''}${ds.valence.toFixed(3)}\n`;
    out += `Goal: ${ds.hasGoalVector ? `active (${ds.goalComponents} beliefs)` : 'not built'}\n`;
    out += `Tempo: ${ds.adaptiveMs}ms | Tick: ${heartbeat.tickCount()}`;
    return out;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const FRESH = args.includes('--fresh');

// Switch to alternate screen
process.stdout.write(A.altOn);
process.stdout.write(A.clear + A.home);

// Cleanup on exit
function cleanup() {
    if (_heartbeatTimer) clearInterval(_heartbeatTimer);
    if (_spinnerTimer) clearInterval(_spinnerTimer);
    process.stdout.write(A.show);
    process.stdout.write(A.altOff);
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

// Load state
if (!FRESH && persistence.stateExists()) {
    const result = persistence.load();
    if (result.ok) {
        if (result.raw && result.raw.drive) drive.restore(result.raw.drive);
        plasma = new Plasma(false);
    } else {
        require('./seed');
        plasma = new Plasma(false);
    }
} else {
    if (!FRESH) {
        // Seed without the noisy console output
        const origLog = console.log;
        console.log = () => {};
        require('./seed');
        console.log = origLog;
    } else {
        const origLog = console.log;
        console.log = () => {};
        require('./seed');
        console.log = origLog;
    }
    plasma = new Plasma(false);
}

// Start heartbeat (silent — vitals line handles display)
heartbeat.start(plasma, {
    intervalMs: 5000,
    goalText: GOAL_TEXT,
    onTick: (summary) => {
        // Update header cell count on promotions
        if (summary.promoted && summary.promoted.length) {
            lastPromotionText = summary.promoted[0].text;
            // Re-render header to update cell count
            process.stdout.write(A.saveCur);
            renderHeader();
            process.stdout.write(A.restCur);
        }
    },
});

// Start heartbeat animation
startHeartbeatAnimation();

// Initial render
fullRedraw();

// Handle resize
process.stdout.on('resize', () => {
    fullRedraw();
});

// ── REPL ──────────────────────────────────────────────────────────────────────
_rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: '',
});

// Position cursor for input
positionCursor();

process.stdin.on('keypress', (str, key) => {
    // Ctrl+C to exit
    if (key && key.ctrl && key.name === 'c') {
        heartbeat.stop();
        persistence.save({ heartbeatTick: heartbeat.tickCount(), drive: drive.serialize() });
        cleanup();
        process.exit(0);
    }
});

_rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
        renderInput();
        positionCursor();
        return;
    }

    // Announce promotions
    if (lastPromotionText) {
        turnHistory.push({
            role: 'kai',
            text: `⬆ Belief formed: "${lastPromotionText.slice(0, 60)}"`,
            ts: Date.now(),
        });
        lastPromotionText = null;
    }

    showAllHistory = false;
    const route = routeInput(input);

    switch (route.type) {
        case 'help': {
            turnHistory.push({ role: 'user', text: input, ts: Date.now() });
            const helpText = 'Just type naturally. Questions synthesize, short words search. ' +
                'Commands: status, mood, drive, dream, store <text>, ingest <text>, ' +
                'candidates, history, save, quit';
            turnHistory.push({ role: 'kai', text: helpText, ts: Date.now() });
            break;
        }

        case 'history':
            showAllHistory = true;
            renderMessages();
            renderInput();
            positionCursor();
            return;

        case 'ask': {
            turnHistory.push({ role: 'user', text: input, ts: Date.now() });
            renderMessages();
            startSpinner();
            const hits = universe.query(route.body, 5);
            stopSpinner();
            if (!hits.length || hits[0].score < 0.45) {
                turnHistory.push({ role: 'kai', text: `No strong resonance for "${route.body}"`, ts: Date.now() });
            } else {
                turnHistory.push({
                    role: 'kai', text: hits[0].text,
                    region: hits[0].region, score: hits[0].score,
                    ts: Date.now(),
                });
            }
            break;
        }

        case 'think': {
            turnHistory.push({ role: 'user', text: input, ts: Date.now() });
            renderMessages();
            startSpinner('Synthesizing');
            const result = generateToResult(route.body, 5);
            stopSpinner();
            if (result.confidence < 0.3) {
                const hits = universe.query(route.body, 3);
                if (hits.length && hits[0].score > 0.5) {
                    turnHistory.push({
                        role: 'kai', text: hits[0].text,
                        region: hits[0].region, score: hits[0].score,
                        ts: Date.now(),
                    });
                } else {
                    turnHistory.push({ role: 'kai', text: "Can't form a strong thought on that yet.", ts: Date.now() });
                }
            } else {
                let response = `"${result.thought}"`;
                if (result.matches.length) {
                    const sources = result.matches.slice(0, 2).map(m => `${m.region}(${(m.score*100).toFixed(0)}%)`).join(', ');
                    response += ` [${(result.confidence * 100).toFixed(0)}% · ${sources}]`;
                }
                turnHistory.push({
                    role: 'kai', text: response,
                    score: result.confidence,
                    ts: Date.now(),
                });
            }
            break;
        }

        case 'store': {
            turnHistory.push({ role: 'user', text: input, ts: Date.now() });
            startSpinner('Storing');
            universe.store(route.body, 'memory', { source: 'user-input' });
            stopSpinner();
            turnHistory.push({ role: 'kai', text: '✓ Stored in memory region', region: 'memory', ts: Date.now() });
            // Update header
            process.stdout.write(A.saveCur);
            renderHeader();
            process.stdout.write(A.restCur);
            break;
        }

        case 'ingest': {
            turnHistory.push({ role: 'user', text: input, ts: Date.now() });
            startSpinner('Ingesting');
            const ir = bridge.ingest(route.body, { source: 'manual', topic: 'user-ingest' });
            stopSpinner();
            turnHistory.push({
                role: 'kai',
                text: ir.stored ? '✓ Ingested (untrusted, str 0.6)' : `✗ Skipped: ${ir.reason}`,
                ts: Date.now(),
            });
            break;
        }

        case 'github': {
            turnHistory.push({ role: 'user', text: input, ts: Date.now() });
            const [owner, repo] = route.body.split('/');
            if (!owner || !repo) {
                turnHistory.push({ role: 'kai', text: 'Usage: github owner/repo', ts: Date.now() });
                break;
            }
            startSpinner('Fetching GitHub');
            try {
                const gr = await bridge.ingestFromGitHub(owner, repo);
                stopSpinner();
                turnHistory.push({ role: 'kai', text: `✓ ${gr.stored} stored, ${gr.skipped} skipped from ${owner}/${repo}`, ts: Date.now() });
            } catch (e) {
                stopSpinner();
                turnHistory.push({ role: 'kai', text: `✗ ${e.message}`, ts: Date.now() });
            }
            break;
        }

        case 'dream': {
            turnHistory.push({ role: 'user', text: 'dream', ts: Date.now() });
            startSpinner('Dreaming');
            const dr = consolidate(plasma, { goalText: GOAL_TEXT });
            stopSpinner();
            if (dr) {
                candidateBuffer.observe(dr);
                turnHistory.push({
                    role: 'kai',
                    text: `💭 "${dr.insight.slice(0, 65)}" (Φg:${dr.field.phi_g.toFixed(3)} C:${dr.field.C.toFixed(3)} conf:${(dr.confidence*100).toFixed(0)}%)`,
                    ts: Date.now(),
                });
            } else {
                turnHistory.push({ role: 'kai', text: 'No viable dream pair found.', ts: Date.now() });
            }
            break;
        }

        case 'promote': {
            startSpinner();
            const pr = runPromotion();
            stopSpinner();
            if (pr.promoted.length) {
                pr.promoted.forEach(p => {
                    turnHistory.push({ role: 'kai', text: `⬆ Promoted: "${p.text.slice(0,55)}" (str=${p.strength.toFixed(1)})`, ts: Date.now() });
                });
            } else {
                turnHistory.push({ role: 'kai', text: 'No promotions ready.', ts: Date.now() });
            }
            break;
        }

        case 'homeostasis': {
            const hr = runHomeostasis();
            turnHistory.push({ role: 'kai', text: `Decayed: ${hr.decayed.length} | Pruned: ${hr.pruned.length}`, ts: Date.now() });
            break;
        }

        case 'status': {
            turnHistory.push({ role: 'user', text: 'status', ts: Date.now() });
            turnHistory.push({ role: 'kai', text: statusText(), ts: Date.now() });
            break;
        }

        case 'mood': {
            const ds = drive.getState();
            const vSign = ds.valence >= 0 ? '+' : '';
            turnHistory.push({ role: 'user', text: 'mood', ts: Date.now() });
            turnHistory.push({
                role: 'kai',
                text: `${ds.mood.toUpperCase()} · V=${vSign}${ds.valence.toFixed(3)} · Φg=${ds.avgPhiG.toFixed(4)} · χ=${ds.avgChi.toFixed(4)} · ${ds.adaptiveMs}ms · ${ds.goalComponents} goals`,
                ts: Date.now(),
            });
            break;
        }

        case 'drive': {
            const ds = drive.getState();
            const vh = drive.getValenceHistory();
            const spark = vh.slice(-15).map(v => v > 0.05 ? '▲' : v > 0 ? '△' : v > -0.05 ? '─' : '▼').join('');
            turnHistory.push({ role: 'user', text: 'drive', ts: Date.now() });
            turnHistory.push({
                role: 'kai',
                text: `Mood: ${ds.mood} | V=${ds.valence.toFixed(3)} | Goal: ${ds.hasGoalVector ? 'active' : 'none'} (${ds.goalComponents}) | Tempo: ${ds.adaptiveMs}ms\nHistory: ${spark || 'no data yet'}`,
                ts: Date.now(),
            });
            break;
        }

        case 'candidates': {
            const allCands = candidateBuffer.getAll().sort((a, b) => b.seenCount - a.seenCount);
            turnHistory.push({ role: 'user', text: 'candidates', ts: Date.now() });
            if (!allCands.length) {
                turnHistory.push({ role: 'kai', text: 'No candidates.', ts: Date.now() });
            } else {
                const text = allCands.slice(0, 5).map(c =>
                    `[${c.status}] seen=${c.seenCount} C=${c.bestC.toFixed(3)} "${c.text.slice(0, 40)}"`
                ).join('\n');
                turnHistory.push({ role: 'kai', text: `Candidates (${allCands.length}):\n${text}`, ts: Date.now() });
            }
            break;
        }

        case 'save': {
            startSpinner('Saving');
            const sr = persistence.save({ heartbeatTick: heartbeat.tickCount(), drive: drive.serialize() });
            stopSpinner();
            turnHistory.push({ role: 'kai', text: `💾 Saved ${sr.cells} cells, ${sr.candidates} candidates (${Math.round(sr.bytes/1024)} KB)`, ts: Date.now() });
            break;
        }

        case 'quit': {
            heartbeat.stop();
            persistence.save({ heartbeatTick: heartbeat.tickCount(), drive: drive.serialize() });
            cleanup();
            console.log('\n  KAI dormant. State preserved.\n');
            process.exit(0);
        }
    }

    renderMessages();
    renderInput();
    positionCursor();
});

_rl.on('close', () => {
    heartbeat.stop();
    persistence.save({ heartbeatTick: heartbeat.tickCount(), drive: drive.serialize() });
    cleanup();
    process.exit(0);
});
