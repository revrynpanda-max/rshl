"use strict";

/**
 * kai-ui.js — Premium KAI Terminal Interface
 *
 * A polished, conversational CLI with:
 *   - Colored header with version/status box
 *   - Animated thinking spinner
 *   - Natural language input (no command prefixes needed)
 *   - Heartbeat runs silently — mood/valence shown in prompt
 *   - Clean, styled output with color-coded regions
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

// ── ANSI color codes ──────────────────────────────────────────────────────────
const C = {
    reset:    '\x1b[0m',
    bold:     '\x1b[1m',
    dim:      '\x1b[2m',
    italic:   '\x1b[3m',
    // Foreground
    black:    '\x1b[30m',
    red:      '\x1b[31m',
    green:    '\x1b[32m',
    yellow:   '\x1b[33m',
    blue:     '\x1b[34m',
    magenta:  '\x1b[35m',
    cyan:     '\x1b[36m',
    white:    '\x1b[37m',
    // Bright
    bRed:     '\x1b[91m',
    bGreen:   '\x1b[92m',
    bYellow:  '\x1b[93m',
    bBlue:    '\x1b[94m',
    bMagenta: '\x1b[95m',
    bCyan:    '\x1b[96m',
    bWhite:   '\x1b[97m',
    // Background
    bgBlack:  '\x1b[40m',
    bgRed:    '\x1b[41m',
    bgGreen:  '\x1b[42m',
    bgYellow: '\x1b[43m',
    bgBlue:   '\x1b[44m',
    bgMagenta:'\x1b[45m',
    bgCyan:   '\x1b[46m',
    bgWhite:  '\x1b[47m',
    bgGray:   '\x1b[100m',
    // Cursor
    clearLine:'\x1b[2K',
    cursorUp: '\x1b[1A',
    hide:     '\x1b[?25l',
    show:     '\x1b[?25h',
};

// ── Animated Spinner ──────────────────────────────────────────────────────────
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_WORDS = [
    'Resonating', 'Binding', 'Dreaming', 'Bundling', 'Searching',
    'Weaving', 'Recalling', 'Synthesizing', 'Aligning', 'Emerging',
];

let _spinnerTimer = null;
let _spinnerFrame = 0;

function startSpinner(label) {
    _spinnerFrame = 0;
    const word = label || SPINNER_WORDS[Math.floor(Math.random() * SPINNER_WORDS.length)];
    process.stdout.write(C.hide);
    _spinnerTimer = setInterval(() => {
        const frame = SPINNER_FRAMES[_spinnerFrame % SPINNER_FRAMES.length];
        process.stdout.write(`\r${C.clearLine}  ${C.bCyan}${frame}${C.reset} ${C.cyan}${word}${C.dim}...${C.reset}`);
        _spinnerFrame++;
    }, 80);
}

function stopSpinner() {
    if (_spinnerTimer) {
        clearInterval(_spinnerTimer);
        _spinnerTimer = null;
    }
    process.stdout.write(`\r${C.clearLine}${C.show}`);
}

// ── Box drawing ───────────────────────────────────────────────────────────────
function drawBox(lines, color = C.bCyan) {
    const maxLen = Math.max(...lines.map(l => stripAnsi(l).length), 20);
    const top    = `${color}╭${'─'.repeat(maxLen + 2)}╮${C.reset}`;
    const bottom = `${color}╰${'─'.repeat(maxLen + 2)}╯${C.reset}`;
    const mid    = lines.map(l => {
        const stripped = stripAnsi(l);
        const pad = maxLen - stripped.length;
        return `${color}│${C.reset} ${l}${' '.repeat(Math.max(0, pad))} ${color}│${C.reset}`;
    }).join('\n');
    return `${top}\n${mid}\n${bottom}`;
}

function stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// ── Region colors ─────────────────────────────────────────────────────────────
function regionColor(region) {
    const map = {
        memory:    C.bMagenta,
        reasoning: C.bBlue,
        language:  C.bGreen,
        action:    C.bYellow,
    };
    return map[region] || C.white;
}

// ── Mood display ──────────────────────────────────────────────────────────────
function moodDisplay() {
    const ds = drive.getState();
    const icons = {
        curious: '🔍', engaged: '⚡', neutral: '·',
        uneasy: '😟', conflicted: '⚔️', dormant: '💤'
    };
    const colors = {
        curious: C.bCyan, engaged: C.bGreen, neutral: C.dim,
        uneasy: C.bYellow, conflicted: C.bRed, dormant: C.dim,
    };
    const icon = icons[ds.mood] || '·';
    const col = colors[ds.mood] || C.dim;
    const v = ds.valence >= 0 ? `+${ds.valence.toFixed(2)}` : ds.valence.toFixed(2);
    return `${icon}${col}${ds.mood}${C.reset} ${C.dim}V=${v}${C.reset}`;
}

// ── Prompt ─────────────────────────────────────────────────────────────────────
function getPrompt() {
    return `\n  ${C.bCyan}>${C.reset} `;
}

// ── Header ────────────────────────────────────────────────────────────────────
function renderHeader(cellCount, mood, savedAt) {
    const version = 'v5.0';
    const kaiArt = [
        `${C.bCyan}${C.bold}    ╦╔═ ╔═╗ ╦${C.reset}`,
        `${C.bCyan}${C.bold}    ╠╩╗ ╠═╣ ║${C.reset}`,
        `${C.bCyan}${C.bold}    ╩ ╩ ╩ ╩ ╩${C.reset}`,
    ];

    const leftLines = [
        `${C.bCyan}${C.bold}─── KAI ${version} ───${C.reset}`,
        ``,
        `  ${C.bWhite}Geometric Intelligence${C.reset}`,
        ...kaiArt,
        ``,
        `  ${C.dim}RSHL · Sparse Ternary · HDC${C.reset}`,
        `  ${C.dim}C:\\KAI${C.reset}`,
    ];

    const rightLines = [
        `${C.bYellow}Status${C.reset}`,
        `${C.dim}Universe: ${C.reset}${cellCount} cells`,
        `${C.dim}Mood:     ${C.reset}${mood}`,
        `${C.dim}Heartbeat:${C.reset} ${C.bGreen}♥ adaptive${C.reset}`,
        ``,
        `${C.bYellow}Saved${C.reset}`,
        `${C.dim}${savedAt || 'Fresh boot'}${C.reset}`,
    ];

    // Render side-by-side box
    const maxLeft = Math.max(...leftLines.map(l => stripAnsi(l).length));
    const maxRight = Math.max(...rightLines.map(l => stripAnsi(l).length));
    const maxRows = Math.max(leftLines.length, rightLines.length);

    const hBar = `${C.bCyan}─${C.reset}`;
    const topLine = `  ${C.bCyan}╭${'─'.repeat(maxLeft + 2)}┬${'─'.repeat(maxRight + 2)}╮${C.reset}`;
    const midLine = `  ${C.bCyan}├${'─'.repeat(maxLeft + 2)}┼${'─'.repeat(maxRight + 2)}┤${C.reset}`;
    const botLine = `  ${C.bCyan}╰${'─'.repeat(maxLeft + 2)}┴${'─'.repeat(maxRight + 2)}╯${C.reset}`;

    let output = '\n' + topLine + '\n';
    for (let i = 0; i < maxRows; i++) {
        const left  = leftLines[i] || '';
        const right = rightLines[i] || '';
        const lPad = maxLeft - stripAnsi(left).length;
        const rPad = maxRight - stripAnsi(right).length;
        output += `  ${C.bCyan}│${C.reset} ${left}${' '.repeat(Math.max(0, lPad))} ${C.bCyan}│${C.reset} ${right}${' '.repeat(Math.max(0, rPad))} ${C.bCyan}│${C.reset}\n`;
    }
    output += botLine;
    return output;
}

// ── Format response ───────────────────────────────────────────────────────────
function formatResponse(text, region, score) {
    const rc = regionColor(region);
    const scoreBar = score ? ` ${C.dim}(${(score * 100).toFixed(0)}% resonance)${C.reset}` : '';
    const regionTag = region ? `${rc}[${region}]${C.reset}` : '';
    return `\n  ${regionTag}${scoreBar}\n  ${C.bWhite}${text}${C.reset}\n`;
}

function formatThought(thought, confidence, matches) {
    let out = `\n  ${C.bCyan}💡 Synthesized thought${C.reset} ${C.dim}(${(confidence * 100).toFixed(0)}% confidence)${C.reset}\n`;
    out += `  ${C.bWhite}${C.bold}"${thought}"${C.reset}\n`;
    if (matches && matches.length) {
        out += `\n  ${C.dim}Sources:${C.reset}\n`;
        matches.slice(0, 3).forEach(m => {
            const rc = regionColor(m.region);
            out += `  ${rc}${m.region}${C.reset} ${C.dim}(${(m.score * 100).toFixed(0)}%)${C.reset} ${C.dim}${m.text.slice(0, 55)}${C.reset}\n`;
        });
    }
    return out;
}

function formatStatus() {
    const cells = universe.getCells();
    const cands = candidateBuffer.getAll();
    const promoted_count = cands.filter(c => c.status === 'promoted').length;
    const ds = drive.getState();
    const vh = drive.getValenceHistory();

    const regions = {};
    cells.forEach(c => { regions[c.region] = (regions[c.region] || 0) + 1; });
    const strengths = cells.map(c => c.strength);
    const avgStr = strengths.length ? strengths.reduce((a, b) => a + b, 0) / strengths.length : 0;

    let out = `\n  ${C.bCyan}${C.bold}── KAI System Status ──${C.reset}\n\n`;

    // Field
    out += `  ${C.bWhite}Field${C.reset}\n`;
    out += `  ${C.dim}Universe:${C.reset}     ${cells.length} cells  ${C.dim}|${C.reset}  ${C.dim}Avg str:${C.reset} ${avgStr.toFixed(2)}\n`;
    out += `  ${C.dim}Regions:${C.reset}      `;
    for (const [r, n] of Object.entries(regions)) {
        out += `${regionColor(r)}${r}${C.reset}:${n}  `;
    }
    out += `\n  ${C.dim}Candidates:${C.reset}   ${cands.length} ${C.dim}(${promoted_count} promoted)${C.reset}\n\n`;

    // Drive
    out += `  ${C.bWhite}Drive${C.reset}\n`;
    const moodColors = { curious: C.bCyan, engaged: C.bGreen, neutral: C.dim, uneasy: C.bYellow, conflicted: C.bRed, dormant: C.dim };
    const mc = moodColors[ds.mood] || C.dim;
    out += `  ${C.dim}Mood:${C.reset}         ${mc}${ds.mood}${C.reset}\n`;
    const vSign = ds.valence >= 0 ? '+' : '';
    out += `  ${C.dim}Valence:${C.reset}      ${vSign}${ds.valence.toFixed(4)}\n`;
    out += `  ${C.dim}avgΦg:${C.reset}        ${ds.avgPhiG.toFixed(4)}  ${C.dim}|${C.reset}  ${C.dim}avgχ:${C.reset} ${ds.avgChi.toFixed(4)}\n`;
    out += `  ${C.dim}Goal:${C.reset}         ${ds.hasGoalVector ? `${C.bGreen}active${C.reset} (${ds.goalComponents} beliefs)` : `${C.dim}not yet built${C.reset}`}\n\n`;

    // Heartbeat
    out += `  ${C.bWhite}Heartbeat${C.reset}\n`;
    out += `  ${C.dim}Status:${C.reset}       ${heartbeat.isRunning() ? `${C.bGreen}♥ running${C.reset}` : `${C.bRed}✗ stopped${C.reset}`}\n`;
    out += `  ${C.dim}Tick:${C.reset}         ${heartbeat.tickCount()}\n`;
    out += `  ${C.dim}Tempo:${C.reset}        ${heartbeat.currentInterval()}ms ${C.dim}(${ds.adaptiveMs < 4000 ? 'fast' : ds.adaptiveMs > 7000 ? 'resting' : 'moderate'})${C.reset}\n`;

    // Valence sparkline
    if (vh.length > 2) {
        const spark = vh.slice(-20).map(v => {
            if (v > 0.1) return `${C.bGreen}▲${C.reset}`;
            if (v > 0.02) return `${C.green}△${C.reset}`;
            if (v > -0.02) return `${C.dim}─${C.reset}`;
            if (v > -0.1) return `${C.yellow}▽${C.reset}`;
            return `${C.bRed}▼${C.reset}`;
        }).join('');
        out += `  ${C.dim}Valence:${C.reset}      ${spark}\n`;
    }

    return out;
}

// ── Smart input routing ───────────────────────────────────────────────────────
// No need to type "ask" or "think" — just type naturally
function routeInput(input) {
    const lower = input.toLowerCase().trim();

    // Explicit commands
    if (lower === 'status')      return { type: 'status' };
    if (lower === 'mood')        return { type: 'mood' };
    if (lower === 'drive')       return { type: 'drive' };
    if (lower === 'help' || lower === '?') return { type: 'help' };
    if (lower === 'dream')       return { type: 'dream' };
    if (lower === 'promote')     return { type: 'promote' };
    if (lower === 'homeostasis') return { type: 'homeostasis' };
    if (lower === 'candidates')  return { type: 'candidates' };
    if (lower === 'save')        return { type: 'save' };
    if (lower === 'quit' || lower === 'exit') return { type: 'quit' };
    if (lower.startsWith('store '))  return { type: 'store', body: input.slice(6) };
    if (lower.startsWith('ingest ')) return { type: 'ingest', body: input.slice(7) };
    if (lower.startsWith('github ')) return { type: 'github', body: input.slice(7) };

    // Questions → generative synthesis (think)
    if (lower.includes('?') || lower.startsWith('what') || lower.startsWith('how') ||
        lower.startsWith('why') || lower.startsWith('who') || lower.startsWith('when') ||
        lower.startsWith('where') || lower.startsWith('do you') || lower.startsWith('can you') ||
        lower.startsWith('are you') || lower.startsWith('tell me')) {
        return { type: 'think', body: input };
    }

    // Short inputs → resonance search
    if (input.split(/\s+/).length <= 4) {
        return { type: 'ask', body: input };
    }

    // Longer inputs → try think first, fall back to ask
    return { type: 'think', body: input };
}

// ── Boot ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const FRESH = args.includes('--fresh');
const GOAL_TEXT = 'coherent world understanding with low contradiction and natural intelligence growth';

let plasma;
let savedAt = null;
let lastPromotion = null;

// Clear screen
process.stdout.write('\x1b[2J\x1b[H');

if (!FRESH && persistence.stateExists()) {
    const info = persistence.getStateInfo();
    savedAt = info.savedAt;
    const result = persistence.load();
    if (result.ok) {
        if (result.raw && result.raw.drive) {
            drive.restore(result.raw.drive);
        }
        plasma = new Plasma(false);
    } else {
        require('./seed');
        plasma = new Plasma(false);
    }
} else {
    require('./seed');
    plasma = new Plasma(false);
}

// Render header
const header = renderHeader(
    universe.count(),
    moodDisplay(),
    savedAt ? new Date(savedAt).toLocaleString() : null
);
console.log(header);

// Start heartbeat (silent — drive shows mood in prompt)
heartbeat.start(plasma, {
    intervalMs: 5000,
    goalText: GOAL_TEXT,
    onTick: (summary) => {
        // Silent — no tick spam. Drive updates internally.
        // Track promotions to announce them
        if (summary.promoted && summary.promoted.length) {
            lastPromotion = summary.promoted[0];
        }
    },
});

console.log(`\n  ${C.dim}Heartbeat running. Just type naturally — KAI will understand.${C.reset}`);
console.log(`  ${C.dim}Type ${C.bCyan}help${C.dim} for commands, or just talk.${C.reset}`);

// ── REPL ──────────────────────────────────────────────────────────────────────
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: getPrompt(),
});

rl.prompt();

rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // Announce any promotions that happened since last input
    if (lastPromotion) {
        console.log(`\n  ${C.bMagenta}⬆ Belief formed:${C.reset} ${C.dim}"${lastPromotion.text.slice(0, 60)}"${C.reset}`);
        lastPromotion = null;
    }

    const route = routeInput(input);

    switch (route.type) {
        case 'help':
            console.log(`\n  ${C.bCyan}${C.bold}── KAI Commands ──${C.reset}\n`);
            console.log(`  ${C.bWhite}Just type naturally${C.reset} ${C.dim}— KAI detects questions vs statements${C.reset}`);
            console.log(`  ${C.dim}Questions auto-synthesize, short phrases auto-search${C.reset}\n`);
            console.log(`  ${C.bCyan}status${C.reset}         ${C.dim}Field + drive + heartbeat overview${C.reset}`);
            console.log(`  ${C.bCyan}mood${C.reset}           ${C.dim}Current mood, valence, tempo${C.reset}`);
            console.log(`  ${C.bCyan}drive${C.reset}          ${C.dim}Full drive system snapshot${C.reset}`);
            console.log(`  ${C.bCyan}dream${C.reset}          ${C.dim}Trigger a manual dream cycle${C.reset}`);
            console.log(`  ${C.bCyan}store ${C.italic}<text>${C.reset}   ${C.dim}Store a memory directly${C.reset}`);
            console.log(`  ${C.bCyan}ingest ${C.italic}<text>${C.reset}  ${C.dim}Ingest via world bridge (untrusted)${C.reset}`);
            console.log(`  ${C.bCyan}candidates${C.reset}     ${C.dim}Show candidate buffer${C.reset}`);
            console.log(`  ${C.bCyan}save${C.reset}           ${C.dim}Force save state${C.reset}`);
            console.log(`  ${C.bCyan}quit${C.reset}           ${C.dim}Save and exit${C.reset}`);
            break;

        case 'ask': {
            startSpinner();
            const hits = universe.query(route.body, 5);
            stopSpinner();
            if (!hits.length || hits[0].score < 0.45) {
                console.log(`\n  ${C.dim}No strong resonance found for "${route.body}"${C.reset}`);
            } else {
                console.log(formatResponse(hits[0].text, hits[0].region, hits[0].score));
                if (hits.length > 1 && hits[1].score > 0.5) {
                    console.log(`  ${C.dim}Also:${C.reset} ${C.dim}${hits[1].text.slice(0, 60)}${C.reset} ${C.dim}(${(hits[1].score * 100).toFixed(0)}%)${C.reset}`);
                }
            }
            break;
        }

        case 'think': {
            startSpinner('Synthesizing');
            const result = generateToResult(route.body, 5);
            stopSpinner();
            if (result.confidence < 0.3) {
                console.log(`\n  ${C.dim}Couldn't form a strong thought about that yet.${C.reset}`);
                // Fall back to resonance search
                const hits = universe.query(route.body, 3);
                if (hits.length && hits[0].score > 0.5) {
                    console.log(formatResponse(hits[0].text, hits[0].region, hits[0].score));
                }
            } else {
                console.log(formatThought(result.thought, result.confidence, result.matches));
            }
            break;
        }

        case 'store': {
            startSpinner('Storing');
            const sid = universe.store(route.body, 'memory', { source: 'user-input' });
            stopSpinner();
            console.log(`\n  ${C.bGreen}✓${C.reset} Stored in ${C.bMagenta}memory${C.reset} region\n`);
            break;
        }

        case 'ingest': {
            startSpinner('Ingesting');
            const ir = bridge.ingest(route.body, { source: 'manual', topic: 'user-ingest' });
            stopSpinner();
            if (ir.stored) {
                console.log(`\n  ${C.bGreen}✓${C.reset} Ingested ${C.dim}(untrusted, strength 0.6)${C.reset}\n`);
            } else {
                console.log(`\n  ${C.bYellow}✗${C.reset} Skipped: ${ir.reason}\n`);
            }
            break;
        }

        case 'github': {
            const [owner, repo] = route.body.split('/');
            if (!owner || !repo) {
                console.log(`\n  ${C.dim}Usage: github owner/repo${C.reset}`);
                break;
            }
            startSpinner('Fetching from GitHub');
            try {
                const gr = await bridge.ingestFromGitHub(owner, repo);
                stopSpinner();
                console.log(`\n  ${C.bGreen}✓${C.reset} ${gr.stored} stored, ${gr.skipped} skipped\n`);
            } catch (e) {
                stopSpinner();
                console.log(`\n  ${C.bRed}✗${C.reset} ${e.message}\n`);
            }
            break;
        }

        case 'dream': {
            startSpinner('Dreaming');
            const dr = consolidate(plasma, { goalText: GOAL_TEXT });
            stopSpinner();
            if (dr) {
                candidateBuffer.observe(dr);
                console.log(`\n  ${C.bMagenta}💭 Dream:${C.reset} ${C.bWhite}"${dr.insight.slice(0, 70)}"${C.reset}`);
                console.log(`  ${C.dim}Confidence: ${(dr.confidence * 100).toFixed(0)}%  Φg: ${dr.field.phi_g.toFixed(3)}  C: ${dr.field.C.toFixed(3)}${C.reset}\n`);
            } else {
                console.log(`\n  ${C.dim}No viable dream pair found.${C.reset}\n`);
            }
            break;
        }

        case 'promote': {
            startSpinner('Checking promotions');
            const pr = runPromotion();
            stopSpinner();
            if (pr.promoted.length) {
                pr.promoted.forEach(p => {
                    console.log(`\n  ${C.bMagenta}⬆ Promoted:${C.reset} ${C.bWhite}"${p.text.slice(0, 60)}"${C.reset}`);
                    console.log(`  ${C.dim}seen=${p.seenCount} strength=${p.strength.toFixed(2)}${C.reset}`);
                });
            } else {
                console.log(`\n  ${C.dim}No promotions ready.${C.reset}`);
            }
            console.log();
            break;
        }

        case 'homeostasis': {
            const hr = runHomeostasis();
            console.log(`\n  ${C.dim}Decayed: ${hr.decayed.length}  Pruned: ${hr.pruned.length}${C.reset}\n`);
            break;
        }

        case 'status':
            console.log(formatStatus());
            break;

        case 'mood': {
            const ds = drive.getState();
            const moodColors = { curious: C.bCyan, engaged: C.bGreen, neutral: C.dim, uneasy: C.bYellow, conflicted: C.bRed, dormant: C.dim };
            const mc = moodColors[ds.mood] || C.dim;
            const vSign = ds.valence >= 0 ? '+' : '';
            console.log(`\n  ${mc}${C.bold}${ds.mood.toUpperCase()}${C.reset}  ${C.dim}valence: ${vSign}${ds.valence.toFixed(3)}${C.reset}`);
            console.log(`  ${C.dim}Φg: ${ds.avgPhiG.toFixed(4)}  χ: ${ds.avgChi.toFixed(4)}  tempo: ${ds.adaptiveMs}ms${C.reset}`);
            console.log(`  ${C.dim}Goal: ${ds.goalComponents} components${C.reset}\n`);
            break;
        }

        case 'drive': {
            const ds = drive.getState();
            const vh = drive.getValenceHistory();
            console.log(`\n  ${C.bCyan}${C.bold}── Drive System ──${C.reset}\n`);
            console.log(`  ${C.dim}Mood:${C.reset}      ${ds.mood}`);
            console.log(`  ${C.dim}Valence:${C.reset}   ${ds.valence >= 0 ? '+' : ''}${ds.valence.toFixed(4)}`);
            console.log(`  ${C.dim}avgΦg:${C.reset}     ${ds.avgPhiG.toFixed(4)}`);
            console.log(`  ${C.dim}avgχ:${C.reset}      ${ds.avgChi.toFixed(4)}`);
            console.log(`  ${C.dim}Goal:${C.reset}      ${ds.hasGoalVector ? `active (${ds.goalComponents} beliefs)` : 'not yet built'}`);
            console.log(`  ${C.dim}Tempo:${C.reset}     ${ds.adaptiveMs}ms → ${heartbeat.currentInterval()}ms actual`);
            if (vh.length > 2) {
                const spark = vh.slice(-20).map(v => {
                    if (v > 0.1) return `${C.bGreen}▲${C.reset}`;
                    if (v > 0.02) return `${C.green}△${C.reset}`;
                    if (v > -0.02) return `${C.dim}─${C.reset}`;
                    if (v > -0.1) return `${C.yellow}▽${C.reset}`;
                    return `${C.bRed}▼${C.reset}`;
                }).join('');
                console.log(`  ${C.dim}History:${C.reset}   ${spark}`);
            }
            console.log();
            break;
        }

        case 'candidates': {
            const allCands = candidateBuffer.getAll().sort((a, b) => b.seenCount - a.seenCount);
            if (!allCands.length) { console.log(`\n  ${C.dim}No candidates.${C.reset}\n`); break; }
            console.log(`\n  ${C.bCyan}${C.bold}── Candidates (${allCands.length}) ──${C.reset}\n`);
            allCands.slice(0, 10).forEach(c => {
                const statusColor = c.status === 'promoted' ? C.bGreen : c.status === 'rejected' ? C.bRed : C.bYellow;
                console.log(`  ${statusColor}${c.status.toUpperCase().padEnd(9)}${C.reset} ${C.dim}seen=${c.seenCount} C=${c.bestC.toFixed(3)} Φ=${c.bestPhi_g.toFixed(3)}${C.reset} "${c.text.slice(0, 45)}"`);
            });
            console.log();
            break;
        }

        case 'save': {
            startSpinner('Saving');
            const sr = persistence.save({ heartbeatTick: heartbeat.tickCount(), drive: drive.serialize() });
            stopSpinner();
            console.log(`\n  ${C.bGreen}💾${C.reset} Saved ${sr.cells} cells, ${sr.candidates} candidates ${C.dim}(${Math.round(sr.bytes / 1024)} KB)${C.reset}\n`);
            break;
        }

        case 'quit': {
            heartbeat.stop();
            const fr = persistence.save({ heartbeatTick: heartbeat.tickCount(), drive: drive.serialize() });
            console.log(`\n  ${C.bGreen}💾${C.reset} Saved ${fr.cells} cells`);
            console.log(`  ${C.dim}Mood at shutdown: ${drive.getMood()} (V=${drive.getValence().toFixed(3)})${C.reset}`);
            console.log(`\n  ${C.bCyan}KAI entering dormancy.${C.reset}\n`);
            process.exit(0);
        }
    }

    rl.prompt();
});

rl.on('close', () => {
    heartbeat.stop();
    persistence.save({ heartbeatTick: heartbeat.tickCount(), drive: drive.serialize() });
    console.log(`\n  ${C.bCyan}KAI dormant.${C.reset}\n`);
    process.exit(0);
});
