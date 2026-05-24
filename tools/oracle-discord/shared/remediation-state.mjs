// shared/remediation-state.mjs
// ──────────────────────────────────────────────────────────────────────────────
// Stage 8: behavioral remediation — soft runtime actions, no code edits.
//
// The correlation engine writes to this state when rules trip. Consumers
// (start-bot.mjs's reply scoring + system-prompt builder, etc.) read from
// it to decide whether to skip a turn or add an extra nudge.
//
// File-based so it works across the multiple bot processes — each bot reads
// the same state on every tick. Atomic writes via fs.writeFileSync.
// ──────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { recordMetric } from './metrics-store.mjs';

function resolveStateFile() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.join(here, '..', 'state', 'remediation-state.json');
  } catch (_) {
    return 'c:/KAI/tools/oracle-discord/state/remediation-state.json';
  }
}
const STATE_FILE = resolveStateFile();

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (_) { return { suppressedBots: {}, extraPrompts: {}, lastWrite: 0 }; }
}
function writeState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    s.lastWrite = Date.now();
    fs.writeFileSync(STATE_FILE, JSON.stringify(s));
  } catch (_) { /* fail silently — state is best-effort */ }
}

/** Mark a bot as suppressed from replying for `durationMs`. */
export function suppressBot(botName, durationMs = 60_000, reason = '') {
  const s = readState();
  s.suppressedBots[botName] = { until: Date.now() + durationMs, reason };
  writeState(s);
  recordMetric('remediation', 'bot_suppressed', durationMs, { bot: botName, reason: String(reason).slice(0, 60) });
}

/** True if bot's suppression is still active. */
export function isBotSuppressed(botName) {
  const s = readState();
  const entry = s.suppressedBots[botName];
  return !!(entry && entry.until > Date.now());
}

/** Attach an extra system-prompt snippet for a channel for `durationMs`. */
export function requestExtraSystemPrompt(channelId, text, durationMs = 5 * 60_000, tag = '') {
  if (!channelId || !text) return;
  const s = readState();
  if (!s.extraPrompts[channelId]) s.extraPrompts[channelId] = [];
  // Drop expired entries first
  s.extraPrompts[channelId] = s.extraPrompts[channelId].filter(e => e.until > Date.now());
  // Dedupe by tag
  s.extraPrompts[channelId] = s.extraPrompts[channelId].filter(e => e.tag !== tag);
  s.extraPrompts[channelId].push({ text: String(text).slice(0, 500), until: Date.now() + durationMs, tag });
  writeState(s);
  recordMetric('remediation', 'extra_prompt_added', durationMs, { channel: channelId, tag });
}

/** Get all active extra prompts for a channel, joined into one string. */
export function getExtraSystemPrompt(channelId) {
  if (!channelId) return '';
  const s = readState();
  const arr = (s.extraPrompts[channelId] || []).filter(e => e.until > Date.now());
  return arr.map(e => e.text).join('\n');
}

/** Cleanup loop — purges expired entries. */
export function gcRemediationState() {
  const s = readState();
  const now = Date.now();
  for (const bot of Object.keys(s.suppressedBots)) {
    if (s.suppressedBots[bot].until <= now) delete s.suppressedBots[bot];
  }
  for (const ch of Object.keys(s.extraPrompts)) {
    s.extraPrompts[ch] = (s.extraPrompts[ch] || []).filter(e => e.until > now);
    if (!s.extraPrompts[ch].length) delete s.extraPrompts[ch];
  }
  writeState(s);
}
