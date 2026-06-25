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

// ── AUTONOMOUS FLEET MODE (master flag KAI_AUTONOMOUS) ───────────────────────
// Lets the fleet ACT ON SCHEDULE with NO human present: during social hours bots
// converse with EACH OTHER (ambient), during work hours they work their threads.
// This is the ONE switch that opens the otherwise human-gated social pulse. With
// it OFF, every autonomous-bypass below is inert and behavior is byte-for-byte as
// before (the strict presence gate stands). Default ON; set KAI_AUTONOMOUS=0 to
// fully restore the old human-only behavior.
//
// RATE-LIMIT SAFETY is enforced FLEET-WIDE (not per-bot) via a shared state file:
//   • a minimum interval between ANY two autonomous turns across the whole fleet
//     (KAI_AMBIENT_MIN_MS, default 120000 = one autonomous turn ~every 2 min);
//   • a hard hourly cap on autonomous turns (KAI_AMBIENT_MAX_PER_HOUR, default 20)
//     so a loop bug can never burn the free-tier quota;
//   • a 429/quota BACKOFF that extends the next-allowed time so we don't retry-spam.
// The existing per-bot social throttle (botChainAllows), the resource governor
// (shouldRunSpot) and the provider circuit-breaker (isProviderReady) ALL still
// apply on top of this — this only ADDS a conservative global ceiling.
export function autonomousMode() {
  return String(process.env.KAI_AUTONOMOUS ?? '1') !== '0';
}

export const KAI_AMBIENT_MIN_MS =
  Number(process.env.KAI_AMBIENT_MIN_MS) > 0 ? Number(process.env.KAI_AMBIENT_MIN_MS) : 120000;
export const KAI_AMBIENT_MAX_PER_HOUR =
  Number(process.env.KAI_AMBIENT_MAX_PER_HOUR) > 0 ? Number(process.env.KAI_AMBIENT_MAX_PER_HOUR) : 20;

const AMBIENT_PACE_FILE = path.join(STATE_DIR, 'ambient_pace.json');

function readAmbientPace() {
  try { return JSON.parse(fs.readFileSync(AMBIENT_PACE_FILE, 'utf8')); }
  catch (_) { return { lastTurnAt: 0, backoffUntil: 0, hour: 0, hourCount: 0 }; }
}
function writeAmbientPace(s) {
  try { fs.writeFileSync(AMBIENT_PACE_FILE, JSON.stringify(s)); } catch (_) {}
}

/**
 * FLEET-WIDE AUTONOMOUS PACING GATE. Returns true only if an autonomous (no-human)
 * turn is allowed RIGHT NOW under the global ceiling: master flag on, past the
 * min-interval since the last fleet autonomous turn, not inside a 429 backoff, and
 * under the hourly cap. Does NOT itself reserve the slot — call recordAmbientTurn()
 * after a turn actually fires so the next bot waits its turn. A tiny jitter is added
 * to the interval so the fleet's processes don't all unlock on the same tick.
 */
export function ambientPaceAllows() {
  if (!autonomousMode()) return false;
  const now = Date.now();
  const s = readAmbientPace();
  if (now < (s.backoffUntil || 0)) return false;            // cooling down after a 429
  const jitter = Math.floor(Math.random() * 15000);         // up to 15s stagger
  if (now - (s.lastTurnAt || 0) < KAI_AMBIENT_MIN_MS + jitter) return false;
  const thisHour = Math.floor(now / 3600000);
  const hourCount = (s.hour === thisHour) ? (s.hourCount || 0) : 0;
  if (hourCount >= KAI_AMBIENT_MAX_PER_HOUR) return false;   // hourly quota guard
  return true;
}

/** Reserve the fleet-wide autonomous slot after a turn actually fired. */
export function recordAmbientTurn() {
  const now = Date.now();
  const thisHour = Math.floor(now / 3600000);
  const s = readAmbientPace();
  s.hourCount = (s.hour === thisHour) ? (s.hourCount || 0) + 1 : 1;
  s.hour = thisHour;
  s.lastTurnAt = now;
  writeAmbientPace(s);
}

/**
 * On a 429 / quota / RESOURCE_EXHAUSTED error during an autonomous turn, extend the
 * fleet-wide next-allowed time so NO bot retries into the same limit. Default backoff
 * is 5 minutes (override with KAI_AMBIENT_BACKOFF_MS). Idempotent: only ever pushes
 * the window further out, never pulls it in.
 */
export function recordAmbientBackoff(ms) {
  const now = Date.now();
  const backoff = Number(ms) > 0 ? Number(ms)
    : (Number(process.env.KAI_AMBIENT_BACKOFF_MS) > 0 ? Number(process.env.KAI_AMBIENT_BACKOFF_MS) : 300000);
  const s = readAmbientPace();
  s.backoffUntil = Math.max(s.backoffUntil || 0, now + backoff);
  writeAmbientPace(s);
}

/** Autonomous industrial work sessions: opt-in via flag file or env. */
export function workSessionsEnabled() {
  if (process.env.KAI_WORK_SESSIONS === 'always') return true;
  if (process.env.KAI_WORK_SESSIONS === 'off') return false;
  try { return fs.existsSync(WORK_FLAG_FILE); } catch (_) { return false; }
}

// ── LIVING-CONVERSATION SOCIAL CONTROLS ─────────────────────────────────────
// Cross-process state so the WHOLE fleet (every bot is its own node process)
// shares one bot-to-bot chain counter and per-bot reply cooldowns. This is what
// keeps bot-to-bot replies ALIVE but bounded: they build on each other for a
// few turns, then the fleet quiets and waits for a human or a cooldown so two
// bots never ping-pong forever and cost never runs away.
//
// Env knobs (conservative defaults):
//   SOCIAL_BOT_REPLY_PROB   reply-probability when a bot hears another bot   (0.55)
//   SOCIAL_MAX_BOT_CHAIN    consecutive bot-only turns before forced pause   (4)
//   SOCIAL_BOT_COOLDOWN_MS  per-bot min gap between its own social replies   (20000)
//   SOCIAL_CHAIN_PAUSE_MS   how long the fleet stays quiet after a chain cap (45000)
//   SOCIAL_THINK_MIN_MS     min added "think" stagger before a bot replies   (700)
//   SOCIAL_THINK_MAX_MS     max added "think" stagger                        (2600)
const SOCIAL_FILE = path.join(STATE_DIR, 'social_chain.json');

function numEnv(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

export const SOCIAL_BOT_REPLY_PROB  = (() => { const v = Number(process.env.SOCIAL_BOT_REPLY_PROB); return v >= 0 && v <= 1 ? v : 0.55; })();
export const SOCIAL_MAX_BOT_CHAIN   = numEnv('SOCIAL_MAX_BOT_CHAIN', 4);
export const SOCIAL_BOT_COOLDOWN_MS = numEnv('SOCIAL_BOT_COOLDOWN_MS', 20000);
export const SOCIAL_CHAIN_PAUSE_MS  = numEnv('SOCIAL_CHAIN_PAUSE_MS', 45000);
export const SOCIAL_THINK_MIN_MS    = numEnv('SOCIAL_THINK_MIN_MS', 700);
export const SOCIAL_THINK_MAX_MS    = numEnv('SOCIAL_THINK_MAX_MS', 2600);

function readSocial() {
  try { return JSON.parse(fs.readFileSync(SOCIAL_FILE, 'utf8')); }
  catch (_) { return { chain: 0, lastTurnAt: 0, pauseUntil: 0, perBot: {} }; }
}
function writeSocial(s) {
  try { fs.writeFileSync(SOCIAL_FILE, JSON.stringify(s)); } catch (_) {}
}

/** A small randomized think-delay (ms) so replies stagger and never start together. */
export function socialThinkDelay() {
  const span = Math.max(0, SOCIAL_THINK_MAX_MS - SOCIAL_THINK_MIN_MS);
  return Math.round(SOCIAL_THINK_MIN_MS + Math.random() * span);
}

/** A human talking resets the bot-chain and clears any cooldown pause. */
export function resetBotChain() {
  const s = readSocial();
  s.chain = 0;
  s.pauseUntil = 0;
  writeSocial(s);
}

/**
 * Decide whether THIS bot may take a bot-to-bot social turn right now.
 * Enforces: fleet chain-cap + pause window, per-bot cooldown, and a probabilistic
 * gate. Returns true only if all guards pass (the caller still applies interest
 * scoring + the floor lock on top of this).
 */
export function botChainAllows(botName, replyProb = SOCIAL_BOT_REPLY_PROB) {
  const now = Date.now();
  const s = readSocial();
  if (now < (s.pauseUntil || 0)) return false;            // fleet is cooling down
  if (s.chain >= SOCIAL_MAX_BOT_CHAIN) {                   // cap hit: pause the fleet
    s.pauseUntil = now + SOCIAL_CHAIN_PAUSE_MS;
    s.chain = 0;
    writeSocial(s);
    return false;
  }
  const last = (s.perBot && s.perBot[botName]) || 0;
  if (now - last < SOCIAL_BOT_COOLDOWN_MS) return false;   // this bot just spoke
  if (Math.random() >= replyProb) return false;            // probabilistic stagger
  return true;
}

// ── NAMED-BYPASS COOLDOWN (env: SOCIAL_NAMED_BYPASS_COOLDOWN, default ON) ──────
// A bot that is DIRECTLY NAMED ('hey Claudey', or another bot handing it the
// turn) may answer once even if it is inside its own per-bot cooldown, so it can
// respond when called. The fleet chain cap + pause window STILL apply, so this
// can't be used to ping-pong two bots forever. Returns true only if the chain
// guard passes; the per-bot cooldown is the only check it relaxes.
const NAMED_BYPASS_ON = String(process.env.SOCIAL_NAMED_BYPASS_COOLDOWN ?? '1') === '1';
export function botChainAllowsNamed(botName, replyProb = SOCIAL_BOT_REPLY_PROB) {
  if (!NAMED_BYPASS_ON) return botChainAllows(botName, replyProb);
  const now = Date.now();
  const s = readSocial();
  if (now < (s.pauseUntil || 0)) return false;            // fleet still cooling down
  if (s.chain >= SOCIAL_MAX_BOT_CHAIN) {                   // cap hit: pause the fleet
    s.pauseUntil = now + SOCIAL_CHAIN_PAUSE_MS;
    s.chain = 0;
    writeSocial(s);
    return false;
  }
  // Per-bot cooldown + probabilistic gate are intentionally bypassed for a
  // directly-named bot — the chain cap above is what bounds the exchange.
  return true;
}

/** Record that THIS bot actually took a bot-to-bot turn (advances the chain). */
export function recordBotTurn(botName) {
  const now = Date.now();
  const s = readSocial();
  s.chain = (s.chain || 0) + 1;
  s.lastTurnAt = now;
  if (!s.perBot) s.perBot = {};
  s.perBot[botName] = now;
  writeSocial(s);
}

// ── PROACTIVE VOICE KICKOFF (cross-process rotation + cooldown) ──────────────
// When the social voice room goes quiet and 2+ bots are anchored, ONE bot should
// proactively SPEAK to revive the conversation — instead of all sitting silent.
// This state file is the fleet-wide election lock so (a) only one bot opens at a
// time and (b) the SAME bot does not keep opening (rotation + per-bot cooldown).
//
// Env knobs (conservative-but-audible defaults):
//   SOCIAL_VOICE_IDLE_MS              quiet window before a kickoff is allowed   (25000)
//   SOCIAL_VOICE_KICKOFF_COOLDOWN_MS  per-initiator min gap between its kickoffs (90000)
//   SOCIAL_VOICE_KICKOFF_MIN_GAP_MS   fleet-wide min gap between ANY two kickoffs(20000)
const VOICE_KICKOFF_FILE = path.join(STATE_DIR, 'voice_kickoff.json');

export const SOCIAL_VOICE_IDLE_MS =
  numEnv('SOCIAL_VOICE_IDLE_MS', 25000);
export const SOCIAL_VOICE_KICKOFF_COOLDOWN_MS =
  numEnv('SOCIAL_VOICE_KICKOFF_COOLDOWN_MS', 90000);
export const SOCIAL_VOICE_KICKOFF_MIN_GAP_MS =
  numEnv('SOCIAL_VOICE_KICKOFF_MIN_GAP_MS', 20000);

function readKickoff() {
  try { return JSON.parse(fs.readFileSync(VOICE_KICKOFF_FILE, 'utf8')); }
  catch (_) { return { lastKickoffAt: 0, lastInitiator: '', perBot: {} }; }
}
function writeKickoff(s) {
  try { fs.writeFileSync(VOICE_KICKOFF_FILE, JSON.stringify(s)); } catch (_) {}
}

/**
 * ROTATION ELECTION: decide whether THIS bot should be the one to open the room.
 * anchored = the list of bot names currently anchored in the voice room (incl self).
 * Picks the eligible bot that has gone LONGEST without initiating (or never has),
 * tie-broken by name, so the initiator rotates instead of always being the same one.
 * Returns false if the fleet just opened the room (min-gap) or this bot is on
 * its per-initiator cooldown.
 */
export function shouldInitiateVoice(botName, anchored = []) {
  const now = Date.now();
  const s = readKickoff();
  if (now - (s.lastKickoffAt || 0) < SOCIAL_VOICE_KICKOFF_MIN_GAP_MS) return false;
  const perBot = s.perBot || {};
  const mine = perBot[botName] || 0;
  if (now - mine < SOCIAL_VOICE_KICKOFF_COOLDOWN_MS) return false;
  const candidates = (anchored && anchored.length) ? anchored.slice() : [botName];
  // Elect the candidate with the OLDEST last-initiation timestamp (0 = never).
  let best = null;
  let bestTs = Infinity;
  for (const name of candidates.slice().sort()) {
    const ts = perBot[name] || 0;
    if (ts < bestTs) { bestTs = ts; best = name; }
  }
  return best === botName;
}

// ── LAST-MESSAGE PICKUP ELECTION (env: SOCIAL_LAST_MESSAGE_PICKUP, default ON) ─
// Guarantees the newest social message gets at least one reply so the thread
// never stalls. If the message NAMED a specific bot, that bot answers (handled by
// the caller via getPrimaryAddressee). Otherwise ONE bot is elected here. The
// election is DETERMINISTIC from the message id, so every bot process agrees on
// the same winner with no extra coordination — exactly one bot picks it up.
// Rotation comes for free because consecutive message ids hash to different bots.
export const SOCIAL_LAST_PICKUP_ON =
  String(process.env.SOCIAL_LAST_MESSAGE_PICKUP ?? '1') === '1';
export const SOCIAL_LAST_PICKUP_GRACE_MS =
  numEnv('SOCIAL_LAST_PICKUP_GRACE_MS', 9000);

function hashStr(str) {
  let h = 0;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Is THIS bot the elected pickup responder for a given message id?
 * candidates = social bot names present (incl self). Optional weights bias the
 * draw toward higher-interest bots while staying deterministic per id.
 */
export function isElectedPickup(botName, msgId, candidates = [], weights = null) {
  if (!SOCIAL_LAST_PICKUP_ON) return false;
  const pool = (candidates && candidates.length) ? candidates.slice().sort() : [botName];
  if (pool.length === 1) return pool[0] === botName;
  if (weights && typeof weights === 'object') {
    // Interest-weighted deterministic election: each bot gets an integer weight
    // (default 1); the id-hash indexes into the expanded weighted pool.
    const expanded = [];
    for (const name of pool) {
      const w = Math.max(1, Math.round(Number(weights[name]) || 1));
      for (let i = 0; i < w; i++) expanded.push(name);
    }
    return expanded[hashStr(msgId) % expanded.length] === botName;
  }
  return pool[hashStr(msgId) % pool.length] === botName;
}

/** Record that THIS bot just performed a proactive voice kickoff. */
export function recordVoiceKickoff(botName) {
  const now = Date.now();
  const s = readKickoff();
  s.lastKickoffAt = now;
  s.lastInitiator = botName;
  if (!s.perBot) s.perBot = {};
  s.perBot[botName] = now;
  writeKickoff(s);
}

// ── LEO LIVE-CONVERSATION FLEET COOLDOWN (anti-stutter headroom) ─────────────
// When a human is ACTIVELY talking to Leo over Gemini Live native audio, Leo's
// real-time playback competes with the rest of the fleet (4 other concurrent
// Live native-audio sessions + VAD + STT + TTS) for CPU and the event loop. That
// contention starves Leo's playout buffer and produces stutter/gaps (underrun).
// To give Leo headroom WITHOUT tearing down the other Live sessions (which would
// break aliveness / floor-lock / attribution), Leo writes a short-lived "active
// conversation" heartbeat; the OTHER social bots see it and back off their own
// autonomous voice/Live activity for a cooldown so Leo stays smooth. This does
// NOT silence direct replies to a human — it only suppresses bot-to-bot and
// proactive (kickoff) turns while the human<->Leo exchange is hot.
//
// Env knobs (conservative defaults):
//   LEO_CONVO_HEARTBEAT_TTL_MS   how long one heartbeat keeps the flag "active"  (6000)
//   LEO_CONVO_FLEET_COOLDOWN     disable the fleet back-off entirely (set 0)     (on)
const LEO_CONVO_FILE = path.join(STATE_DIR, 'leo_voice_convo.json');

export const LEO_CONVO_HEARTBEAT_TTL_MS =
  numEnv('LEO_CONVO_HEARTBEAT_TTL_MS', 6000);

let _leoConvoLastWrite = 0;
let _leoConvoCachedTs = 0;
let _leoConvoCachedRead = 0;

/**
 * Leo's process calls this on each chunk of human<->Leo Live audio activity to
 * publish a fleet-wide "I am in an active voice conversation" heartbeat.
 * Throttled to at most one file write per second.
 */
export function recordLeoVoiceConversation() {
  const now = Date.now();
  _leoConvoCachedTs = now;
  _leoConvoCachedRead = now;
  if (now - _leoConvoLastWrite < 1000) return;
  _leoConvoLastWrite = now;
  try { fs.writeFileSync(LEO_CONVO_FILE, JSON.stringify({ activeAt: now })); } catch (_) {}
}

/**
 * Any OTHER bot calls this to learn whether a human is actively conversing with
 * Leo right now. Re-reads the shared file at most every 2s. Returns false when
 * the fleet cooldown is disabled (LEO_CONVO_FLEET_COOLDOWN=0).
 */
export function leoVoiceConversationActive(ttlMs = LEO_CONVO_HEARTBEAT_TTL_MS) {
  if (process.env.LEO_CONVO_FLEET_COOLDOWN === '0') return false;
  const now = Date.now();
  if (now - _leoConvoCachedRead > 2000) {
    _leoConvoCachedRead = now;
    try {
      const data = JSON.parse(fs.readFileSync(LEO_CONVO_FILE, 'utf8'));
      if (Number(data.activeAt) > _leoConvoCachedTs) _leoConvoCachedTs = Number(data.activeAt);
    } catch (_) {}
  }
  return now - _leoConvoCachedTs < ttlMs;
}
