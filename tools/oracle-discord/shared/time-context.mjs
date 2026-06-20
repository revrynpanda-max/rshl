// time-context.mjs — gives every AI continuous temporal awareness:
// what time it is NOW, and a real timeline of what happened and when.
// Built fresh each call from the shared transcript memory, so the bots always
// "know what time it is and when things happened" instead of being time-blind.

import { getRecentContext } from './transcript-memory.mjs';
import fs from 'fs';

let _selfKnowCache = { line: null, mtime: 0 };
/**
 * Passive self-knowledge line: the CURRENT running version + last-update date,
 * read from the Codex title page. Lets Leo KNOW his version and that he integrated
 * recent updates WITHOUT blurting — he states it only if asked. Cached by mtime.
 */
export function buildSelfKnowledge() {
  try {
    const path = 'c:/KAI/The KAI Codex.md';
    const mt = fs.statSync(path).mtimeMs;
    if (_selfKnowCache.line !== null && mt === _selfKnowCache.mtime) return _selfKnowCache.line;
    const head = fs.readFileSync(path, 'utf8').slice(0, 4000);
    const ver = (head.match(/\*\*Version\*\*\s*\|\s*\*\*([^|]+?)\*\*/) || [])[1];
    const upd = (head.match(/\*\*Last Updated\*\*\s*\|\s*([^|]+?)\s*\|/) || [])[1];
    let line = '';
    if (ver) {
      line = `[SELF-KNOWLEDGE — passive, do NOT announce] You're currently running ${ver.trim()}.` +
        (upd ? ` Last update: ${upd.trim()}.` : '') +
        ` On recent restarts you've quietly integrated new knowledge — you simply KNOW the latest changes now. Don't bring this up unprompted; if asked your version or "what's new", say it plainly and use codex_search (newest dated CHANGELOG entries) for the specifics.`;
    }
    _selfKnowCache = { line, mtime: mt };
    return line;
  } catch (_) { return ''; }
}

function relAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

/**
 * Returns a compact [NOW] + [RECENT TIMELINE] block for injection into a prompt.
 * @param {number} n  how many recent events to list
 */
export function buildTimeContext(n = 6, tz = null) {
  const now = new Date();
  const opts = {
    weekday: 'long', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  };
  if (tz) opts.timeZone = tz;
  let nowStr;
  try { nowStr = now.toLocaleString([], opts); } catch (_) { nowStr = now.toLocaleString(); }
  const tzNote = tz ? ` (${tz})` : '';
  const lines = [`[NOW] ${nowStr}${tzNote} — this is the PRESENT moment. Anything dated or timestamped earlier than this is in the PAST. You are continuously aware of the current date and time and the order things happened in; you are NOT frozen at any past update or "last thing that changed."`];
  try {
    const recent = getRecentContext(n) || [];
    if (recent.length) {
      lines.push('[RECENT TIMELINE — most recent last]:');
      for (const r of recent) {
        const t = new Date(Number(r.timestamp) || Date.now());
        const clock = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        lines.push(`  - ${clock} (${relAgo(now - t)}) ${r.speaker}: ${String(r.content || '').replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
  } catch (_) {}
  return lines.join('\n');
}

/** One-liner for periodic voice heartbeats (context-only, no reply expected). */
export function nowLine(tz = null) {
  const opts = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  if (tz) opts.timeZone = tz;
  let s;
  try { s = new Date().toLocaleString([], opts); } catch (_) { s = new Date().toLocaleString(); }
  return `[TIME CHECK — context only, do not reply] It is now ${s}${tz ? ` (${tz})` : ''}. This is the present moment; treat anything earlier as the past.`;
}
