"use strict";

/**
 * kai-tui.js â€” KAI Terminal Interface
 *
 * Mimics the KAI Code terminal UX:
 *   - Welcome header with KAI ASCII art + status panel
 *   - Shimmer animation on thinking verbs (bright glyph sweeps across text)
 *   - Red beating heartbeat glyph (like KAI's spinner, but cardiac)
 *   - Conversation stays in middle zone, last 2 turns visible
 *   - Input pinned at bottom
 *   - No tick spam â€” heartbeat is silent, vitals in header
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

// â”€â”€ ANSI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const E = '\x1b[';
const A = {
    reset:     `${E}0m`,
    bold:      `${E}1m`,
    dim:       `${E}2m`,
    italic:    `${E}3m`,
    red:       `${E}31m`,
    green:     `${E}32m`,
    yellow:    `${E}33m`,
    blue:      `${E}34m`,
    magenta:   `${E}35m`,
    cyan:      `${E}36m`,
    white:     `${E}37m`,
    bRed:      `${E}91m`,
    bGreen:    `${E}92m`,
    bYellow:   `${E}93m`,
    bBlue:     `${E}94m`,
    bMagenta:  `${E}95m`,
    bCyan:     `${E}96m`,
    bWhite:    `${E}97m`,
    hide:      `${E}?25l`,
    show:      `${E}?25h`,
    clear:     `${E}2J`,
    home:      `${E}H`,
    clearLine: `${E}2K`,
    altOn:     `${E}?1049h`,
    altOff:    `${E}?1049l`,
    saveCur:   `${E}s`,
    restCur:   `${E}u`,
};

function moveTo(r, c) { return `${E}${r};${c}H`; }
function stripAnsi(s) { return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''); }

// â”€â”€ KAI Spinner verbs (geometric intelligence themed) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const KAI_VERBS = [
    'Resonating', 'Binding', 'Dreaming', 'Bundling', 'Weaving',
    'Crystallizing', 'Aligning', 'Emerging', 'Synthesizing', 'Propagating',
    'Coalescing', 'Incubating', 'Orbiting', 'Nucleating', 'Germinating',
    'Harmonizing', 'Recalling', 'Sprouting', 'Unfurling', 'Morphing',
    'Cascading', 'Fermenting', 'Percolating', 'Simmering', 'Ruminating',
    'Sculpting', 'Distilling', 'Forging', 'Threading', 'Pulsing',
];

// â”€â”€ Shimmer animation (like KAI's) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// A bright character sweeps Lâ†’R across the text, then resets
const SHIMMER_WIDTH   = 2;     // how many chars are bright at once
const SHIMMER_SPEED   = 100;   // ms per position
const SHIMMER_PAUSE   = 800;   // ms pause between sweeps

function renderShimmer(text, time) {
    const len = text.length;
    const totalCycle = (len + SHIMMER_WIDTH + 4) * SHIMMER_SPEED + SHIMMER_PAUSE;
    const phase = time % totalCycle;
    const pos = Math.floor(phase / SHIMMER_SPEED) - 2;

    let result = '';
    for (let i = 0; i < len; i++) {
        if (i >= pos && i < pos + SHIMMER_WIDTH) {
            result += `${A.bCyan}${A.bold}${text[i]}${A.reset}`;
        } else {
            result += `${A.dim}${text[i]}${A.reset}`;
        }
    }
    return result;
}

// â”€â”€ Heart glyph animation (like KAI's spinner, but a heartbeat) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// KAI uses characters that flow: â ‹â ™â ¹â ¸â ¼â ´â ¦â §â ‡â  then reverse
// KAI uses a cardiac rhythm with the heart
const HEART_GLYPHS = [
    // Resting (dim)
    { ch: 'â™¥', color: A.red },
    { ch: 'â™¥', color: A.red },
    { ch: 'â™¥', color: A.red },
    { ch: 'â™¥', color: A.red },
    { ch: 'â™¥', color: A.red },
    // BEAT! (bright, bigger)
    { ch: 'â¤', color: A.bRed + A.bold },
    { ch: 'â¤', color: A.bRed + A.bold },
    // Relax
    { ch: 'â™¥', color: A.red },
    { ch: 'â™¥', color: A.red },
    // Second beat
    { ch: 'â¤', color: A.bRed + A.bold },
    { ch: 'â¤', color: A.bRed + A.bold },
    // Rest
    { ch: 'â™¥', color: A.red },
    { ch: 'â™¥', color: A.red },
    { ch: 'â™¥', color: A.red },
    { ch: 'â™¥', color: A.red },
    { ch: 'â™¥', color: A.red },
];

function getHeartGlyph(time) {
    const frame = Math.floor(time / 120) % HEART_GLYPHS.length;
    const g = HEART_GLYPHS[frame];
    return `${g.color}${g.ch}${A.reset}`;
}

// â”€â”€ Layout constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const HEADER_HEIGHT = 12;
const INPUT_HEIGHT  = 3;
const GOAL_TEXT     = 'coherent world understanding with low contradiction and natural intelligence growth';

// â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let plasma;
let turnHistory   = [];
let showAll       = false;
let lastPromo     = null;
let _spinnerTimer = null;
let _spinnerVerb  = null;
let _spinnerStart = 0;
let _heartTimer   = null;
let _heartStart   = Date.now();
let _rl           = null;

// â”€â”€ Region colors â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function regionColor(r) {
    return { memory: A.bMagenta, reasoning: A.bBlue, language: A.bGreen, action: A.bYellow }[r] || A.white;
}
function moodColor(m) {
    return { curious: A.bCyan, engaged: A.bGreen, neutral: A.dim, uneasy: A.bYellow, conflicted: A.bRed, dormant: A.dim }[m] || A.dim;
}

// â”€â”€ Sizing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function cols() { return process.stdout.columns || 80; }
function rows() { return process.stdout.rows || 30; }
function msgZone() {
    return { top: HEADER_HEIGHT + 1, bottom: rows() - INPUT_HEIGHT, height: rows() - HEADER_HEIGHT - INPUT_HEIGHT };
}

// â”€â”€ Render Header â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function renderHeader() {
    const w = cols();
    const ds = drive.getState();
    const mc = moodColor(ds.mood);
    const vSign = ds.valence >= 0 ? '+' : '';
    const cellCount = universe.count();
    const tick = heartbeat.tickCount();
    const hbMs = heartbeat.currentInterval();

    // Left side: KAI branding
    const left = [
        `${A.bCyan}${A.bold}â”€â”€ KAI v5.0 â”€â”€${A.reset}`,
        ``,
        `  ${A.bWhite}Geometric Intelligence${A.reset}`,
        ``,
        `  ${A.bCyan}${A.bold}â•¦â•”â• â•”â•â•— â•¦${A.reset}`,
        `  ${A.bCyan}${A.bold}â• â•©â•— â• â•â•£ â•‘${A.reset}`,
        `  ${A.bCyan}${A.bold}â•© â•© â•© â•© â•©${A.reset}`,
        ``,
        `  ${A.dim}RSHL Â· Sparse Ternary Â· HDC${A.reset}`,
        `  ${A.dim}C:\\KAI${A.reset}`,
    ];

    // Right side: live status
    const right = [
        `${A.bYellow}Status${A.reset}`,
        `${A.dim}Universe:${A.reset}  ${cellCount} cells`,
        `${A.dim}Mood:${A.reset}      ${mc}${ds.mood}${A.reset} ${A.dim}V=${vSign}${ds.valence.toFixed(2)}${A.reset}`,
        `${A.dim}Heartbeat:${A.reset} ${A.bRed}â™¥${A.reset} ${A.dim}${hbMs}ms${A.reset}`,
        `${A.dim}Tick:${A.reset}      ${tick}`,
        ``,
        `${A.bYellow}Drive${A.reset}`,
        `${A.dim}Î¦g:${A.reset} ${ds.avgPhiG.toFixed(3)} ${A.dim}Ï‡:${A.reset} ${ds.avgChi.toFixed(3)}`,
        `${A.dim}Goal:${A.reset} ${ds.hasGoalVector ? `${A.bGreen}â—${A.reset} ${ds.goalComponents}` : `${A.dim}â—‹ none${A.reset}`}`,
        `${A.dim}Tempo:${A.reset} ${ds.adaptiveMs < 4000 ? `${A.bGreen}fast${A.reset}` : ds.adaptiveMs > 7000 ? `${A.dim}resting${A.reset}` : `${A.dim}moderate${A.reset}`}`,
    ];

    const maxL = Math.max(...left.map(l => stripAnsi(l).length));
    const maxR = Math.max(...right.map(l => stripAnsi(l).length));
    const maxRows = Math.max(left.length, right.length);
    const boxW = maxL + maxR + 5;
    const pad = Math.max(0, Math.floor((w - boxW) / 2));
    const sp = ' '.repeat(pad);

    process.stdout.write(moveTo(1, 1) + A.clearLine);
    process.stdout.write(sp + `${A.bCyan}â•­${'â”€'.repeat(maxL + 2)}â”¬${'â”€'.repeat(maxR + 2)}â•®${A.reset}`);

    for (let i = 0; i < maxRows; i++) {
        const l = left[i] || '';
        const r = right[i] || '';
        const lPad = maxL - stripAnsi(l).length;
        const rPad = maxR - stripAnsi(r).length;
        process.stdout.write(moveTo(i + 2, 1) + A.clearLine);
        process.stdout.write(sp + `${A.bCyan}â”‚${A.reset} ${l}${' '.repeat(Math.max(0, lPad))} ${A.bCyan}â”‚${A.reset} ${r}${' '.repeat(Math.max(0, rPad))} ${A.bCyan}â”‚${A.reset}`);
    }

    process.stdout.write(moveTo(maxRows + 2, 1) + A.clearLine);
    process.stdout.write(sp + `${A.bCyan}â•°${'â”€'.repeat(maxL + 2)}â”´${'â”€'.repeat(maxR + 2)}â•¯${A.reset}`);

    // Vitals line (row HEADER_HEIGHT) â€” animated heart + mood
    renderVitals();
}

function renderVitals() {
    const w = cols();
    const ds = drive.getState();
    const mc = moodColor(ds.mood);
    const time = Date.now() - _heartStart;
    const heart = getHeartGlyph(time);
    const vSign = ds.valence >= 0 ? '+' : '';
    const tick = heartbeat.tickCount();

    const line = `${heart} ${mc}${ds.mood}${A.reset} ${A.dim}V=${vSign}${ds.valence.toFixed(2)}${A.reset} ${A.dim}t${tick}${A.reset} ${A.dim}${heartbeat.currentInterval()}ms${A.reset}`;
    const stripped = stripAnsi(line);
    const pad = Math.max(0, Math.floor((w - stripped.length) / 2));

    process.stdout.write(A.saveCur);
    process.stdout.write(moveTo(HEADER_HEIGHT, 1) + A.clearLine);
    process.stdout.write(' '.repeat(pad) + line);
    process.stdout.write(A.restCur);
}

// â”€â”€ Spinner (KAI-style shimmer) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function startSpinner(label) {
    _spinnerVerb = label || KAI_VERBS[Math.floor(Math.random() * KAI_VERBS.length)];
    _spinnerStart = Date.now();
    const zone = msgZone();
    const w = cols();

    _spinnerTimer = setInterval(() => {
        const elapsed = Date.now() - _spinnerStart;
        const heart = getHeartGlyph(elapsed);
        const shimmer = renderShimmer(_spinnerVerb, elapsed);
        const dots = '.'.repeat((Math.floor(elapsed / 300) % 3) + 1).padEnd(3);

        const text = `${heart} ${shimmer}${A.dim}${dots}${A.reset}`;
        const stripped = stripAnsi(text);
        const pad = Math.max(0, Math.floor((w - stripped.length) / 2));

        process.stdout.write(A.saveCur);
        process.stdout.write(moveTo(zone.bottom - 1, 1) + A.clearLine);
        process.stdout.write(' '.repeat(pad) + text);
        process.stdout.write(A.restCur);
    }, 50);
}

function stopSpinner() {
    if (_spinnerTimer) { clearInterval(_spinnerTimer); _spinnerTimer = null; }
    const zone = msgZone();
    process.stdout.write(A.saveCur);
    process.stdout.write(moveTo(zone.bottom - 1, 1) + A.clearLine);
    process.stdout.write(A.restCur);
    _spinnerVerb = null;
}

// â”€â”€ Messages â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function wrapText(text, max) {
    max = Math.max(20, max || 60);
    const words = text.split(/\s+/);
    const lines = []; let cur = '';
    for (const w of words) {
        if (cur.length + w.length + 1 > max) { lines.push(cur); cur = w; }
        else cur = cur ? cur + ' ' + w : w;
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
}

function renderMessages() {
    const zone = msgZone();
    const w = cols();

    for (let r = zone.top; r <= zone.bottom; r++) {
        process.stdout.write(moveTo(r, 1) + A.clearLine);
    }

    if (!turnHistory.length) {
        const hint = `${A.dim}Just type naturally â€” KAI will understand. Type ${A.bCyan}help${A.dim} for commands.${A.reset}`;
        const stripped = stripAnsi(hint);
        const pad = Math.max(0, Math.floor((w - stripped.length) / 2));
        process.stdout.write(moveTo(zone.top + Math.floor(zone.height / 2), 1));
        process.stdout.write(' '.repeat(pad) + hint);
        return;
    }

    const visible = showAll ? turnHistory : turnHistory.slice(-4);
    const margin = Math.max(4, Math.floor(w * 0.08));
    const maxTextW = w - margin * 2 - 8;
    let row = zone.top + 1;

    for (const turn of visible) {
        if (row >= zone.bottom - 1) break;

        if (turn.role === 'user') {
            process.stdout.write(moveTo(row, 1) + A.clearLine);
            process.stdout.write(' '.repeat(margin) + `${A.dim}you â€º${A.reset}`);
            row++;
            for (const line of wrapText(turn.text, maxTextW)) {
                if (row >= zone.bottom - 1) break;
                process.stdout.write(moveTo(row, 1) + A.clearLine);
                process.stdout.write(' '.repeat(margin + 2) + `${A.white}${line}${A.reset}`);
                row++;
            }
        } else {
            process.stdout.write(moveTo(row, 1) + A.clearLine);
            let label = `${A.bCyan}KAI â€¹${A.reset}`;
            if (turn.region) label += ` ${regionColor(turn.region)}[${turn.region}]${A.reset}`;
            if (turn.score) label += ` ${A.dim}(${(turn.score * 100).toFixed(0)}%)${A.reset}`;
            process.stdout.write(' '.repeat(margin) + label);
            row++;
            for (const line of wrapText(turn.text, maxTextW)) {
                if (row >= zone.bottom - 1) break;
                process.stdout.write(moveTo(row, 1) + A.clearLine);
                process.stdout.write(' '.repeat(margin + 2) + `${A.bWhite}${line}${A.reset}`);
                row++;
            }
        }
        row++;
    }

    if (!showAll && turnHistory.length > 4) {
        process.stdout.write(moveTo(zone.bottom, 1) + A.clearLine);
        const more = `${A.dim}â†‘ ${turnHistory.length - 4} older â€” type "history"${A.reset}`;
        const s = stripAnsi(more);
        process.stdout.write(' '.repeat(Math.max(0, Math.floor((w - s.length) / 2))) + more);
    }
}

// â”€â”€ Input â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function renderInput() {
    const w = cols();
    const r = rows();
    const sepPad = Math.max(0, Math.floor((w - 56) / 2));

    process.stdout.write(moveTo(r - 2, 1) + A.clearLine);
    process.stdout.write(' '.repeat(sepPad) + `${A.dim}${'â”€'.repeat(Math.min(56, w - 8))}${A.reset}`);

    process.stdout.write(moveTo(r - 1, 1) + A.clearLine);
    process.stdout.write(' '.repeat(sepPad) + `  ${A.bCyan}â€º${A.reset} `);
}

function positionCursor() {
    const w = cols();
    const r = rows();
    const pad = Math.max(0, Math.floor((w - 56) / 2));
    process.stdout.write(moveTo(r - 1, pad + 5) + A.show);
}

function fullRedraw() {
    process.stdout.write(A.clear + A.home);
    renderHeader();
    renderMessages();
    renderInput();
    positionCursor();
}

// â”€â”€ Smart routing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function route(input) {
    const lo = input.toLowerCase().trim();
    if (lo === 'status') return { t: 'status' };
    if (lo === 'mood')   return { t: 'mood' };
    if (lo === 'drive')  return { t: 'drive' };
    if (lo === 'help' || lo === '?') return { t: 'help' };
    if (lo === 'dream')  return { t: 'dream' };
    if (lo === 'history') return { t: 'history' };
    if (lo === 'promote') return { t: 'promote' };
    if (lo === 'homeostasis') return { t: 'homeostasis' };
    if (lo === 'candidates') return { t: 'candidates' };
    if (lo === 'save')   return { t: 'save' };
    if (lo === 'quit' || lo === 'exit') return { t: 'quit' };
    if (lo.startsWith('store '))  return { t: 'store', b: input.slice(6) };
    if (lo.startsWith('ingest ')) return { t: 'ingest', b: input.slice(7) };
    if (lo.startsWith('github ')) return { t: 'github', b: input.slice(7) };
    if (lo.includes('?') || /^(what|how|why|who|when|where|do you|can you|are you|tell me)/i.test(lo))
        return { t: 'think', b: input };
    if (input.split(/\s+/).length <= 4) return { t: 'ask', b: input };
    return { t: 'think', b: input };
}

// â”€â”€ Status text â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function statusText() {
    const cells = universe.getCells();
    const cands = candidateBuffer.getAll();
    const ds = drive.getState();
    const regions = {};
    cells.forEach(c => { regions[c.region] = (regions[c.region] || 0) + 1; });
    const avgStr = cells.length ? (cells.map(c => c.strength).reduce((a, b) => a + b, 0) / cells.length).toFixed(2) : '0';
    let out = `Universe: ${cells.length} cells | Avg str: ${avgStr}\n`;
    out += `Regions: ${Object.entries(regions).map(([r,n]) => `${r}:${n}`).join(' ')}\n`;
    out += `Candidates: ${cands.length} (${cands.filter(c => c.status === 'promoted').length} promoted)\n`;
    out += `Mood: ${ds.mood} | Valence: ${ds.valence >= 0 ? '+' : ''}${ds.valence.toFixed(3)}\n`;
    out += `Goal: ${ds.hasGoalVector ? `active (${ds.goalComponents})` : 'none'}\n`;
    out += `Tempo: ${ds.adaptiveMs}ms | Tick: ${heartbeat.tickCount()}`;
    return out;
}

// â”€â”€ Boot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const args = process.argv.slice(2);
const FRESH = args.includes('--fresh');

process.stdout.write(A.altOn + A.clear + A.home);

function cleanup() {
    if (_heartTimer)   clearInterval(_heartTimer);
    if (_spinnerTimer) clearInterval(_spinnerTimer);
    process.stdout.write(A.show + A.altOff);
}
process.on('exit', cleanup);
process.on('SIGINT',  () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

// Load state
if (!FRESH && persistence.stateExists()) {
    const result = persistence.load();
    if (result.ok) {
        if (result.raw && result.raw.drive) drive.restore(result.raw.drive);
        plasma = new Plasma(false);
    } else {
        const ol = console.log; console.log = () => {}; require('./seed'); console.log = ol;
        plasma = new Plasma(false);
    }
} else {
    const ol = console.log; console.log = () => {}; require('./seed'); console.log = ol;
    plasma = new Plasma(false);
}

// Start heartbeat (silent)
heartbeat.start(plasma, {
    intervalMs: 5000,
    goalText: GOAL_TEXT,
    onTick: (summary) => {
        if (summary.promoted && summary.promoted.length) {
            lastPromo = summary.promoted[0].text;
        }
        // Refresh header vitals
        process.stdout.write(A.saveCur);
        renderHeader();
        process.stdout.write(A.restCur);
    },
});

// Start heartbeat glyph animation (updates vitals line)
_heartTimer = setInterval(renderVitals, 120);
if (_heartTimer.unref) _heartTimer.unref();

// Initial render
fullRedraw();

// Handle resize
process.stdout.on('resize', fullRedraw);

// â”€â”€ REPL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
_rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, prompt: '' });
positionCursor();

_rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { renderInput(); positionCursor(); return; }

    if (lastPromo) {
        turnHistory.push({ role: 'kai', text: `â¬† Belief formed: "${lastPromo.slice(0, 55)}"`, ts: Date.now() });
        lastPromo = null;
    }

    showAll = false;
    const r = route(input);

    switch (r.t) {
        case 'help':
            turnHistory.push({ role: 'user', text: input, ts: Date.now() });
            turnHistory.push({ role: 'kai', text: 'Just type naturally. Questions synthesize, short words search. Commands: status, mood, drive, dream, store <text>, ingest <text>, candidates, history, save, quit', ts: Date.now() });
            break;

        case 'history':
            showAll = true;
            renderMessages(); renderInput(); positionCursor();
            return;

        case 'ask': {
            turnHistory.push({ role: 'user', text: input, ts: Date.now() });
            renderMessages();
            startSpinner();
            const hits = universe.query(r.b, 5);
            stopSpinner();
            if (!hits.length || hits[0].score < 0.45) {
                turnHistory.push({ role: 'kai', text: `No strong resonance for "${r.b}"`, ts: Date.now() });
            } else {
                turnHistory.push({ role: 'kai', text: hits[0].text, region: hits[0].region, score: hits[0].score, ts: Date.now() });
            }
            break;
        }

        case 'think': {
            turnHistory.push({ role: 'user', text: input, ts: Date.now() });
            renderMessages();
            startSpinner('Synthesizing');
            const result = generateToResult(r.b, 5);
            stopSpinner();
            if (result.confidence < 0.3) {
                const hits = universe.query(r.b, 3);
                if (hits.length && hits[0].score > 0.5) {
                    turnHistory.push({ role: 'kai', text: hits[0].text, region: hits[0].region, score: hits[0].score, ts: Date.now() });
                } else {
                    turnHistory.push({ role: 'kai', text: "Can't form a strong thought on that yet.", ts: Date.now() });
                }
            } else {
                let resp = `"${result.thought}"`;
                if (result.matches.length) {
                    const src = result.matches.slice(0, 2).map(m => `${m.region}(${(m.score*100).toFixed(0)}%)`).join(', ');
                    resp += ` [${(result.confidence * 100).toFixed(0)}% Â· ${src}]`;
                }
                turnHistory.push({ role: 'kai', text: resp, score: result.confidence, ts: Date.now() });
            }
            break;
        }

        case 'store': {
            turnHistory.push({ role: 'user', text: input, ts: Date.now() });
            startSpinner('Storing');
            universe.store(r.b, 'memory', { source: 'user-input' });
            stopSpinner();
            turnHistory.push({ role: 'kai', text: 'âœ“ Stored in memory region', region: 'memory', ts: Date.now() });
            process.stdout.write(A.saveCur); renderHeader(); process.stdout.write(A.restCur);
            break;
        }

        case 'ingest': {
            turnHistory.push({ role: 'user', text: input, ts: Date.now() });
            startSpinner('Ingesting');
            const ir = bridge.ingest(r.b, { source: 'manual', topic: 'user-ingest' });
            stopSpinner();
            turnHistory.push({ role: 'kai', text: ir.stored ? 'âœ“ Ingested (untrusted, str 0.6)' : `âœ— Skipped: ${ir.reason}`, ts: Date.now() });
            break;
        }

        case 'github': {
            const [owner, repo] = r.b.split('/');
            if (!owner || !repo) { turnHistory.push({ role: 'kai', text: 'Usage: github owner/repo', ts: Date.now() }); break; }
            turnHistory.push({ role: 'user', text: input, ts: Date.now() });
            startSpinner('Fetching GitHub');
            try {
                const gr = await bridge.ingestFromGitHub(owner, repo);
                stopSpinner();
                turnHistory.push({ role: 'kai', text: `âœ“ ${gr.stored} stored, ${gr.skipped} skipped`, ts: Date.now() });
            } catch (e) {
                stopSpinner();
                turnHistory.push({ role: 'kai', text: `âœ— ${e.message}`, ts: Date.now() });
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
                turnHistory.push({ role: 'kai', text: `ðŸ’­ "${dr.insight.slice(0, 65)}" (Î¦g:${dr.field.phi_g.toFixed(3)} C:${dr.field.C.toFixed(3)})`, ts: Date.now() });
            } else {
                turnHistory.push({ role: 'kai', text: 'No viable dream pair found.', ts: Date.now() });
            }
            break;
        }

        case 'promote': {
            startSpinner('Checking');
            const pr = runPromotion();
            stopSpinner();
            if (pr.promoted.length) {
                pr.promoted.forEach(p => turnHistory.push({ role: 'kai', text: `â¬† "${p.text.slice(0,55)}" (str=${p.strength.toFixed(1)})`, ts: Date.now() }));
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

        case 'status':
            turnHistory.push({ role: 'user', text: 'status', ts: Date.now() });
            turnHistory.push({ role: 'kai', text: statusText(), ts: Date.now() });
            break;

        case 'mood': {
            const ds = drive.getState();
            turnHistory.push({ role: 'user', text: 'mood', ts: Date.now() });
            turnHistory.push({ role: 'kai', text: `${ds.mood.toUpperCase()} Â· V=${ds.valence >= 0 ? '+' : ''}${ds.valence.toFixed(3)} Â· Î¦g=${ds.avgPhiG.toFixed(4)} Â· Ï‡=${ds.avgChi.toFixed(4)} Â· ${ds.adaptiveMs}ms`, ts: Date.now() });
            break;
        }

        case 'drive': {
            const ds = drive.getState();
            const vh = drive.getValenceHistory();
            const spark = vh.slice(-15).map(v => v > 0.05 ? 'â–²' : v > 0 ? 'â–³' : v > -0.05 ? 'â”€' : 'â–¼').join('');
            turnHistory.push({ role: 'user', text: 'drive', ts: Date.now() });
            turnHistory.push({ role: 'kai', text: `${ds.mood} | V=${ds.valence.toFixed(3)} | Goal: ${ds.hasGoalVector ? 'active' : 'none'} (${ds.goalComponents}) | ${ds.adaptiveMs}ms\n${spark || 'â”€'}`, ts: Date.now() });
            break;
        }

        case 'candidates': {
            const allC = candidateBuffer.getAll().sort((a, b) => b.seenCount - a.seenCount);
            turnHistory.push({ role: 'user', text: 'candidates', ts: Date.now() });
            if (!allC.length) { turnHistory.push({ role: 'kai', text: 'No candidates.', ts: Date.now() }); }
            else {
                turnHistory.push({ role: 'kai', text: allC.slice(0,5).map(c => `[${c.status}] seen=${c.seenCount} "${c.text.slice(0,40)}"`).join('\n'), ts: Date.now() });
            }
            break;
        }

        case 'save': {
            startSpinner('Saving');
            const sr = persistence.save({ heartbeatTick: heartbeat.tickCount(), drive: drive.serialize() });
            stopSpinner();
            turnHistory.push({ role: 'kai', text: `ðŸ’¾ Saved ${sr.cells} cells, ${sr.candidates} candidates (${Math.round(sr.bytes/1024)} KB)`, ts: Date.now() });
            break;
        }

        case 'quit':
            heartbeat.stop();
            persistence.save({ heartbeatTick: heartbeat.tickCount(), drive: drive.serialize() });
            cleanup();
            console.log('\n  KAI dormant. State preserved.\n');
            process.exit(0);
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
