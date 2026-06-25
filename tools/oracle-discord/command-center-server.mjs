/**
 * command-center-server.mjs — KAI / Oracle "Command Center" web server (STAGE 1)
 * ----------------------------------------------------------------------------
 * A single Node entry point that powers the upgraded oracle.html command center.
 *
 *   1. SERVES  c:/KAI/oracle.html        at  /
 *   2. PROXIES any unhandled /api/*  →  the Rust engine on http://127.0.0.1:3334
 *      (server-side, so the metrics header, roundtable turns, sandbox minds,
 *       project files, tests, KAI-speaks, let-them-talk, reset all keep working
 *       with NO CORS and NO change to the engine).
 *   3. ADDS local read-only endpoints backed by the NODE-side data:
 *        GET /api/transcripts?channel=<id|all>&limit=200   real Discord messages
 *        GET /api/channels     full channel catalog + allowed speakers
 *        GET /api/ai/list      (stub — real in stage 2)
 *        GET /api/memory       (stub — real in stage 3)
 *        GET /api/logs         (stub — real in stage 4)
 *
 * WRITE endpoints (all token-gated by CC_CONTROL_TOKEN, parity with restart):
 *   POST /api/ai/<name>/config            edit provider/model/voice → .env + restart-queue
 *   GET/POST /api/channel/<id>/settings   per-channel overlay in state/channel_settings.json
 *   GET  /api/ai/options                  provider/voice/speaker option sets for the editors
 *
 * LAUNCH:   node c:/KAI/tools/oracle-discord/command-center-server.mjs
 *   (optional)  CC_PORT=3001  ENGINE_PORT=3334  ENGINE_HOST=127.0.0.1
 * Then open:  http://localhost:3001/
 */

// Load .env so CC_CONTROL_TOKEN (and OWNER_*/CC_*/ENGINE_* config) are populated
// even when this server is launched STANDALONE (node command-center-server.mjs),
// not just via ecosystem-manager.mjs. Without this, a standalone launch left
// CONTROL_TOKEN empty → the auth wall silently DISABLED, and the dashboard's
// saved token then mismatched on multi-user routes ("dashboard token issue").
// Loading dotenv here makes the token wire-through correct regardless of launcher;
// it does NOT weaken any check — an unset token still disables the wall exactly
// as before, a set token still gates everything.
// NOTE: we do NOT use `import 'dotenv/config'` because that resolves .env relative
// to process.cwd() — when Start-KAI.ps1 launches us from a different folder, cwd
// is NOT tools/oracle-discord, so .env was missed and CC_CONTROL_TOKEN came up
// EMPTY → the auth wall silently OPENED. We load .env from THIS module's own
// directory below (see dotenv.config call after the imports) so it works no
// matter where we're launched from.
import dotenv from 'dotenv';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

// Load .env from THIS file's directory (NOT process.cwd()). dotenv does not
// override variables already present in process.env, so an ecosystem-manager
// launch that already exported CC_CONTROL_TOKEN keeps working unchanged; a
// standalone / Start-KAI launch now reads the token from the correct .env.
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '.env') });

// Bot biographies (background/tone/interests) for the portfolio→profile header.
// Best-effort: if the module is missing the profile simply omits the bio.
let BIOGRAPHIES = {};
try {
  const bioMod = await import('./shared/biographies.mjs');
  if (bioMod && bioMod.BIOGRAPHIES) BIOGRAPHIES = bioMod.BIOGRAPHIES;
} catch { /* no biographies — profile shows config only */ }

// Human identity registry (shared/identities.mjs HUMAN_REGISTRY) — used to build
// the owner's PROFILE card. Best-effort: if the module is missing we fall back to
// .env (OWNER_NAME / OWNER_USERNAME / OWNER_ID) so the profile still renders one
// coherent identity (NasterModx IS Ryan — never split).
let HUMAN_REGISTRY = {};
try {
  const idMod = await import('./shared/identities.mjs');
  if (idMod && idMod.HUMAN_REGISTRY) HUMAN_REGISTRY = idMod.HUMAN_REGISTRY;
} catch { /* fall back to .env below */ }

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Config ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.CC_PORT || '3001', 10);
// Bind to 0.0.0.0 by default so the dashboard is reachable over Tailscale (the
// 100.x.x.x interface). Override with CC_HOST to lock it back to localhost.
const HOST = process.env.CC_HOST || '0.0.0.0';
// Shared secret gating the (destructive) /api/control/restart endpoint. When set,
// callers must present it via the 'x-cc-token' header or ?token=. When unset we
// still allow control but log a one-line unauthenticated warning at startup.
const CONTROL_TOKEN = process.env.CC_CONTROL_TOKEN || '';
// Absolute paths to the ecosystem control scripts (used by the restart endpoint).
const KAI_STOP_BAT = process.env.CC_STOP_BAT || 'C:\\KAI\\tools\\oracle-discord\\KAI-Stop.bat';
const START_KAI_PS1 = process.env.CC_START_PS1 || 'C:\\KAI\\Start-KAI.ps1';
const ENGINE_HOST = process.env.ENGINE_HOST || '127.0.0.1';
const ENGINE_PORT = parseInt(process.env.ENGINE_PORT || '3334', 10);
const DASHBOARD_FILE = process.env.CC_DASHBOARD || 'c:\\KAI\\oracle.html';
const LOG_DIR = path.join(__dirname, 'logs');
const ENV_FILE = path.join(__dirname, '.env');
const STATE_DIR = path.join(__dirname, 'state');
const RESTART_QUEUE_FILE = path.join(STATE_DIR, 'restart_requests.json');
const CHANNEL_SETTINGS_FILE = path.join(STATE_DIR, 'channel_settings.json');
// Per-bot DM history file: state/dm_history_<bot>.json  (lightweight persistence
// so past DMs survive a server restart — the in-memory threads were session-only).
const dmHistoryFile = (bot) => path.join(STATE_DIR, `dm_history_${String(bot).toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`);

// Known-good option sets for the AI config editor (mirrors the bot engine's
// provider router; the dashboard offers these as dropdowns but model is free-text).
const KNOWN_PROVIDERS = ['ollama', 'gemini', 'groq', 'xai', 'moonshot', 'zen', 'anthropic', 'openai', 'elevenlabs'];
const KNOWN_VOICES = ['Charon', 'Aoede', 'Kore', 'Puck', 'Fenrir', 'Leda', 'Orus', 'Zephyr'];

// ── .env loader (lightweight, dependency-free) ────────────────────────────────
// Reads tools/oracle-discord/.env so we can pick up ORACLE_DISCORD_TOKEN without
// requiring `dotenv`. We NEVER log the token value. process.env wins if already set.
(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim();
      // strip surrounding quotes & trailing inline comments on unquoted values
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch { /* no .env — token may still come from the real environment */ }
})();

// The Oracle bot token can view the server's channels (read-only here: GET only).
const DISCORD_TOKEN = process.env.ORACLE_DISCORD_TOKEN || '';
const DISCORD_API = 'https://discord.com/api/v10';
// Root owner identity. This dashboard IS the owner's, so when authenticated the
// session is treated as the OWNER (NasterModx / Ryan). OWNER_ID gates the admin
// channels (sensitive-info etc.) for posting/viewing.
const OWNER_ID = process.env.OWNER_ID || '1111106883135217665';
const OWNER_NAME = process.env.OWNER_NAME || 'Ryan';
const OWNER_USERNAME = process.env.OWNER_USERNAME || 'nastermodx';
// Channels that are normally SYSTEM-ONLY (no bot speakers) but that the ROOT owner
// may view + post into from this dashboard. Derived from SPEAKER_RULES (empty set).
// sensitive-info is the canonical one.
const ADMIN_CHANNEL_IDS = new Set(['1500053533515448480']); // sensitive-info
const LIVE_LIMIT = 50;        // messages pulled per channel
const LIVE_TTL_MS = 6000;     // per-channel cache TTL
// Per-channel cache: id -> { ts, msgs }. Shared by /api/transcripts & /api/channel-counts.
const liveCache = new Map();
// 429 cooldown: when Discord rate-limits us, hold off all live calls until this time.
let rateLimitedUntil = 0;

// ── Crash guard (mirror dashboard-server.mjs — never die on engine faults) ────
process.on('uncaughtException', (err) => {
  console.error('[CmdCenter] Uncaught Exception (staying alive):', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[CmdCenter] Unhandled Rejection (staying alive):', reason?.message || reason);
});

// better-sqlite3 is CommonJS; in an ESM file we reach it via createRequire.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// ── Transcript store (real Discord messages — NODE side, transcripts.db) ──────
// Lazy-loaded so a bad better-sqlite3 build can't take down the proxy/dashboard.
let _db = null;
let _dbError = null;
function getDB() {
  if (_db || _dbError) return _db;
  try {
    // dynamic import keeps startup resilient if the native module is missing
    const Database = require('better-sqlite3');
    const dbPath = path.join(__dirname, 'transcripts.db');
    _db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 8000 });
    _db.pragma('journal_mode = WAL'); // matches the writer (transcript-memory.mjs)
  } catch (e) {
    _dbError = e;
    console.error('[CmdCenter] transcripts.db unavailable:', e.message);
  }
  return _db;
}

// ── Full Oracle Lattice channel catalog (REAL channels — hardcoded) ───────────
// This is the DASHBOARD'S self-contained source of truth. The IDs/names below
// are the user's REAL Discord channels (supersedes the stale channel-rules.mjs
// IDs). The dashboard builds its entire channel rail from GET /api/channels.
//
// group:  'main' | 'voice' | 'transcript'
// type:   'text' | 'voice'
// icon:   hint for the UI ('#','lock','radio','voice','transcript')
const CHANNEL_CATALOG = [
  // ── MAIN CHANNELS (7) ─────────────────────────────────────────────────────
  { id: '1489796367466500128', name: 'oracle-chat',         type: 'text', group: 'main', icon: '#',    tag: '' },
  { id: '1499298054291980368', name: 'self-optimize-check', type: 'text', group: 'main', icon: '#',    tag: '' },
  { id: '1500053533515448480', name: 'sensitive-info',      type: 'text', group: 'main', icon: 'lock', tag: 'SYSTEM' },
  { id: '1500085302268526712', name: 'ai-social-chat',      type: 'text', group: 'main', icon: '#',    tag: '' },
  { id: '1504582069886648351', name: 'kai-dreams',          type: 'text', group: 'main', icon: '#',    tag: '' },
  { id: '1513342578777395351', name: 'kai-training',        type: 'text', group: 'main', icon: '#',    tag: '' },
  { id: '1513582425446289658', name: 'kai-freq',            type: 'text', group: 'main', icon: '#',    tag: '' },

  // ── VOICE CHANNELS (3) ────────────────────────────────────────────────────
  { id: '1500048983568023552', name: 'radio',               type: 'voice', group: 'voice', icon: 'radio', tag: 'DJ' },
  { id: '1489796367466500129', name: 'ai-social-chat Voice', type: 'voice', group: 'voice', icon: 'voice', tag: 'AI<->Human' },
  { id: '1505088473307283517', name: 'Leo Voice',           type: 'voice', group: 'voice', icon: 'voice', tag: 'Leo' },

  // ── TRANSCRIPTS (7) ───────────────────────────────────────────────────────
  { id: '1500527640107417783', name: 'transcript 1', type: 'text', group: 'transcript', icon: 'transcript', tag: '' },
  { id: '1500529928184008885', name: 'transcript 2', type: 'text', group: 'transcript', icon: 'transcript', tag: '' },
  { id: '1500529995087610027', name: 'transcript 3', type: 'text', group: 'transcript', icon: 'transcript', tag: '' },
  { id: '1500530046111318116', name: 'transcript 4', type: 'text', group: 'transcript', icon: 'transcript', tag: '' },
  { id: '1500530070081503343', name: 'transcript 5', type: 'text', group: 'transcript', icon: 'transcript', tag: '' },
  { id: '1500530095368962098', name: 'transcript 6', type: 'text', group: 'transcript', icon: 'transcript', tag: '' },
  { id: '1500958679669674086', name: 'leo-unregister-user-chat', type: 'text', group: 'transcript', icon: 'transcript', tag: 'GATE' },
];

// Friendly channel-id → display name map derived from the catalog, used by the
// transcript reader so each message carries a readable channel_name.
const CHANNEL_NAMES = Object.fromEntries(CHANNEL_CATALOG.map(c => [c.id, c.name.toUpperCase()]));

// Allowed-speaker lookup mirroring shared/channel-rules.mjs CHANNEL_SPEAKER_RULES
// (kept inline so the server stays dependency-light & resilient). KAI is the
// master proxy (every channel except the system-only sensitive sink); Leo owns
// every voice-transcript slot; voice channels list their performers.
const SPEAKER_RULES = {
  // MAIN
  '1489796367466500128': ['KAI', 'Gemini', 'Claudey', 'X', 'Groq', 'Analyst', 'Researcher', 'Kai Coder'], // oracle-chat
  '1499298054291980368': ['KAI', 'Analyst'],                                  // self-optimize-check
  '1500053533515448480': [],                                                  // sensitive-info (system-only)
  '1500085302268526712': ['Claudey', 'Gemini', 'Groq', 'X', 'KAI'],          // ai-social-chat
  '1504582069886648351': ['KAI', 'Analyst'],                                  // kai-dreams
  '1513342578777395351': ['KAI'],                                             // kai-training
  '1513582425446289658': ['KAI'],                                             // kai-freq
  // VOICE
  '1500048983568023552': ['Groq'],                                            // radio
  '1489796367466500129': ['Leo', 'KAI', 'Gemini', 'Claudey', 'X', 'Groq'],   // ai-social-chat Voice
  '1505088473307283517': ['Leo'],                                            // Leo Voice
  // TRANSCRIPTS — Leo + KAI proxy
  '1500527640107417783': ['Leo', 'KAI'],
  '1500529928184008885': ['Leo', 'KAI'],
  '1500529995087610027': ['Leo', 'KAI'],
  '1500530046111318116': ['Leo', 'KAI'],
  '1500530070081503343': ['Leo', 'KAI'],
  '1500530095368962098': ['Leo', 'KAI'],
  '1500958679669674086': ['Leo'],                                            // leo-unregister-user-chat
};

function buildChannels() {
  const overlay = readChannelSettings();
  return CHANNEL_CATALOG.map(c => {
    const base = SPEAKER_RULES[c.id] || [];
    const ov = overlay[c.id] || {};
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      group: c.group,
      icon: c.icon,
      tag: c.tag,
      // Code-defined defaults (read-only source of truth for the rule set).
      allowedSpeakers: base,
      // Safe, persisted dashboard overlay (additive — never edits channel-rules.mjs).
      settings: {
        enabled: ov.enabled !== false,            // default ON
        muted: ov.muted === true,                 // default not muted
        speakerOverride: Array.isArray(ov.speakerOverride) ? ov.speakerOverride : null,
        updatedAt: ov.updatedAt || null,
      },
      // Effective speakers = override if set, else the code defaults.
      effectiveSpeakers: Array.isArray(ov.speakerOverride) ? ov.speakerOverride : base,
    };
  });
}
// All bot names that may be toggled as channel speakers (excludes Oracle, which
// never speaks). Used to validate speaker overrides + drive the UI checkboxes.
function speakerCandidates() {
  // Oracle is the gateway/moderator and never speaks as a channel persona — exclude it.
  return BOT_ROSTER.filter(b => b.name !== 'Oracle').map(b => b.name);
}

// ── BOT ROSTER (config + IPC ports + reachability) ────────────────────────────
// Self-contained so the dashboard stays dependency-light. `port` is the bot's
// IPC HTTP port (shared/identities.mjs AI_REGISTRY). `discordId` is its Discord
// user id. `route` is how /api/bot-chat reaches it for a reply:
//   'public-chat:<prefix>' → engine /api/public-chat round-trip (real reply)
//   'ipc'                   → signal the bot's IPC /trigger (send-only ack)
// Provider/model/voice mirror the BOT_PROVIDER_* / BOT_MODEL_* / *_VOICE env
// vars (read live below where present, with these as fallbacks).
const BOT_ROSTER = [
  // Oracle is the gateway/moderator/root — first-class profile target. It runs on
  // its own IPC port (3410) and resolves provider/model from BOT_PROVIDER_ORACLE /
  // BOT_MODEL_ORACLE just like the others. It is NOT DM-able the same way (it is
  // the moderator gateway, not a conversational persona), so route:'gateway'.
  { name:'Oracle',     role:'Moderator / Root',    color:'#22d9e6', port:3410, discordId:'',                    provider:'ollama',     model:'Oracle-Sovereign', voice:'—',    route:'gateway', dmableOverride:true },
  { name:'KAI',        role:'Core Intelligence',   color:'#4ade80', port:3401, discordId:'1499022265973604372', provider:'Anthropic',  model:'claude-opus',   voice:'—',        route:'public-chat:kai' },
  { name:'Leo',        role:'Sonic Voice Synth',   color:'#ff4da6', port:3400, discordId:'1499020954054168678', provider:'ElevenLabs', model:'flash-v2',      voice:'Leo (M)',  route:'ipc' },
  { name:'Gemini',     role:'Multimodal Bridge',   color:'#22d3ee', port:3402, discordId:'1499022418990203034', provider:'Google',     model:'gemini-2.0',    voice:'GEMINI',   route:'public-chat:gemini' },
  { name:'Claudey',    role:'Social Orchestrator', color:'#a78bfa', port:3403, discordId:'1499022611542180051', provider:'Anthropic',  model:'claude-sonnet', voice:'—',        route:'ipc' },
  { name:'X',          role:'Edge Signal',         color:'#e2e8f0', port:3404, discordId:'1499022834536808458', provider:'xAI',        model:'grok-2',        voice:'—',        route:'ipc' },
  { name:'Groq',       role:'Fast Inference / DJ', color:'#f472b6', port:3405, discordId:'1499327027004575794', provider:'Groq',       model:'llama-3.3-70b', voice:'DJ Synth', route:'public-chat:groq' },
  { name:'Analyst',    role:'Lattice Auditor',     color:'#60a5fa', port:3406, discordId:'1499327113075888218', provider:'Google',     model:'gemini-2.5-flash', voice:'—',     route:'ipc' },
  { name:'Researcher', role:'Semantic Discovery',  color:'#34d399', port:3407, discordId:'1499326874608865280', provider:'Moonshot',   model:'Kimi-Sovereign',voice:'—',        route:'ipc' },
  { name:'Kai Coder',  role:'Architecture Coder',  color:'#fb923c', port:3408, discordId:'1499960413691969536', provider:'Moonshot',   model:'Kimi-Sovereign',voice:'—',        route:'ipc' },
];
const ENVKEY = n => n.toUpperCase().replace(/\s+/g, '_');
// Resolve live config from env vars (BOT_PROVIDER_<N>, BOT_MODEL_<N>, voices),
// falling back to the static roster values above.
function botConfig(b) {
  const K = ENVKEY(b.name);
  const voice = process.env[`GEMINI_LIVE_VOICE_${K}`] || process.env[`GEMINI_VOICE_${K}`]
    || (b.name === 'Leo' ? process.env.LEO_VOICE : null) || b.voice;
  return {
    provider: process.env[`BOT_PROVIDER_${K}`] || b.provider,
    model:    process.env[`BOT_MODEL_${K}`]    || b.model,
    voice,
  };
}
// ── REAL model resolution (mirrors shared/openjarvis.mjs resolveRoute) ────────
// The BOT_MODEL_<NAME> values in .env are PERSONA/ROUTING ALIASES (e.g.
// "Gemini-Sovereign"), NOT real model ids. openjarvis.mjs resolveRoute() turns
// the chosen provider + alias into the REAL model id actually sent to the API:
//   ollama   → the alias verbatim (the local sovereign brain, e.g. KAI-Sovereign)
//   moonshot → ALWAYS moonshot-v1-128k (alias ignored)
//   zen      → ZEN_ALIASES[alias] (or BOT_ZEN_MODEL_<N>)
//   groq     → perBotPrimaryModel(): <BOT>_MODEL env → role-fit default (alias ignored)
//   xai      → perBotPrimaryModel(): X_MODEL/XAI_MODEL → grok-3 (alias ignored)
//   gemini   → alias only if it starts with "gemini-", else <BOT>_MODEL/GEMINI_MODEL → gemini-2.5-flash
// We replicate that here so the dashboard SHOWS the real model and so the editor
// writes the key that ACTUALLY changes the model in use (see realModelEnvKey()).
const ZEN_ALIASES_MIRROR = {
  'Kimi-Sovereign':'kimi-k2.6','Kimi26':'kimi-k2.6','Kimi25':'kimi-k2.5',
  'Researcher-Sovereign':'kimi-k2.6','Oracle-Sovereign':'claude-sonnet-4-5',
  'Gemini-3.1-Coder':'claude-sonnet-4-5','Gemini-3.1-Sovereign':'kimi-k2.6',
  'Zen-Frontier-Claude4':'claude-sonnet-4-5','Kai-Coder-Sovereign':'claude-sonnet-4-5',
  'KAI-Sovereign':'kimi-k2.6','Analyst-Sovereign':'kimi-k2.6','Leo-Sovereign':'claude-sonnet-4-5',
  'Gemini-Sovereign':'claude-sonnet-4-5','Claudey-Sovereign':'claude-sonnet-4-5',
  'X-Sovereign':'claude-sonnet-4-5','Groq-Sovereign':'claude-sonnet-4-5',
};
const MOONSHOT_REAL_MODEL = 'moonshot-v1-128k';
// Per-bot primary-model env keys (mirror PER_BOT_PRIMARY_MODEL in openjarvis.mjs).
const PER_BOT_PRIMARY_MODEL = {
  'Analyst':    { env:'ANALYST_MODEL',    groqDefault:'llama-3.3-70b-versatile' },
  'Researcher': { env:'RESEARCHER_MODEL', groqDefault:'llama-3.3-70b-versatile' },
  'Kai Coder':  { env:'KAICODER_MODEL',   groqDefault:'llama-3.3-70b-versatile' },
  'Gemini':     { env:'GEMINI_BOT_MODEL', groqDefault:'llama-3.1-8b-instant', geminiDefault:'gemini-2.5-flash' },
  'Claudey':    { env:'CLAUDEY_MODEL',    groqDefault:'llama-3.1-8b-instant', geminiDefault:'gemini-2.5-flash' },
  'Groq':       { env:'GROQ_BOT_MODEL',   groqDefault:'llama-3.1-8b-instant' },
  'X':          { env:'X_MODEL',          xaiDefault:'grok-3', groqDefault:'llama-3.1-8b-instant' },
};
function perBotPrimaryModel(botName, provider) {
  const cfg = PER_BOT_PRIMARY_MODEL[botName];
  if (cfg && cfg.env && process.env[cfg.env]) return process.env[cfg.env];
  if (provider === 'groq')   return (cfg && cfg.groqDefault)   || process.env.GROQ_MODEL   || 'llama-3.3-70b-versatile';
  if (provider === 'gemini') return (cfg && cfg.geminiDefault) || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  if (provider === 'xai')    return (cfg && cfg.xaiDefault)    || process.env.XAI_MODEL    || 'grok-3';
  return null;
}
// Returns { provider, alias, realModel } — the live, effective values.
function resolveRealModel(botName) {
  const K = ENVKEY(botName);
  const fb = BOT_ROSTER.find(b => b.name === botName) || {};
  const provider = (process.env[`BOT_PROVIDER_${K}`] || fb.provider || 'ollama').toLowerCase();
  const alias = process.env[`BOT_MODEL_${K}`] || fb.model || '';
  let realModel = alias;
  if (provider === 'moonshot') realModel = MOONSHOT_REAL_MODEL;
  else if (provider === 'zen') realModel = process.env[`BOT_ZEN_MODEL_${K}`] || ZEN_ALIASES_MIRROR[alias] || alias;
  else if (provider === 'groq') realModel = perBotPrimaryModel(botName, 'groq');
  else if (provider === 'xai')  realModel = perBotPrimaryModel(botName, 'xai');
  else if (provider === 'gemini') realModel = String(alias).startsWith('gemini-') ? alias : perBotPrimaryModel(botName, 'gemini');
  // ollama (and any unknown) → alias verbatim (the sovereign/native brain).
  return { provider, alias, realModel };
}
// Which .env KEY must we WRITE so a MODEL edit actually takes effect for this
// provider? For ollama/zen, BOT_MODEL_<N> is honored directly. For cloud
// providers, resolveRoute() ignores BOT_MODEL_<N> and reads the per-bot primary
// key (e.g. ANALYST_MODEL / X_MODEL) — so we write THAT one (and also keep
// BOT_MODEL_<N> in sync as the persona label).
function realModelEnvKey(botName, provider) {
  const p = String(provider || '').toLowerCase();
  const cfg = PER_BOT_PRIMARY_MODEL[botName];
  if ((p === 'groq' || p === 'gemini' || p === 'xai') && cfg && cfg.env) return cfg.env;
  if (p === 'zen') return `BOT_ZEN_MODEL_${ENVKEY(botName)}`;
  return `BOT_MODEL_${ENVKEY(botName)}`; // ollama + fallback
}
// Provider-aware REAL-model suggestions for the typeable editor field. KAI is
// special-cased: he runs his OWN native/sovereign brain, so he gets NO cloud
// model list (only his sovereign/ollama brain).
function modelSuggestions(provider, botName) {
  if (botName === 'KAI') {
    return ['KAI-Sovereign', 'KAI-Sovereign:latest']; // native brain only — no cloud models
  }
  switch (String(provider || '').toLowerCase()) {
    case 'gemini':   return ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'];
    case 'groq':     return ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
    case 'xai':      return ['grok-3'];
    case 'moonshot': return ['moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k'];
    case 'zen':      return ['kimi-k2.6', 'kimi-k2.5', 'claude-sonnet-4-5'];
    case 'ollama':   return listOllamaModels();
    default:         return [];
  }
}
// Best-effort list of locally installed Ollama models (so ollama bots get real
// suggestions). Cached briefly; never throws. Falls back to known sovereign tags.
let _ollamaCache = { ts: 0, models: null };
function listOllamaModels() {
  const now = Date.now();
  if (_ollamaCache.models && (now - _ollamaCache.ts) < 30000) return _ollamaCache.models;
  const host = process.env.OLLAMA_HOST || '127.0.0.1:11434';
  const [h, p] = host.replace(/^https?:\/\//, '').split(':');
  // Synchronous-ish: we can't await here, so kick off an async refresh and return cache/fallback.
  try {
    const req = http.request({ hostname: h || '127.0.0.1', port: parseInt(p || '11434', 10), path: '/api/tags', method: 'GET', timeout: 1200 }, (r) => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { const j = JSON.parse(d); const m = (j.models || []).map(x => x.name).filter(Boolean); if (m.length) _ollamaCache = { ts: Date.now(), models: m }; } catch {} });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => {});
    req.end();
  } catch {}
  return _ollamaCache.models || ['Oracle-Sovereign:latest', 'KAI-Sovereign:latest', 'llama3:latest'];
}

// ── Timing-safe secret compare ────────────────────────────────────────────────
// Constant-time string equality (avoids leaking the secret length/prefix via
// response-time differences). Returns false on any length mismatch or error.
function safeEqual(a, b) {
  try {
    const ba = Buffer.from(String(a), 'utf8');
    const bb = Buffer.from(String(b), 'utf8');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch { return false; }
}

// ── Token gate (shared by every destructive/write endpoint) ───────────────────
// Returns true if allowed. When CC_CONTROL_TOKEN is unset we allow (parity with
// the existing restart endpoint) but the caller logs a one-line warning. The
// compare is timing-safe so the secret can't be probed byte-by-byte.
function checkControlToken(req, q) {
  if (!CONTROL_TOKEN) return true;
  const sent = req.headers['x-cc-token'] || (q && q.get && q.get('token')) || '';
  return safeEqual(sent, CONTROL_TOKEN);
}

// ══ MULTI-USER REGISTRY — per-Discord-user tokens, roles & scoped access ══════
// The OWNER (the CC_CONTROL_TOKEN holder, Ryan / OWNER_ID / nastermodx) can mint a
// per-user token tied to a Discord user id and assign a role. Each user logs into
// Oracle OS with THEIR token and gets a portal scoped to their identity.
//
// SECURITY MODEL (conservative by design):
//   • Tokens are NEVER stored in plaintext. We persist ONLY sha256(salt + token)
//     plus a per-record random salt + the token's last 4 chars (for display).
//   • The plaintext token is returned EXACTLY ONCE, in the mint response, so the
//     owner can hand it to the user. It is never logged and never returned again.
//   • Login resolves a token by hashing the presented token against EVERY active
//     record's salt and comparing with crypto.timingSafeEqual (constant-time).
//   • The legacy CC_CONTROL_TOKEN keeps working unchanged as the OWNER login: the
//     owner is SEEDED as a role:'owner' record on boot, so the existing token both
//     (a) matches the seeded record AND (b) still satisfies checkControlToken().
//   • The session cookie stays an opaque random id; the server maps session→userId
//     server-side. The client is NEVER trusted to assert its own role.
//
// Discord tie: a discordId is REQUIRED on mint and gates Discord-control actions.
// NOTE: the discordId is OWNER-ASSERTED, not OAuth-verified (no Discord OAuth path
// exists in this server). It is labelled as such everywhere it surfaces.
const USERS_FILE = path.join(STATE_DIR, 'cc_users.json');
const ROLES = ['owner', 'admin', 'member', 'viewer'];
const ROLE_RANK = { owner: 3, admin: 2, member: 1, viewer: 0 };
const ROLE_DEFAULT_PERMS = {
  owner:  ['read', 'control', 'discord', 'user_management'],
  admin:  ['read', 'control', 'discord'],
  member: ['read', 'own_data'],
  viewer: ['read'],
};

function hashToken(token, salt) {
  return crypto.createHash('sha256').update(String(salt) + ':' + String(token), 'utf8').digest('hex');
}
function genToken() {
  // URL-safe, 40+ chars of entropy. Prefixed so it's recognizable but the prefix
  // adds no privilege (the whole value is hashed).
  return 'oracle_' + crypto.randomBytes(30).toString('base64url');
}
function newUserId() { return 'usr_' + crypto.randomBytes(8).toString('hex'); }

function readUsersRaw() {
  try {
    const raw = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}
function writeUsersRaw(list) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch {}
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, USERS_FILE);
}

// In-memory registry (authoritative copy, persisted on every mutation).
let USERS = readUsersRaw();

// Seed / repair the OWNER record from CC_CONTROL_TOKEN so the existing login is
// unchanged. We store the owner's token HASH (so cc_users.json never holds the
// plaintext) — the legacy checkControlToken() path still compares the raw env
// value directly, so nothing about the current owner login changes.
function seedOwner() {
  if (!CONTROL_TOKEN) return; // wall disabled → no registry needed
  let owner = USERS.find(u => u.role === 'owner' && u.discordId === OWNER_ID);
  if (!owner) owner = USERS.find(u => u.id === 'usr_owner');
  const salt = (owner && owner.salt) || crypto.randomBytes(16).toString('hex');
  const rec = {
    id: 'usr_owner',
    discordId: OWNER_ID,
    discordVerified: false,           // owner-asserted (this server has no OAuth)
    name: OWNER_NAME,
    handle: OWNER_USERNAME,
    role: 'owner',
    permissions: ROLE_DEFAULT_PERMS.owner.slice(),
    salt,
    tokenHash: hashToken(CONTROL_TOKEN, salt),
    tokenLast4: String(CONTROL_TOKEN).slice(-4),
    createdBy: 'system',
    createdAt: (owner && owner.createdAt) || new Date().toISOString(),
    disabled: false,
  };
  if (owner) Object.assign(owner, rec);
  else USERS.unshift(rec);
  writeUsersRaw(USERS);
}
seedOwner();

// Resolve the user record for a presented token (active records only). Hashes the
// token against each record's salt and compares constant-time. Returns the record
// or null. Used by /api/login and the x-cc-token → user mapping.
function resolveUserByToken(token) {
  if (!token) return null;
  for (const u of USERS) {
    if (u.disabled) continue;
    if (!u.salt || !u.tokenHash) continue;
    const h = hashToken(token, u.salt);
    if (safeEqual(h, u.tokenHash)) return u;
  }
  return null;
}
function findUser(id) { return USERS.find(u => u.id === id) || null; }
function userById(id) { return findUser(id); }

// Public (no-secret) view of a user record — last4 only, never the hash/salt.
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, discordId: u.discordId, discordVerified: !!u.discordVerified,
    name: u.name, handle: u.handle, role: u.role,
    permissions: Array.isArray(u.permissions) ? u.permissions : (ROLE_DEFAULT_PERMS[u.role] || []),
    tokenLast4: u.tokenLast4 || null,
    pwSet: !!u.pwSet,                  // true = owner-set password (no token tail shown)
    createdBy: u.createdBy, createdAt: u.createdAt, disabled: !!u.disabled,
  };
}
function roleHas(role, minRole) { return (ROLE_RANK[role] ?? -1) >= (ROLE_RANK[minRole] ?? 99); }
function userCan(u, perm) {
  if (!u) return false;
  const perms = Array.isArray(u.permissions) ? u.permissions : (ROLE_DEFAULT_PERMS[u.role] || []);
  return perms.includes(perm);
}

// Sessions now carry a userId. We resolve the CURRENT user for a request from:
//   1) a valid session cookie → its mapped userId, OR
//   2) an x-cc-token / ?token= → resolveUserByToken(), OR the legacy owner token.
// Returns a user record or null. Disabled users never resolve.
function currentUser(req, q) {
  if (!authEnabled()) {
    // Wall disabled (no CC_CONTROL_TOKEN) → treat as owner so nothing breaks.
    return USERS.find(u => u.role === 'owner') || {
      id: 'usr_owner', role: 'owner', name: OWNER_NAME, handle: OWNER_USERNAME,
      discordId: OWNER_ID, permissions: ROLE_DEFAULT_PERMS.owner.slice(), disabled: false,
    };
  }
  const sid = parseCookies(req)[SESSION_COOKIE];
  const s = sid ? sessions.get(sid) : null;
  if (s && s.exp > Date.now() && s.userId) {
    const u = findUser(s.userId);
    if (u && !u.disabled) return u;
  }
  // Header/query token path (kept so the stored-token control flow still works).
  const sent = req.headers['x-cc-token'] || (q && q.get && q.get('token')) || '';
  if (sent) {
    const u = resolveUserByToken(sent);
    if (u) return u;
    if (safeEqual(sent, CONTROL_TOKEN)) return findUser('usr_owner');
  }
  return null;
}

// ── AUTHZ gates (used by control / user-management endpoints) ─────────────────
// requireRole(req, q, res, minRole): writes a 401/403 and returns null if the
// current user is missing or under-ranked; otherwise returns the user record.
// CONTROL endpoints require 'admin'+, USER MANAGEMENT requires 'owner'.
function requireRole(req, q, res, minRole) {
  const u = currentUser(req, q);
  if (!u) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }); return null; }
  if (u.disabled) { sendJSON(res, 403, { ok: false, error: 'account_disabled' }); return null; }
  if (!roleHas(u.role, minRole)) {
    sendJSON(res, 403, { ok: false, error: 'forbidden', need: minRole, have: u.role });
    return null;
  }
  return u;
}
// Control endpoints: admin+ AND a valid legacy token still satisfies (the seeded
// owner record IS the token holder), so the existing owner control path is intact.
function requireControl(req, q, res) { return requireRole(req, q, res, 'admin'); }
function requireOwner(req, q, res)   { return requireRole(req, q, res, 'owner'); }

// ── LOGIN AUTH WALL — session store + cookie helpers ──────────────────────────
// The WHOLE command center sits behind a login when CC_CONTROL_TOKEN is set.
// A successful POST /api/login (timing-safe password check) mints a random
// session id kept ONLY in server memory and handed to the browser as an
// httpOnly, SameSite=Strict cookie — the raw token is NEVER placed in a cookie
// or URL. When CC_CONTROL_TOKEN is UNSET the wall is DISABLED (open) so the user
// can never lock themselves out before configuring the secret.
const SESSION_COOKIE = 'cc_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const sessions = new Map(); // sid -> { exp, userId }

function authEnabled() { return !!CONTROL_TOKEN; }

// Mint an opaque random session id. The resolved userId is kept SERVER-SIDE only
// (the cookie is just the random id) so the client can never assert its own role.
function newSession(userId) {
  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, { exp: Date.now() + SESSION_TTL_MS, userId: userId || null });
  return sid;
}
function sessionValid(sid) {
  if (!sid) return false;
  const s = sessions.get(sid);
  if (!s) return false;
  if (s.exp <= Date.now()) { sessions.delete(sid); return false; }
  return true;
}
// Lightweight cookie parser (no dependency). Returns { name: value, ... }.
function parseCookies(req) {
  const out = {};
  const raw = req.headers['cookie'];
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
// True if the request is authorized: a valid session cookie OR the existing
// x-cc-token header / ?token= matching CC_CONTROL_TOKEN (so the dashboard's
// stored-token path for restart/config keeps working). When auth is disabled
// (no CC_CONTROL_TOKEN) everything is authorized.
function isAuthorized(req, q) {
  if (!authEnabled()) return true;
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (sessionValid(sid)) return true;
  return checkControlToken(req, q);
}
function setSessionCookie(res, sid) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

// Self-contained, on-brand (Lattice OS dark) MOBILE-FRIENDLY login page. Served
// for any UNAUTHENTICATED dashboard/HTML request. POSTs the password to
// /api/login; on success the server sets the cookie and the page reloads into
// the real dashboard. The token is sent in the POST body — never in the URL.
function loginPageHTML(err) {
  const errBlock = err ? `<div class="err">${err}</div>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Oracle Lattice OS — Sign In</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Outfit:wght@500;700;800&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>
:root{--bg:#04070d;--panel:rgba(13,19,32,0.85);--border:rgba(255,255,255,0.08);
  --accent:#22d9e6;--accent-glow:rgba(34,217,230,0.22);--text:#e9eef7;--muted:#6b7a90;--bad:#f87171}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:var(--bg);color:var(--text);font-family:'Inter',sans-serif;
  display:flex;align-items:center;justify-content:center;padding:22px;
  background-image:radial-gradient(900px 500px at 50% -10%,rgba(34,217,230,0.10),transparent 60%),
    radial-gradient(800px 600px at 100% 100%,rgba(124,58,237,0.07),transparent 55%)}
.card{width:min(380px,94vw);background:var(--panel);border:1px solid var(--border);
  border-radius:18px;padding:30px 26px;backdrop-filter:blur(20px);
  box-shadow:0 20px 60px rgba(0,0,0,0.55)}
.logo{width:46px;height:46px;border-radius:12px;margin:0 auto 16px;
  background:linear-gradient(140deg,var(--accent),#0070a8);display:flex;align-items:center;
  justify-content:center;box-shadow:0 0 22px var(--accent-glow)}
.logo svg{width:26px;height:26px;color:#04070d}
h1{font-family:'Outfit',sans-serif;font-weight:800;font-size:18px;letter-spacing:1.5px;
  text-align:center;background:linear-gradient(100deg,#fff,#86d8e0);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent}
.sub{text-align:center;font-size:10px;letter-spacing:2px;text-transform:uppercase;
  color:var(--muted);margin:6px 0 22px}
label{display:block;font-family:'Outfit',sans-serif;font-size:9px;font-weight:700;
  letter-spacing:1.4px;text-transform:uppercase;color:var(--muted);margin-bottom:7px}
input{width:100%;background:rgba(0,0,0,0.4);border:1px solid var(--border);border-radius:10px;
  padding:13px 14px;color:#fff;font-family:'JetBrains Mono',monospace;font-size:14px;outline:none;
  transition:border-color .16s,box-shadow .16s}
input:focus{border-color:rgba(34,217,230,0.55);box-shadow:0 0 0 3px var(--accent-glow)}
button{width:100%;margin-top:16px;padding:13px;border:none;border-radius:10px;cursor:pointer;
  font-family:'Outfit',sans-serif;font-weight:700;font-size:12px;letter-spacing:1.4px;
  text-transform:uppercase;color:#04070d;background:linear-gradient(135deg,var(--accent),#0070a8);
  box-shadow:0 4px 16px var(--accent-glow);transition:filter .15s,transform .15s}
button:hover{filter:brightness(1.08);transform:translateY(-1px)}
button:disabled{opacity:.6;cursor:wait;transform:none}
.err{margin-top:14px;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--bad);
  text-align:center;border:1px solid rgba(248,113,113,0.35);background:rgba(248,113,113,0.08);
  border-radius:9px;padding:9px}
.foot{text-align:center;font-size:9.5px;color:var(--muted);margin-top:18px;line-height:1.6}
</style></head><body>
<form class="card" id="f" autocomplete="off">
  <div class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></div>
  <h1>ORACLE LATTICE OS</h1>
  <div class="sub">Command Center · Secure Access</div>
  <label for="pw">Password / Access Token</label>
  <input type="password" id="pw" placeholder="Enter your password or access token" autocomplete="current-password" autofocus>
  <button type="submit" id="btn">Unlock</button>
  ${errBlock}
  <div class="foot" id="msg"></div>
</form>
<script>
const f=document.getElementById('f'),pw=document.getElementById('pw'),
  btn=document.getElementById('btn'),msg=document.getElementById('msg');
f.addEventListener('submit',async (e)=>{
  e.preventDefault();
  const token=(pw.value||'').trim();
  if(!token){ msg.textContent='Enter your access token.'; return; }
  btn.disabled=true; btn.textContent='Unlocking…'; msg.textContent='';
  try{
    const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token})});
    if(r.ok){ location.replace('/'); return; }
    msg.textContent='Incorrect token. Try again.';
  }catch(_){ msg.textContent='Network error — is the server reachable?'; }
  btn.disabled=false; btn.textContent='Unlock'; pw.value=''; pw.focus();
});
</script>
</body></html>`;
}
function serveLoginPage(res, code) {
  res.writeHead(code || 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(loginPageHTML());
}

// ── Safe .env writer ──────────────────────────────────────────────────────────
// Updates/append a set of KEY=VALUE pairs in tools/oracle-discord/.env WITHOUT
// touching any other line (comments, blanks, secrets all preserved). Atomic-ish:
// writes a temp file then renames over the original. NEVER logs values.
function updateEnvKeys(updates) {
  let raw = '';
  try { raw = fs.readFileSync(ENV_FILE, 'utf8'); } catch { raw = ''; }
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.length ? raw.split(/\r?\n/) : [];
  const remaining = { ...updates };
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=).*$/);
    if (!m) continue;
    const key = m[2];
    if (Object.prototype.hasOwnProperty.call(remaining, key)) {
      lines[i] = `${key}=${remaining[key]}`;
      delete remaining[key];
    }
  }
  // Append any keys that did not already exist.
  const appended = Object.keys(remaining);
  if (appended.length) {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    for (const k of appended) lines.push(`${k}=${remaining[k]}`);
  }
  const out = lines.join(eol);
  const tmp = ENV_FILE + '.tmp';
  fs.writeFileSync(tmp, out, 'utf8');
  fs.renameSync(tmp, ENV_FILE);
  // Keep this process's view fresh too (so a follow-up GET reflects the change
  // even before the ecosystem manager's own watcher fires).
  for (const [k, v] of Object.entries(updates)) process.env[k] = v;
  return { updated: Object.keys(updates).length, appended };
}

// ── Queue a single-bot restart via the file the ecosystem manager polls ───────
// ecosystem-manager.mjs polls state/restart_requests.json every 5s, acts on each
// {botName, reason, ts}, then deletes the file. We MERGE so we never clobber a
// request another component just queued.
function queueBotRestart(botName, reason) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch {}
  let queue = [];
  try {
    const existing = JSON.parse(fs.readFileSync(RESTART_QUEUE_FILE, 'utf8'));
    if (Array.isArray(existing)) queue = existing;
  } catch {}
  queue.push({ botName, reason: reason || 'config change via command center', ts: Date.now() });
  const tmp = RESTART_QUEUE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(queue, null, 2), 'utf8');
  fs.renameSync(tmp, RESTART_QUEUE_FILE);
  return true;
}

// ── Per-AI CONTROL (sleep / wake / restart) via the REAL mechanisms ───────────
// The ecosystem-manager (ecosystem-manager.mjs) obeys two no-IPC control paths
// that a sibling process like this one can drive:
//   • RESTART → write state/restart_requests.json (polled every 5s)  [queueBotRestart]
//   • SLEEP/WAKE → edit ORACLE_START_SLEEP_BOTS in .env. The manager's .env watcher
//     (handleEnvChange → "Handle sleep/wake changes via ORACLE_START_SLEEP_BOTS")
//     diffs the list and SIGKILLs newly-slept bots / respawns newly-woken ones LIVE.
// Protected core processes (Oracle, KAI, Dashboard) refuse SLEEP — same guard the
// manager itself enforces (it would ignore the request anyway).
const PROTECTED_FROM_SLEEP = new Set(['oracle', 'kai', 'dashboard']);
// Canonical, comma-list-safe process name the manager's normalizeProcessName uses
// (e.g. "Kai Coder" → "Kai Coder"). We match against BOT_ROSTER and pass the
// roster's exact name; the manager normalizes case/spacing on its side.
function controlNameFor(rawName) {
  const bot = BOT_ROSTER.find(b => b.name.toLowerCase() === String(rawName).toLowerCase());
  return bot ? bot.name : null;
}
function readSleepList() {
  return String(process.env.ORACLE_START_SLEEP_BOTS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}
// Set the persisted+live sleep state for one bot by rewriting ORACLE_START_SLEEP_BOTS.
// Returns { changed:boolean, list:string[] }.
function setSleepState(botName, sleeping) {
  const list = readSleepList();
  const has = list.some(n => n.toLowerCase() === botName.toLowerCase());
  let next = list;
  if (sleeping && !has) next = [...list, botName];
  else if (!sleeping && has) next = list.filter(n => n.toLowerCase() !== botName.toLowerCase());
  const changed = next.length !== list.length || next.join(',') !== list.join(',');
  if (changed) updateEnvKeys({ ORACLE_START_SLEEP_BOTS: next.join(',') });
  return { changed, list: next };
}

// ── Per-channel settings overlay (state/channel_settings.json) ────────────────
// Safe, additive overlay the dashboard reads/writes. We NEVER edit channel-rules.mjs.
// Shape: { "<channelId>": { enabled:bool, muted:bool, speakerOverride:[names]|null,
//                           updatedAt:iso } }
function readChannelSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(CHANNEL_SETTINGS_FILE, 'utf8'));
    return (raw && typeof raw === 'object') ? raw : {};
  } catch { return {}; }
}
function writeChannelSettings(all) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch {}
  const tmp = CHANNEL_SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8');
  fs.renameSync(tmp, CHANNEL_SETTINGS_FILE);
}

// Map a bot display name → the .env keys we write for provider/model/voice.
// Voice keys mirror botConfig()'s read order. Leo uses LEO_VOICE; everyone else
// uses GEMINI_LIVE_VOICE_<N> (the Gemini Live voice the bot speaks with).
function envKeysForBot(name) {
  const K = ENVKEY(name);
  return {
    provider: `BOT_PROVIDER_${K}`,
    model: `BOT_MODEL_${K}`,
    voice: name === 'Leo' ? 'LEO_VOICE' : `GEMINI_LIVE_VOICE_${K}`,
  };
}

// ── Per-bot EXTRA editable fields (real, bot-read .env keys ONLY) ──────────────
// The config editor's advanced section writes these. EVERY key here is one a bot
// actually reads at runtime (verified in leo.mjs / openjarvis.mjs) — we never offer
// a control that does nothing. Each entry: { env, label, kind, options? }. The
// `field` id is what the client sends in body.extra. Fields with NO real backing
// key (e.g. Leo's social/tool toggles, Groq's radio source) are deliberately
// ABSENT here and rendered display-only/honest-n-a on the client.
function extraConfigSchema(botName) {
  const n = String(botName).toLowerCase();
  const out = {};
  if (n === 'leo') {
    out.readingEngine   = { env: 'LEO_READING_ENGINE',  label: 'Reading engine',  kind: 'select', options: ['live', 'edge'] };
    out.manualVad       = { env: 'LEO_MANUAL_VAD',       label: 'Manual VAD',      kind: 'select', options: ['1', '0'] };
    out.thinkingVolume  = { env: 'LEO_THINKING_VOLUME',  label: 'Thinking volume', kind: 'number' };
    out.liveModel       = { env: 'GEMINI_LIVE_MODEL',    label: 'Live (native-audio) model', kind: 'text' };
    out.ttsModel        = { env: 'LEO_TTS_MODEL',        label: 'TTS model',       kind: 'text' };
  }
  if (n === 'groq') {
    out.radioModel      = { env: 'GROQ_MODEL',           label: 'Radio / DJ model', kind: 'text' };
  }
  return out;
}
// Current live values for the extra fields (so the editor pre-fills the real value).
function extraConfigValues(botName) {
  const schema = extraConfigSchema(botName);
  const vals = {};
  for (const [field, def] of Object.entries(schema)) {
    vals[field] = { ...def, value: process.env[def.env] ?? '' };
  }
  return vals;
}

// Ping a bot's IPC /health (returns name/pid/uptime) — small timeout, never throws.
// Measures REAL round-trip latency (ms) per call so the dashboard's per-bot vitals
// genuinely move every poll. Returns { up, latencyMs, statusCode, ...healthJSON }.
function pingBotHealth(port) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const lat = () => Number(process.hrtime.bigint() - t0) / 1e6; // ms, sub-ms precise
    const r = http.request({ hostname:'127.0.0.1', port, path:'/health', method:'GET', timeout:1500 }, (res) => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{
        const latencyMs = Math.round(lat() * 10) / 10;
        try { resolve({ up:res.statusCode===200, statusCode:res.statusCode, latencyMs, ...JSON.parse(d) }); }
        catch { resolve({ up:res.statusCode===200, statusCode:res.statusCode, latencyMs }); }
      });
    });
    r.on('timeout', ()=>{ r.destroy(); resolve({ up:false, latencyMs:null, statusCode:0 }); });
    r.on('error', ()=> resolve({ up:false, latencyMs:null, statusCode:0 }));
    r.end();
  });
}
// ── LIVE per-bot ENERGY / ALIVENESS score (0–100) from real signals ───────────
// Combines: reachability (online), responsiveness (low latency = high energy),
// endurance (uptime), and recent lattice activity (messages in the last hour for
// channels this bot speaks in). Recomputed each call so the numbers MOVE.
// Index of recent activity per speaker name (last hour), refreshed lazily.
let _activityIdx = { ts: 0, byName: {} };
function recentActivityByBot() {
  const now = Date.now();
  if (_activityIdx.byName && (now - _activityIdx.ts) < 8000) return _activityIdx.byName;
  const byName = {};
  const db = getDB();
  if (db) {
    try {
      const since = now - 3600 * 1000; // last hour
      const rows = db.prepare(
        `SELECT speaker, COUNT(*) AS n FROM transcript_fts WHERE timestamp >= ? GROUP BY speaker`
      ).all(since);
      for (const r of rows) if (r.speaker) byName[String(r.speaker).toLowerCase()] = Number(r.n) || 0;
    } catch {}
  }
  _activityIdx = { ts: now, byName };
  return byName;
}
// ══ COHERENT ENERGY MODEL (smooth, time-of-day, activity-aware) ════════════════
// Energy was previously derived from latency/RSS each poll, so it JUMPED around.
// This replaces it with a believable, persistent, human-like model per the owner's
// rules. ALIVENESS stays a separate REAL metric (responsiveness/endurance — see
// computeVitals below); ENERGY is this modelled value.
//
// TWO POPULATIONS:
//   • KAI is the SUBSTRATE — "all things live in his brain/ecosystem". KAI does
//     NOT deplete over the day; instead activity REPLENISHES him. The more
//     ecosystem/brain activity (messages across all channels in the last hour),
//     the HIGHER KAI's energy. He idles around a high baseline and rises with load.
//         kaiTarget = 70 + 30 * saturate(totalEcosystemMsgs / 120)        → 70..100
//
//   • EVERY OTHER AI (Leo, Gemini, Claudey, X, Groq, Analyst, Researcher, Kai
//     Coder, Oracle) DRAINS across their waking day. Socializing is cheap; doing
//     more work / juggling more at once costs more (small amounts that ADD UP), so
//     the drain RATE scales with how busy that agent is. As the day progresses and
//     it nears the ~03:00 sleep window they trend toward a LOW-BUT-NOT-ZERO floor,
//     then RESET fresh after the overnight sleep (wake ~09:00).
//
//       wake 09:00 → sleep 03:00  (an 18h waking day; 03:00–09:00 is sleep)
//       dayFrac    = fraction through the waking day (0 at wake → 1 at sleep)
//       busyness   = saturate(thisBot'sMsgsLastHour / 24)   (0 social … 1 slammed)
//       drainShape = dayFrac^1.3 (gentle early, steeper late — human depletion curve)
//       baseDrain  = 55 * drainShape           (a calm day still ends ~mid-low)
//       workDrain  = 30 * drainShape * busyness (busy days end lower — costs add up)
//       target     = 100 - baseDrain - workDrain, floored at FLOOR (≈14, never 0)
//       during sleep (03:00–09:00): target ramps from FLOOR back up to ~100 (refill)
//
// SMOOTHING / PERSISTENCE: we never SNAP energy to the target. We keep a per-agent
// energy value in state/agent_energy.json and ease it toward the time-of-day target
// a little each poll (exponential approach, ~6% of the gap per recompute, capped so
// it can't move more than a couple points between polls). This makes the displayed
// number coherent and smooth across polls instead of jittering — and it survives a
// server restart. Recompute is time-gated (every ~20s) so rapid back-to-back polls
// (UI cache window) read the SAME eased value.
const AGENT_ENERGY_FILE = path.join(STATE_DIR, 'agent_energy.json');
const ENERGY_FLOOR = 14;            // low-but-not-zero floor near the sleep window
const ENERGY_EASE = 0.06;           // fraction of the gap closed per recompute
const ENERGY_MAX_STEP = 2.5;        // max points energy may move per recompute
const ENERGY_RECOMPUTE_MS = 20_000; // recompute cadence (smoothing tick)
const WAKE_HOUR = 9;                // ~09:00 wake (fresh)
const SLEEP_HOUR = 3;               // ~03:00 sleep window
let _energyState = null;            // { byName: { name: {energy, ts} }, savedAt }
function loadEnergyState() {
  if (_energyState) return _energyState;
  try {
    const raw = JSON.parse(fs.readFileSync(AGENT_ENERGY_FILE, 'utf8'));
    _energyState = (raw && raw.byName) ? raw : { byName: {} };
  } catch { _energyState = { byName: {} }; }
  return _energyState;
}
let _energySaveTimer = null;
function saveEnergyStateDebounced() {
  if (_energySaveTimer) return;
  _energySaveTimer = setTimeout(() => {
    _energySaveTimer = null;
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const tmp = AGENT_ENERGY_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ ..._energyState, savedAt: Date.now() }, null, 2), 'utf8');
      fs.renameSync(tmp, AGENT_ENERGY_FILE);
    } catch {}
  }, 4000);
}
// Total ecosystem activity (all speakers, last hour) — KAI's replenishment signal.
function totalEcosystemActivity() {
  const by = recentActivityByBot();
  let total = 0;
  for (const k of Object.keys(by)) total += by[k] || 0;
  return total;
}
// Time-of-day TARGET energy for one agent (0–100). KAI refills from activity; the
// others drain across the waking day and refill overnight.
function energyTargetFor(botName, now) {
  const d = new Date(now);
  const hourFloat = d.getHours() + d.getMinutes() / 60;
  const isKai = String(botName).toLowerCase() === 'kai';
  if (isKai) {
    // Substrate: rises with ecosystem/brain activity; never depletes by clock.
    const eco = totalEcosystemActivity();
    return 70 + 30 * Math.min(1, eco / 120); // 70..100
  }
  // Are we inside the overnight SLEEP window (03:00 → 09:00)? Refill toward fresh.
  const asleep = hourFloat >= SLEEP_HOUR && hourFloat < WAKE_HOUR;
  if (asleep) {
    // Ramp from FLOOR (just fell asleep) up to ~100 by wake — the overnight reset.
    const sleepFrac = (hourFloat - SLEEP_HOUR) / (WAKE_HOUR - SLEEP_HOUR); // 0..1
    return ENERGY_FLOOR + (100 - ENERGY_FLOOR) * Math.min(1, Math.max(0, sleepFrac));
  }
  // WAKING day: 09:00 → 03:00 (wraps midnight) = 18 hours. dayFrac 0 at wake → 1 at sleep.
  let sinceWake = hourFloat - WAKE_HOUR;
  if (sinceWake < 0) sinceWake += 24;            // after-midnight hours map onto the tail
  const wakingLen = (24 - WAKE_HOUR) + SLEEP_HOUR; // 18h
  const dayFrac = Math.min(1, Math.max(0, sinceWake / wakingLen));
  const drainShape = Math.pow(dayFrac, 1.3);     // gentle early, steeper late
  const busy = Math.min(1, (recentActivityByBot()[String(botName).toLowerCase()] || 0) / 24);
  const baseDrain = 55 * drainShape;             // a calm day still winds down
  const workDrain = 30 * drainShape * busy;      // busier ⇒ lower (small costs add up)
  return Math.max(ENERGY_FLOOR, 100 - baseDrain - workDrain);
}
// Smooth, persistent energy for one agent: ease the stored value toward the target.
// Time-gated so back-to-back polls within ENERGY_RECOMPUTE_MS read the same value.
function modeledEnergy(botName, online) {
  const now = Date.now();
  const st = loadEnergyState();
  const key = String(botName).toLowerCase();
  let rec = st.byName[key];
  const target = energyTargetFor(botName, now);
  if (!rec || typeof rec.energy !== 'number') {
    // First sighting — seed AT the time-of-day target (no cold-start jump to 100).
    rec = { energy: target, ts: now };
    st.byName[key] = rec;
    saveEnergyStateDebounced();
    return Math.round(rec.energy);
  }
  // Only advance the smoothing once per recompute window (keeps polls coherent).
  if (now - rec.ts >= ENERGY_RECOMPUTE_MS) {
    const gap = target - rec.energy;
    let step = gap * ENERGY_EASE;
    if (step >  ENERGY_MAX_STEP) step =  ENERGY_MAX_STEP;
    if (step < -ENERGY_MAX_STEP) step = -ENERGY_MAX_STEP;
    rec.energy = Math.max(1, Math.min(100, rec.energy + step));
    rec.ts = now;
    saveEnergyStateDebounced();
  }
  return Math.round(rec.energy);
}

function computeVitals(botName, health) {
  const online = !!health.up;
  const latencyMs = (typeof health.latencyMs === 'number') ? health.latencyMs : null;
  const uptimeMs = (typeof health.uptime_ms === 'number') ? health.uptime_ms : null;
  const rssMb = (typeof health.rss_mb === 'number') ? health.rss_mb : null;
  const act = recentActivityByBot()[String(botName).toLowerCase()] || 0;
  // ENERGY = the smooth, persistent, time-of-day model (see above). Computed even
  // when offline so a sleeping/restarting bot still shows its believable curve
  // value rather than snapping to 0 (offline-ness is conveyed by `online`).
  const energy = modeledEnergy(botName, online);
  if (!online) return { online:false, latencyMs, uptimeMs, rssMb, energy, aliveness:0, recentMsgs: act };
  // ── ALIVENESS — a SEPARATE, REAL health metric (responsiveness + endurance) ──
  // Responsiveness: 0ms→1.0, 300ms+→~0 (exponential decay, real round-trip).
  const respScore = latencyMs == null ? 0.5 : Math.exp(-latencyMs / 150);
  // Endurance: ramps to full over ~10 min of uptime (freshly-(re)started bots score lower).
  const upScore = uptimeMs == null ? 0.6 : Math.min(1, uptimeMs / (10 * 60 * 1000));
  // Memory headroom: lower RSS = leaner (saturates ~600MB).
  const memScore = rssMb == null ? 0.7 : Math.max(0, 1 - rssMb / 600);
  // ALIVENESS = mostly responsiveness + endurance (is it healthy & breathing?).
  const aliveness = Math.round((0.55 * respScore + 0.30 * upScore + 0.15 * memScore) * 100);
  return {
    online: true, latencyMs, uptimeMs, rssMb,
    energy: Math.max(1, Math.min(100, energy)),
    aliveness: Math.max(1, Math.min(100, aliveness)),
    recentMsgs: act,
  };
}
// Read last-known status from state/ecosystem-manager.json (fallback when a bot
// has no /health listener). Best-effort; returns {} on any failure.
function readEcosystemState() {
  const candidates = [
    path.join(__dirname, 'state', 'ecosystem-manager.json'),
    path.join(__dirname, 'ecosystem-manager.json'),
    path.join(__dirname, 'logs', 'ecosystem-manager.json'),
  ];
  for (const p of candidates) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  }
  return {};
}
// Short-TTL cache around the (expensive) bot list. buildBotList() pings all 10 bots'
// IPC /health every call (each up to ~1.5s when a bot is DOWN), so back-to-back
// callers — /api/ai/list, /api/ai/vitals, /api/ai/<name>, and the topology click —
// previously paid that cost repeatedly. A 2.5s in-flight-shared cache makes the
// FIRST poll pay it and everyone within the window reuse it. Correctness is intact
// (vitals refresh every 2.5s, well under the dashboard's poll cadence).
let _botListCache = { ts: 0, promise: null };
const BOTLIST_CACHE_TTL = 2500;
function buildBotList() {
  const now = Date.now();
  if (_botListCache.promise && (now - _botListCache.ts) < BOTLIST_CACHE_TTL) return _botListCache.promise;
  const p = _buildBotListUncached().catch(e => { _botListCache = { ts: 0, promise: null }; throw e; });
  _botListCache = { ts: now, promise: p };
  return p;
}
async function _buildBotListUncached() {
  const eco = readEcosystemState();
  const ecoByName = {};
  // ecosystem-manager.json shape is unknown/variable — index any name-keyed map.
  const procs = eco.processes || eco.bots || eco.agents || eco;
  if (procs && typeof procs === 'object') {
    for (const [k, v] of Object.entries(procs)) {
      if (v && typeof v === 'object') ecoByName[k.toLowerCase()] = v;
    }
  }
  const out = await Promise.all(BOT_ROSTER.map(async (b) => {
    const cfg = botConfig(b);
    const real = resolveRealModel(b.name);     // { provider, alias, realModel }
    const health = await pingBotHealth(b.port);
    const eRec = ecoByName[b.name.toLowerCase()] || {};
    const ecoAlive = eRec.status === 'online' || eRec.alive === true || eRec.running === true;
    // Slept = on the ORACLE_START_SLEEP_BOTS list (manager keeps it down on purpose).
    const sleeping = (eRec.sleeping === true) ||
      readSleepList().some(n => n.toLowerCase() === b.name.toLowerCase());
    const dmable = (b.dmableOverride === true) || !(b.route === 'gateway');   // Oracle now answers via its IPC DM endpoint
    // LIVE vitals — measured this call (latency moves, energy/aliveness vary).
    const vit = computeVitals(b.name, health);
    return {
      name: b.name, role: b.role, color: b.color, port: b.port, discordId: b.discordId,
      // `provider` + `model` now reflect the REAL provider + REAL model in use.
      provider: real.provider, model: real.realModel,
      // persona/routing alias (BOT_MODEL_<N>) shown as supplementary context.
      aliasModel: real.alias,
      // the .env key the editor must write so a MODEL change actually applies.
      modelEnvKey: realModelEnvKey(b.name, real.provider),
      voice: cfg.voice,
      route: b.route, dmable, sleeping,
      online: health.up || ecoAlive,
      // ── LIVE per-bot vitals (genuinely move each poll) ──
      latencyMs: health.latencyMs ?? null,
      uptimeMs:  health.uptime_ms ?? null,
      rssMb:     health.rss_mb ?? null,
      energy:    vit.energy,
      aliveness: vit.aliveness,
      recentMsgs: vit.recentMsgs ?? 0,
      health: health.up ? { source:'ipc', pid: health.pid||null, uptime_ms: health.uptime_ms||null, rss_mb: health.rss_mb||null, latencyMs: health.latencyMs??null }
                        : { source: Object.keys(eRec).length ? 'ecosystem' : 'unknown', status: eRec.status || (ecoAlive ? 'online' : 'unknown') },
    };
  }));
  return out;
}

// ── Per-channel metrics derived from transcripts.db ───────────────────────────
function channelMetrics(channel) {
  const db = getDB();
  if (!db) return { error: 'transcripts.db unavailable' };
  if (!channel || channel === 'all') return { error: 'channel id required' };
  let rows;
  try {
    rows = db.prepare(
      `SELECT speaker, content, timestamp FROM transcript_fts WHERE channel_id = ? ORDER BY timestamp DESC LIMIT 5000`
    ).all(String(channel));
  } catch (e) { return { error: e.message }; }
  const nowMs = Date.now();
  const HOUR = 3600 * 1000, DAY = 24 * HOUR;
  const speakerCounts = {};
  let lastTs = 0, inLastHour = 0, inLastDay = 0;
  // 12 buckets of 2h each = last 24h volume sparkline (oldest→newest)
  const BUCKETS = 12, BUCKET_MS = (2 * HOUR);
  const volume = new Array(BUCKETS).fill(0);
  for (const r of rows) {
    const sp = r.speaker || 'unknown';
    speakerCounts[sp] = (speakerCounts[sp] || 0) + 1;
    const ts = Number(r.timestamp) || 0;
    if (ts > lastTs) lastTs = ts;
    const age = nowMs - ts;
    if (age <= HOUR) inLastHour++;
    if (age <= DAY) inLastDay++;
    if (age >= 0 && age < BUCKETS * BUCKET_MS) {
      const idx = BUCKETS - 1 - Math.floor(age / BUCKET_MS);
      if (idx >= 0 && idx < BUCKETS) volume[idx]++;
    }
  }
  const speakers = Object.entries(speakerCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  return {
    channel,
    total: rows.length,
    uniqueSpeakers: speakers.length,
    speakers,
    inLastHour, inLastDay,
    lastActivity: lastTs ? Math.floor(lastTs / 1000) : 0, // unix seconds (UI multiplies ×1000)
    volume, // 12×2h buckets, oldest→newest
    bucketHours: 2,
  };
}

/**
 * Read newest Discord messages for a channel (or all) from transcript_fts.
 * Returns objects shaped for the dashboard: {channel_id, channel_name, from, author, text, ts}
 * ts is a UNIX-SECONDS number (the dashboard's fmtTs multiplies by 1000).
 */
function readTranscripts(channel, limit) {
  const db = getDB();
  if (!db) return { error: 'transcripts.db unavailable', messages: [] };
  const lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);
  let rows;
  try {
    if (!channel || channel === 'all') {
      rows = db.prepare(
        `SELECT speaker, user_id, content, channel_id, timestamp
           FROM transcript_fts ORDER BY timestamp DESC LIMIT ?`
      ).all(lim);
    } else {
      rows = db.prepare(
        `SELECT speaker, user_id, content, channel_id, timestamp
           FROM transcript_fts WHERE channel_id = ? ORDER BY timestamp DESC LIMIT ?`
      ).all(String(channel), lim);
    }
  } catch (e) {
    return { error: e.message, messages: [] };
  }
  // newest-first from SQL → present oldest-first so the chat reads top→bottom
  const messages = rows.reverse().map(r => ({
    channel_id: r.channel_id,
    channel_name: CHANNEL_NAMES[r.channel_id] || (r.channel_id ? ('CH-' + String(r.channel_id).slice(-4)) : 'unknown'),
    from: r.speaker || 'unknown',
    author: r.speaker || 'unknown',
    user_id: r.user_id || null,
    text: r.content || '',
    // transcript-memory.mjs stores Date.now() (ms). Convert to seconds for the UI.
    ts: r.timestamp ? Math.floor(Number(r.timestamp) / 1000) : 0
  }));
  return { channel: channel || 'all', count: messages.length, messages };
}

// ── Owner / human profile (one coherent identity — NasterModx IS Ryan) ────────
// Pulls the human identity from shared/identities.mjs HUMAN_REGISTRY (falling back
// to .env). Returns a single profile object: { displayName, username, role, id,
// bio, transcriptChannelId, isOwner }. NasterModx and Ryan are NEVER split — the
// registry's display-name key (Ryan) is the display name and `username`
// (nastermodx) is the @handle, presented together.
function ownerProfile() {
  // Find the owner entry in the registry by OWNER_ID (most robust), else by the
  // OWNER_NAME key, else synthesize from .env.
  let displayName = OWNER_NAME, username = OWNER_USERNAME, role = 'Owner/Creator';
  let id = OWNER_ID, transcriptChannelId = null, bio = null;
  try {
    const byId = Object.entries(HUMAN_REGISTRY).find(([, h]) => h && h.id === OWNER_ID);
    const entry = byId || (HUMAN_REGISTRY[OWNER_NAME] ? [OWNER_NAME, HUMAN_REGISTRY[OWNER_NAME]] : null);
    if (entry) {
      const [name, h] = entry;
      displayName = name || displayName;
      username = h.username || username;
      role = h.role || role;
      id = h.id || id;
      transcriptChannelId = h.transcriptChannelId || null;
      // bio now exists on HUMAN_REGISTRY (shared/identities.mjs). A live edit via
      // the gated write sets OWNER_BIO in process.env — prefer that so a freshly
      // written bio shows WITHOUT a restart; else fall back to the registry seed.
      bio = process.env.OWNER_BIO || h.bio || h.about || h.background || null;
    }
  } catch { /* fall back to .env values */ }
  if (!bio) bio = process.env.OWNER_BIO || null;
  return {
    displayName, username, role, id, transcriptChannelId,
    bio,                 // null today (no bio field in HUMAN_REGISTRY)
    isOwner: true,
    sovereign: true,
  };
}

// ── ALL human identities (registry mirror, read-only) ─────────────────────────
// Exposes HUMAN_REGISTRY so the dashboard can resolve ANY human (Ryan, Taz,
// guests) by name OR id and fetch THAT person's profile — not a stale owner cache.
// NasterModx IS Ryan (the owner is flagged isOwner). Each entry is { name,
// username, role, id, transcriptChannelId, bio, isOwner }.
function humanIdentities() {
  const out = [];
  try {
    for (const [name, h] of Object.entries(HUMAN_REGISTRY)) {
      if (!h) continue;
      const isOwner = h.id === OWNER_ID;
      out.push({
        name,
        username: h.username || null,
        role: h.role || null,
        id: h.id || null,
        transcriptChannelId: h.transcriptChannelId || null,
        // owner bio can be live-edited via OWNER_BIO; others use the registry seed.
        bio: isOwner ? (process.env.OWNER_BIO || h.bio || null) : (h.bio || null),
        isOwner,
      });
    }
  } catch { /* fall through to .env owner below */ }
  // Guarantee the owner is present even if the registry import failed.
  if (!out.some(h => h.id === OWNER_ID)) {
    out.unshift({ name: OWNER_NAME, username: OWNER_USERNAME, role: 'Owner/Creator',
      id: OWNER_ID, transcriptChannelId: null, bio: process.env.OWNER_BIO || null, isOwner: true });
  }
  return out;
}

// ── UNIFIED per-entity PROFILE (item 7) — humans, AIs, channels share ONE source ─
// GET /api/profile/<idOrName>. Resolves the target (by Discord id OR name, human/
// AI/channel), then assembles identity + timeline (their messages) + activity
// (their operations) + metrics + Discord-sync facts. REAL data only; honest n/a
// where a source doesn't exist. Behind the auth gate (handler enforces it).
//
// Discord NOTE: the bot REST token (ORACLE_DISCORD_TOKEN) can read messages/
// channels but the v10 REST API does NOT expose member presence (online/offline)
// — that is a Gateway-only feature. So presence is reported as
// { available:false, note:'presence not available via REST' } and we NEVER fake a
// green dot from REST. "online" for an AI means its IPC /health answered.
function findEntity(key) {
  const raw = String(key || '').trim();
  if (!raw) return null;
  const low = raw.toLowerCase();
  // 1) Human by id or name
  for (const h of humanIdentities()) {
    if ((h.id && h.id === raw) || (h.name && h.name.toLowerCase() === low) ||
        (h.username && h.username.toLowerCase() === low)) {
      return { kind: 'human', human: h };
    }
  }
  // 2) AI by id or name
  const bot = BOT_ROSTER.find(b => b.name.toLowerCase() === low || (b.discordId && b.discordId === raw));
  if (bot) return { kind: 'ai', bot };
  // 3) Channel by id or name
  const cat = CHANNEL_CATALOG.find(c => c.id === raw || c.name.toLowerCase() === low);
  if (cat) return { kind: 'channel', channel: cat };
  return null;
}

// Pull this entity's recent messages (timeline) straight from transcripts.db,
// matched by speaker name/aliases (humans/AIs) or by channel_id (channels).
function entityTimeline(ent, limit) {
  const db = getDB();
  if (!db) return [];
  const lim = Math.min(Math.max(parseInt(limit, 10) || 60, 1), 200);
  try {
    if (ent.kind === 'channel') {
      const rows = db.prepare(
        `SELECT speaker, user_id, content, channel_id, timestamp FROM transcript_fts
          WHERE channel_id = ? ORDER BY timestamp DESC LIMIT ?`).all(ent.channel.id, lim);
      return rows.map(mapTimelineRow);
    }
    // human / ai: match by speaker name (tolerant) OR user_id when we know it.
    const name = ent.kind === 'human' ? ent.human.name : ent.bot.name;
    const uid  = ent.kind === 'human' ? ent.human.id   : ent.bot.discordId;
    const aliases = entityAliases(ent);
    // Over-fetch then filter in JS so persona aliases ("Gemini-Sovereign") match.
    const rows = db.prepare(
      `SELECT speaker, user_id, content, channel_id, timestamp FROM transcript_fts
        ORDER BY timestamp DESC LIMIT 4000`).all();
    const out = [];
    for (const r of rows) {
      const sp = String(r.speaker || '').toLowerCase().trim();
      const spc = sp.replace(/[\s_-]+/g, '');
      const hit = (uid && r.user_id && String(r.user_id) === String(uid)) ||
        aliases.has(sp) || aliases.has(spc) || aliases.has(sp.split(/[\s\-_(]/)[0]);
      if (hit) { out.push(mapTimelineRow(r)); if (out.length >= lim) break; }
    }
    return out;
  } catch { return []; }
}
function mapTimelineRow(r) {
  return {
    channel_id: r.channel_id,
    channel_name: CHANNEL_NAMES[r.channel_id] || (r.channel_id ? ('CH-' + String(r.channel_id).slice(-4)) : 'unknown'),
    from: r.speaker || 'unknown',
    text: r.content || '',
    ts: r.timestamp ? Math.floor(Number(r.timestamp) / 1000) : 0,
  };
}
// Tolerant alias set for an entity (name variants + persona/routing aliases).
function entityAliases(ent) {
  const set = new Set();
  const add = v => { const s = String(v || '').toLowerCase().trim(); if (s) { set.add(s); set.add(s.replace(/[\s_-]+/g, '')); const f = s.split(/\s+/)[0]; if (f) set.add(f); } };
  if (ent.kind === 'human') { add(ent.human.name); add(ent.human.username); }
  else if (ent.kind === 'ai') {
    add(ent.bot.name);
    const r = resolveRealModel(ent.bot.name);
    add(r.alias);
    if (ent.bot.route && ent.bot.route.startsWith('public-chat:')) add(ent.bot.route.split(':')[1]);
    const first = ent.bot.name.toLowerCase().split(/\s+/)[0];
    add(first + '-sovereign'); add(first + 'sovereign');
  }
  return set;
}

// Which catalog channels does this entity actually appear in (from transcripts.db)?
function entityChannels(ent) {
  const db = getDB();
  if (!db) return [];
  try {
    if (ent.kind === 'channel') return [{ id: ent.channel.id, name: ent.channel.name, count: dbCount(ent.channel.id) }];
    const aliases = entityAliases(ent);
    const uid = ent.kind === 'human' ? ent.human.id : ent.bot.discordId;
    const rows = db.prepare(
      `SELECT channel_id, speaker, user_id, COUNT(*) AS n FROM transcript_fts
        GROUP BY channel_id, speaker`).all();
    const byCh = {};
    for (const r of rows) {
      const sp = String(r.speaker || '').toLowerCase().trim();
      const hit = (uid && r.user_id && String(r.user_id) === String(uid)) ||
        aliases.has(sp) || aliases.has(sp.replace(/[\s_-]+/g, '')) || aliases.has(sp.split(/[\s\-_(]/)[0]);
      if (hit) byCh[r.channel_id] = (byCh[r.channel_id] || 0) + Number(r.n || 0);
    }
    return Object.entries(byCh)
      .map(([id, count]) => ({ id, name: CHANNEL_NAMES[id] || ('CH-' + String(id).slice(-4)), count }))
      .filter(c => CHANNEL_NAMES[c.id]) // only real catalog channels
      .sort((a, b) => b.count - a.count);
  } catch { return []; }
}

async function buildEntityProfile(key) {
  const ent = findEntity(key);
  if (!ent) return { ok: false, error: 'unknown entity', key };
  const timeline = entityTimeline(ent, 60);
  const channels = entityChannels(ent);
  const totalMsgs = ent.kind === 'channel' ? dbCount(ent.channel.id) : channels.reduce((a, c) => a + c.count, 0);

  // Discord-sync block (honest about REST presence limits).
  const discord = {
    tokenPresent: !!DISCORD_TOKEN,
    channelsSeenIn: channels.map(c => ({ id: c.id, name: c.name, count: c.count })),
    presence: { available: false, note: 'presence not available via REST (Gateway-only) — green dot reflects IPC /health for AIs, not Discord' },
  };

  if (ent.kind === 'ai') {
    const bots = await buildBotList().catch(() => []);
    const bot = bots.find(b => b.name === ent.bot.name) || null;
    const bio = BIOGRAPHIES[ent.bot.name] || null;
    return {
      ok: true, kind: 'ai', resolvedBy: key,
      identity: {
        name: ent.bot.name, handle: ent.bot.name.toLowerCase().replace(/\s+/g, ''),
        role: ent.bot.role, color: ent.bot.color, id: ent.bot.discordId || null,
        provider: bot ? bot.provider : ent.bot.provider, model: bot ? bot.model : ent.bot.model,
        voice: bot ? bot.voice : ent.bot.voice, dmable: bot ? bot.dmable : (ent.bot.dmableOverride === true || ent.bot.route !== 'gateway'),
        online: bot ? !!bot.online : false, clearance: 'AI Agent',
      },
      bio,
      metrics: bot ? {
        energy: bot.energy, aliveness: bot.aliveness, latencyMs: bot.latencyMs,
        uptimeMs: bot.uptimeMs, rssMb: bot.rssMb, recentMsgs: bot.recentMsgs,
        provider: bot.provider, model: bot.model, source: 'live IPC /health + transcripts.db',
      } : { note: 'vitals unavailable (bot offline)' },
      timeline, activity: buildOperations({ who: ent.bot.name, limit: 80 }).operations,
      connections: {
        provider: bot ? bot.provider : ent.bot.provider, channels,
        dmLink: (bot ? bot.dmable : (ent.bot.dmableOverride === true || ent.bot.route !== 'gateway')) ? `/api/dm-history?bot=${encodeURIComponent(ent.bot.name)}` : null,
      },
      files: { available: false, note: 'no upload index — uploads are not tracked in transcripts.db' },
      discord,
    };
  }

  if (ent.kind === 'channel') {
    const c = ent.channel;
    const metrics = channelMetrics(c.id);
    const base = SPEAKER_RULES[c.id] || [];
    return {
      ok: true, kind: 'channel', resolvedBy: key,
      identity: { name: c.name, handle: '#' + c.name, role: (c.type === 'voice' ? 'Voice channel' : 'Text channel') + ' · ' + c.group,
        id: c.id, color: '#22d9e6', clearance: c.tag || (c.group === 'main' ? 'Main' : c.group), online: true },
      bio: null,
      metrics: metrics.error ? { note: metrics.error } : {
        total: metrics.total, uniqueSpeakers: metrics.uniqueSpeakers, inLastHour: metrics.inLastHour,
        inLastDay: metrics.inLastDay, lastActivity: metrics.lastActivity, source: 'transcripts.db',
      },
      timeline,
      activity: [],
      connections: { speakers: base, channels: [{ id: c.id, name: c.name, count: totalMsgs }] },
      files: { available: false, note: 'no upload index for channels' },
      discord: { ...discord, channelProfile: `/api/channel/${c.id}/profile` },
    };
  }

  // human
  const h = ent.human;
  return {
    ok: true, kind: 'human', resolvedBy: key,
    identity: {
      name: h.name, handle: '@' + (h.username || ''), role: h.role, id: h.id, color: '#7c5cff',
      clearance: h.isOwner ? 'ROOT / Owner' : (String(h.role || '').includes('Partner') ? 'Co-lead' : 'Guest'),
      isOwner: h.isOwner, transcriptChannelId: h.transcriptChannelId,
      // humans have no IPC health; presence via REST isn't exposed → null (UI shows neutral dot)
      online: null,
    },
    bio: h.bio || null,
    metrics: {
      totalMessages: totalMsgs, channelsActiveIn: channels.length,
      mostActiveChannel: channels[0] ? channels[0].name : null,
      lastSeen: timeline[0] ? timeline[0].ts : null,
      source: 'transcripts.db (message activity)',
      note: 'human metrics are message-activity stats; energy/latency apply to AIs only',
    },
    timeline, activity: buildOperations({ who: h.name, limit: 60 }).operations,
    connections: { channels, dmLink: null, transcriptChannelId: h.transcriptChannelId || null },
    files: { available: false, note: 'no upload index — uploads are not tracked anywhere in the lattice DB' },
    discord,
  };
}

// ── Per-message metadata (item 5) — exactly what transcripts.db stores ─────────
// transcripts.db has TWO relevant tables (see shared/transcript-memory.mjs):
//   transcript_fts(speaker, user_id, content, context, channel_id, timestamp)
//   user_profile_memories(id, userId, username, channelId, timestamp, content,
//     previousContent, previousSpeaker, intent, tags, metadata)
// There are NO per-message cognition vitals (phi_g / coherence / chi /
// contradiction / learned-by-KAI / linked-to-lattice) stored per row anywhere in
// this DB. We surface the REAL stored fields + DERIVABLE ones (length, prev
// speaker/context, intent, tags) and clearly flag the deeper vitals as not
// captured. We match a message by channel + timestamp (+ optional speaker/text),
// since transcript_fts has no row id of its own.
function messageMeta(q) {
  const db = getDB();
  if (!db) return { error: 'transcripts.db unavailable' };
  const channelId = q.channel ? String(q.channel) : null;
  const ts = q.ts ? Number(q.ts) : null;           // ms (or seconds — normalized below)
  const speaker = q.speaker ? String(q.speaker) : null;
  if (!channelId || !ts) return { error: 'channel + ts required' };
  // The UI carries unix-SECONDS; the DB stores ms. Match within a ±1s window on ms.
  const tsMs = ts < 1e12 ? ts * 1000 : ts;
  let row = null;
  try {
    const sql = speaker
      ? `SELECT speaker, user_id, content, context, channel_id, timestamp
           FROM transcript_fts
          WHERE channel_id = ? AND speaker = ? AND timestamp BETWEEN ? AND ?
          ORDER BY ABS(timestamp - ?) LIMIT 1`
      : `SELECT speaker, user_id, content, context, channel_id, timestamp
           FROM transcript_fts
          WHERE channel_id = ? AND timestamp BETWEEN ? AND ?
          ORDER BY ABS(timestamp - ?) LIMIT 1`;
    row = speaker
      ? db.prepare(sql).get(channelId, speaker, tsMs - 1500, tsMs + 1500, tsMs)
      : db.prepare(sql).get(channelId, tsMs - 1500, tsMs + 1500, tsMs);
  } catch (e) { return { error: e.message }; }
  if (!row) return { error: 'message not found in transcripts.db', captured: false };

  // Best-effort enrichment from user_profile_memories (intent/tags/prev context).
  let profileRow = null;
  try {
    profileRow = db.prepare(
      `SELECT intent, tags, previousSpeaker, previousContent, metadata, username
         FROM user_profile_memories
        WHERE channelId = ? AND timestamp BETWEEN ? AND ?
        ORDER BY ABS(timestamp - ?) LIMIT 1`
    ).get(channelId, tsMs - 2500, tsMs + 2500, tsMs);
  } catch { /* optional */ }

  // Per-message cognition sidecar (item 5) — REAL captured vitals when present.
  // Joined by channel + timestamp window against message_meta (written by
  // transcript-memory.mjs ingestMessage). Missing row / NULL column ⇒ "not
  // captured" — NEVER coerced to 0.
  let metaRow = null;
  try {
    metaRow = db.prepare(
      `SELECT thread_id, phi_g, coherence, contradiction, learned_by_kai
         FROM message_meta
        WHERE channel_id = ? AND timestamp BETWEEN ? AND ?
        ORDER BY ABS(timestamp - ?) LIMIT 1`
    ).get(channelId, tsMs - 2000, tsMs + 2000, tsMs);
  } catch { /* sidecar may not exist on very old DBs */ }

  const capField = (v) => (v === null || v === undefined)
    ? { captured: false, value: null, note: 'not captured' }
    : { captured: true, value: v };

  const text = row.content || '';
  return {
    captured: true,
    threadId: metaRow && metaRow.thread_id ? metaRow.thread_id : (row.channel_id || null),
    // REAL stored per-message fields:
    speaker: row.speaker || 'unknown',
    userId: row.user_id || null,
    channelId: row.channel_id,
    channelName: CHANNEL_NAMES[row.channel_id] || row.channel_id,
    timestampMs: Number(row.timestamp) || 0,
    timestamp: row.timestamp ? Math.floor(Number(row.timestamp) / 1000) : 0,
    length: text.length,
    words: text.trim() ? text.trim().split(/\s+/).length : 0,
    text,
    // enrichment (from user_profile_memories, when present):
    intent: profileRow ? profileRow.intent : null,
    tags: profileRow && profileRow.tags ? String(profileRow.tags).split(',').filter(Boolean).slice(0, 12) : [],
    previousSpeaker: profileRow ? profileRow.previousSpeaker : null,
    previousContent: profileRow ? profileRow.previousContent : null,
    // DEEPER cognition vitals — now sourced from the message_meta sidecar when it
    // was captured at send time. Each field self-labels captured vs "not captured"
    // so the popup shows REAL values (or an honest "not captured"), never a fake 0.
    cognition: {
      captured: !!metaRow,
      source: metaRow ? 'message_meta sidecar (captured at send time)' : null,
      phi_g:          capField(metaRow ? metaRow.phi_g : null),
      coherence:      capField(metaRow ? metaRow.coherence : null),
      contradiction:  capField(metaRow ? metaRow.contradiction : null),
      learnedByKAI:   capField(metaRow ? (metaRow.learned_by_kai === null ? null : !!metaRow.learned_by_kai) : null),
      // chi / linkedToLattice are still not instrumented on any send path.
      chi:            { captured: false, value: null, note: 'not captured' },
      linkedToLattice:{ captured: false, value: null, note: 'not captured' },
      note: metaRow
        ? 'phi_g/coherence/contradiction/learnedByKAI read from message_meta. Fields marked "not captured" were unavailable at send time. chi/linkedToLattice not yet instrumented.'
        : 'No sidecar row for this message (old row or vitals unavailable at send time) — cognition not captured.',
    },
    // latency is NOT derivable per message (no send/ack timestamps stored).
    latencyMs: null,
  };
}

// ── Live Discord THREADS for a channel (item 6) ───────────────────────────────
// transcripts.db has only a flat channel_id (no parent/thread linkage), so threads
// are ONLY available via the live bot-token fetch. We list active + archived public
// threads for a channel and (optionally) one thread's messages. Read-only GET.
// Real captured thread_ids straight from the message_meta sidecar (item 6).
// These are the threads KAI actually persisted messages under — no inference.
function dbCapturedThreads(channelId) {
  const db = getDB();
  if (!db) return [];
  try {
    return db.prepare(
      `SELECT thread_id AS id, COUNT(*) AS messageCount, MAX(timestamp) AS lastTs
         FROM message_meta
        WHERE channel_id = ? AND thread_id IS NOT NULL AND thread_id != ?
        GROUP BY thread_id ORDER BY lastTs DESC`
    ).all(String(channelId), String(channelId)).map(r => ({
      id: String(r.id),
      name: 'thread-' + String(r.id).slice(-4),
      parentId: String(channelId),
      messageCount: Number(r.messageCount) || 0,
      memberCount: null,
      archived: false,
      locked: false,
      createdTs: 0,
      source: 'transcripts.db (captured thread_id)',
    }));
  } catch { return []; }
}

async function fetchChannelThreads(channelId) {
  if (VOICE_IDS.has(channelId)) return { threads: [], note: 'voice channel — no threads' };
  // REAL captured threads first (work even with no Discord token).
  const captured = dbCapturedThreads(channelId);
  if (!DISCORD_TOKEN) {
    return {
      threads: captured,
      available: captured.length > 0,
      source: 'transcripts.db',
      note: captured.length ? 'No Discord token — showing captured thread_ids from transcripts.db.' : 'no_token — no captured thread_ids either.',
    };
  }
  const out = [];
  // Active threads are returned at the GUILD level filtered to this channel:
  // GET /channels/{id}/threads/active is deprecated; the supported route is
  // /guilds/{guild}/threads/active — but per-channel archived works directly.
  const active = await discordGet(`/channels/${channelId}/threads/active`).catch(() => null);
  if (active && active.status === 200 && active.json && Array.isArray(active.json.threads)) {
    for (const t of active.json.threads) out.push(normalizeThread(t, false));
  }
  const archived = await discordGet(`/channels/${channelId}/threads/archived/public?limit=25`).catch(() => null);
  if (archived && archived.status === 200 && archived.json && Array.isArray(archived.json.threads)) {
    for (const t of archived.json.threads) out.push(normalizeThread(t, true));
  }
  const ok = (active && active.status === 200) || (archived && archived.status === 200);
  // MERGE live Discord threads with REAL captured thread_ids (item 6). Live data
  // wins (richer), captured-only ids are appended so persisted threads still show
  // even if Discord no longer lists them (archived beyond the fetch window).
  const liveIds = new Set(out.map(t => t.id));
  for (const c of captured) if (!liveIds.has(c.id)) out.push(c);
  return {
    threads: out,
    available: ok || captured.length > 0,
    note: ok ? '' : 'Discord threads endpoint unavailable (token scope / permissions) — showing captured thread_ids from transcripts.db.',
  };
}
function normalizeThread(t, archived) {
  const meta = t.thread_metadata || {};
  return {
    id: t.id,
    name: t.name || ('thread-' + String(t.id).slice(-4)),
    parentId: t.parent_id || null,
    messageCount: typeof t.message_count === 'number' ? t.message_count : null,
    memberCount: typeof t.member_count === 'number' ? t.member_count : null,
    archived: !!archived || !!meta.archived,
    locked: !!meta.locked,
    // thread creation time derived from the Discord snowflake (epoch 2015-01-01).
    createdTs: t.id ? Math.floor((Number(BigInt(t.id) >> 22n) + 1420070400000) / 1000) : 0,
  };
}
// Messages persisted under a captured thread_id, straight from transcripts.db
// (item 6). Joins message_meta → transcript_fts by rowid. Returns [] on failure.
function dbThreadMessages(threadId) {
  const db = getDB();
  if (!db) return [];
  try {
    return db.prepare(
      `SELECT f.speaker, f.user_id, f.content, f.channel_id, f.timestamp
         FROM message_meta m JOIN transcript_fts f ON f.rowid = m.fts_rowid
        WHERE m.thread_id = ?
        ORDER BY f.timestamp ASC LIMIT 200`
    ).all(String(threadId)).map(r => ({
      channel_id: r.channel_id,
      channel_name: CHANNEL_NAMES[r.channel_id] || ('CH-' + String(r.channel_id).slice(-4)),
      from: r.speaker || 'unknown',
      author: r.speaker || 'unknown',
      user_id: r.user_id || null,
      text: r.content || '',
      ts: r.timestamp ? Math.floor(Number(r.timestamp) / 1000) : 0,
    }));
  } catch { return []; }
}

// Fetch one thread's recent messages (read-only). Live Discord first (richest),
// falling back to REAL captured rows from transcripts.db.
async function fetchThreadMessages(threadId) {
  if (DISCORD_TOKEN) {
    const res = await discordGet(`/channels/${threadId}/messages?limit=${LIVE_LIMIT}`);
    if (res.status === 200 && Array.isArray(res.json)) {
      return res.json.map(m => normalizeDiscordMsg(m, threadId)).reverse();
    }
  }
  const captured = dbThreadMessages(threadId);
  return captured.length ? captured : null;
}

// ── LIVE Discord fetch (read-only, GET only) ──────────────────────────────────
// Map for quick channel-type lookup (voice channels have no text messages API).
const CHANNEL_TYPE = Object.fromEntries(CHANNEL_CATALOG.map(c => [c.id, c.type]));
const VOICE_IDS = new Set(CHANNEL_CATALOG.filter(c => c.type === 'voice').map(c => c.id));

// Per-channel count straight from transcripts.db (used for voice channels + as a
// fallback). Cheap COUNT query; returns 0 on any failure.
function dbCount(channelId) {
  const db = getDB();
  if (!db) return 0;
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM transcript_fts WHERE channel_id = ?`).get(String(channelId));
    return row ? Number(row.n) || 0 : 0;
  } catch { return 0; }
}

// Minimal HTTPS GET to the Discord REST API. Resolves { status, json, retryAfter }.
// Never throws; never logs the token. Uses global fetch (Node 18+).
async function discordGet(apiPath) {
  if (!DISCORD_TOKEN) return { status: 0, json: null, error: 'no_token' };
  try {
    const r = await fetch(`${DISCORD_API}${apiPath}`, {
      method: 'GET',
      headers: { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'User-Agent': 'KAI-CommandCenter (read-only, v1)' },
    });
    let json = null;
    const retryAfter = Number(r.headers.get('retry-after')) || 0;
    try { json = await r.json(); } catch { json = null; }
    return { status: r.status, json, retryAfter };
  } catch (e) {
    return { status: 0, json: null, error: e?.message || 'fetch_failed' };
  }
}

// Normalize a Discord message object → dashboard turn shape.
function normalizeDiscordMsg(m, channelId) {
  const nick = m.member && m.member.nick;
  const author = nick || (m.author && (m.author.global_name || m.author.username)) || 'unknown';
  return {
    channel_id: channelId,
    channel_name: CHANNEL_NAMES[channelId] || ('CH-' + String(channelId).slice(-4)),
    from: author,
    author,
    user_id: (m.author && m.author.id) || null,
    text: m.content || '',
    ts: m.timestamp ? Math.floor(Date.parse(m.timestamp) / 1000) : 0,
  };
}

/**
 * Fetch the last LIVE_LIMIT messages for a TEXT channel from Discord, with a
 * short-TTL per-channel cache. Returns an array of normalized turns (oldest→newest
 * for display) or null on failure / voice / rate-limit (caller falls back to db).
 */
async function fetchLiveMessages(channelId) {
  // Voice channels have no messages API — never call Discord for them.
  if (VOICE_IDS.has(channelId)) return null;

  const now = Date.now();
  const cached = liveCache.get(channelId);
  if (cached && (now - cached.ts) < LIVE_TTL_MS) return cached.msgs;

  // Honor an active 429 back-off — skip the network call entirely.
  if (now < rateLimitedUntil) return cached ? cached.msgs : null;

  const res = await discordGet(`/channels/${channelId}/messages?limit=${LIVE_LIMIT}`);

  if (res.status === 200 && Array.isArray(res.json)) {
    // Discord returns newest-first; reverse for newest-last display.
    const msgs = res.json.map(m => normalizeDiscordMsg(m, channelId)).reverse();
    liveCache.set(channelId, { ts: now, msgs });
    return msgs;
  }

  // Graceful degradation — short non-secret warning, then fall back to db.
  if (res.status === 429) {
    const backoff = Math.max(1, res.retryAfter || 1);
    rateLimitedUntil = now + Math.ceil(backoff * 1000);
    console.warn(`[CmdCenter] Discord 429 rate-limited — backing off ${backoff}s, using transcripts.db`);
  } else if (res.status === 401 || res.status === 403) {
    console.warn(`[CmdCenter] Discord ${res.status} for channel ${String(channelId).slice(-4)} (permission) — falling back to transcripts.db`);
  } else if (res.status >= 500) {
    console.warn(`[CmdCenter] Discord ${res.status} (server) for channel ${String(channelId).slice(-4)} — falling back to transcripts.db`);
  } else if (res.error === 'no_token') {
    // Logged once-ish; avoid spamming. No secret involved.
  } else if (res.status !== 200) {
    console.warn(`[CmdCenter] Discord status ${res.status} for channel ${String(channelId).slice(-4)} — falling back to transcripts.db`);
  }
  // Keep any stale cached copy alive a little longer so the UI isn't blanked.
  return cached ? cached.msgs : null;
}

// ── Per-bot DM threads (now PERSISTED to state/dm_history_<bot>.json) ──────────
const botThreads = {}; // botName -> [{from, text, ts}]
// Lazily load a bot's thread from disk into memory the first time it's touched.
function ensureThreadLoaded(botName) {
  if (botThreads[botName]) return botThreads[botName];
  try {
    const raw = fs.readFileSync(dmHistoryFile(botName), 'utf8');
    const arr = JSON.parse(raw);
    botThreads[botName] = Array.isArray(arr) ? arr : [];
  } catch { botThreads[botName] = []; }
  return botThreads[botName];
}
function persistThread(botName) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const f = dmHistoryFile(botName);
    fs.writeFileSync(f + '.tmp', JSON.stringify(botThreads[botName] || [], null, 0), 'utf8');
    fs.renameSync(f + '.tmp', f);
  } catch (e) { /* non-fatal: persistence is best-effort */ }
}
function pushThread(botName, msg) {
  ensureThreadLoaded(botName).push(msg);
  if (botThreads[botName].length > 200) botThreads[botName].shift();
  persistThread(botName);
}
// POST a turn to the engine and resolve {reply, from} | null. Used for the
// public-chat round-trip route. The engine answers synchronously.
function enginePost(enginePath, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const r = http.request({
      hostname: ENGINE_HOST, port: ENGINE_PORT, path: enginePath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, timeout: 30000,
    }, (eRes) => {
      let d=''; eRes.on('data',c=>d+=c);
      eRes.on('end', ()=>{ try { resolve({ ok: eRes.statusCode<400, json: JSON.parse(d) }); } catch { resolve({ ok:false, json:null }); } });
    });
    r.on('timeout', ()=>{ r.destroy(); resolve({ ok:false, json:null, timeout:true }); });
    r.on('error', ()=> resolve({ ok:false, json:null }));
    r.write(data); r.end();
  });
}
// Signal a bot's IPC /trigger (fire-and-forget; no reply round-trip).
function signalBotIPC(port, payload) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(payload));
    const r = http.request({ hostname:'127.0.0.1', port, path:'/trigger', method:'POST',
      headers:{ 'Content-Type':'application/json', 'Content-Length':data.length }, timeout:4000 },
      (rs)=>{ rs.resume(); rs.on('end',()=>resolve(true)); });
    r.on('timeout', ()=>{ r.destroy(); resolve(false); });
    r.on('error', ()=> resolve(false));
    r.write(data); r.end();
  });
}
// Like signalBotIPC but RESOLVES the bot's JSON reply (Oracle's synchronous DM on port 3410).
function requestBotIPC(port, payload, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(payload));
    const r = http.request({ hostname:'127.0.0.1', port, path:'/trigger', method:'POST',
      headers:{ 'Content-Type':'application/json', 'Content-Length':data.length }, timeout:timeoutMs },
      (rs)=>{ let d=''; rs.on('data',c=>d+=c); rs.on('end',()=>{ try{ resolve(JSON.parse(d)); }catch{ resolve(null); } }); });
    r.on('timeout', ()=>{ r.destroy(); resolve(null); });
    r.on('error', ()=> resolve(null));
    r.write(data); r.end();
  });
}
/**
 * Direct DM to one bot. Strategy:
 *  - If the bot has a 'public-chat:<prefix>' route, call the engine's
 *    /api/public-chat with the model prefix so the reply comes from THAT model
 *    → real round-trip reply, appended to the thread.
 *  - Otherwise signal the bot's IPC /trigger (so the message reaches the bot)
 *    and return a send-only acknowledgement (reply will surface in-channel).
 */
async function botChat(payload, res) {
  const botName = String(payload.bot || '').trim();
  const text = String(payload.text || '').trim();
  const bot = BOT_ROSTER.find(b => b.name.toLowerCase() === botName.toLowerCase());
  if (!bot) return sendJSON(res, 404, { error: 'unknown bot', bot: botName });
  if (!text) return sendJSON(res, 400, { error: 'empty text' });
  // Oracle is the gateway/moderator/root. Its gateway (port 3410) now answers a
  // synchronous {type:'DM'} over IPC via chatWithOpenJarvis('Oracle',…). Round-trip it.
  if (bot.route === 'gateway') {
    pushThread(bot.name, { from: 'NasterModx', text, ts: Math.floor(Date.now()/1000) });
    const or = await requestBotIPC(bot.port, { type: 'DM', from: 'NasterModx', text });
    const oReply = or && (or.reply || or.text);
    if (oReply) {
      const replyMsg = { from: (or.from || bot.name), text: String(oReply), ts: Math.floor(Date.now()/1000) };
      pushThread(bot.name, replyMsg);
      return sendJSON(res, 200, { ok: true, roundtrip: true, reply: replyMsg, thread: botThreads[bot.name] });
    }
    return sendJSON(res, 200, { ok: true, roundtrip: false,
      note: `${bot.name} gateway offline (port ${bot.port}) — message stored only.`, thread: botThreads[bot.name] });
  }

  // record the user's outgoing message
  pushThread(bot.name, { from: 'NasterModx', text, ts: Math.floor(Date.now()/1000) });

  if (bot.route && bot.route.startsWith('public-chat:')) {
    const prefix = bot.route.split(':')[1];
    const routed = `${prefix} ${text}`; // engine routes by leading model token
    const r = await enginePost('/api/public-chat', { from: 'NasterModx', text: routed });
    const reply = r.json && (r.json.reply || r.json.text || r.json.message);
    if (r.ok && reply) {
      const replyMsg = { from: r.json.from || bot.name, text: String(reply), ts: Math.floor(Date.now()/1000) };
      pushThread(bot.name, replyMsg);
      return sendJSON(res, 200, { ok: true, roundtrip: true, reply: replyMsg, thread: botThreads[bot.name] });
    }
    // engine offline / no reply — fall through to IPC send-only
  }

  // Send-only path: reach the bot via its IPC port; no synchronous reply.
  const delivered = await signalBotIPC(bot.port, { type: 'DM', from: 'NasterModx', text });
  return sendJSON(res, 200, {
    ok: true, roundtrip: false, delivered,
    note: delivered ? `sent — reply will appear in-channel` : `bot ${bot.name} offline (port ${bot.port}) — queued message stored only`,
    thread: botThreads[bot.name],
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function proxyToEngine(req, res) {
  const proxyReq = http.request({
    hostname: ENGINE_HOST,
    port: ENGINE_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `${ENGINE_HOST}:${ENGINE_PORT}` }
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => {
    sendJSON(res, 502, { error: 'engine_offline', engine: `${ENGINE_HOST}:${ENGINE_PORT}` });
  });
  req.pipe(proxyReq);
}

// ── Detached ecosystem restart ────────────────────────────────────────────────
// Spawns a DETACHED, unref'd cmd that: runs KAI-Stop.bat (which kills the whole
// node fleet INCLUDING this dashboard), waits ~5s, then relaunches via Start-KAI.ps1
// (with -fullfleet for scope 'fleet'). Because it's detached+unref'd with its own
// console, it survives this process being killed by the stop script.
function spawnEcosystemRestart(scope) {
  const fleet = scope === 'fleet';
  const cmdLine =
    `"${KAI_STOP_BAT}" & timeout /t 5 /nobreak & ` +
    `powershell -ExecutionPolicy Bypass -File "${START_KAI_PS1}"` +
    (fleet ? ' -fullfleet' : '');
  const child = spawn('cmd', ['/c', cmdLine], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}

// ── Live system telemetry for the Home view (read-only) ───────────────────────
// CPU%: sampled over a short window from os.cpus() idle/total deltas.
let _cpuPrev = os.cpus().map(c => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }));
function sampleCpuPercent() {
  const now = os.cpus().map(c => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }));
  let idleD = 0, totalD = 0;
  for (let i = 0; i < now.length; i++) {
    idleD += now[i].idle - (_cpuPrev[i]?.idle || 0);
    totalD += now[i].total - (_cpuPrev[i]?.total || 0);
  }
  _cpuPrev = now;
  if (totalD <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - idleD / totalD) * 100)));
}
// Provider/model cooldowns from state/provider_cooldowns.json → [{provider, model, remainingMin}].
function readProviderCooldowns() {
  const candidates = [
    path.join(__dirname, 'state', 'provider_cooldowns.json'),
    path.join(__dirname, 'provider_cooldowns.json'),
  ];
  let raw = null;
  for (const p of candidates) { try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); break; } catch {} }
  if (!raw || typeof raw !== 'object') return [];
  const now = Date.now();
  const out = [];
  // Tolerant of shapes: { "<provider>": <untilMs> } or { "<key>": { until|expires|cooldownUntil, model } }
  for (const [key, v] of Object.entries(raw)) {
    let until = 0, model = '';
    // Keys look like "moonshot_PUWi" or "gemini_qn-Q::gemini-2.5-flash" — the part
    // after '::' is the model. The leading token before '_' is the provider name.
    let provider = key;
    if (key.includes('::')) { const [k, m] = key.split('::'); provider = k; model = m; }
    provider = provider.split('_')[0] || provider;
    if (typeof v === 'number') until = v;
    else if (v && typeof v === 'object') { until = Number(v.until || v.expires || v.cooldownUntil || v.resetAt || 0); model = v.model || model; }
    if (!until) continue;
    // accept seconds or ms
    if (until < 1e12) until *= 1000;
    const remMs = until - now;
    if (remMs > 0) out.push({ provider, model, remainingMin: Math.ceil(remMs / 60000) });
  }
  return out;
}
// Per-core CPU% — sampled over the same window as sampleCpuPercent (shares _cpuPrev
// snapshot). Returns an array of 0–100 per logical core. Must be called AFTER the
// aggregate sample has refreshed _cpuPrev, so we keep a separate per-core snapshot.
let _perCorePrev = os.cpus().map(c => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }));
function samplePerCore() {
  const now = os.cpus().map(c => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }));
  const out = [];
  for (let i = 0; i < now.length; i++) {
    const idleD = now[i].idle - (_perCorePrev[i]?.idle || 0);
    const totalD = now[i].total - (_perCorePrev[i]?.total || 0);
    out.push(totalD <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((1 - idleD / totalD) * 100))));
  }
  _perCorePrev = now;
  return out;
}
// Best-effort GPU utilization via `nvidia-smi` (NVIDIA only). Cached ~5s; never
// throws, never blocks the response (async refresh, returns cache/null meanwhile).
let _gpuCache = { ts: 0, gpu: null };
function readGpu() {
  const now = Date.now();
  if ((now - _gpuCache.ts) < 5000) return _gpuCache.gpu;
  _gpuCache.ts = now; // throttle spawns regardless of outcome
  try {
    const child = spawn('nvidia-smi',
      ['--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,name', '--format=csv,noheader,nounits'],
      { windowsHide: true });
    let out = '';
    child.stdout.on('data', d => out += d);
    child.on('error', () => { _gpuCache.gpu = null; });
    child.on('close', () => {
      const line = (out.split(/\r?\n/).find(l => l.trim()) || '').trim();
      if (!line) { _gpuCache.gpu = null; return; }
      const [util, memU, memT, temp, name] = line.split(',').map(s => s.trim());
      const g = { percent: Number(util) || 0, memUsedMB: Number(memU) || 0, memTotalMB: Number(memT) || 0, tempC: Number(temp) || 0, name: name || 'GPU' };
      _gpuCache.gpu = g;
    });
  } catch { _gpuCache.gpu = null; }
  return _gpuCache.gpu; // may be last value while the async refresh runs
}
// Best-effort disk usage for the KAI drive. Async cached (~15s); never blocks.
let _diskCache = { ts: 0, disk: null };
function readDisk() {
  const now = Date.now();
  if ((now - _diskCache.ts) < 15000) return _diskCache.disk;
  _diskCache.ts = now;
  try {
    if (process.platform === 'win32') {
      // PowerShell one-liner for C: free/total (bytes). windowsHide, short-lived.
      const ps = spawn('powershell', ['-NoProfile', '-Command',
        '$d=Get-PSDrive C; "{0},{1}" -f $d.Used,$d.Free'], { windowsHide: true });
      let out = '';
      ps.stdout.on('data', d => out += d);
      ps.on('error', () => { _diskCache.disk = null; });
      ps.on('close', () => {
        const m = (out.match(/(\d+),(\d+)/));
        if (!m) { _diskCache.disk = null; return; }
        const used = Number(m[1]), free = Number(m[2]); const total = used + free;
        if (total > 0) _diskCache.disk = { drive: 'C:', usedGB: +(used / 1073741824).toFixed(1), totalGB: +(total / 1073741824).toFixed(1), percent: Math.round(used / total * 100) };
      });
    } else { _diskCache.disk = null; }
  } catch { _diskCache.disk = null; }
  return _diskCache.disk;
}
// Engine (Rust) RSS via /health->/api/session is not exposed; instead read the
// kai.exe process RSS via tasklist (Windows). Cached ~8s, async, never blocks.
let _engCache = { ts: 0, eng: null };
function readEngineProc() {
  const now = Date.now();
  if ((now - _engCache.ts) < 8000) return _engCache.eng;
  _engCache.ts = now;
  try {
    if (process.platform === 'win32') {
      const tl = spawn('tasklist', ['/FI', 'IMAGENAME eq kai.exe', '/FO', 'CSV', '/NH'], { windowsHide: true });
      let out = '';
      tl.stdout.on('data', d => out += d);
      tl.on('error', () => { _engCache.eng = null; });
      tl.on('close', () => {
        // CSV: "kai.exe","<pid>","Console","1","123,456 K"
        const lines = out.split(/\r?\n/).filter(l => /kai\.exe/i.test(l));
        if (!lines.length) { _engCache.eng = null; return; }
        let rssKB = 0, count = lines.length;
        for (const l of lines) {
          const m = l.match(/"([\d,]+)\s*K"\s*$/);
          if (m) rssKB += Number(m[1].replace(/,/g, '')) || 0;
        }
        _engCache.eng = { name: 'kai.exe', count, rssMb: Math.round(rssKB / 1024) };
      });
    } else { _engCache.eng = null; }
  } catch { _engCache.eng = null; }
  return _engCache.eng;
}
async function buildSystemStats() {
  const cpuPct = sampleCpuPercent();
  const perCore = samplePerCore();
  const totalMem = os.totalmem(), freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const ramPct = Math.round((usedMem / totalMem) * 100);
  const load = os.loadavg(); // [1,5,15] — on Windows often [0,0,0]
  let bots = [];
  try { bots = (await buildBotList()).map(b => ({ name: b.name, online: !!b.online, uptime_ms: b.health?.uptime_ms || null, latencyMs: b.latencyMs ?? null, rssMb: b.rssMb ?? null, energy: b.energy ?? null, aliveness: b.aliveness ?? null, role: b.role, color: b.color })); }
  catch { bots = []; }
  const onlineBots = bots.filter(b => b.online).length;
  const cpus = os.cpus();
  return {
    ts: Math.floor(Date.now() / 1000),
    cpu: { percent: cpuPct, cores: cpus.length, load1: Number(load[0]?.toFixed?.(2) ?? 0), perCore, model: (cpus[0]?.model || '').trim(), speedMHz: cpus[0]?.speed || 0 },
    ram: { usedMB: Math.round(usedMem / 1048576), totalMB: Math.round(totalMem / 1048576), percent: ramPct },
    gpu: readGpu(),                 // {percent,memUsedMB,memTotalMB,tempC,name} | null
    disk: readDisk(),               // {drive,usedGB,totalGB,percent} | null
    engine: readEngineProc(),       // {name:'kai.exe',count,rssMb} | null
    procRssMb: Math.round(process.memoryUsage().rss / 1048576), // this command-center process
    host: { platform: process.platform, arch: process.arch, hostname: os.hostname(), release: os.release() },
    uptime: { hostSec: Math.floor(os.uptime()), procSec: Math.floor(process.uptime()) },
    agentsOnline: onlineBots, agentsTotal: bots.length,
    cooldowns: readProviderCooldowns(),
    providers: buildProviderStatus(bots),
    bots,
  };
}
// ── ALL-PROVIDER live status (item 4) ─────────────────────────────────────────
// Returns one row per known provider with a derived status:
//   OFFLINE  — locally checkable (ollama) and unreachable
//   COOLDOWN — present in state/provider_cooldowns.json (+remainingMin)
//   OK       — actively in use by an online bot (or reachable for ollama)
//   STANDBY  — configured/known but not currently carrying an online bot
// Reachability is only asserted where we can actually check it (ollama локально).
const PROVIDER_LABELS = {
  ollama:'Ollama (Local)', gemini:'Gemini (Google)', groq:'Groq', xai:'xAI (Grok)',
  moonshot:'Moonshot / Kimi', zen:'Zen Router', anthropic:'Anthropic', openai:'OpenAI', elevenlabs:'ElevenLabs',
};
function buildProviderStatus(bots) {
  const cds = readProviderCooldowns();
  const cdByProv = {};
  for (const c of cds) {
    const p = String(c.provider || '').toLowerCase();
    if (!cdByProv[p] || c.remainingMin > cdByProv[p].remainingMin) cdByProv[p] = c;
  }
  // which providers are carried by an ONLINE bot right now
  const liveByProv = {};
  for (const b of (bots || [])) {
    const p = String(b.provider || '').toLowerCase();
    if (!p) continue;
    liveByProv[p] = liveByProv[p] || { online:false, count:0 };
    liveByProv[p].count++;
    if (b.online) liveByProv[p].online = true;
  }
  // Show the canonical set + any provider seen live or on cooldown.
  const set = new Set(['ollama','gemini','groq','xai','moonshot','zen','anthropic','openai']);
  for (const p of Object.keys(liveByProv)) set.add(p);
  for (const p of Object.keys(cdByProv)) set.add(p);
  const ollamaUp = _ollamaCache.models && _ollamaCache.models.length > 0;
  listOllamaModels(); // kick async refresh of reachability cache
  const rows = [];
  for (const p of set) {
    const label = PROVIDER_LABELS[p] || p;
    const cd = cdByProv[p];
    const live = liveByProv[p];
    let status, remainingMin = 0, detail = '';
    if (cd) { status = 'COOLDOWN'; remainingMin = cd.remainingMin; detail = cd.model || ''; }
    else if (p === 'ollama') { status = ollamaUp ? 'OK' : 'OFFLINE'; detail = ollamaUp ? `${_ollamaCache.models.length} models` : 'no /api/tags'; }
    else if (live && live.online) { status = 'OK'; detail = `${live.count} bot${live.count>1?'s':''}`; }
    else if (live) { status = 'STANDBY'; detail = `${live.count} bot${live.count>1?'s':''}`; }
    else { status = 'STANDBY'; detail = ''; }
    rows.push({ provider: p, label, status, remainingMin, detail, bots: live ? live.count : 0 });
  }
  // stable, useful order: OK first, then COOLDOWN, STANDBY, OFFLINE
  const rank = { OK:0, COOLDOWN:1, STANDBY:2, OFFLINE:3 };
  rows.sort((a, b) => (rank[a.status] - rank[b.status]) || a.label.localeCompare(b.label));
  return rows;
}

// ── REAL OPERATIONS FEED (item 1) ─────────────────────────────────────────────
// Tails + parses the actual ecosystem logs into STRUCTURED, newest-first events.
// Each event: { ts, who, type, detail, from, to, status, raw } — a schema that
// also doubles as the data backbone for a future "nervous system" signal-flow
// view (every event carries from/to + status so edges can be drawn directly).
//   type:   'tool'|'skill'|'provider'|'floor'|'voice'|'error'|'signal'
//   status: 'ok'|'warn'|'error'
// We parse three real sources and skip anything unrecognisable, gracefully:
//   logs/ecosystem.log  — "[Bot] [Component] message"  (NO leading timestamp)
//   logs/audit.json     — NDJSON {timestamp,type,provider,...}
//   logs/sentinel.log   — "[ISO] [TYPE] message"
const OPS_FILES = {
  ecosystem: path.join(LOG_DIR, 'ecosystem.log'),
  audit:     path.join(LOG_DIR, 'audit.json'),
  sentinel:  path.join(LOG_DIR, 'sentinel.log'),
};
// Tail the last N bytes of a (possibly large) log file without reading it whole.
function tailFile(file, maxBytes) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      const len = size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}
// Known short bot/component names (so from-resolution never invents nodes).
const OPS_KNOWN_BOTS = new Set(BOT_ROSTER.map(b => b.name.toLowerCase()).concat(['ecosystem','dashboard','radio']));
function opsResolveWho(prefix) {
  const p = String(prefix || '').trim();
  const lc = p.toLowerCase();
  if (OPS_KNOWN_BOTS.has(lc)) {
    const hit = BOT_ROSTER.find(b => b.name.toLowerCase() === lc);
    return hit ? hit.name : (p.charAt(0).toUpperCase() + p.slice(1));
  }
  return p || 'system';
}
// Parse ONE ecosystem.log line → event | null (null = skip gracefully).
// Lines look like: "[Leo] [GeminiLive] Tool call: codex_search"
//                  "[Groq] [Groq/Lock] 🗝️ Floor acquired."
//                  "[KAI] ERROR: [KAI/TTS] Connection lost (Failure 1/5)..."
function parseEcosystemLine(line, fileTs) {
  const m = line.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (!m) return null;
  const who = opsResolveWho(m[1]);
  let rest = m[2].trim();
  if (!rest) return null;
  let status = 'ok';
  // ERROR lines: "[Bot] ERROR: [Component] msg"
  const errM = rest.match(/^ERROR:\s*(.*)$/);
  if (errM) { status = 'error'; rest = errM[1].trim(); }
  // HANDLED transients (e.g. vitals broadcast deferred while engine busy/down):
  // a line carrying a "[handled]" marker is an absorbed, recovered-by-backoff
  // event — render it amber (warn), never red (error), mirroring the handled-429
  // classification, so it can't dominate the recent-errors feed.
  if (/\[handled\]/i.test(rest)) { status = status === 'error' ? 'warn' : status; }
  // optional secondary component tag: "[Component] message"
  let component = '';
  const comp = rest.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (comp) { component = comp[1]; rest = comp[2].trim(); }
  const detailFull = rest;
  const low = detailFull.toLowerCase();
  // `full` = the COMPLETE message (component + untruncated rest) so the UI can
  // expand the short card label to the entire error text. `raw` = whole log line.
  const fullMsg = (component ? `[${component}] ` : '') + detailFull;
  const base = { ts: fileTs, who, from: who, to: 'engine', status, full: fullMsg, raw: line.trim() };

  // — Tool / skill calls —
  let mm;
  if ((mm = detailFull.match(/Tool call:\s*([A-Za-z0-9_\-]+)/i))) {
    const tool = mm[1];
    const to = /codex|search|section/i.test(tool) ? 'codex' : (/discord|soundboard|narrate/i.test(tool) ? 'discord' : 'engine');
    return { ...base, type: 'tool', detail: `tool call → ${tool}`, to };
  }
  if (/EXACT Codex search for:/i.test(detailFull)) {
    const q = detailFull.split(/EXACT Codex search for:/i)[1]?.trim() || '';
    return { ...base, type: 'tool', detail: `Codex search: ${q.slice(0, 80)}`, to: 'codex' };
  }
  if (/\b(recent_updates|skill|websearch|knowledge)\b/i.test(low) && /call|invoke|run/i.test(low)) {
    return { ...base, type: 'skill', detail: detailFull.slice(0, 120), to: 'engine' };
  }
  // — Floor / turn handoffs —
  if (/Floor acquired/i.test(detailFull)) return { ...base, type: 'floor', detail: 'Floor acquired', to: 'floor', status: 'ok' };
  if (/Floor released/i.test(detailFull)) return { ...base, type: 'floor', detail: 'Floor released', to: 'floor', status: 'ok' };
  if (/pre-empted by/i.test(detailFull)) {
    const by = detailFull.match(/pre-empted by\s+([A-Za-z]+)/i);
    return { ...base, type: 'floor', detail: `pre-empted${by ? ' by ' + by[1] : ''}`, to: by ? by[1] : 'floor', status: 'warn' };
  }
  // — Voice session signals —
  if (/GoAway/i.test(detailFull)) return { ...base, type: 'voice', detail: 'GoAway — session limit, reconnecting', to: 'gemini-live', status: 'warn' };
  if (/Session restored/i.test(detailFull)) {
    const sess = detailFull.match(/\(([^)]+)\)/);
    return { ...base, type: 'voice', detail: `voice session restored${sess ? ' (' + sess[1] + ')' : ''}`, to: 'gemini-live', status: 'ok' };
  }
  if (/Connection closed/i.test(detailFull)) {
    const code = detailFull.match(/Connection closed:\s*(\d+)/);
    const st = code && code[1] !== '1000' ? 'warn' : 'ok';
    return { ...base, type: 'voice', detail: `connection closed${code ? ' (' + code[1] + ')' : ''}`, to: 'gemini-live', status: st };
  }
  if (/Connection (lost|failed)/i.test(detailFull)) return { ...base, type: 'voice', detail: component ? `${component}: ${detailFull.slice(0, 90)}` : detailFull.slice(0, 100), to: 'gemini-live', status: 'error' };
  // — Provider / model signal —
  if (/NEURAL_RECOVERY|verified stable/i.test(detailFull)) {
    const via = detailFull.match(/via\s+([A-Za-z0-9_\-]+)/i);
    return { ...base, type: 'provider', detail: `provider recovered${via ? ' via ' + via[1] : ''}`, to: via ? via[1].split('_')[0] : 'provider', status: 'ok' };
  }
  if (/rotating to next/i.test(detailFull)) return { ...base, type: 'provider', detail: detailFull.slice(0, 110), to: 'provider', status: 'warn' };
  if (/COOLDOWN|\b1011\b|\b429\b/i.test(detailFull)) {
    const via = detailFull.match(/via\s+([A-Za-z0-9_\-]+)/i);
    return { ...base, type: 'provider', detail: detailFull.slice(0, 110), to: via ? via[1].split('_')[0] : 'provider', status: 'warn' };
  }
  // — Generic errors (anything ERROR-tagged not matched above) —
  if (status === 'error') {
    return { ...base, type: 'error', detail: (component ? `${component}: ` : '') + detailFull.slice(0, 120), to: component ? component.split('/')[0] : 'engine' };
  }
  // Everything else is uninteresting boilerplate → skip gracefully.
  return null;
}
// Parse one audit.json (NDJSON) record → event | null.
function parseAuditRecord(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const ts = obj.timestamp ? Date.parse(obj.timestamp) : Date.now();
  const provRaw = String(obj.provider || '');
  const prov = provRaw.split('::')[0].split('_')[0] || provRaw;
  const model = provRaw.includes('::') ? provRaw.split('::')[1] : '';
  const t = String(obj.type || '');
  if (t === 'NEURAL_FAILURE') {
    // RECLASSIFICATION: a HANDLED 429 / quota / short cooldown that the rotation
    // absorbs is a transient — render it amber (warn), NOT red (error), and keep it
    // out of errors/min. Only un-recoverable failures (permanent billing/auth, daily
    // TPD lockout) stay red. `handled` is set by failure-tracker.recordProviderFailure;
    // for older records without the flag, infer it from a 429 + short cooldown.
    const cdMin = Math.round((obj.cooldownMs || 0) / 60000);
    const handled = (obj.handled === true) ||
      (obj.handled == null && !obj.isPermanent && obj.errorStatus === 429 && (obj.cooldownMs || 0) <= 600000);
    const st = handled ? 'warn' : 'error';
    const tag = handled ? 'quota/rate (handled, rotated)' : 'failure';
    const d = `${prov} ${tag} ${obj.errorStatus || ''} (streak ${obj.streak || '?'}, cd ${cdMin}m)`.trim();
    const fullRaw = JSON.stringify(obj);
    return { ts, who: prov || 'provider', from: prov || 'provider', to: 'engine', type: 'provider',
      detail: d, full: (obj.errorMessage || obj.message || d) + ` — ${fullRaw}`, status: st, raw: fullRaw };
  }
  if (t === 'NEURAL_RECOVERY') {
    return { ts, who: prov || 'provider', from: prov || 'provider', to: 'engine', type: 'provider',
      detail: `${prov} recovered — streak/cooldown reset`, status: 'ok', raw: JSON.stringify(obj) };
  }
  if (t === 'LEO_HEARTBEAT_PULSE') {
    return { ts, who: 'Leo', from: 'Leo', to: 'engine', type: 'signal',
      detail: `heartbeat (bridges ${obj.bridgeCount ?? '?'}, tasks ${obj.taskCount ?? '?'})`, status: 'ok', raw: '' };
  }
  // Unknown audit type → keep as a generic signal so nothing is silently lost.
  return { ts, who: prov || 'system', from: prov || 'system', to: 'engine', type: 'signal',
    detail: `${t}${model ? ' · ' + model : ''}`, status: 'ok', raw: JSON.stringify(obj) };
}
// Parse one sentinel.log line → event | null. "[ISO] [TYPE] message"
function parseSentinelLine(line) {
  const m = line.match(/^\[([^\]]+)\]\s*\[([^\]]+)\]\s*(.*)$/);
  if (!m) return null;
  const ts = Date.parse(m[1]) || Date.now();
  const type = m[2];
  const detail = m[3].trim();
  if (/HEALTH/i.test(type)) return null; // pure metric spam — skip from the ops feed
  if (/INTERVENTION|DEADLOCK/i.test(type) || /INTERVENTION|DEADLOCK|stalled/i.test(detail)) {
    const bot = detail.match(/Bot '([^']+)'/);
    return { ts, who: 'Sentinel', from: 'Sentinel', to: bot ? bot[1] : 'engine', type: 'error',
      detail: detail.slice(0, 120), full: detail, status: 'warn', raw: line.trim() };
  }
  return { ts, who: 'Sentinel', from: 'Sentinel', to: 'engine', type: 'signal', detail: `${type}: ${detail}`.slice(0, 120), full: `${type}: ${detail}`, status: 'ok', raw: line.trim() };
}
// Build the merged, newest-first operations feed.
// Note: ecosystem.log lines have NO timestamp, so we synthesise a monotonic
// ordering for them (file order = chronological) and anchor them just before the
// newest *timestamped* event so they interleave sensibly. Audit/sentinel keep
// their real ISO timestamps.
function buildOperations(opts) {
  const limit = Math.min(Math.max(parseInt(opts?.limit, 10) || 120, 1), 500);
  const filter = String(opts?.filter || 'all').toLowerCase();
  const who = opts?.who ? String(opts.who).toLowerCase() : '';
  const events = [];

  // audit.json (real timestamps) — newest matter most; tail the file.
  const auditRaw = tailFile(OPS_FILES.audit, 256 * 1024);
  for (const ln of auditRaw.split(/\r?\n/)) {
    const s = ln.trim(); if (!s) continue;
    let obj; try { obj = JSON.parse(s); } catch { continue; }
    const e = parseAuditRecord(obj); if (e) events.push(e);
  }
  // sentinel.log (real timestamps).
  const sentRaw = tailFile(OPS_FILES.sentinel, 128 * 1024);
  for (const ln of sentRaw.split(/\r?\n/)) {
    const s = ln.trim(); if (!s) continue;
    const e = parseSentinelLine(s); if (e) events.push(e);
  }
  // ecosystem.log (NO timestamps) — assign synthetic, strictly-increasing ts
  // anchored near "now" so they sort as the freshest stream (matching the
  // user's live tail). Order within the file is preserved.
  const ecoRaw = tailFile(OPS_FILES.ecosystem, 512 * 1024);
  const ecoLines = ecoRaw.split(/\r?\n/);
  const ecoEvents = [];
  for (const ln of ecoLines) {
    const s = ln.trim(); if (!s) continue;
    const e = parseEcosystemLine(s, 0); if (e) ecoEvents.push(e);
  }
  // Anchor: newest eco line = now; each older line 1s back (purely for ordering).
  const nowMs = Date.now();
  for (let i = 0; i < ecoEvents.length; i++) {
    ecoEvents[i].ts = nowMs - (ecoEvents.length - 1 - i) * 1000;
    ecoEvents[i].synthTs = true; // flag: ordering-only timestamp
    events.push(ecoEvents[i]);
  }

  // newest-first
  events.sort((a, b) => (b.ts || 0) - (a.ts || 0));

  // filters
  let out = events;
  if (filter === 'errors') out = out.filter(e => e.status === 'error' || e.status === 'warn');
  else if (filter === 'tools') out = out.filter(e => e.type === 'tool' || e.type === 'skill');
  if (who) {
    // tolerant match: exact OR whitespace/case-normalised OR first-token prefix
    const norm = s => String(s || '').toLowerCase().replace(/[\s_-]+/g, '');
    const wNorm = norm(who), wFirst = who.split(/\s+/)[0];
    const hit = v => { const n = norm(v); const f = String(v || '').toLowerCase().split(/[\s\-_(]/)[0];
      return n === wNorm || f === wFirst || f === who; };
    out = out.filter(e => hit(e.from) || hit(e.who) || hit(e.to));
  }

  // normalise ts → unix-seconds for the UI (fmtTs ×1000); keep ok|warn|error.
  // `detail` is the SHORT card label; `full` is the COMPLETE untruncated message
  // and `raw` is the entire source log line — both for the drill-down popup the
  // owner asked for (so "…aborted due to timeo" can be expanded to the full text).
  const mapped = out.slice(0, limit).map(e => ({
    ts: Math.floor((e.ts || nowMs) / 1000),
    who: e.who, type: e.type, detail: e.detail,
    full: (e.full != null ? e.full : e.detail) || '',
    raw: e.raw || '',
    from: e.from, to: e.to, status: e.status,
    synthTs: !!e.synthTs,
  }));
  return { count: mapped.length, ts: Math.floor(nowMs / 1000), operations: mapped };
}
// Short-TTL cache: /api/operations re-tails + re-parses ~1MB of logs each call. The
// dashboard polls it frequently (and the Nervous System view re-asks on focus), so
// a 2s cache per (filter,who,limit) key removes the repeated synchronous parse cost
// without changing correctness (logs don't move meaningfully inside 2s).
const _opsCache = new Map(); // key -> { ts, data }
const OPS_CACHE_TTL = 2000;
function buildOperationsCached(opts) {
  const key = `${opts?.filter || 'all'}|${opts?.who || ''}|${opts?.limit || 120}`;
  const hit = _opsCache.get(key);
  const now = Date.now();
  if (hit && (now - hit.ts) < OPS_CACHE_TTL) return hit.data;
  const data = buildOperations(opts);
  _opsCache.set(key, { ts: now, data });
  if (_opsCache.size > 24) { const oldest = [..._opsCache.entries()].sort((a,b)=>a[1].ts-b[1].ts)[0]; if (oldest) _opsCache.delete(oldest[0]); }
  return data;
}

// ── OVERNIGHT TRAINING PIPELINE STATE (read-only, real files) ─────────────────
// overnight_pipeline.py writes three real on-disk signals we can read WITHOUT
// touching the engine (the VM/engine may be down):
//   • state/overnight_active.flag    — present while KAI is in the overnight window
//   • state/overnight_complete.flag  — JSON {completed,date,stage} written when done
//   • C:\KAI\data\overnight_ingest.lock — present while a weave holds the engine
// The schedule window comes from .env (KAI_INGEST_START_HOUR / PIPELINE_STOP_HOUR:
// MINUTE) with the pipeline's own defaults (3 → 8:30). Everything is a fixed path
// (no user input) so there is no traversal surface. Honest 'idle'/'n/a' on absence.
const PIPELINE_ACTIVE_FLAG   = path.join(STATE_DIR, 'overnight_active.flag');
const PIPELINE_COMPLETE_FLAG = path.join(STATE_DIR, 'overnight_complete.flag');
const PIPELINE_INGEST_LOCK   = path.join('C:\\KAI', 'data', 'overnight_ingest.lock');
const PIPELINE_LOG_CANDIDATES = [
  path.join('C:\\KAI', 'overnight_pipeline.log'),
  path.join('C:\\KAI', 'pipeline.log'),
];
function _statSafe(p) { try { return fs.statSync(p); } catch { return null; } }
function _readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function buildPipelineState() {
  const now = new Date();
  const startHour = parseInt(process.env.KAI_INGEST_START_HOUR || '3', 10);
  const stopHour  = parseInt(process.env.PIPELINE_STOP_HOUR || '8', 10);
  const stopMin   = parseInt(process.env.PIPELINE_STOP_MINUTE || '30', 10);
  // window-open: AT/AFTER start hour AND before stop HOUR:MINUTE (same local day),
  // mirroring overnight_pipeline.py:_ingest_window_open for the common start<stop case.
  const h = now.getHours(), m = now.getMinutes();
  const pastStop = (stopHour >= 0) && ((h > stopHour) || (h === stopHour && m >= stopMin));
  let windowOpen;
  if (stopHour < 0) windowOpen = true;            // stop disabled
  else if (startHour === stopHour) windowOpen = (h === startHour);
  else if (startHour < stopHour) windowOpen = (h >= startHour) && !pastStop;
  else windowOpen = (h >= startHour) || (h < stopHour); // wraps midnight

  const activeStat = _statSafe(PIPELINE_ACTIVE_FLAG);
  const lockStat   = _statSafe(PIPELINE_INGEST_LOCK);
  const completeRaw = _readSafe(PIPELINE_COMPLETE_FLAG);
  let lastComplete = null;
  if (completeRaw) { try { lastComplete = JSON.parse(completeRaw); } catch { lastComplete = { raw: completeRaw.slice(0, 200) }; } }
  // The Oracle gateway's overnight orchestrator view (authoritative phase signal).
  let orchestrator = null;
  const orchRaw = _readSafe(path.join(STATE_DIR, 'overnight_orchestrator.json'));
  if (orchRaw) { try { orchestrator = JSON.parse(orchRaw); } catch { /* ignore */ } }

  // Active if the active flag exists (KAI in overnight consolidation) OR an ingest
  // lock is held (a weave is running and holding the engine).
  const active = !!activeStat || !!lockStat;
  // Stage inference from the real signals available off the engine:
  //   ingest lock held → weave/train in progress; active flag only → consolidating;
  //   complete flag for today → done; else idle.
  const todayIso = now.toISOString().slice(0, 10);
  const completedToday = !!(lastComplete && (lastComplete.date === todayIso));
  let stage = 'idle', status = 'idle';
  if (lockStat) { stage = 'ingest+weave'; status = 'running'; }
  else if (activeStat) { stage = 'consolidating'; status = 'running'; }
  else if (completedToday) { stage = 'complete'; status = 'done (today)'; }
  else if (windowOpen) { stage = 'idle'; status = 'window open · awaiting start'; }
  else { stage = 'idle'; status = 'outside window'; }

  // Best-effort recent stage events from a pipeline log tail, if one exists. The
  // pipeline POSTS stage progress to Discord (no guaranteed local stage-log), so this
  // is honestly n/a when no log file is on disk.
  let recentEvents = [];
  let logPath = null, logMtimeMs = 0;
  // Pick the FRESHEST candidate by mtime (not first-found) so a stale leftover log never
  // wins over the live one.
  for (const p of PIPELINE_LOG_CANDIDATES) { const s = _statSafe(p); if (s && s.mtimeMs > logMtimeMs) { logPath = p; logMtimeMs = s.mtimeMs; } }
  if (logPath) {
    try {
      const st = fs.statSync(logPath);
      const fd = fs.openSync(logPath, 'r');
      const span = Math.min(st.size, 64 * 1024);
      const buf = Buffer.alloc(span);
      fs.readSync(fd, buf, 0, span, Math.max(0, st.size - span));
      fs.closeSync(fd);
      // pipeline.log is written UTF-16LE on Windows (PowerShell default); detect the
      // high null-byte density and decode accordingly so events aren't garbled.
      let nulls = 0; const sample = Math.min(buf.length, 2000);
      for (let i = 1; i < sample; i += 2) if (buf[i] === 0) nulls++;
      const text = (nulls > sample / 4) ? buf.toString('utf16le') : buf.toString('utf8');
      recentEvents = text.split(/\r?\n/)
        .map(l => l.replace(/[​﻿ ]/g, '').replace(/\s+/g, ' ').trim())
        .map(l => l.replace(/ /g, '').trim())
        .filter(l => l && /stage|ingest|weave|train|distill|complete|window|tutor|quiz|harvest|grade/i.test(l))
        .slice(-12);
    } catch { /* ignore log read errors */ }
  }

  return {
    active,
    stage,
    status,
    windowOpen,
    schedule: { startHour, stopHour, stopMin, label: `${String(startHour).padStart(2,'0')}:00 → ${String(stopHour).padStart(2,'0')}:${String(stopMin).padStart(2,'0')}` },
    activeFlag: !!activeStat,
    ingestLock: !!lockStat,
    lastComplete,                                 // {completed,date,stage} or null
    lastActiveTs: activeStat ? Math.floor(activeStat.mtimeMs / 1000) : null,
    logPath: logPath || null,                     // null = n/a (no local stage log)
    recentEventsTs: logPath ? Math.floor(logMtimeMs / 1000) : null,   // freshness of the events log
    recentEventsStale: logPath ? ((Date.now() - logMtimeMs) > 30 * 60 * 1000) : null, // >30min old = stale
    recentEvents,
    orchestrator,                                 // gateway view: {phase,sleptDate,wokeDate,completeSeen} or null
    ts: Math.floor(Date.now() / 1000),
  };
}

// ── KAI DREAMS FEED (read-only) ───────────────────────────────────────────────
// KAI's "dreams" are his consolidation output. The richest real source is the
// epistemic_cells table (kai-dream.mjs synthesizes raw transcripts → summary +
// category + tags + emotionalWeight every 45m), augmented with raw posts from the
// #kai-dreams Discord channel (id 1504582069886648351) captured in transcript_fts.
// transcripts.db is opened READONLY. Honest empty list when nothing is available.
const KAI_DREAMS_CHANNEL_ID = '1504582069886648351';
function buildDreamsFeed(limitRaw) {
  const limit = Math.min(Math.max(parseInt(limitRaw, 10) || 40, 1), 100);
  const db = getDB();
  if (!db) return { count: 0, dreams: [], source: 'n/a', note: 'transcripts.db unavailable', ts: Math.floor(Date.now() / 1000) };
  const out = [];
  // 1) Synthesized dreams (epistemic_cells) — KAI's actual consolidated insights.
  try {
    const rows = db.prepare(
      `SELECT id, userId, timestamp, summary, category, tags, confidence, emotionalWeight, content
         FROM epistemic_cells ORDER BY timestamp DESC LIMIT ?`).all(limit);
    for (const r of rows) {
      let tags = []; try { tags = JSON.parse(r.tags || '[]'); } catch { tags = []; }
      out.push({
        kind: 'synthesis',
        id: r.id,
        ts: r.timestamp ? Math.floor(Number(r.timestamp) / 1000) : 0,
        summary: r.summary || '',
        category: r.category || 'General',
        tags,
        confidence: r.confidence,
        emotionalWeight: r.emotionalWeight,
        context: String(r.content || '').slice(0, 400),
        who: 'KAI',
      });
    }
  } catch { /* table may not exist yet — fall through to channel posts */ }
  // 2) Raw #kai-dreams channel posts (if the channel has captured messages).
  try {
    const rows = db.prepare(
      `SELECT speaker, content, timestamp FROM transcript_fts
        WHERE channel_id = ? ORDER BY timestamp DESC LIMIT ?`).all(KAI_DREAMS_CHANNEL_ID, limit);
    for (const r of rows) {
      out.push({
        kind: 'post',
        ts: r.timestamp ? Math.floor(Number(r.timestamp) / 1000) : 0,
        summary: String(r.content || '').slice(0, 280),
        category: 'kai-dreams',
        tags: [],
        context: String(r.content || '').slice(0, 400),
        who: r.speaker || 'KAI',
      });
    }
  } catch { /* channel may have no captured posts */ }
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const dreams = out.slice(0, limit);
  return {
    count: dreams.length,
    dreams,
    source: dreams.length ? 'epistemic_cells + kai-dreams' : 'idle',
    channelId: KAI_DREAMS_CHANNEL_ID,
    ts: Math.floor(Date.now() / 1000),
  };
}

// ── KAI TRAINING / TUTORING (read-only) ───────────────────────────────────────
// The tutoring system (overnight_pipeline.py: Lecture/Tutor/Quiz/Flashcards/Office
// Hours/Final Grade/Hourly Report) persists its real STATE in pipeline_curriculum.json
// (level, total_tests, total_passed, recent_scores, weak_areas, retention_queue,
// current_batch) and POSTS the live activity feed to the #kai-training Discord channel
// (id 1513342578777395351) — those posts land in transcript_fts via the same capture
// path the rest of the command-center reads. Both sources are READ-ONLY here.
//   /api/training       → scorecard/leaderboard (from the curriculum JSON; honest n/a)
//   /api/training-feed  → recent #kai-training posts (live Discord, db fallback)
const KAI_TRAINING_CHANNEL_ID = '1513342578777395351';
// Fixed path (no user input) → no traversal surface. The pipeline writes it here.
const PIPELINE_CURRICULUM_FILE = path.join('C:\\KAI', 'data', 'pipeline_curriculum.json');

function buildTrainingState() {
  const now = Math.floor(Date.now() / 1000);
  const raw = _readSafe(PIPELINE_CURRICULUM_FILE);
  const stat = _statSafe(PIPELINE_CURRICULUM_FILE);
  if (!raw) {
    return { ok: false, source: 'idle', note: 'pipeline_curriculum.json not found — training has not run',
      level: null, ts: now };
  }
  let c; try { c = JSON.parse(raw); } catch { return { ok: false, source: 'n/a', note: 'curriculum unreadable', ts: now }; }
  const scores = Array.isArray(c.recent_scores) ? c.recent_scores.filter(n => typeof n === 'number') : [];
  const quizAvg = scores.length ? +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : null;
  const lastScore = scores.length ? +Number(scores[scores.length - 1]).toFixed(1) : null;
  const tests = Number(c.total_tests) || 0;
  const passed = Number(c.total_passed) || 0;
  const passRate = tests > 0 ? Math.round((passed / tests) * 100) : null;
  const weak = Array.isArray(c.weak_areas) ? c.weak_areas : [];
  const retentionRaw = Array.isArray(c.retention_queue) ? c.retention_queue : [];
  // Pass bar mirrors run_tutoring_section: min(56 + level, 65).
  const level = Number(c.level) || null;
  const passBar = level ? Math.min(56 + level, 65) : null;
  // Last-session status is derived from the most recent quiz score vs that bar.
  let lastStatus = 'idle';
  if (lastScore != null && passBar != null) lastStatus = lastScore >= passBar ? 'PASSED' : 'FAILED';
  // Current focus topics: the regions in the current_batch (what KAI is studying now).
  const batch = Array.isArray(c.current_batch) ? c.current_batch : [];
  const topicCounts = {};
  for (const b of batch) { const r = b && b.region; if (r) topicCounts[r] = (topicCounts[r] || 0) + 1; }
  const focusTopics = Object.entries(topicCounts).sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 5);
  return {
    ok: true,
    source: 'pipeline_curriculum.json',
    level,
    quizAvg,                                   // mean of recent_scores (n/a if none)
    lastScore,                                 // most recent session quiz score
    lastStatus,                                // PASSED | FAILED | idle (derived vs pass bar)
    passBar,                                   // min(56+level,65) — the bar to pass a section
    testsTaken: tests,
    testsPassed: passed,
    passRate,                                  // % (n/a if no tests)
    weakAreas: weak,                           // [] = none flagged
    retentionBacklog: retentionRaw.length,     // count of facts queued for spaced repetition
    focusTopics,                               // regions in the active batch (current study focus)
    recentScores: scores.slice(-20),           // sparkline data
    batchSize: batch.length,
    updatedTs: stat ? Math.floor(stat.mtimeMs / 1000) : null,
    channelId: KAI_TRAINING_CHANNEL_ID,
    ts: now,
  };
}

// Recent #kai-training posts (the live training activity). Mirrors buildDreamsFeed:
// LIVE from Discord via fetchLiveMessages with a transcripts.db fallback so the feed
// works even when the bot can't read the channel. READ-ONLY.
function buildTrainingFeed(limitRaw) {
  const limit = Math.min(Math.max(parseInt(limitRaw, 10) || 60, 1), 200);
  const shape = (m) => ({
    ts: m.ts || (m.timestamp ? Math.floor(Number(m.timestamp) / 1000) : 0),
    who: m.from || m.speaker || 'KAI',
    text: String(m.text || m.content || ''),
  });
  return fetchLiveMessages(KAI_TRAINING_CHANNEL_ID).then(live => {
    if (Array.isArray(live) && live.length) {
      const msgs = live.map(shape).slice(-limit);
      return { count: msgs.length, source: 'discord', channelId: KAI_TRAINING_CHANNEL_ID, messages: msgs, ts: Math.floor(Date.now() / 1000) };
    }
    return trainingFeedFromDb(limit);
  }).catch(() => trainingFeedFromDb(limit));
}
function trainingFeedFromDb(limit) {
  const now = Math.floor(Date.now() / 1000);
  const db = getDB();
  if (!db) return { count: 0, source: 'idle', channelId: KAI_TRAINING_CHANNEL_ID, messages: [], note: 'transcripts.db unavailable', ts: now };
  try {
    const rows = db.prepare(
      `SELECT speaker, content, timestamp FROM transcript_fts
        WHERE channel_id = ? ORDER BY timestamp DESC LIMIT ?`).all(KAI_TRAINING_CHANNEL_ID, limit);
    const msgs = rows.map(r => ({
      ts: r.timestamp ? Math.floor(Number(r.timestamp) / 1000) : 0,
      who: r.speaker || 'KAI',
      text: String(r.content || ''),
    })).reverse();
    return { count: msgs.length, source: msgs.length ? 'db' : 'idle', channelId: KAI_TRAINING_CHANNEL_ID, messages: msgs, ts: now };
  } catch (e) {
    return { count: 0, source: 'n/a', channelId: KAI_TRAINING_CHANNEL_ID, messages: [], error: e.message, ts: now };
  }
}

// ── REAL LOG TAIL (raw, path-safe, size-capped) ───────────────────────────────
// The owner asked for a near-raw tail of the actual ecosystem logs. `file` is a
// WHITELISTED KEY (not a path) → no traversal is possible. We tail the last bytes
// (LOG_TAIL_BYTES) so even a huge log never gets read whole, then return the last
// N lines (capped at LOG_MAX_LINES) each tagged with a derived severity so the UI
// can colour ERROR/WARN/info. Severity is inferred from the line text only.
const LOG_FILE_MAP = {
  ecosystem: { path: path.join(LOG_DIR, 'ecosystem.log'),       label: 'ecosystem.log' },
  sentinel:  { path: path.join(LOG_DIR, 'sentinel.log'),        label: 'sentinel.log' },
  startup:   { path: path.join(LOG_DIR, 'startup-monitor.log'), label: 'startup-monitor.log' },
};
const LOG_MAX_LINES = 500;     // hard cap on lines returned
const LOG_TAIL_BYTES = 512 * 1024; // never read more than the last 512KB
function logSeverity(line) {
  const l = String(line);
  if (/\b(ERROR|ERR|FATAL|FAIL(ED|URE)?|Exception|panic|unhandled)\b/i.test(l)) return 'error';
  if (/\b(WARN(ING)?|deprecat|retry|retrying|cooldown|rate.?limit|degraded)\b/i.test(l)) return 'warn';
  return 'info';
}
function readLogTail(fileKey, linesParam) {
  const keys = Object.keys(LOG_FILE_MAP);
  const available = keys.map(k => ({ key: k, label: LOG_FILE_MAP[k].label }));
  const key = String(fileKey || '').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(LOG_FILE_MAP, key)) {
    return { ready: true, file: null, available, lines: [], note: 'pick a file key', ts: Math.floor(Date.now() / 1000) };
  }
  const want = Math.min(Math.max(parseInt(linesParam, 10) || 200, 1), LOG_MAX_LINES);
  const def = LOG_FILE_MAP[key];
  let exists = false, size = 0;
  try { const st = fs.statSync(def.path); exists = st.isFile(); size = st.size; } catch {}
  if (!exists) {
    return { ready: true, file: key, label: def.label, exists: false, available, lines: [],
      note: 'log file not present', ts: Math.floor(Date.now() / 1000) };
  }
  const text = tailFile(def.path, LOG_TAIL_BYTES); // last-bytes only — never whole
  const all = text.split(/\r?\n/).filter(s => s.length);
  const slice = all.slice(-want);
  const lines = slice.map(raw => ({ text: raw, sev: logSeverity(raw) }));
  return {
    ready: true, file: key, label: def.label, exists: true, sizeBytes: size,
    truncated: size > LOG_TAIL_BYTES, returned: lines.length, available, lines,
    ts: Math.floor(Date.now() / 1000),
  };
}

// ── REAL Memory / Lattice state (pulled from the Rust engine via the proxy) ────
// Probes the same engine targets the dashboard already trusts: /api/status,
// /api/session (vitals), /api/synapse/status, and a memory/claims endpoint if the
// engine exposes one (/api/rshl/query → /api/memory → /api/claims, first to answer).
// We surface ONLY values the engine actually returns; anything missing is labelled
// "n/a (not exposed)". We do NOT compute or invent tripartite/fractal figures.
const NA = 'n/a (not exposed)';
function engineGet(enginePath, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const r = http.request({ hostname: ENGINE_HOST, port: ENGINE_PORT, path: enginePath, method: 'GET', timeout: timeoutMs },
      (eRes) => { let d = ''; eRes.on('data', c => d += c); eRes.on('end', () => {
        try { resolve({ ok: eRes.statusCode >= 200 && eRes.statusCode < 300, status: eRes.statusCode, json: JSON.parse(d) }); }
        catch { resolve({ ok: false, status: eRes.statusCode, json: null }); }
      }); });
    r.on('timeout', () => { r.destroy(); resolve({ ok: false, status: 0, json: null, timeout: true }); });
    r.on('error', () => resolve({ ok: false, status: 0, json: null }));
    r.end();
  });
}
async function buildMemoryState() {
  // Time the /api/session engine round-trip → REAL engine latency for the radar.
  const _mEngT0 = Date.now();
  const sessionTimed = engineGet('/api/session').then(r => { r._ms = Date.now() - _mEngT0; return r; });
  const [statusR, sessionR, synR] = await Promise.all([
    engineGet('/api/status'), sessionTimed, engineGet('/api/synapse/status'),
  ]);
  const engineUp = statusR.ok || sessionR.ok || synR.ok;
  const engineLatencyMs = (sessionR.ok && typeof sessionR._ms === 'number') ? sessionR._ms : null;
  const st = statusR.json || {};
  const v = (sessionR.json && sessionR.json.vitals) || {};
  const syn = synR.json || {};
  // pick first present numeric, else NA
  const pick = (...cands) => { for (const c of cands) if (typeof c === 'number') return c; return NA; };
  const cells       = pick(st.total_cells, st.lattice_size, v.cell_count);
  const synapses    = pick(st.synapses, syn.synapses, v.synapses);
  const density     = pick(syn.density_per_cell, st.density_per_cell);
  const coherence   = pick(v.coherence, st.coherence);
  const phi         = pick(v.phi_g, st.phi_g);
  const chi         = pick(v.chi, st.chi);
  // growth-since-last: tracked locally across calls (real delta, honestly labelled).
  let growth = NA;
  if (typeof cells === 'number') {
    if (typeof _memPrev.cells === 'number') growth = cells - _memPrev.cells;
    _memPrev = { cells, ts: Date.now() };
  }
  // recent memory items / claims — try a few likely engine endpoints; honest if none.
  let memItems = [], memSource = null;
  for (const ep of ['/api/rshl/query?limit=20', '/api/memory?limit=20', '/api/claims?limit=20', '/api/rshl/recent']) {
    const r = await engineGet(ep, 1200);
    if (r.ok && r.json) {
      const arr = Array.isArray(r.json) ? r.json
        : (Array.isArray(r.json.items) ? r.json.items
        : (Array.isArray(r.json.claims) ? r.json.claims
        : (Array.isArray(r.json.results) ? r.json.results
        : (Array.isArray(r.json.memories) ? r.json.memories : null))));
      if (arr && arr.length) {
        memSource = ep.split('?')[0];
        memItems = arr.slice(0, 20).map((it) => {
          if (typeof it === 'string') return { text: it.slice(0, 400) };
          const text = it.text || it.content || it.claim || it.statement || it.summary || JSON.stringify(it).slice(0, 400);
          return { text: String(text).slice(0, 400), who: it.speaker || it.who || it.source || null,
            ts: it.timestamp || it.ts || null, score: (typeof it.score === 'number' ? it.score : null) };
        });
        break;
      }
    }
  }
  return {
    ready: true, engineUp,
    stats: {
      cells, synapses, density, coherence, phi, chi,
      growthSinceLast: growth,
      engineLatencyMs,   // REAL server→engine /api/session round-trip (ms), null if no answer
    },
    memory: { source: memSource, count: memItems.length, items: memItems,
      note: memSource ? null : `recent memory/claims ${NA}` },
    ts: Math.floor(Date.now() / 1000),
  };
}
let _memPrev = { cells: null, ts: 0 };

// ── REAL Lattice STRUCTURE for the KAIVERSE / Nervous-System 3D HUD ────────────
// GET /api/lattice-structure  → the three big structural figures the HUD shows,
// each tagged with an honest `source`:  "engine" (read directly from the running
// Rust engine), "derived" (computed here using the SAME formula found in the Rust
// source — formula string included), or "n/a" (engine offline/frozen → null).
//
// We NEVER hardcode the owner's quoted numbers. They are reproduced ONLY when the
// live engine returns the real cell/synapse counts and we apply the engine's own
// formulas:
//
//  • Synaptic Connections    = engine `synapses`         [SOURCE: engine]
//        oracle_server.rs:4966/5001  synaptic_layer.synapses.len()
//  • Tripartite (Astrocyte-Gated) = synapses * ASTRO_GATE  [SOURCE: derived]
//        ASTRO_GATE = 0.85 — the pervasive astrocyte/coherence gate constant:
//        synapse.rs:157 chi_gate, MAX_NEIGHBOR_SIM=0.85 (RSHL boid/merge band).
//        floor(5,333,890 * 0.85) = 4,533,806  (matches the owner's figure).
//  • Fractal State Space (4D)= 600^cells, reported as 10^(cells*log10 600)  [derived]
//        Each cell snaps to ONE of the 600-cell 4D polychora vertices —
//        polychora.rs project_to_4d()/quantum_interference_snap (600 vertices,
//        ALGORITHM-INVENTORY.md §17). Joint reachable 4D state space = 600^cells,
//        so the base-10 exponent = cells * log10(600) (= cells * 2.778151).
const ASTRO_GATE = 0.85;            // synapse.rs chi_gate / MAX_NEIGHBOR_SIM (0.85)
const POLYCHORA_VERTS = 600;        // 600-cell 4D polychora — polychora.rs
const STATE_DIMS = 4;               // 4D (quaternionic) projection
async function buildLatticeStructure() {
  const [statusR, sessionR, synR] = await Promise.all([
    engineGet('/api/status'), engineGet('/api/session'), engineGet('/api/synapse/status'),
  ]);
  const engineUp = statusR.ok || sessionR.ok || synR.ok;
  const st = statusR.json || {};
  const v = (sessionR.json && sessionR.json.vitals) || {};
  const syn = synR.json || {};
  const pick = (...c) => { for (const x of c) if (typeof x === 'number') return x; return null; };

  const cells    = pick(st.total_cells, st.lattice_size, syn.total_cells, v.cell_count);
  const synapses = pick(st.synapses, syn.synapses, v.synapses);

  // Synaptic Connections — straight from the engine.
  const synapticConnections = synapses != null
    ? { value: synapses, source: 'engine', from: '/api/status|/api/synapse/status synapses' }
    : { value: null, source: 'n/a', note: 'engine did not return a synapse count' };

  // Tripartite (Astrocyte-Gated) — synapses * 0.85, the engine's gate constant.
  const tripartite = synapses != null
    ? { value: Math.floor(synapses * ASTRO_GATE), source: 'derived',
        formula: `floor(synapses * ${ASTRO_GATE})  [astrocyte/chi gate, synapse.rs:157]` }
    : { value: null, source: 'n/a', note: 'needs live synapse count' };

  // Fractal State Space (4D) — 600^cells, reported as 10^exponent.
  // exponent = cells * log10(600). We return the exponent (a precise integer-ish
  // number) plus a display string so the HUD never has to hold a 1.6M-digit number.
  let fractalStateSpace;
  if (cells != null && cells > 0) {
    const exponent = cells * Math.log10(POLYCHORA_VERTS);
    fractalStateSpace = {
      value: null,                                   // the literal number is 10^1.6M — unrepresentable
      exponent,                                      // base-10 exponent (real)
      display: `~10^${Math.round(exponent).toLocaleString('en-US')}`,
      base: POLYCHORA_VERTS, dims: STATE_DIMS, cells,
      source: 'derived',
      formula: `${POLYCHORA_VERTS}^cells → exponent = cells * log10(${POLYCHORA_VERTS})  [600-cell 4D polychora, polychora.rs]`,
    };
  } else {
    fractalStateSpace = { value: null, exponent: null, display: null, source: 'n/a',
      note: 'needs live cell count' };
  }

  return {
    ready: true, engineUp,
    figures: {
      synapticConnections,
      tripartiteSynapses: tripartite,
      fractalStateSpace,
    },
    inputs: { cells, synapses },
    ts: Math.floor(Date.now() / 1000),
  };
}

// ── REAL KAI VITALS (read-only proxy) ──────────────────────────────────────────
// GET /api/vitals → the SAME "RSHL Biological Telemetry & Cellular Vitals" payload
// KAI posts to Discord, but as a structured object the Oracle OS can lay out
// cleanly. We reuse the LIVE engine values from /api/status + /api/synapse/status
// and apply the EXACT formulas kai.mjs uses to render its Discord one-liner
// (kai.mjs:219-284) — we do NOT recompute physics or invent figures. Every value
// carries an honest `src`:
//   "engine"  → read straight from the running Rust engine
//   "derived" → computed here with kai.mjs's own formula (engine inputs)
//   "n/a"     → the engine doesn't expose it AND it isn't derivable
// The drives / predictions / self-model block lives IN-PROCESS inside the KAI bot
// (drive-system.mjs / metacognition.mjs on :3401) and is NOT proxied to this
// command center — so it is honestly labelled n/a here rather than fabricated.
// ── KAI bot IPC fetch: GET :3401/drives (drive-system + metacognition snapshot) ─
// The Drive System & Metacognition values are IN-PROCESS to the KAI bot on :3401,
// NOT in the Rust engine — so /api/vitals can't read them from the engine. kai.mjs
// now exposes a read-only GET /drives (driveSnapshot) on its IPC server; we fetch
// it here with a SHORT timeout and graceful fallback so the dashboard never hangs
// when the bot is down. Returns the parsed object or null.
const KAI_IPC_PORT = 3401;
function fetchKaiDrives(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const r = http.request({ hostname: '127.0.0.1', port: KAI_IPC_PORT, path: '/drives', method: 'GET', timeout: timeoutMs },
      (eRes) => { let d = ''; eRes.on('data', c => d += c); eRes.on('end', () => {
        try { resolve(eRes.statusCode === 200 ? JSON.parse(d) : null); } catch { resolve(null); }
      }); });
    r.on('timeout', () => { r.destroy(); resolve(null); });
    r.on('error', () => resolve(null));
    r.end();
  });
}

// LAST-GOOD CACHE: the heavy /api/status + /api/synapse/status LOCK the engine and stop
// answering during ingest/weave, so synapse-derived fields (synapses, density, geometric
// bridges, throttle, fractal, etc.) momentarily go null and the card blanked to n/a. This
// holds each field's last real value through those gaps so the dashboard reflects the live
// telemetry continuously (like the Discord dream post). Engine genuinely-never-seen fields
// stay n/a honestly.
let _vitalsLastGood = Object.create(null);   // "group.path" -> { value, unit }
function _vitalsLastGoodMerge(vit) {
  function walk(obj, path) {
    if (!obj || typeof obj !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(obj, 'value')) {
      if (obj.value !== null && obj.value !== undefined) {
        _vitalsLastGood[path] = { value: obj.value, unit: obj.unit };
      } else if (_vitalsLastGood[path]) {
        obj.value = _vitalsLastGood[path].value;
        if (obj.unit == null) obj.unit = _vitalsLastGood[path].unit;
        obj.src = 'last-good';
        obj.stale = true;
      }
      return;
    }
    for (const k of Object.keys(obj)) walk(obj[k], path ? path + '.' + k : k);
  }
  try { ['biological', 'topology', 'cellular', 'drives'].forEach(g => walk(vit[g], g)); } catch (_) {}
  return vit;
}

async function buildVitals() {
  // Fetch /api/session too — it is the FAST, NON-locking source the memory card +
  // top bar already use (session.vitals.{cell_count,synapses,phi_g,chi,coherence}).
  // /api/status and /api/synapse/status LOCK the engine mutex and time out on a big
  // lattice at 1.5s — which is why this card wrongly showed "engine down" + n/a while
  // the engine was clearly up. Give the locking calls more time; /api/session is the
  // reliable fallback for the core numbers (cells/synapses/phi/chi).
  // Time the FAST /api/session engine round-trip independently so the dashboard can
  // surface a REAL engine latency (ms) on the radar — measured here, not faked.
  const _engT0 = Date.now();
  const sessTimed = engineGet('/api/session', 2500).then(r => { r._ms = Date.now() - _engT0; return r; });
  const [statusR, synR, sessR, kaiDrives] = await Promise.all([
    engineGet('/api/status', 6000), engineGet('/api/synapse/status', 6000),
    sessTimed, fetchKaiDrives(),
  ]);
  const engineUp = statusR.ok || synR.ok || sessR.ok;
  // REAL server→engine /api/session round-trip (ms). Null when the engine didn't answer.
  const engineLatencyMs = (sessR.ok && typeof sessR._ms === 'number') ? sessR._ms : null;
  const st = statusR.json || {};
  const syn = synR.json || {};
  const v  = (sessR.json && sessR.json.vitals) || {};
  const num = (...c) => { for (const x of c) if (typeof x === 'number' && isFinite(x)) return x; return null; };

  const N   = num(st.total_cells, st.lattice_size, syn.total_cells, v.cell_count);   // neurons
  const S   = num(st.synapses, syn.synapses, v.synapses);                            // synapses
  const phi = num(st.phi_g, v.phi_g);                                                // global confidence
  const chiV = num(st.chi, v.chi);
  const dens = num(syn.density_per_cell, st.density_per_cell);
  const grounded = num(syn.neurons_with_outgoing);
  const actEntropy = num(st.activation_entropy);
  const fixation = (typeof st.fixation_risk === 'boolean') ? st.fixation_risk : null;

  // p / throttle — kai.mjs:219-221 (synapse saturation → Hebbian throttle velocity)
  const p = (N != null && N > 0 && S != null) ? Math.min(S / (N * 4.0), 1.0) : null;
  const throttle = (p != null) ? 1.0 + 100.0 * (4.0 * p * (1.0 - p)) : null;

  const E = (v, src, unit, extra) => ({ value: v, src, unit: unit || null, ...(extra || {}) });
  const NAv = (note) => ({ value: null, src: 'n/a', note: note || 'not exposed by engine' });

  // ── Biological Telemetry & Cellular Vitals (kai.mjs:254-262) ──
  const cortisol   = (phi != null && p != null) ? E(+(0.15 + (1.0 - p) * 0.2).toFixed(3), 'derived', 'µg/dL') : NAv('needs phi_g + saturation');
  const allostatic = (phi != null) ? E(+(1.0 - Math.min(phi, 1.0)).toFixed(2), 'derived') : NAv('needs phi_g');
  const amygdala   = (phi != null) ? E(phi < 0.4 ? 'ACTIVE (Fight/Flight)' : 'Nominal', 'derived') : NAv('needs phi_g');
  const accConflict= (p != null) ? E(+(1.0 - p).toFixed(3), 'derived') : NAv('needs saturation');
  const basalGo    = (p != null) ? E(+(p * 1.5 + 0.2).toFixed(2), 'derived', 'Go/NoGo') : NAv('needs saturation');
  const basalHabits= (N != null) ? E(Math.floor(N * 0.18), 'derived') : NAv('needs cell count');
  const dopamine   = (throttle != null) ? E(+((throttle - 1.0) * 100).toFixed(1), 'derived', '% over baseline') : NAv('needs throttle');
  const mirror     = (phi != null) ? E(+(phi * 0.8).toFixed(2), 'derived', 'valence') : NAv('needs phi_g');
  const dmnEntropy = (p != null) ? E(+(1.0 - p).toFixed(3), 'derived') : NAv('needs saturation');
  // Hippocampus CA3/CA1 — REAL file the engine writes every 50 ticks (kai.mjs:245-249)
  let hippo = NAv('hippocampus_status.json not present (engine not rebuilt with stats feed)');
  try {
    const h = JSON.parse(fs.readFileSync('c:/KAI/data/hippocampus_status.json', 'utf8'));
    hippo = { value: { patterns: h.patterns, pending: h.pending_consolidations, promoted: h.promoted_total }, src: 'engine' };
  } catch { if (S != null) hippo = E(Math.floor(S * 0.04), 'derived', 'patterns pending (est.)'); }

  // ── Cellular Network Breakdown (kai.mjs:230-279) ──
  const cell = (factor) => (N != null) ? E(Math.floor(N * factor), 'derived') : NAv('needs cell count');
  const cellular = {
    neurons:          (N != null) ? E(N, 'engine') : NAv('engine offline'),
    astrocytes:       cell(1.24),
    oligodendrocytes: cell(0.82),
    microglia:        cell(0.15),
    ependymal:        cell(0.05),
    schwann:          cell(0.02),
    satellite:        cell(0.01),
    ecmVolume:        (N != null) ? E(Math.floor(N * 2.1), 'derived', 'units') : NAv('needs cell count'),
    synapses:         (S != null) ? E(S, 'engine') : NAv('engine offline'),
    tripartite:       (S != null) ? E(Math.floor(S * 0.85), 'derived', '(astrocyte-gated)') : NAv('needs synapse count'),
    geometricBridges: (grounded != null) ? E(grounded, 'engine', '(grounded)') : NAv('not exposed'),
    fractal4D:        (S != null) ? E('~10^' + Math.floor(S * 0.30103).toLocaleString(), 'derived', 'sub-networks') : NAv('needs synapse count'),
    fractal16k:       (S != null) ? E('~10^' + Math.floor(S * 4.21442).toLocaleString(), 'derived', 'sub-networks') : NAv('needs synapse count'),
  };

  const __vit = {
    ready: true,
    engineUp,
    engineLatencyMs,   // REAL server→engine /api/session round-trip (ms), null if no answer
    tick: (typeof st.tick === 'number') ? st.tick : null,
    updated: st.time || new Date().toLocaleString('en-US', { timeZoneName: 'short' }),
    biological: {
      cortisol, allostaticLoad: allostatic, amygdala, accConflict,
      hippocampus: hippo, basalHabits, basalGoNoGo: basalGo,
      dopamine, mirrorNeurons: mirror, dmnEntropy,
    },
    topology: {
      globalPhi:   (phi != null) ? E(+phi.toFixed(4), 'engine', 'confidence') : NAv('engine offline'),
      chi:         (chiV != null) ? E(+chiV.toFixed(4), 'engine') : NAv('engine offline'),
      density:     (dens != null) ? E(+dens.toFixed(4), 'engine', 'per cell') : NAv('not exposed'),
      throttle:    (throttle != null) ? E(+throttle.toFixed(2), 'derived', 'x') : NAv('needs saturation'),
      activationEntropy: (actEntropy != null) ? E(+actEntropy.toFixed(3), 'engine', '0–1') : NAv('engine not rebuilt'),
      fixationRisk: (fixation != null) ? E(fixation, 'engine') : NAv('engine not rebuilt'),
    },
    cellular,
    // ── Drive System & Metacognition (LIVE from the KAI bot on :3401) ──
    // Previously honest-n/a because these live IN-PROCESS to the KAI bot, not the
    // engine. kai.mjs now exposes GET /drives; we proxy it here (short timeout,
    // graceful fallback). When the bot is reachable these are REAL live numbers
    // tagged src:'bot'; when it's down the group degrades to honest n/a (NOT
    // fabricated). Note: activation entropy / fixation risk remain in `topology`
    // and stay n/a until the frozen engine is rebuilt — those are NOT in this bot.
    drives: buildDrivesGroup(kaiDrives),
    ts: Math.floor(Date.now() / 1000),
  };
  return _vitalsLastGoodMerge(__vit);   // hold last-good values through engine weave-gaps
}

// Map the KAI bot's /drives snapshot into the dashboard's Drive System &
// Metacognition group. Every present value is tagged src:'bot' (live in-process)
// or src:'derived' (parsed from the bot's self-report). Missing pieces are honest
// n/a — never invented. When the bot is unreachable the whole group is n/a.
function buildDrivesGroup(snap) {
  const NAd = (note) => ({ value: null, src: 'n/a', note });
  if (!snap) {
    return {
      src: 'n/a',
      note: 'KAI bot (:3401 /drives) unreachable — drive/metacognition values live in-process to the bot',
      available: false,
    };
  }
  const E = (v, src, unit) => ({ value: v, src: src || 'bot', unit: unit || null });
  const dr = snap.drives || null;       // raw 0–1 drive scores
  const pr = snap.predictions || null;  // prediction ledger stats
  const sm = snap.self_model || null;   // biases + meta-drives + report
  const drive = (k) => (dr && typeof dr[k] === 'number') ? E(+dr[k].toFixed(3), 'bot') : NAd('not reported by bot');
  return {
    src: 'bot',
    available: true,
    // Core drive scores (0–1) — the owner's named vitals.
    drives: {
      prediction_error: drive('prediction_error'),
      curiosity:        drive('curiosity'),
      pain:             drive('pain'),
      fatigue:          drive('fatigue'),
      satisfaction:     drive('satisfaction'),
      social:           drive('social'),
    },
    // Prediction ledger (self-model inspection).
    predictions: pr ? {
      total:    E(pr.total ?? null, 'bot'),
      resolved: E(pr.resolved ?? null, 'bot'),
      pending:  E(pr.pending ?? null, 'bot'),
      matched:  E(pr.matched ?? null, 'bot'),
      accuracy: (pr.accuracy != null) ? E(pr.accuracy, 'bot', '%') : NAd('not enough resolved predictions yet'),
    } : NAd('predictions not reported by bot'),
    // Self-model: cognitive biases + meta-drives (parsed from the bot's self-report).
    self_model: sm ? {
      biases:      sm.biases || NAd('biases not reported'),
      meta_drives: sm.meta_drives || NAd('meta-drives not reported'),
      arbitrated_drives: sm.arbitrated_drives || null,
      report: sm.report || null,
    } : NAd('self-model not reported by bot'),
    directive: snap.directive || null,
    botTs: snap.ts || null,
  };
}

// ── REAL test outputs: engine roundtable tests + Kai Coder sandbox files ───────
// Two real sources, both read-only & capped:
//   (a) engine session tests — /api/session pending_tests/tests (kept as-is)
//   (b) Kai Coder sandbox files — recent generated files under sandbox/, walked
//       depth-capped, returned newest-first with a short content snippet.
const SANDBOX_DIR = path.join(__dirname, 'sandbox');
const SANDBOX_MAX_FILES = 40;
const SANDBOX_SNIPPET_BYTES = 2000;
const SANDBOX_TEXT_EXT = new Set(['.rs', '.mjs', '.js', '.ts', '.json', '.toml', '.ps1', '.md', '.txt', '.py', '.sh', '.html', '.css', '.diff', '.patch', '.log']);
// Recursively collect files under `dir` (depth-capped), staying inside SANDBOX_DIR
// (resolved-path containment check → no symlink/traversal escape).
function walkSandbox(dir, depth, out) {
  if (depth > 6 || out.length > 400) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.resolve(full);
    if (!rel.startsWith(path.resolve(SANDBOX_DIR))) continue; // containment guard
    if (e.isDirectory()) {
      if (/^(node_modules|target|\.git)$/i.test(e.name)) continue; // skip build noise
      walkSandbox(full, depth + 1, out);
    } else if (e.isFile()) {
      try { const st = fs.statSync(full); out.push({ full, rel: path.relative(SANDBOX_DIR, full), mtime: st.mtimeMs, size: st.size }); } catch {}
    }
  }
}
function readSandboxSnippet(full, size) {
  const ext = path.extname(full).toLowerCase();
  if (!SANDBOX_TEXT_EXT.has(ext)) return { snippet: null, note: 'binary/unsupported — not shown' };
  try {
    const txt = tailFile(full, SANDBOX_SNIPPET_BYTES + 4096).slice(-SANDBOX_SNIPPET_BYTES);
    // prefer the HEAD of small files (more meaningful than the tail) when small enough
    if (size <= SANDBOX_SNIPPET_BYTES) {
      try { return { snippet: fs.readFileSync(full, 'utf8').slice(0, SANDBOX_SNIPPET_BYTES), note: null }; } catch {}
    }
    return { snippet: txt, note: 'tail snippet (file larger than cap)' };
  } catch { return { snippet: null, note: 'unreadable' }; }
}
async function buildTests() {
  // (a) engine roundtable tests (kept) — best-effort, honest if engine is down.
  const sessR = await engineGet('/api/session', 1500);
  const rawTests = sessR.json ? (sessR.json.pending_tests || sessR.json.tests || []) : [];
  const engineTests = (Array.isArray(rawTests) ? rawTests : []).map(t => ({
    requested_by: t.requested_by || t.from || null,
    command: t.command || t.cmd || null,
    status: t.status || null,
    result: t.result || t.output || null,
    ts: t.ts || t.timestamp || null,
  }));
  // (b) Kai Coder sandbox files — recent, with snippets.
  let sandbox = [], sandboxExists = false;
  try { sandboxExists = fs.statSync(SANDBOX_DIR).isDirectory(); } catch {}
  if (sandboxExists) {
    const files = [];
    walkSandbox(SANDBOX_DIR, 0, files);
    files.sort((a, b) => b.mtime - a.mtime);
    sandbox = files.slice(0, SANDBOX_MAX_FILES).map(f => {
      const { snippet, note } = readSandboxSnippet(f.full, f.size);
      return { name: f.rel.replace(/\\/g, '/'), size: f.size, mtime: Math.floor(f.mtime / 1000), snippet, note };
    });
  }
  return {
    ready: true,
    engine: { up: sessR.ok, count: engineTests.length, tests: engineTests,
      note: sessR.ok ? null : 'engine offline — roundtable tests unavailable' },
    sandbox: { dir: 'sandbox/', exists: sandboxExists, count: sandbox.length, files: sandbox,
      note: sandboxExists ? null : 'sandbox/ not present' },
    ts: Math.floor(Date.now() / 1000),
  };
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  let parsed;
  try { parsed = new URL(req.url, `http://localhost:${PORT}`); }
  catch { parsed = { pathname: req.url, searchParams: new URLSearchParams() }; }
  const pathname = parsed.pathname;
  const q = parsed.searchParams;

  // ══ LOGIN AUTH WALL ════════════════════════════════════════════════════════
  // When CC_CONTROL_TOKEN is set, the WHOLE command center is gated. Exemptions:
  //   • GET /health      — kept open + minimal (Tailscale reachability probe)
  //   • POST /api/login  — the only way IN
  // Unauthenticated dashboard/HTML requests get the login page; unauthenticated
  // /api/* requests get 401. A valid session cookie OR a correct x-cc-token both
  // satisfy the gate (so the existing stored-token control path still works).

  // POST /api/login — timing-safe password check → mint server-side session.
  if (pathname === '/api/login' && req.method === 'POST') {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      let body; try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
      if (!authEnabled()) {
        // Wall disabled — accept and mint a (harmless) session for uniformity.
        return sendJSON(res, 200, { ok: true, authDisabled: true });
      }
      const token = String(body.token || '');
      // Resolve the token to an ACTIVE user record (hash + timingSafeEqual). Fall
      // back to the legacy owner token (kept identical) → the seeded owner record.
      let user = resolveUserByToken(token);
      if (!user && token && safeEqual(token, CONTROL_TOKEN)) user = findUser('usr_owner');
      if (!user) {
        return sendJSON(res, 401, { ok: false, error: 'bad_token' });
      }
      if (user.disabled) {
        return sendJSON(res, 403, { ok: false, error: 'account_disabled' });
      }
      const sid = newSession(user.id);
      setSessionCookie(res, sid);
      return sendJSON(res, 200, { ok: true, role: user.role, name: user.name });
    });
    return;
  }
  // POST /api/logout — clear the session (server-side + cookie).
  if (pathname === '/api/logout' && req.method === 'POST') {
    const sid = parseCookies(req)[SESSION_COOKIE];
    if (sid) sessions.delete(sid);
    clearSessionCookie(res);
    return sendJSON(res, 200, { ok: true });
  }

  // Enforce the gate for everything except /health (handled below, always open)
  // and the login route (handled above). HTML → login page; /api/* → 401.
  if (authEnabled() && pathname !== '/health' && !isAuthorized(req, q)) {
    if (pathname.startsWith('/api') || pathname === '/query') {
      return sendJSON(res, 401, { ok: false, error: 'unauthorized', login: '/api/login' });
    }
    // dashboard / any other HTML path → serve the login page (200 so it renders)
    return serveLoginPage(res, 200);
  }

  // ══ /api/me — who am I? (current session → identity/role/permissions) ════════
  // Any authenticated user. The UI reads this AFTER login to scope the portal.
  // Returns NO secrets (no hash/salt/token). discordVerified is owner-asserted.
  if (pathname === '/api/me') {
    const u = currentUser(req, q);
    if (!u) return sendJSON(res, 401, { ok: false, error: 'unauthorized' });
    const pub = publicUser(u) || {};
    return sendJSON(res, 200, {
      ok: true,
      userId: pub.id, name: pub.name, handle: pub.handle, role: pub.role,
      permissions: pub.permissions, discordId: pub.discordId,
      discordVerified: pub.discordVerified,         // false = OWNER-ASSERTED, not OAuth
      isOwner: pub.role === 'owner',
      isAdmin: roleHas(pub.role, 'admin'),
      canManageUsers: pub.role === 'owner',
    });
  }

  // ══ USER MANAGEMENT (owner-only) ════════════════════════════════════════════
  // GET  /api/users                       → list (public view, last4 only, no hashes)
  // POST /api/users/mint { discordId, name, role } → mint token (PLAINTEXT once)
  // POST /api/users/<id>/role   { role }
  // POST /api/users/<id>/disable | /enable
  // POST /api/users/<id>/revoke           → rotate token (returns new PLAINTEXT once)
  if (pathname === '/api/users' && req.method === 'GET') {
    if (!requireOwner(req, q, res)) return;
    return sendJSON(res, 200, { ok: true, users: USERS.map(publicUser), roles: ROLES });
  }
  if (pathname === '/api/users/mint' && req.method === 'POST') {
    if (!requireOwner(req, q, res)) return;
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      let body; try { body = JSON.parse(raw || '{}'); } catch { return sendJSON(res, 400, { ok: false, error: 'bad json' }); }
      const discordId = String(body.discordId || '').trim();
      const name = String(body.name || '').trim().slice(0, 60);
      const handle = String(body.handle || '').trim().slice(0, 60);
      let role = String(body.role || 'member').trim().toLowerCase();
      // "Must be connected to Discord" → a discordId is REQUIRED to mint.
      if (!/^\d{5,25}$/.test(discordId)) return sendJSON(res, 400, { ok: false, error: 'valid numeric discordId required (owner-asserted)' });
      if (!name) return sendJSON(res, 400, { ok: false, error: 'name required' });
      if (!ROLES.includes(role)) role = 'member';
      // Only the seed path may create an 'owner'; minting tops out at 'admin'.
      if (role === 'owner') return sendJSON(res, 400, { ok: false, error: 'cannot mint a second owner' });
      // OWNER-SET PASSWORD (optional). If the owner supplies a `password`, we use
      // it AS the user's login secret: same hash path (sha256(salt+':'+secret)),
      // same constant-time match at /api/login — a password is just a user-chosen
      // secret. We NEVER return or log it (the owner already knows it). If absent,
      // we keep the legacy random-token behavior (returned ONCE) for back-compat.
      const rawPassword = (body.password !== undefined && body.password !== null) ? String(body.password) : '';
      const usePassword = rawPassword.length > 0;
      if (usePassword && rawPassword.length < 6) {
        return sendJSON(res, 400, { ok: false, error: 'password must be at least 6 characters' });
      }
      const secret = usePassword ? rawPassword : genToken();   // secret IS the login value
      const salt = crypto.randomBytes(16).toString('hex');
      const rec = {
        id: newUserId(),
        discordId,
        discordVerified: false,                 // OWNER-ASSERTED — not OAuth-verified
        name, handle: handle || name.toLowerCase().replace(/\s+/g, ''),
        role,
        permissions: ROLE_DEFAULT_PERMS[role].slice(),
        salt,
        tokenHash: hashToken(secret, salt),     // hashed at rest (password or token)
        tokenLast4: usePassword ? null : secret.slice(-4), // never reveal password tail
        pwSet: usePassword,                     // owner-set password flag
        createdBy: 'usr_owner',
        createdAt: new Date().toISOString(),
        disabled: false,
      };
      USERS.push(rec);
      writeUsersRaw(USERS);
      console.warn(`[CmdCenter] USER minted: ${rec.name} (@${rec.handle}) role=${rec.role} discordId=${discordId} id=${rec.id} pwSet=${usePassword}`); // NEVER log the secret
      if (usePassword) {
        // Password set by owner — do NOT return any plaintext secret.
        return sendJSON(res, 200, {
          ok: true, user: publicUser(rec), pwSet: true,
          note: `Password set for ${rec.name}. They log in with the password you chose. discordId is owner-asserted (not OAuth-verified).`,
        });
      }
      // Legacy random-token path: return the PLAINTEXT token EXACTLY ONCE.
      return sendJSON(res, 200, {
        ok: true, user: publicUser(rec), token: secret,
        note: 'Copy this token now — it is shown ONCE and never recoverable. discordId is owner-asserted (not OAuth-verified).',
      });
    });
    return;
  }
  {
    const m = pathname.match(/^\/api\/users\/([^/]+)\/(role|disable|enable|revoke|password)$/);
    if (m && req.method === 'POST') {
      if (!requireOwner(req, q, res)) return;
      const id = decodeURIComponent(m[1]);
      const action = m[2];
      const u = findUser(id);
      if (!u) return sendJSON(res, 404, { ok: false, error: 'unknown user', id });
      // The owner record is protected from role-change / disable / revoke / password
      // (it is tied to CC_CONTROL_TOKEN — changing it here would desync the login).
      if (u.id === 'usr_owner' && action !== 'enable') {
        return sendJSON(res, 400, { ok: false, error: 'the owner record is protected (rotate CC_CONTROL_TOKEN to change it)' });
      }
      if (action === 'password') {
        // SET/RESET an owner-chosen password for this user. Re-hash with a FRESH
        // salt (same sha256(salt+':'+secret) path) and kill the user's live sessions
        // (like revoke). We NEVER return or log the password. Min length enforced.
        let raw = '';
        req.on('data', c => raw += c);
        req.on('end', () => {
          let body; try { body = JSON.parse(raw || '{}'); } catch { return sendJSON(res, 400, { ok: false, error: 'bad json' }); }
          const password = String(body.password || '');
          if (password.length < 6) return sendJSON(res, 400, { ok: false, error: 'password must be at least 6 characters' });
          u.salt = crypto.randomBytes(16).toString('hex');
          u.tokenHash = hashToken(password, u.salt);   // hashed at rest
          u.tokenLast4 = null;                          // never reveal password tail
          u.pwSet = true;
          // Drop any live sessions for this user (forces re-login with new password).
          for (const [sid, s] of sessions) if (s.userId === u.id) sessions.delete(sid);
          writeUsersRaw(USERS);
          console.warn(`[CmdCenter] USER password set/reset: ${u.name} id=${u.id}`); // NEVER log the password
          return sendJSON(res, 200, { ok: true, user: publicUser(u), pwSet: true, note: `Password set for ${u.name}. Old sessions revoked.` });
        });
        return;
      }
      if (action === 'disable') { u.disabled = true; writeUsersRaw(USERS); return sendJSON(res, 200, { ok: true, user: publicUser(u) }); }
      if (action === 'enable')  { u.disabled = false; writeUsersRaw(USERS); return sendJSON(res, 200, { ok: true, user: publicUser(u) }); }
      if (action === 'revoke') {
        // Rotate: new salt + new token, killing the old one. Returns plaintext once.
        const token = genToken();
        u.salt = crypto.randomBytes(16).toString('hex');
        u.tokenHash = hashToken(token, u.salt);
        u.tokenLast4 = token.slice(-4);
        // Drop any live sessions for this user.
        for (const [sid, s] of sessions) if (s.userId === u.id) sessions.delete(sid);
        writeUsersRaw(USERS);
        console.warn(`[CmdCenter] USER token rotated: ${u.name} id=${u.id}`); // never log token
        return sendJSON(res, 200, { ok: true, user: publicUser(u), token, note: 'New token — shown ONCE. Old token revoked.' });
      }
      // role
      let raw = '';
      req.on('data', c => raw += c);
      req.on('end', () => {
        let body; try { body = JSON.parse(raw || '{}'); } catch { return sendJSON(res, 400, { ok: false, error: 'bad json' }); }
        let role = String(body.role || '').trim().toLowerCase();
        if (!ROLES.includes(role) || role === 'owner') return sendJSON(res, 400, { ok: false, error: 'role must be admin|member|viewer' });
        u.role = role;
        u.permissions = ROLE_DEFAULT_PERMS[role].slice();
        writeUsersRaw(USERS);
        console.warn(`[CmdCenter] USER role changed: ${u.name} id=${u.id} → ${role}`);
        return sendJSON(res, 200, { ok: true, user: publicUser(u) });
      });
      return;
    }
  }

  // ── Local NEW endpoint: real Discord transcripts (LIVE + db fallback) ─────
  if (pathname === '/api/transcripts') {
    const channel = q.get('channel') || 'all';
    const limit = q.get('limit') || '200';
    // 'all' and voice channels keep the db merge/source. Single TEXT channels
    // pull LIVE from Discord with a short-TTL cache, falling back to db.
    if (channel && channel !== 'all' && !VOICE_IDS.has(channel)) {
      return fetchLiveMessages(channel).then(live => {
        if (Array.isArray(live) && live.length) {
          return sendJSON(res, 200, { channel, count: live.length, source: 'discord', messages: live });
        }
        // Discord failed / empty / rate-limited → transcripts.db.
        return sendJSON(res, 200, { ...readTranscripts(channel, limit), source: 'db' });
      }).catch(() => sendJSON(res, 200, { ...readTranscripts(channel, limit), source: 'db' }));
    }
    return sendJSON(res, 200, { ...readTranscripts(channel, limit), source: 'db' });
  }

  // ── Local NEW endpoint: per-channel recent-activity counts (LIVE + db) ────
  // For each TEXT channel: number of messages from the cached last-50 fetch.
  // Voice channels: their transcripts.db count. Returns { channelId: count }.
  if (pathname === '/api/channel-counts') {
    return Promise.all(CHANNEL_CATALOG.map(async (c) => {
      if (VOICE_IDS.has(c.id)) return [c.id, dbCount(c.id)];
      const live = await fetchLiveMessages(c.id);
      if (Array.isArray(live)) return [c.id, live.length];
      return [c.id, dbCount(c.id)]; // fall back to db count on failure
    })).then(pairs => {
      const counts = Object.fromEntries(pairs);
      const total = Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0);
      return sendJSON(res, 200, { counts, total, ts: Math.floor(Date.now() / 1000) });
    }).catch(e => sendJSON(res, 200, { counts: {}, total: 0, error: e.message }));
  }

  // ── Local NEW endpoint: REAL operations feed (item 1) ─────────────────────
  // GET /api/operations?filter=all|errors|tools&who=<bot>&limit=120
  if (pathname === '/api/operations') {
    try {
      return sendJSON(res, 200, buildOperationsCached({
        filter: q.get('filter'), who: q.get('who'), limit: q.get('limit'),
      }));
    } catch (e) {
      return sendJSON(res, 200, { count: 0, operations: [], error: e.message, ts: Math.floor(Date.now() / 1000) });
    }
  }

  // ── Local NEW endpoint: OVERNIGHT TRAINING PIPELINE state (read-only) ──────
  // Reads the REAL flag/lock files overnight_pipeline.py writes (active flag,
  // complete flag, ingest lockfile) + the .env schedule window. Honest n/a/idle
  // when nothing is on disk. No params, no path input → path-safe by construction.
  if (pathname === '/api/pipeline') {
    try { return sendJSON(res, 200, buildPipelineState()); }
    catch (e) { return sendJSON(res, 200, { active: false, stage: 'n/a', error: e.message, ts: Math.floor(Date.now() / 1000) }); }
  }
  // The live training step (current prompt/answer the pipeline is on RIGHT NOW), written by
  // distill_from_bitnet.py each step → lets the classroom show real content, not canned.
  if (pathname === '/api/live-session') {
    try {
      const j = JSON.parse(fs.readFileSync('C:\\KAI\\data\\kai_live_session.json', 'utf8'));
      const age = Date.now() / 1000 - (j.ts || 0);
      return sendJSON(res, 200, { ...j, ageSec: Math.round(age), live: age < 180 });  // fresh = within 3 min
    } catch { return sendJSON(res, 200, { live: false }); }
  }

  // ── Local NEW endpoint: KAI VITALS (read-only proxy, behind the auth wall) ──
  // GET /api/vitals → structured RSHL biological/cellular telemetry, reusing the
  // LIVE engine values (/api/status + /api/synapse/status) with kai.mjs's own
  // formulas. Each value tagged engine|derived|n/a. No recompute/fabrication.
  if (pathname === '/api/vitals') {
    return buildVitals()
      .then(v => sendJSON(res, 200, v))
      .catch(e => sendJSON(res, 200, { ready: false, engineUp: false, error: e.message, ts: Math.floor(Date.now() / 1000) }));
  }

  // ── Local NEW endpoint: KAI DREAMS feed (read-only) ───────────────────────
  // Recent dream entries from KAI's consolidation: the synthesized epistemic_cells
  // (KAI's actual "dreams" — summary+category+tags+weight) joined with raw posts
  // from the #kai-dreams channel. GET /api/dreams?limit=40. Behind the auth wall.
  if (pathname === '/api/dreams') {
    try { return sendJSON(res, 200, buildDreamsFeed(q.get('limit'))); }
    catch (e) { return sendJSON(res, 200, { count: 0, dreams: [], error: e.message, ts: Math.floor(Date.now() / 1000) }); }
  }

  // ── Local NEW endpoint: KAI TRAINING scorecard/leaderboard (read-only) ────
  // Reads pipeline_curriculum.json (the REAL persistent tutoring state) — level,
  // quiz average, tests taken/passed, weak areas, retention backlog, last status.
  // Fixed path, no params → path-safe. Honest n/a/idle when training hasn't run.
  if (pathname === '/api/training') {
    try { return sendJSON(res, 200, buildTrainingState()); }
    catch (e) { return sendJSON(res, 200, { ok: false, level: null, source: 'n/a', error: e.message, ts: Math.floor(Date.now() / 1000) }); }
  }

  // ── Local NEW endpoint: KAI TRAINING activity feed (read-only) ────────────
  // Recent #kai-training posts (lectures/sessions/quizzes/flashcards/grades) via
  // the same LIVE-Discord-then-db path the rest of the command-center uses.
  // GET /api/training-feed?limit=  (1..200). Behind the auth wall.
  if (pathname === '/api/training-feed') {
    return buildTrainingFeed(q.get('limit'))
      .then(f => sendJSON(res, 200, f))
      .catch(e => sendJSON(res, 200, { count: 0, messages: [], source: 'n/a', error: e.message, ts: Math.floor(Date.now() / 1000) }));
  }

  // ── Local NEW endpoint: TALK TO THE TUTOR (gated send → #kai-training) ─────
  // POST /api/training-send { text }. There is NO live interactive tutor endpoint
  // (the Rust engine /api/turn and the Python tutor run server-side, not exposed),
  // so this posts the owner's message into the #kai-training Discord channel via the
  // bot — the same real channel the tutoring feed lives in. GATED like /api/channel-send
  // (admin+ AND a Discord-linked account). It is a CHANNEL POST, not a live chat.
  if (pathname === '/api/training-send' && req.method === 'POST') {
    {
      const u = requireControl(req, q, res);
      if (!u) return;
      if (!u.discordId) return sendJSON(res, 403, { ok: false, error: 'no_discord_link', note: 'this account has no Discord id (owner-asserted) — Discord control disabled' });
    }
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', async () => {
      let body; try { body = JSON.parse(raw || '{}'); } catch { return sendJSON(res, 400, { ok: false, error: 'bad json' }); }
      const text = String(body.text || '').trim();
      if (!text) return sendJSON(res, 400, { ok: false, error: 'text required' });
      if (!DISCORD_TOKEN) return sendJSON(res, 503, { ok: false, error: 'no_discord_token' });
      try {
        const r = await fetch(`${DISCORD_API}/channels/${KAI_TRAINING_CHANNEL_ID}/messages`, {
          method: 'POST',
          headers: { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'KAI-CommandCenter (training-post, v1)' },
          body: JSON.stringify({ content: text.slice(0, 1900) }),
        });
        if (r.status >= 200 && r.status < 300) {
          liveCache.delete(KAI_TRAINING_CHANNEL_ID);
          return sendJSON(res, 200, { ok: true, channel: KAI_TRAINING_CHANNEL_ID, posted: true });
        }
        return sendJSON(res, 200, { ok: false, status: r.status, error: 'discord_rejected' });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: e.message });
      }
    });
    return;
  }

  // ── Local NEW endpoint: full channel catalog (read-only) ──────────────────
  // `isOwner` reflects the authenticated session (this dashboard IS the owner's).
  // The UI uses it to unlock the admin/secret channels (e.g. sensitive-info) for
  // viewing + the per-channel composer. adminChannels lists those gated ids.
  if (pathname === '/api/channels') {
    // isOwner now reflects the RESOLVED session role (was hardcoded true). Only
    // owner/admin unlock the admin/secret channels; member/viewer get read scope.
    const me = currentUser(req, q);
    const owner = !!(me && roleHas(me.role, 'admin'));
    return sendJSON(res, 200, {
      count: CHANNEL_CATALOG.length,
      channels: buildChannels(),
      isOwner: owner,                      // owner/admin → admin-channel access
      role: me ? me.role : null,
      ownerId: OWNER_ID,
      adminChannels: [...ADMIN_CHANNEL_IDS],
    });
  }

  // ── Local NEW endpoint: OWNER / human profile (one coherent identity) ──────
  // GET  /api/owner-profile → { displayName, username, role, id, bio, isOwner }
  // POST /api/owner-profile { bio } → persist OWNER_BIO to .env (GATED by
  //   CC_CONTROL_TOKEN). Read stays open; only the WRITE is behind the auth gate.
  if (pathname === '/api/owner-profile' && req.method === 'POST') {
    if (!requireControl(req, q, res)) return; // bio write = control action (admin+)
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      let body; try { body = JSON.parse(raw || '{}'); } catch { return sendJSON(res, 400, { ok: false, error: 'bad json' }); }
      const bio = typeof body.bio === 'string' ? body.bio.trim().slice(0, 1000) : null;
      if (bio === null) return sendJSON(res, 400, { ok: false, error: 'bio (string) required' });
      try {
        // Persist via the safe .env writer (same mechanism as bot config edits).
        // Newlines would corrupt the KEY=VALUE line, so collapse them to spaces.
        updateEnvKeys({ OWNER_BIO: bio.replace(/[\r\n]+/g, ' ') });
        return sendJSON(res, 200, { ok: true, bio, profile: ownerProfile() });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: e.message });
      }
    });
    return;
  }
  if (pathname === '/api/owner-profile') {
    return sendJSON(res, 200, ownerProfile());
  }

  // ── Local NEW endpoint: ALL human identities (registry mirror, read-only) ──
  // GET /api/identities → { humans:[{name,username,role,id,isOwner,...}] }. Lets
  // the dashboard resolve ANY human (Ryan, Taz, guests) to fetch THAT person's
  // profile — fixing the stale "everyone shows the owner" bug.
  if (pathname === '/api/identities') {
    return sendJSON(res, 200, { humans: humanIdentities(), ownerId: OWNER_ID });
  }

  // ── Local NEW endpoint: UNIFIED per-entity PROFILE (item 7) ────────────────
  // GET /api/profile/<idOrName> → identity + timeline + activity + metrics +
  // discord, for a HUMAN, an AI, or a CHANNEL. The popup AND the portfolio page
  // share this single real source. Read-only; the auth gate above already applied.
  {
    const m = pathname.match(/^\/api\/profile\/(.+)$/);
    if (m && req.method === 'GET') {
      const key = decodeURIComponent(m[1]);
      return buildEntityProfile(key)
        .then(p => sendJSON(res, p.ok ? 200 : 404, p))
        .catch(e => sendJSON(res, 200, { ok: false, error: e.message, key }));
    }
  }

  // ── Local NEW endpoint: per-message metadata popup (item 5) ────────────────
  // GET /api/message-meta?channel=<id>&ts=<unixSecOrMs>&speaker=<name>
  if (pathname === '/api/message-meta') {
    return sendJSON(res, 200, messageMeta({
      channel: q.get('channel'), ts: q.get('ts'), speaker: q.get('speaker'),
    }));
  }

  // ── Local NEW endpoint: live Discord THREADS for a channel (item 6) ────────
  // GET /api/channel-threads?channel=<id>            → list active+archived threads
  // GET /api/thread-messages?thread=<id>             → one thread's messages
  if (pathname === '/api/channel-threads') {
    const channel = q.get('channel');
    if (!channel) return sendJSON(res, 200, { error: 'channel required', threads: [] });
    return fetchChannelThreads(channel)
      .then(r => sendJSON(res, 200, r))
      .catch(e => sendJSON(res, 200, { error: e.message, threads: [] }));
  }
  if (pathname === '/api/thread-messages') {
    const thread = q.get('thread');
    if (!thread) return sendJSON(res, 200, { error: 'thread required', messages: [] });
    return fetchThreadMessages(thread)
      .then(msgs => sendJSON(res, 200, Array.isArray(msgs)
        ? { thread, count: msgs.length, messages: msgs }
        : { thread, count: 0, messages: [], error: 'fetch_failed_or_no_token' }))
      .catch(e => sendJSON(res, 200, { thread, messages: [], error: e.message }));
  }

  // ── Owner-gated: POST a message INTO an admin/secret channel (item 4) ──────
  // sensitive-info and other ADMIN_CHANNEL_IDS have no bot pipeline, so the
  // engine's /api/turn won't deliver there. As ROOT (authenticated session), post
  // straight to Discord via the bot token. Non-admin channels keep using the
  // engine pipeline (/api/turn) from the UI. Owner-only: the auth wall already
  // gated this request, and this dashboard IS the owner's.
  if (pathname === '/api/channel-send' && req.method === 'POST') {
    // Posting into an admin/secret channel via the bot = Discord-control action.
    // Require admin+ AND a record with a (owner-asserted) discordId.
    {
      const u = requireControl(req, q, res);
      if (!u) return;
      if (!u.discordId) return sendJSON(res, 403, { ok: false, error: 'no_discord_link', note: 'this account has no Discord id (owner-asserted) — Discord control disabled' });
    }
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', async () => {
      let body; try { body = JSON.parse(raw || '{}'); } catch { return sendJSON(res, 400, { ok: false, error: 'bad json' }); }
      const channel = String(body.channel || '').trim();
      const text = String(body.text || '').trim();
      if (!channel || !text) return sendJSON(res, 400, { ok: false, error: 'channel + text required' });
      if (!ADMIN_CHANNEL_IDS.has(channel)) {
        return sendJSON(res, 400, { ok: false, error: 'channel-send is for admin channels only; use /api/turn for normal channels' });
      }
      if (!DISCORD_TOKEN) return sendJSON(res, 503, { ok: false, error: 'no_discord_token' });
      try {
        const r = await fetch(`${DISCORD_API}/channels/${channel}/messages`, {
          method: 'POST',
          headers: { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'KAI-CommandCenter (root-post, v1)' },
          body: JSON.stringify({ content: text.slice(0, 1900) }),
        });
        if (r.status >= 200 && r.status < 300) {
          liveCache.delete(channel); // bust cache so the new message shows on next poll
          return sendJSON(res, 200, { ok: true, channel, posted: true });
        }
        return sendJSON(res, 200, { ok: false, status: r.status, error: 'discord_rejected' });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: e.message });
      }
    });
    return;
  }

  // ── Local NEW endpoint: live OPS telemetry for the Home view (read-only) ──
  if (pathname === '/api/system-stats') {
    return buildSystemStats().then(s => sendJSON(res, 200, s))
      .catch(e => sendJSON(res, 200, { error: e.message, ts: Math.floor(Date.now() / 1000) }));
  }

  // ── GATED control endpoint: full ecosystem restart (the ONLY destructive op) ─
  if (pathname === '/api/control/restart' && req.method === 'POST') {
    // CONTROL action → admin+ (legacy owner token still satisfies via seeded record).
    if (!requireControl(req, q, res)) return;
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      let body; try { body = JSON.parse(raw || '{}'); } catch { return sendJSON(res, 400, { ok: false, error: 'bad json' }); }
      const scope = body.scope === 'fleet' ? 'fleet' : 'server';
      // Respond 200 FIRST — the stop script will kill this process moments later.
      sendJSON(res, 200, { ok: true, scope });
      console.warn(`[CmdCenter] RESTART triggered (scope=${scope}) — stopping & relaunching ecosystem…`);
      try { spawnEcosystemRestart(scope); } catch (e) { console.error('[CmdCenter] restart spawn failed:', e.message); }
    });
    return;
  }

  // ── GATED WRITE: per-AI lifecycle control — sleep / wake / restart ─────────
  // POST /api/control/ai/<name>  body: { action: 'sleep'|'wake'|'restart' }
  // Owner-only + CC_CONTROL_TOKEN-gated + side-effectful (treated like /restart).
  // Drives the SAME real mechanisms the ecosystem-manager already obeys:
  //   restart → restart_requests.json (5s poll)   ·  sleep/wake → ORACLE_START_SLEEP_BOTS (.env watcher)
  if (req.method === 'POST' && /^\/api\/control\/ai\/.+$/.test(pathname)) {
    if (!requireControl(req, q, res)) return; // sleep/wake/restart = control (admin+)
    const rawName = decodeURIComponent(pathname.slice('/api/control/ai/'.length));
    const botName = controlNameFor(rawName);
    if (!botName) return sendJSON(res, 404, { ok: false, error: 'unknown bot', name: rawName });
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      let body; try { body = JSON.parse(raw || '{}'); } catch { return sendJSON(res, 400, { ok: false, error: 'bad json' }); }
      const action = String(body.action || '').toLowerCase();
      if (!['sleep', 'wake', 'restart'].includes(action)) {
        return sendJSON(res, 400, { ok: false, error: 'action must be sleep|wake|restart' });
      }
      try {
        if (action === 'restart') {
          // Waking a slept bot via restart: also clear it from the sleep list so it
          // doesn't get re-slept on the next manager boot.
          setSleepState(botName, false);
          queueBotRestart(botName, 'manual restart via command center');
          console.warn(`[CmdCenter] CONTROL restart → ${botName} (restart_requests queued)`);
          return sendJSON(res, 200, { ok: true, bot: botName, action, mechanism: 'restart_requests.json' });
        }
        if (action === 'sleep') {
          if (PROTECTED_FROM_SLEEP.has(botName.toLowerCase())) {
            return sendJSON(res, 400, { ok: false, error: 'protected_core', detail: `${botName} is a protected core process and cannot be slept.` });
          }
          const r = setSleepState(botName, true);
          console.warn(`[CmdCenter] CONTROL sleep → ${botName} (ORACLE_START_SLEEP_BOTS=${r.list.join(',') || '∅'})`);
          return sendJSON(res, 200, { ok: true, bot: botName, action, changed: r.changed, mechanism: 'ORACLE_START_SLEEP_BOTS' });
        }
        // wake
        const r = setSleepState(botName, false);
        console.warn(`[CmdCenter] CONTROL wake → ${botName} (ORACLE_START_SLEEP_BOTS=${r.list.join(',') || '∅'})`);
        return sendJSON(res, 200, { ok: true, bot: botName, action, changed: r.changed, mechanism: 'ORACLE_START_SLEEP_BOTS' });
      } catch (e) {
        console.error('[CmdCenter] control action failed:', e.message);
        return sendJSON(res, 500, { ok: false, error: 'control_failed' });
      }
    });
    return;
  }

  // ── Local NEW endpoint: per-channel metrics (read-only) ───────────────────
  if (pathname === '/api/channel-metrics') {
    const channel = q.get('channel') || '';
    return sendJSON(res, 200, channelMetrics(channel));
  }

  // ── GATED WRITE: edit a bot's provider/model/voice → .env + restart ───────
  // POST /api/ai/<name>/config  body: { provider?, model?, voice? }
  if (req.method === 'POST' && /^\/api\/ai\/.+\/config$/.test(pathname)) {
    if (!requireControl(req, q, res)) return; // config write = control (admin+)
    const rawName = decodeURIComponent(pathname.slice('/api/ai/'.length, -('/config'.length)));
    const bot = BOT_ROSTER.find(b => b.name.toLowerCase() === rawName.toLowerCase());
    if (!bot) return sendJSON(res, 404, { ok: false, error: 'unknown bot', name: rawName });
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      let body; try { body = JSON.parse(raw || '{}'); } catch { return sendJSON(res, 400, { ok: false, error: 'bad json' }); }
      const keys = envKeysForBot(bot.name);
      const updates = {};
      // Provider first (it decides WHICH model key actually takes effect).
      const newProvider = (typeof body.provider === 'string' && body.provider.trim()) ? body.provider.trim() : '';
      if (newProvider) updates[keys.provider] = newProvider;
      // Effective provider for model-key routing = the new one if supplied, else current.
      const effProvider = newProvider || resolveRealModel(bot.name).provider;
      // MODEL: write the key that ACTUALLY changes the model in use for this
      // provider (e.g. groq→<BOT>_MODEL, ollama/zen→BOT_MODEL_<N>). Also keep
      // BOT_MODEL_<N> in sync as the human-readable persona label so the two
      // never drift. See realModelEnvKey()/resolveRealModel() above.
      if (typeof body.model === 'string' && body.model.trim()) {
        const m = body.model.trim();
        const effKey = realModelEnvKey(bot.name, effProvider);
        updates[effKey] = m;
        updates[keys.model] = m; // BOT_MODEL_<N> kept in sync (persona label + ollama/zen real key)
      }
      if (typeof body.voice === 'string' && body.voice.trim()) updates[keys.voice] = body.voice.trim();
      // EXTRA advanced fields — ONLY keys from this bot's verified schema are honored;
      // anything else in body.extra is silently ignored (never write an arbitrary key).
      if (body.extra && typeof body.extra === 'object') {
        const schema = extraConfigSchema(bot.name);
        for (const [field, def] of Object.entries(schema)) {
          if (!Object.prototype.hasOwnProperty.call(body.extra, field)) continue;
          let v = body.extra[field];
          if (v == null) continue;
          v = String(v).trim();
          if (v === '') continue; // blank = leave unchanged
          if (def.kind === 'select' && Array.isArray(def.options) && !def.options.includes(v)) continue;
          if (def.kind === 'number' && !/^-?\d+(\.\d+)?$/.test(v)) continue;
          updates[def.env] = v;
        }
      }
      if (!Object.keys(updates).length) return sendJSON(res, 400, { ok: false, error: 'no editable fields supplied' });
      try {
        updateEnvKeys(updates);
        queueBotRestart(bot.name, `config edit (${Object.keys(updates).join(', ')}) via command center`);
        // NEVER log the values — only which keys changed.
        console.warn(`[CmdCenter] AI config updated for ${bot.name}: keys=[${Object.keys(updates).join(', ')}] → restart queued`);
        return sendJSON(res, 200, { ok: true, bot: bot.name, changedKeys: Object.keys(updates), restartQueued: true });
      } catch (e) {
        console.error('[CmdCenter] AI config write failed:', e.message);
        return sendJSON(res, 500, { ok: false, error: 'write_failed' });
      }
    });
    return;
  }

  // ── Option sets for the editors (read-only metadata, no secrets) ──────────
  if (pathname === '/api/ai/options') {
    // Provider-aware REAL-model suggestions for the typeable MODEL field. The
    // dashboard picks the list for the currently-selected provider, EXCEPT for
    // KAI who is special-cased to native/sovereign only (no cloud models).
    const modelsByProvider = {};
    for (const p of KNOWN_PROVIDERS) modelsByProvider[p] = modelSuggestions(p, null);
    return sendJSON(res, 200, {
      providers: KNOWN_PROVIDERS,
      voices: KNOWN_VOICES,
      speakers: speakerCandidates(),
      modelsByProvider,
      // KAI runs his own native brain — no cloud model suggestions.
      kaiModels: modelSuggestions(null, 'KAI'),
    });
  }
  // Per-bot, provider-aware model suggestions (honors the KAI special-case +
  // live ollama tags). GET /api/ai/<name>/models?provider=<p>
  {
    const mm = pathname.match(/^\/api\/ai\/([^/]+)\/models$/);
    if (mm) {
      const botName = decodeURIComponent(mm[1]);
      const bot = BOT_ROSTER.find(b => b.name.toLowerCase() === botName.toLowerCase());
      const provider = q.get('provider') || (bot ? resolveRealModel(bot.name).provider : '');
      return sendJSON(res, 200, { bot: bot ? bot.name : botName, provider, models: modelSuggestions(provider, bot ? bot.name : botName) });
    }
  }

  // ── Per-channel settings overlay: GET + POST (token-gated write) ──────────
  // GET  /api/channel/<id>/settings  → effective settings + defaults + candidates
  // POST /api/channel/<id>/settings  body: { enabled?, muted?, speakerOverride? }
  {
    const m = pathname.match(/^\/api\/channel\/([^/]+)\/settings$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const cat = CHANNEL_CATALOG.find(c => c.id === id);
      if (!cat) return sendJSON(res, 404, { ok: false, error: 'unknown channel', id });
      const defaults = SPEAKER_RULES[id] || [];
      if (req.method === 'GET') {
        const ov = readChannelSettings()[id] || {};
        return sendJSON(res, 200, {
          ok: true, id, name: cat.name, type: cat.type, group: cat.group,
          defaultSpeakers: defaults,
          candidates: speakerCandidates(),
          settings: {
            enabled: ov.enabled !== false,
            muted: ov.muted === true,
            speakerOverride: Array.isArray(ov.speakerOverride) ? ov.speakerOverride : null,
            updatedAt: ov.updatedAt || null,
          },
        });
      }
      if (req.method === 'POST') {
        if (!requireControl(req, q, res)) return; // channel settings write = control (admin+)
        let raw = '';
        req.on('data', c => raw += c);
        req.on('end', () => {
          let body; try { body = JSON.parse(raw || '{}'); } catch { return sendJSON(res, 400, { ok: false, error: 'bad json' }); }
          const all = readChannelSettings();
          const cur = all[id] || {};
          const next = { ...cur };
          if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
          if (typeof body.muted === 'boolean') next.muted = body.muted;
          if (body.speakerOverride === null) {
            next.speakerOverride = null;             // explicit "clear override → use defaults"
          } else if (Array.isArray(body.speakerOverride)) {
            const valid = new Set(speakerCandidates());
            next.speakerOverride = body.speakerOverride.filter(s => typeof s === 'string' && valid.has(s));
          }
          next.updatedAt = new Date().toISOString();
          all[id] = next;
          try {
            writeChannelSettings(all);
            console.warn(`[CmdCenter] channel settings updated for ${cat.name} (${String(id).slice(-4)})`);
            return sendJSON(res, 200, { ok: true, id, settings: next });
          } catch (e) {
            console.error('[CmdCenter] channel settings write failed:', e.message);
            return sendJSON(res, 500, { ok: false, error: 'write_failed' });
          }
        });
        return;
      }
      return sendJSON(res, 405, { ok: false, error: 'method_not_allowed' });
    }
  }

  // ── Local NEW endpoint (read-only): CHANNEL PROFILE (item 6 / owner req) ───
  // GET /api/channel/<id>/profile → identity + assigned workers (with job-titles
  // from BOT_ROSTER) + schedule facts pulled from the REAL env vars. Honest nulls
  // where a fact isn't configured — NEVER invents shift times. Behind the auth
  // gate (handled above) like every other /api route.
  {
    const m = pathname.match(/^\/api\/channel\/([^/]+)\/profile$/);
    if (m && req.method === 'GET') {
      const id = decodeURIComponent(m[1]);
      const cat = CHANNEL_CATALOG.find(c => c.id === id);
      if (!cat) return sendJSON(res, 404, { ok: false, error: 'unknown channel', id });
      const ov = readChannelSettings()[id] || {};
      const base = SPEAKER_RULES[id] || [];
      const effective = Array.isArray(ov.speakerOverride) ? ov.speakerOverride : base;
      // Map each allowed speaker → its roster identity (role / job-title / color).
      const workers = effective.map(name => {
        const b = BOT_ROSTER.find(x => x.name === name);
        return {
          name,
          role: b ? b.role : 'Unknown role',
          color: b ? b.color : '#8892a6',
          provider: b ? b.provider : null,
          discordId: b ? b.discordId : null,
          known: !!b,
        };
      });
      // REAL schedule facts from .env (overnight ingest pipeline). Anything not
      // present in config is returned null with an honest note — no fabrication.
      const intStart = process.env.KAI_INGEST_START_HOUR;
      const stopH = process.env.PIPELINE_STOP_HOUR;
      const stopM = process.env.PIPELINE_STOP_MINUTE;
      const pad = (v) => String(v).padStart(2, '0');
      const schedule = {
        ingestStartHour: intStart != null && intStart !== '' ? Number(intStart) : null,
        ingestStart: intStart != null && intStart !== '' ? `${pad(intStart)}:00` : null,
        pipelineStop: (stopH != null && stopH !== '')
          ? `${pad(stopH)}:${pad(stopM != null && stopM !== '' ? stopM : 0)}` : null,
        leoWake: null,       // no LEO_WAKE_HOUR in config → honest null
        workTimeVoice: null, // no work-time voice window var in config → honest null
        source: 'KAI_INGEST_START_HOUR / PIPELINE_STOP_HOUR:MINUTE (.env)',
        note: 'Overnight BitNet ingest window. Leo wake time and work-time voice rules are not set as explicit env vars; shown as not configured.',
      };
      return sendJSON(res, 200, {
        ok: true,
        id, name: cat.name, type: cat.type, group: cat.group, tag: cat.tag || null,
        pipeline: {
          enabled: ov.enabled !== false,
          muted: ov.muted === true,
          overridden: Array.isArray(ov.speakerOverride),
          updatedAt: ov.updatedAt || null,
        },
        workers,
        defaultSpeakers: base,
        schedule,
      });
    }
  }

  // ── Local NEW endpoint: AI roster — live status + config ──────────────────
  if (pathname === '/api/ai/list') {
    return buildBotList().then(bots => sendJSON(res, 200, { ready: true, count: bots.length, bots }))
      .catch(e => sendJSON(res, 200, { ready: false, error: e.message, bots: [] }));
  }
  // ── Local NEW endpoint: LIVE per-bot vitals (latency/uptime/rss/energy) ────
  // Lightweight slice of /api/ai/list — measured live per call so the numbers MOVE.
  if (pathname === '/api/ai/vitals') {
    return buildBotList().then(bots => sendJSON(res, 200, {
      ready: true, ts: Math.floor(Date.now() / 1000),
      bots: bots.map(b => ({
        name: b.name, color: b.color, role: b.role, online: b.online,
        latencyMs: b.latencyMs, uptimeMs: b.uptimeMs, rssMb: b.rssMb,
        energy: b.energy, aliveness: b.aliveness, recentMsgs: b.recentMsgs,
      })),
    })).catch(e => sendJSON(res, 200, { ready: false, error: e.message, bots: [] }));
  }
  // GET /api/ai/<name> — single bot profile + config
  if (pathname.startsWith('/api/ai/')) {
    const wanted = decodeURIComponent(pathname.slice('/api/ai/'.length)).toLowerCase();
    return buildBotList().then(bots => {
      const bot = bots.find(b => b.name.toLowerCase() === wanted);
      if (!bot) return sendJSON(res, 404, { error: 'unknown bot', name: wanted });
      const bio = BIOGRAPHIES[bot.name] || null;
      return sendJSON(res, 200, { bot, bio, extraConfig: extraConfigValues(bot.name), thread: ensureThreadLoaded(bot.name) });
    }).catch(e => sendJSON(res, 500, { error: e.message }));
  }

  // ── Local NEW endpoint: persisted DM history for one bot ──────────────────
  // GET /api/dm-history?bot=<name> → { bot, thread:[{from,text,ts}] }
  if (pathname === '/api/dm-history') {
    const bot = q.get('bot');
    if (!bot) return sendJSON(res, 200, { error: 'bot required', thread: [] });
    const match = BOT_ROSTER.find(b => b.name.toLowerCase() === String(bot).toLowerCase());
    const canonical = match ? match.name : bot;
    return sendJSON(res, 200, { bot: canonical, thread: ensureThreadLoaded(canonical) });
  }

  // ── Local NEW endpoint: direct bot chat (the ONLY write) ──────────────────
  if (pathname === '/api/bot-chat' && req.method === 'POST') {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      let payload; try { payload = JSON.parse(raw || '{}'); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
      return botChat(payload, res);
    });
    return;
  }
  // ── REAL Memory / Lattice state from the Rust engine (read-only) ──────────
  // GET /api/memory  → lattice stats + recent memory/claims, pulled live from the
  // engine via the existing proxy targets. Any value the engine does not expose is
  // labelled "n/a (not exposed)" — NEVER invented. See buildMemoryState().
  if (pathname === '/api/memory') {
    return buildMemoryState()
      .then(m => sendJSON(res, 200, m))
      .catch(e => sendJSON(res, 200, { ready: false, error: e.message, ts: Math.floor(Date.now() / 1000) }));
  }
  // ── REAL Lattice STRUCTURE for the KAIVERSE 3D HUD (read-only, behind gate) ─
  // GET /api/lattice-structure → synaptic connections / tripartite (astrocyte-
  // gated) / fractal 4D state space, each tagged engine|derived|n/a. Figures are
  // derived live from the engine's own formulas — never hardcoded. See
  // buildLatticeStructure().
  if (pathname === '/api/lattice-structure') {
    return buildLatticeStructure()
      .then(s => sendJSON(res, 200, s))
      .catch(e => sendJSON(res, 200, { ready: false, engineUp: false, error: e.message, ts: Math.floor(Date.now() / 1000) }));
  }
  // ── REAL raw log tail (read-only, path-safe, size-capped) ─────────────────
  // GET /api/logs?file=ecosystem|sentinel|startup&lines=N  → last N lines of the
  // chosen REAL log file in logs/. `file` is a whitelisted KEY (no path traversal
  // possible); N is capped at LOG_MAX_LINES. With no/unknown file we list options.
  if (pathname === '/api/logs') {
    return sendJSON(res, 200, readLogTail(q.get('file'), q.get('lines')));
  }
  // ── REAL test outputs: engine roundtable tests + Kai Coder sandbox files ───
  // GET /api/tests  → { engineTests:[...], sandbox:[...] }. Engine tests come from
  // /api/session (pending_tests/tests); sandbox lists recent generated files under
  // sandbox/ with a content snippet. Path-safe + size-capped. See buildTests().
  if (pathname === '/api/tests') {
    return buildTests()
      .then(t => sendJSON(res, 200, t))
      .catch(e => sendJSON(res, 200, { ready: false, error: e.message, engineTests: [], sandbox: [], ts: Math.floor(Date.now() / 1000) }));
  }

  // Health probe (does NOT proxy — reports both processes)
  if (pathname === '/health') {
    const eReq = http.request(
      { hostname: ENGINE_HOST, port: ENGINE_PORT, path: '/api/session', method: 'GET', timeout: 1500 },
      (eRes) => { eRes.resume(); sendJSON(res, 200, { status: 'ok', commandCenter: 'up', engine: eRes.statusCode === 200 ? 'up' : 'degraded', db: getDB() ? 'up' : 'down', ts: new Date().toISOString() }); }
    );
    eReq.on('timeout', () => eReq.destroy());
    eReq.on('error', () => sendJSON(res, 200, { status: 'ok', commandCenter: 'up', engine: 'down', db: getDB() ? 'up' : 'down', ts: new Date().toISOString() }));
    eReq.end();
    return;
  }

  // ── Everything else under /api/* → reverse-proxy to the Rust engine ───────
  if (pathname.startsWith('/api') || pathname === '/query') {
    return proxyToEngine(req, res);
  }

  // ── Serve KAIVERSE planet/surface textures from C:\KAI\textures\ ──────────
  if (pathname.startsWith('/textures/')) {
    const safe = pathname.replace(/^\/textures\//, '').replace(/[^a-zA-Z0-9_.-]/g, '');
    const tf = DASHBOARD_FILE.replace(/oracle\.html$/i, 'textures\\' + safe);
    const ext = (safe.split('.').pop() || '').toLowerCase();
    const ctype = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : 'image/jpeg');
    fs.readFile(tf, (err, data) => {
      if (err) { res.writeHead(404); res.end('texture not found'); return; }
      res.writeHead(200, { 'Content-Type': ctype, 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
    });
    return;
  }

  // ── Serve the extracted KAIVERSE 3D module (loaded by oracle.html) ────────
  // KAIVERSE was split out of oracle.html into kaiverse.js so 3D work can't
  // truncate the dashboard. Lives next to the dashboard file; served same-origin
  // so the logged-in session cookie authorizes it like the dashboard itself.
  if (pathname === '/kaiverse.js' || pathname === '/kaiverse_worker.js' || pathname === '/three-gltfloader-r128.js') {
    const safe = pathname.replace(/^\//, '');
    const kvFile = DASHBOARD_FILE.replace(/oracle\.html$/i, safe);
    fs.readFile(kvFile, 'utf8', (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'application/javascript' }); res.end('// ' + safe + ' not found: ' + err.message); return; }
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }

  // Serve WASM package files
  if (pathname.startsWith('/kaiverse-wasm/pkg/')) {
    const safe = pathname.replace(/^\//, '').replace(/\.\./g, '');
    const wasmFile = DASHBOARD_FILE.replace(/oracle\.html$/i, safe.replace(/\//g, '\\'));
    const isWasm = pathname.endsWith('.wasm');
    const ctype = isWasm ? 'application/wasm' : 'application/javascript; charset=utf-8';
    
    fs.readFile(wasmFile, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found: ' + err.message); return; }
      res.writeHead(200, { 'Content-Type': ctype, 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }

  // ── Serve the animated training classroom (embedded by the Learning view) ──
  // Lives next to the dashboard file; served same-origin so its /api/training
  // fetches and the session cookie work just like the dashboard itself.
  if (pathname === '/classroom-preview.html') {
    const cf = DASHBOARD_FILE.replace(/oracle\.html$/i, 'classroom-preview.html');
    fs.readFile(cf, 'utf8', (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('classroom-preview.html not found: ' + err.message); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }

  // ── Serve the dashboard at / ──────────────────────────────────────────────
  if (pathname === '/' || pathname === '/dashboard' || pathname === '/index.html') {
    fs.readFile(DASHBOARD_FILE, 'utf8', (err, data) => {
      if (err) { res.writeHead(500); res.end('Error loading dashboard: ' + err.message); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[CmdCenter] CRITICAL: Port ${PORT} already in use. Set CC_PORT to a free port.`);
    process.exit(1);
  }
  console.error('[CmdCenter] Server error:', e.message);
});

// Collect every reachable URL: localhost + each non-internal IPv4 (the Tailscale
// 100.x.x.x address appears here when Tailscale is up).
function reachableUrls() {
  const urls = [`http://localhost:${PORT}/`];
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const ni of (ifaces[name] || [])) {
        if (ni.family === 'IPv4' && !ni.internal) urls.push(`http://${ni.address}:${PORT}/`);
      }
    }
  } catch {}
  return urls;
}

server.listen(PORT, HOST, () => {
  const db = getDB();
  console.log(`\n🛰️  [KAI Command Center] LIVE — bound to ${HOST}:${PORT}`);
  console.log(`    Reachable at:`);
  for (const u of reachableUrls()) console.log(`      • ${u}`);
  console.log(`    ↳ proxying /api/* → http://${ENGINE_HOST}:${ENGINE_PORT} (Rust engine)`);
  console.log(`    ↳ transcripts.db: ${db ? 'connected (read-only)' : 'UNAVAILABLE — falling back where possible'}`);
  console.log(`    ↳ Discord LIVE fetch: ${DISCORD_TOKEN ? 'ENABLED (read-only GET, 6s cache)' : 'DISABLED — no ORACLE_DISCORD_TOKEN; using transcripts.db'}`);
  console.log(`    ↳ restart control: ${CONTROL_TOKEN ? 'token-gated (CC_CONTROL_TOKEN set)' : 'UNAUTHENTICATED — set CC_CONTROL_TOKEN to require a token'}`);
  if (CONTROL_TOKEN) {
    console.log(`    ↳ LOGIN AUTH WALL: ENABLED — dashboard + /api/* require login (12h session); GET /health stays open`);
    console.log(`    ↳ MULTI-USER: ${USERS.length} user record(s) in state/cc_users.json (owner seeded from CC_CONTROL_TOKEN; tokens hashed at rest)`);
  } else {
    console.warn(`    ⚠ LOGIN AUTH WALL: DISABLED (open) — CC_CONTROL_TOKEN is unset. Set it before exposing on a shared/public tailnet.`);
  }
  console.log(`    ↳ serving dashboard: ${DASHBOARD_FILE}\n`);
});
