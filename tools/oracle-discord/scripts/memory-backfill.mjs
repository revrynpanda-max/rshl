// ── MEMORY BACKFILL ──────────────────────────────────────────────────────────
// One-time (and re-runnable) catch-up that walks the FULL history of every
// relevant channel and loads it into KAI's lattice — so everything ever said,
// in voice or text, becomes recallable. After this, the live capture in
// leo.mjs/kai.mjs keeps memory current; this fills the backlog from before
// live capture existed.
//
// It uses the SAME ingest path the live system uses (POST /api/rshl/store),
// so a backfilled memory is indistinguishable from one learned in the moment.
//
// Incremental: tracks the newest message id ingested per channel in
// state/backfill_progress.json, so re-runs only pick up what's new and never
// double-ingest.
//
// Usage (engine + a bot token must be available):
//   node scripts/memory-backfill.mjs                  # all registered channels
//   node scripts/memory-backfill.mjs --full           # ignore progress, re-walk everything
//   node scripts/memory-backfill.mjs --max 2000       # cap messages per channel
import fs from 'fs';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { CHANNEL_IDS, TRANSCRIPT_USER_INFO } from '../shared/channel-rules.mjs';
import 'dotenv/config';

const KAI = 'http://127.0.0.1:3334';
const PROGRESS = 'c:/KAI/tools/oracle-discord/state/backfill_progress.json';
const FULL = process.argv.includes('--full');
const maxIdx = process.argv.indexOf('--max');
const MAX_PER_CHANNEL = maxIdx !== -1 ? parseInt(process.argv[maxIdx + 1], 10) || 5000 : 5000;

// Channels worth remembering: each user's personal transcript slot (voice
// conversations land here as "Name [Voice]: ...") plus the shared rooms.
const TRANSCRIPT_SLOTS = Object.keys(TRANSCRIPT_USER_INFO);
const SHARED = [CHANNEL_IDS.PUBLIC, CHANNEL_IDS.SUNDAY, CHANNEL_IDS.VOICE].filter(Boolean);
const TARGETS = [...new Set([...TRANSCRIPT_SLOTS, ...SHARED])];

const token = process.env.ORACLE_DISCORD_TOKEN_LEO || process.env.ORACLE_DISCORD_TOKEN_KAI || process.env.ORACLE_DISCORD_TOKEN;
if (!token) { console.error('No bot token in env (need ORACLE_DISCORD_TOKEN_LEO or _KAI).'); process.exit(1); }

function loadProgress() { try { return JSON.parse(fs.readFileSync(PROGRESS, 'utf8')); } catch (_) { return {}; } }
function saveProgress(p) { try { fs.mkdirSync('c:/KAI/tools/oracle-discord/state', { recursive: true }); fs.writeFileSync(PROGRESS, JSON.stringify(p, null, 2)); } catch (_) {} }

async function storeClaim(text, region, strength, userId) {
  try {
    const r = await fetch(`${KAI}/api/rshl/store`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, region, strength, source: 'memory-backfill', user_id: userId || '' }),
      signal: AbortSignal.timeout(8000)
    });
    return r.ok;
  } catch (_) { return false; }
}

const keywordRe = /prefer|don'?t like|hate|remember|always|never|important|ongoing|working on|issue with|hospital|sick|went to|because|birthday|name is|my |I (am|was|will|have)/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function backfillChannel(client, channelId, progress) {
  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch || typeof ch.messages?.fetch !== 'function') { console.log(`  [skip] ${channelId} — not reachable`); return 0; }
  const info = TRANSCRIPT_USER_INFO[channelId];
  const label = info ? `${info.name}'s transcript` : channelId;
  const stopAt = FULL ? null : progress[channelId];   // newest id we already have
  let before = undefined;
  let ingested = 0, scanned = 0, newestSeen = null;

  console.log(`\n  ▶ ${label} (${channelId})${stopAt ? ` — incremental since ${stopAt}` : ' — FULL walk'}`);
  while (scanned < MAX_PER_CHANNEL) {
    const batch = await ch.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
    if (!batch || batch.size === 0) break;
    const arr = [...batch.values()]; // newest → oldest
    if (!newestSeen) newestSeen = arr[0].id;
    let hitKnown = false;
    for (const m of arr) {
      if (stopAt && m.id === stopAt) { hitKnown = true; break; }
      scanned++;
      // Pull text from content AND embeds (webhook/transcript posts)
      let body = (m.content || '').trim();
      for (const e of m.embeds || []) body += ' ' + [e.title, e.description].filter(Boolean).join(' — ');
      body = body.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
      // Strip a leading "Name [Voice]:" / "Name:" speaker tag into attribution
      const speakerMatch = body.match(/^([A-Za-z0-9 _]+?)(?:\s*\[Voice\])?:\s*(.+)$/);
      const speaker = speakerMatch ? speakerMatch[1].trim() : (m.author?.username || 'someone');
      const said = speakerMatch ? speakerMatch[2].trim() : body;
      if (said.split(/\s+/).length < 5) continue;
      const isKey = keywordRe.test(said);
      const claim = `From past conversation: ${speaker} said "${said.slice(0, 280)}"`;
      const ok = await storeClaim(claim, isKey ? 'personal' : 'social', isKey ? 1.6 : 1.0, info?.userId);
      if (ok) ingested++;
      if (ingested % 25 === 0 && ingested) { process.stdout.write(`\r    ingested ${ingested}…`); await sleep(150); }
    }
    if (hitKnown) break;
    before = arr[arr.length - 1].id;
    await sleep(400); // gentle on Discord rate limits AND the engine
  }
  if (newestSeen) { progress[channelId] = newestSeen; saveProgress(progress); }
  console.log(`\r    ${label}: scanned ${scanned}, ingested ${ingested} memories.        `);
  return ingested;
}

(async () => {
  const alive = await fetch(`${KAI}/api/status`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok).catch(() => false);
  if (!alive) { console.error('❌ KAI engine not reachable — start it first.'); process.exit(1); }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel]
  });

  client.once('ready', async () => {
    console.log(`MEMORY BACKFILL — logged in as ${client.user.tag}`);
    console.log(`Channels: ${TARGETS.length} | mode: ${FULL ? 'FULL re-walk' : 'incremental'} | cap: ${MAX_PER_CHANNEL}/channel`);
    const progress = loadProgress();
    let total = 0;
    for (const id of TARGETS) total += await backfillChannel(client, id, progress);
    console.log(`\n══ DONE — ${total} memories loaded into the lattice. They are now recallable via search_lattice. ══`);
    client.destroy();
    process.exit(0);
  });

  client.login(token).catch(e => { console.error('Login failed:', e.message); process.exit(1); });
})();
