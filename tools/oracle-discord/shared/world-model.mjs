// shared/world-model.mjs
// ──────────────────────────────────────────────────────────────────────────────
// KAI World Model — a live simulation of ecosystem state.
//
// PURPOSE
//   Give KAI a coherent picture of "what's happening right now" so its
//   responses are grounded in real context rather than just pattern-matching
//   the user's text. KAI should know:
//     - What time it is and what phase of day/week
//     - Which bots are online and healthy vs. stressed
//     - What the lattice vitals look like
//     - What recent events happened in the ecosystem
//     - What conversations have been active
//
// USAGE
//   import { worldModel, getWorldSnapshot, recordWorldEvent } from './world-model.mjs';
//   worldModel.start();   // begin polling in background
//   const snap = getWorldSnapshot(); // get current state string for prompts
// ──────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, '..', '..', '..', 'state', 'world-model.json');

function _saveWorldState() {
  try {
    const dir = path.dirname(STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify({
      lattice: state.lattice,
      events:  state.events.slice(-20),
      saved_at: new Date().toISOString(),
    }, null, 2));
  } catch (_) {}
}

function _loadWorldState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (raw.lattice) Object.assign(state.lattice, raw.lattice);
    if (Array.isArray(raw.events)) {
      const cutoff = Date.now() - 2 * 60 * 60_000;
      state.events.push(...raw.events.filter(e => e.ts > cutoff));
    }
    console.log('[WorldModel] State restored from disk.');
  } catch (_) {}
}

// ── Internal state ────────────────────────────────────────────────────────────

const state = {
  // Lattice vitals
  lattice: {
    cell_count: null,
    phi_g:      null,
    chi:        null,
    mood:       null,
    tick:       null,
    online:     false,
    last_check: 0,
  },

  // Bot health: name -> { online, last_seen, stress }
  bots: {},

  // Recent ecosystem events (last 50)
  events: [],

  // Conversation activity: channelId -> { last_msg_ts, msg_count_10m, speakers }
  channels: {},

  // Physical world
  clock: {
    hour:    null,
    day:     null,
    phase:   null, // dawn/morning/afternoon/evening/night
    is_work: false,
  },
};

const MAX_EVENTS = 50;

// ── Clock ─────────────────────────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  const h   = now.getHours();
  const day = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()];
  let phase;
  if (h >= 5  && h < 8)  phase = 'dawn';
  else if (h >= 8  && h < 12) phase = 'morning';
  else if (h >= 12 && h < 17) phase = 'afternoon';
  else if (h >= 17 && h < 21) phase = 'evening';
  else                          phase = 'night';
  const isWork = !['Saturday','Sunday'].includes(day) && h >= 9 && h < 23;
  state.clock = { hour: h, day, phase, is_work: isWork };
}

// ── Lattice vitals poll ───────────────────────────────────────────────────────
async function pollLattice() {
  // Try /api/status first (lighter endpoint)
  try {
    const res = await fetch('http://127.0.0.1:3334/api/status', {
      signal: AbortSignal.timeout(4000)
    });
    if (res.ok) {
      const d = await res.json().catch(() => null);
      if (d) {
        state.lattice = {
          cell_count: d.lattice_size ?? state.lattice.cell_count,
          phi_g:      d.phi_g       ?? state.lattice.phi_g,
          chi:        d.chi         ?? state.lattice.chi,
          mood:       d.mood        ?? state.lattice.mood,
          tick:       null,
          online:     true,
          last_check: Date.now(),
        };
        return;
      }
    }
  } catch (_) {}

  // Fallback: /api/session has vitals too
  try {
    const res2 = await fetch('http://127.0.0.1:3334/api/session', {
      signal: AbortSignal.timeout(4000)
    });
    if (res2.ok) {
      const d2 = await res2.json().catch(() => null);
      const v  = d2?.vitals || d2 || {};
      if (v.cell_count) {
        state.lattice = {
          cell_count: v.cell_count,
          phi_g:      v.phi_g,
          chi:        v.chi,
          mood:       v.mood,
          tick:       v.tick,
          online:     true,
          last_check: Date.now(),
        };
        return;
      }
    }
  } catch (_) {}

  state.lattice.online = false;
}


// ── Event recording ───────────────────────────────────────────────────────────
export function recordWorldEvent(type, detail, severity = 'info') {
  state.events.push({ ts: Date.now(), type, detail, severity });
  if (state.events.length > MAX_EVENTS) state.events.shift();
}

// ── Bot registration ──────────────────────────────────────────────────────────
export function registerBot(name, port) {
  if (!state.bots[name]) {
    state.bots[name] = { name, port, online: true, stress: 0, last_seen: Date.now() };
  }
}

export function updateBotHealth(name, data) {
  if (!state.bots[name]) state.bots[name] = { name, online: false, stress: 0 };
  Object.assign(state.bots[name], { ...data, last_seen: Date.now() });
}

// ── Channel tracking ──────────────────────────────────────────────────────────
export function recordChannelMessage(channelId, authorName) {
  const now = Date.now();
  if (!state.channels[channelId]) {
    state.channels[channelId] = { last_msg_ts: now, msgs: [], speakers: new Set() };
  }
  const ch = state.channels[channelId];
  ch.last_msg_ts = now;
  ch.msgs.push(now);
  ch.speakers.add(authorName);
  // Keep only last 10 min of msgs
  const cutoff = now - 10 * 60_000;
  ch.msgs = ch.msgs.filter(t => t > cutoff);
}

// ── Snapshot builder ──────────────────────────────────────────────────────────
/**
 * Returns a concise natural-language snapshot of world state.
 * Suitable for injecting into KAI's system prompt.
 */
export function getWorldSnapshot() {
  updateClock();
  const { clock, lattice, events, bots } = state;

  const lines = [];

  // Time context
  lines.push(`[WORLD STATE — ${new Date().toISOString()}]`);
  lines.push(`Time: ${clock.day} ${clock.phase} (${clock.hour}:00). ${clock.is_work ? 'Work hours active.' : 'Off-hours.'}`);

  // Lattice
  if (lattice.online) {
    const phi  = lattice.phi_g?.toFixed(3) ?? '?';
    const chi  = lattice.chi?.toFixed(3)   ?? '?';
    const mood = lattice.mood ?? 'unknown';
    const cells = lattice.cell_count?.toLocaleString() ?? '?';
    lines.push(`Lattice: ONLINE — ${cells} cells, phi_g=${phi}, chi=${chi}, mood=${mood}.`);
  } else {
    lines.push(`Lattice: OFFLINE or rebuilding index (normal after restart).`);
  }

  // Bot health
  const botNames = Object.keys(bots);
  if (botNames.length > 0) {
    const online  = botNames.filter(n => bots[n].online);
    const offline = botNames.filter(n => !bots[n].online);
    lines.push(`Bots online (${online.length}): ${online.join(', ') || 'none'}.${offline.length ? ` Offline: ${offline.join(', ')}.` : ''}`);
  }

  // Recent events (last 5, non-info)
  const notable = events.filter(e => e.severity !== 'info').slice(-5);
  if (notable.length > 0) {
    lines.push(`Recent events:`);
    for (const ev of notable) {
      const age = Math.round((Date.now() - ev.ts) / 60_000);
      lines.push(`  [${age}m ago] ${ev.type}: ${ev.detail}`);
    }
  }

  return lines.join('\n');
}

/**
 * Returns raw state object for programmatic use.
 */
export function getWorldState() {
  updateClock();
  return { ...state, clock: { ...state.clock } };
}

// ── Background polling loop ───────────────────────────────────────────────────
let _interval = null;

export const worldModel = {
  start(tickMs = 30_000) {
    if (_interval) return;
    _loadWorldState();          // restore last-known lattice vitals and events
    updateClock();
    pollLattice();
    _interval = setInterval(() => {
      updateClock();
      pollLattice().catch(() => {});
    }, tickMs);
    // Persist world state every 5 minutes
    setInterval(_saveWorldState, 5 * 60_000);
    console.log('[KAI/WorldModel] World simulation started.');
  },
  stop() {
    if (_interval) { clearInterval(_interval); _interval = null; }
    _saveWorldState();
  },
};
