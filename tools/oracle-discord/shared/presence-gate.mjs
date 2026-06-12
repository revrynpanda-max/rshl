// ── PRESENCE GATE ───────────────────────────────────────────────────────────
// Central resource-saver gates shared by every bot process via state files.
//
//  1. Human presence  → autonomous social turns only run while a human has
//     been active in chat recently. No humans = zero API calls, zero TTS.
//  2. Work sessions   → industrial bots (Analyst, Researcher, Kai Coder)
//     stay online and answer requests instantly, but autonomous work loops
//     only run while state/work_sessions.on exists (or KAI_WORK_SESSIONS=always).
//
// Toggle work sessions at runtime (no restart needed):
//   ON :  New-Item C:\KAI\tools\oracle-discord\state\work_sessions.on
//   OFF:  Remove-Item C:\KAI\tools\oracle-discord\state\work_sessions.on

import fs from 'fs';
import path from 'path';

const STATE_DIR = 'c:/KAI/tools/oracle-discord/state';
const PRESENCE_FILE = path.join(STATE_DIR, 'human_presence.json');
const WORK_FLAG_FILE = path.join(STATE_DIR, 'work_sessions.on');

// Default: bots stay chatty for 10 min after the last human message.
export const HUMAN_ACTIVE_WINDOW_MS =
  Number(process.env.KAI_HUMAN_ACTIVE_WINDOW_MS) > 0
    ? Number(process.env.KAI_HUMAN_ACTIVE_WINDOW_MS)
    : 10 * 60 * 1000;

try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch (_) {}

let lastWriteMs = 0;
let cachedTs = 0;
let cachedReadMs = 0;

/** Call on every non-bot Discord message. Throttled file write (max 1/15s). */
export function recordHumanActivity() {
  const now = Date.now();
  cachedTs = now;
  cachedReadMs = now;
  if (now - lastWriteMs < 15000) return;
  lastWriteMs = now;
  try {
    fs.writeFileSync(PRESENCE_FILE, JSON.stringify({ lastHumanMessageAt: now }));
  } catch (_) {}
}

/** True if any human messaged (in any bot's view) within the window. */
export function isHumanActive(windowMs = HUMAN_ACTIVE_WINDOW_MS) {
  const now = Date.now();
  // Re-read the shared file at most every 10s — other processes may have
  // seen human activity that this one did not.
  if (now - cachedReadMs > 10000) {
    cachedReadMs = now;
    try {
      const data = JSON.parse(fs.readFileSync(PRESENCE_FILE, 'utf8'));
      if (Number(data.lastHumanMessageAt) > cachedTs) {
        cachedTs = Number(data.lastHumanMessageAt);
      }
    } catch (_) {}
  }
  return now - cachedTs < windowMs;
}

/**
 * AMBIENT SIMULATION MODE: when no human is around, the social fleet keeps
 * a slow background life going — their simulated world continues, and the
 * conversation corpus keeps feeding KAI's language learning — at a fraction
 * of the active rate. The resource governor (shouldRunSpot) still vetoes
 * every turn under load, so this never fights the host PC.
 * Disable with KAI_AMBIENT_SOCIAL=0.
 */
export function ambientMode() {
  return process.env.KAI_AMBIENT_SOCIAL !== '0';
}

/** Roll for an ambient (no-human) turn: ~30% pass rate slows the world down. */
export function ambientTurnAllowed() {
  return ambientMode() && Math.random() < 0.3;
}

/** Autonomous industrial work sessions: opt-in via flag file or env. */
export function workSessionsEnabled() {
  if (process.env.KAI_WORK_SESSIONS === 'always') return true;
  if (process.env.KAI_WORK_SESSIONS === 'off') return false;
  try { return fs.existsSync(WORK_FLAG_FILE); } catch (_) { return false; }
}
