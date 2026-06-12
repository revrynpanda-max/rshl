/**
 * conversation-learning.mjs — Oracle intent memory + KAI conversation quality pipeline.
 *
 * Every Ryan ↔ Oracle turn is:
 *   1. Persisted locally (survives Oracle restart)
 *   2. Stored in RSHL lattice as intent-labeled claims (KAI learns patterns)
 *   3. Logged to training corpus with quality metrics (KAI binds input→reply)
 *   4. Recorded in metrics-store for drift / quality tracking
 */
import fs from 'fs';
import path from 'path';
import { storeLattice, logTrainingCorpus } from './lattice-bridge.mjs';
import { recordMetric } from './metrics-store.mjs';

const STATE_DIR = 'c:/KAI/tools/oracle-discord/state';
const CONVO_FILE = path.join(STATE_DIR, 'oracle-convo-memory.json');
const INTENT_FILE = path.join(STATE_DIR, 'oracle-intent-memory.json');

function ensureDir() {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch (_) {}
}

function loadJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {}
  return fallback;
}

function saveJson(file, data) {
  ensureDir();
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (_) {}
}

/** Score 0–1: how well Oracle matched Ryan's intent (conversation vs work). */
export function scoreConversationQuality(userText, oracleReply, intentResult = {}) {
  if (!userText || !oracleReply) return 0.2;
  let score = 0.5;

  const intent = intentResult.intent || 'conversation';
  const conf = intentResult.confidence ?? 0.5;
  score += conf * 0.25;

  const replyLen = oracleReply.length;
  const userLen = userText.length;
  if (intent === 'conversation') {
    if (replyLen > 20 && replyLen < 800) score += 0.15;
    if (/how can i assist|always ready for a chat|what's on your mind/i.test(oracleReply)) score -= 0.25;
    if (/governor|drift|footprint|tier=/i.test(oracleReply) && !/status|health|fleet|kai/i.test(userText)) score -= 0.2;
  } else {
    if (replyLen > 40) score += 0.1;
  }

  if (replyLen > 8 && userLen > 3) score += 0.05;
  return Math.max(0, Math.min(1, score));
}

/** Past intent hints for the same user (keyword overlap). */
export function getIntentHints(userId, text, limit = 3) {
  const store = loadJson(INTENT_FILE, { users: {} });
  const entries = store.users?.[userId] || [];
  if (!entries.length || !text) return [];

  const lower = text.toLowerCase();
  const words = new Set(lower.split(/\s+/).filter(w => w.length > 3));

  return entries
    .map(e => {
      const overlap = (e.keywords || []).filter(k => words.has(k) || lower.includes(k)).length;
      return { ...e, overlap };
    })
    .filter(e => e.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, limit);
}

/**
 * Record classified intent for future resonance (local + lattice).
 */
export async function recordIntentPattern(userId, text, intentResult) {
  if (!userId || !text || !intentResult?.intent) return;

  const keywords = text.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 12);
  const store = loadJson(INTENT_FILE, { users: {} });
  if (!store.users[userId]) store.users[userId] = [];
  store.users[userId].push({
    intent: intentResult.intent,
    agent: intentResult.agent,
    confidence: intentResult.confidence,
    keywords,
    ts: Date.now(),
    sample: text.slice(0, 120),
  });
  while (store.users[userId].length > 80) store.users[userId].shift();
  saveJson(INTENT_FILE, store);

  const claim = `[ORACLE-INTENT] Ryan→${intentResult.intent} (${intentResult.agent}): "${text.slice(0, 200)}"`;
  storeLattice(claim, 'oracle-intent', 1.2 + (intentResult.confidence || 0) * 0.5, 'oracle-intent', userId).catch(() => {});
}

/**
 * Full turn: user message + Oracle reply → KAI learning pipeline.
 */
export async function recordOracleLearning({
  requesterId,
  userText,
  intentResult,
  oracleReply,
  channelId,
  from = 'Ryan',
}) {
  if (!requesterId || !userText) return;

  const quality = scoreConversationQuality(userText, oracleReply || '', intentResult);

  await recordIntentPattern(requesterId, userText, intentResult);

  if (oracleReply && oracleReply.length > 5) {
    const mood = intentResult.intent === 'conversation' ? 'social' : 'industrial';
    await logTrainingCorpus(userText, oracleReply, {
      user_id: requesterId,
      channel_id: channelId || '',
      confidence: quality,
      conflict: intentResult.intent === 'conversation' ? 0.05 : 0.15,
      valence: quality > 0.6 ? 0.3 : -0.1,
      mood,
      hits: [{ intent: intentResult.intent, agent: intentResult.agent, from }],
    });

    const digest = `[ORACLE-DIALOGUE] ${from}: "${userText.slice(0, 150)}" → Oracle(${intentResult.intent}): "${oracleReply.slice(0, 150)}"`;
    storeLattice(digest, 'oracle-dialogue', 1.0 + quality, 'social', requesterId).catch(() => {});
  }

  recordMetric('oracle-conversation', 'turn_quality', quality, {
    intent: intentResult.intent,
    agent: intentResult.agent,
    user_id: requesterId,
  });

  recordMetric('oracle-conversation', 'intent_classified', 1, {
    intent: intentResult.intent,
    confidence: intentResult.confidence,
  });
}

/** Load persisted per-user convo buffer into oracle-intent CONVO_MEMORY Map. */
export function hydrateConvoMemory(convoMap) {
  const saved = loadJson(CONVO_FILE, {});
  for (const [userId, turns] of Object.entries(saved)) {
    if (!Array.isArray(turns)) continue;
    const fresh = turns.filter(t => Date.now() - (t.ts || 0) < 2 * 3600_000);
    if (fresh.length) convoMap.set(userId, fresh);
  }
}

/** Persist CONVO_MEMORY Map to disk. */
export function persistConvoMemory(convoMap) {
  const out = {};
  for (const [userId, turns] of convoMap.entries()) {
    out[userId] = turns.slice(-14);
  }
  saveJson(CONVO_FILE, out);
}
