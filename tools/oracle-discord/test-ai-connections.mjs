#!/usr/bin/env node
/**
 * test-ai-connections.mjs — COMPREHENSIVE per-bot, per-PURPOSE, per-MODEL
 * connection auditor for the KAI fleet.
 *
 * Sections printed:
 *   (a) PER-BOT PER-PURPOSE table — every model each bot uses for each job
 *       (text brain, live/native-audio voice, tts, reading engine, embeddings),
 *       with provider, model, key(last4), HTTP, OK/FAIL, error.
 *   (b) PER-PROVIDER MODEL MATRIX — for every provider that has a key, a curated
 *       candidate model list tested with that key (model | HTTP | OK/FAIL).
 *   (c) OLLAMA model+endpoint tests — REAL /api/generate per Sovereign model,
 *       /api/embeddings for nomic-embed-text, plus /api/tags /api/version /api/ps.
 *   (d) LOCAL SERVICES — engine /api/session + each bot /health.
 *   (e) SUMMARY — working vs failing per provider, and any bot purpose with NO
 *       working model.
 *
 * HOW LIVE / TTS ARE TESTED:
 *   - Live (native-audio) is a WebSocket API; we do NOT open a socket. Instead we
 *     check the model is LISTED/available for the key via the Gemini models-list
 *     endpoint (GET /v1beta/models?key=). Rows are labeled "live (availability)".
 *   - TTS model is likewise checked for availability via the models-list endpoint
 *     (the gemini-*-tts model must be present for the key), labeled "tts (availability)".
 *   - Text models get a REAL generateContent / chat-completions ping.
 *
 * Run:  cd C:\KAI\tools\oracle-discord  &&  node test-ai-connections.mjs
 * Secrets are NEVER printed in full — only the last 4 chars of each key.
 */

import dotenv from 'dotenv';
import { AI_REGISTRY } from './shared/identities.mjs';
dotenv.config();

const TIMEOUT_CLOUD = 30000;
const TIMEOUT_LOCAL = 5000;
const TIMEOUT_OLLAMA_GEN = 60000;
const OLLAMA = 'http://127.0.0.1:11434';

// ── Mirror of openjarvis.mjs routing (kept in sync intentionally) ────────────
const MOONSHOT_REAL_MODEL = 'moonshot-v1-128k';

const FLEET = [
  'Oracle', 'KAI', 'Kai Coder', 'Analyst',
  'Researcher',
  'Gemini', 'Claudey', 'X', 'Groq', 'Leo',
];

// gemini-live native-audio bots (have a Live voice purpose)
const LIVE_BOTS = ['Leo', 'Gemini', 'Claudey', 'X', 'Groq'];

function slug(name) { return name.toUpperCase().replace(/[\s-]+/g, '_'); }
function last4(k) { return k ? '...' + String(k).slice(-4) : '(none)'; }

// Resolve the realModel the SAME way resolveRoute() does (text brain).
function resolveModel(name, provider, alias) {
  if (provider === 'ollama') return alias;
  if (provider === 'moonshot') return MOONSHOT_REAL_MODEL;
  if (provider === 'gemini') {
    if (alias && alias.startsWith('gemini-')) return alias;
    const perBot = { 'Gemini': 'gemini-2.5-flash', 'Claudey': 'gemini-2.5-flash' }[name];
    return perBot || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  }
  if (provider === 'groq') {
    const env = { 'Analyst': 'ANALYST_MODEL', 'Researcher': 'RESEARCHER_MODEL', 'Kai Coder': 'KAICODER_MODEL', 'Gemini': 'GEMINI_BOT_MODEL', 'Claudey': 'CLAUDEY_MODEL', 'Groq': 'GROQ_BOT_MODEL', 'X': 'X_MODEL' }[name];
    if (env && process.env[env]) return process.env[env];
    const def = { 'Gemini': 'llama-3.1-8b-instant', 'Claudey': 'llama-3.1-8b-instant', 'Groq': 'llama-3.1-8b-instant', 'X': 'llama-3.1-8b-instant' }[name];
    return def || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  }
  if (provider === 'xai') return process.env.X_MODEL || process.env.XAI_MODEL || 'grok-3';
  if (provider === 'zen') return process.env.ZEN_MODEL || 'kimi-k2.6';
  return alias;
}

function resolveKey(name, provider) {
  const s = slug(name);
  const pick = (base) => process.env[base + '_' + s] || process.env[base] || '';
  switch (provider) {
    case 'gemini':   return pick('GEMINI_API_KEY');
    case 'groq':     return pick('GROQ_API_KEY');
    case 'xai':      return pick('XAI_API_KEY');
    case 'moonshot': return pick('MOONSHOT_API_KEY');
    case 'zen':      return pick('OPENCODE_ZEN_KEY');
    default:         return '';
  }
}

function resolveRoute(name) {
  const def = { 'KAI': 'KAI-Sovereign:latest', 'Oracle': 'Oracle-Sovereign:latest' }[name];
  const provider = (process.env['BOT_PROVIDER_' + slug(name)] || 'ollama').toLowerCase();
  const alias = process.env['BOT_MODEL_' + slug(name)] || def || (name.replace(' ', '-') + '-Sovereign');
  const model = resolveModel(name, provider, alias);
  const key = resolveKey(name, provider);
  return { provider, alias, model, key };
}

// Per-bot Gemini key for LIVE/TTS purposes (mirrors GEMINI_API_KEY_<NAME> -> free key).
function geminiKeyFor(name) {
  return process.env['GEMINI_API_KEY_' + slug(name)] || process.env.GEMINI_API_KEY || '';
}

// Per-bot live voice (GEMINI_VOICE_<NAME> / GEMINI_LIVE_VOICE_<NAME> / LEO_VOICE).
function liveVoiceFor(name) {
  const s = slug(name);
  return process.env['GEMINI_VOICE_' + s] ||
         process.env['GEMINI_LIVE_VOICE_' + s] ||
         (name === 'Leo' ? (process.env.LEO_VOICE || '') : '') || '(default)';
}

// Ordered Live model candidates (mirror of gemini-live-bridge.mjs).
function liveModelCandidates() {
  const primary = process.env.GEMINI_LIVE_MODEL || 'models/gemini-2.5-flash-native-audio-preview-09-2025';
  const defaults = [
    primary,
    'models/gemini-2.5-flash-native-audio-latest',
    'models/gemini-2.5-flash-native-audio-preview-12-2025',
    'models/gemini-2.5-flash-native-audio-preview-09-2025',
    'models/gemini-3.1-flash-live-preview',
  ];
  let list = defaults;
  const raw = process.env.GEMINI_LIVE_MODELS;
  if (raw) {
    const extra = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (extra.length) list = [primary].concat(extra);
  }
  // dedup, preserve order
  return [...new Set(list)];
}

// ── Provider endpoints (OpenAI-compatible chat/completions) ──────────────────
const ENDPOINTS = {
  groq:       'https://api.groq.com/openai/v1/chat/completions',
  xai:        'https://api.x.ai/v1/chat/completions',
  gemini:     'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  zen:        'https://opencode.ai/zen/v1/chat/completions',
  moonshot:   'https://api.moonshot.cn/v1/chat/completions',
  openai:     'https://api.openai.com/v1/chat/completions',
  cerebras:   'https://api.cerebras.ai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
};

function classify(http) {
  if (!http) return 'unreachable';
  if (http >= 200 && http < 300) return 'ok';
  if (http >= 400 && http < 500) return '4xx';
  if (http >= 500) return '5xx';
  return String(http);
}

async function pingCloud(provider, model, key) {
  const endpoint = ENDPOINTS[provider];
  if (!endpoint) return { http: 0, ok: false, err: 'no endpoint' };
  if (!key) return { http: 0, ok: false, err: 'missing key' };
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(TIMEOUT_CLOUD),
    });
    if (res.ok) return { http: res.status, ok: true, err: '' };
    const t = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 90);
    return { http: res.status, ok: false, err: t };
  } catch (e) {
    return { http: 0, ok: false, err: (e.message || 'fetch error').slice(0, 90) };
  }
}

// Gemini models-list — used for LIVE + TTS availability checks. Cached per key.
const _geminiListCache = new Map();
async function geminiListModels(key) {
  if (!key) return { http: 0, ok: false, models: [], err: 'missing key' };
  if (_geminiListCache.has(key)) return _geminiListCache.get(key);
  let out;
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(key) + '&pageSize=1000', {
      signal: AbortSignal.timeout(TIMEOUT_CLOUD),
    });
    if (!res.ok) {
      const t = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 90);
      out = { http: res.status, ok: false, models: [], err: t };
    } else {
      const data = await res.json();
      const models = (data.models || []).map(m => String(m.name || '').replace(/^models\//, ''));
      out = { http: res.status, ok: true, models, err: '' };
    }
  } catch (e) {
    out = { http: 0, ok: false, models: [], err: (e.message || 'fetch error').slice(0, 90) };
  }
  _geminiListCache.set(key, out);
  return out;
}

// Gemini IMAGE test — calls <model>:generateContent with a tiny prompt and
// responseModalities ["TEXT","IMAGE"], reports HTTP + whether image bytes came back.
// NOTE: image gen may have its own free-tier quota; we report the REAL status (200/OK
// or the actual error e.g. 429) so we know if the free key can actually do images.
async function pingGeminiImage(key, model) {
  if (!key) return { http: 0, ok: false, err: 'missing key' };
  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(key);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'a tiny red circle on white' }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      }),
      signal: AbortSignal.timeout(TIMEOUT_CLOUD),
    });
    if (!res.ok) {
      const t = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 90);
      return { http: res.status, ok: false, err: t };
    }
    const data = await res.json().catch(() => ({}));
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const hasImage = parts.some(p => p.inlineData?.mimeType?.startsWith('image/') && p.inlineData?.data);
    return { http: res.status, ok: hasImage, err: hasImage ? 'image returned' : 'no image in response (text-only)' };
  } catch (e) {
    return { http: 0, ok: false, err: (e.message || 'fetch error').slice(0, 90) };
  }
}

function norm(m) { return String(m || '').replace(/^models\//, ''); }

// Availability check against the models list (for live + tts).
async function checkAvailability(key, model) {
  const list = await geminiListModels(key);
  if (!list.ok) return { http: list.http, ok: false, err: list.err || 'models-list failed' };
  const want = norm(model);
  const found = list.models.includes(want) || list.models.some(m => m === want || m.startsWith(want));
  if (found) return { http: 200, ok: true, err: 'listed' };
  return { http: 404, ok: false, err: 'not listed for key' };
}

// ── Ollama helpers ───────────────────────────────────────────────────────────
async function ollamaTags() {
  try {
    const res = await fetch(OLLAMA + '/api/tags', { signal: AbortSignal.timeout(TIMEOUT_LOCAL) });
    if (!res.ok) return { up: true, http: res.status, models: [] };
    const data = await res.json();
    return { up: true, http: 200, models: (data.models || []).map(m => m.name) };
  } catch (e) { return { up: false, http: 0, models: [], err: (e.message || '').slice(0, 80) }; }
}

async function ollamaGet(path) {
  try {
    const res = await fetch(OLLAMA + path, { signal: AbortSignal.timeout(TIMEOUT_LOCAL) });
    return { http: res.status, ok: res.ok };
  } catch (e) { return { http: 0, ok: false, err: (e.message || '').slice(0, 80) }; }
}

async function ollamaGenerate(model) {
  try {
    const res = await fetch(OLLAMA + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: 'ping', stream: false, options: { num_predict: 1 } }),
      signal: AbortSignal.timeout(TIMEOUT_OLLAMA_GEN),
    });
    if (res.ok) return { http: 200, ok: true, err: '' };
    const t = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 90);
    return { http: res.status, ok: false, err: t };
  } catch (e) { return { http: 0, ok: false, err: (e.message || '').slice(0, 90) }; }
}

async function ollamaEmbeddings(model) {
  try {
    const res = await fetch(OLLAMA + '/api/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: 'ping' }),
      signal: AbortSignal.timeout(TIMEOUT_OLLAMA_GEN),
    });
    if (res.ok) {
      const d = await res.json().catch(() => ({}));
      const dim = Array.isArray(d.embedding) ? d.embedding.length : 0;
      return { http: 200, ok: true, err: dim ? ('dim=' + dim) : 'no vector' };
    }
    const t = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 90);
    return { http: res.status, ok: false, err: t };
  } catch (e) { return { http: 0, ok: false, err: (e.message || '').slice(0, 90) }; }
}

function ollamaHas(models, target) {
  const t = String(target);
  return models.includes(t) || models.some(m => m === t || m.split(':')[0] === t.split(':')[0]);
}

function pad(s, n) { s = String(s == null ? '' : s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }
function statusCell(ok) { return ok ? 'OK' : 'FAIL'; }

(async () => {
  console.log('\n=== KAI FLEET COMPREHENSIVE AI CONNECTION AUDIT ===  ' + new Date().toISOString() + '\n');

  const tags = await ollamaTags();
  const ollamaModels = tags.models || [];
  console.log('Ollama daemon (' + OLLAMA + '): ' + (tags.up ? 'UP' : 'DOWN ' + (tags.err || '')));
  if (tags.up) console.log('  installed models: ' + (ollamaModels.join(', ') || '(none)'));
  console.log('');

  // ════════════════════════════════════════════════════════════════════════
  // (a) PER-BOT, PER-PURPOSE
  // ════════════════════════════════════════════════════════════════════════
  const botRows = [];   // {name, purpose, provider, model, key, http, ok, err}
  // track per-bot per-purpose working status for the summary
  const purposeWorks = {}; // `${name}|${purpose}` -> bool (any candidate worked)

  const liveCandidates = liveModelCandidates();

  for (const name of FLEET) {
    // --- TEXT brain ---
    const r = resolveRoute(name);
    let textRes;
    if (r.provider === 'ollama') {
      if (!tags.up) textRes = { http: 0, ok: false, err: 'ollama daemon DOWN' };
      else if (!ollamaHas(ollamaModels, r.model)) textRes = { http: 404, ok: false, err: 'model not pulled' };
      else textRes = await ollamaGenerate(r.model);
    } else {
      textRes = await pingCloud(r.provider, r.model, r.key);
    }
    botRows.push({ name, purpose: 'text', provider: r.provider, model: r.model, key: last4(r.key), ...textRes });
    purposeWorks[name + '|text'] = textRes.ok;

    // --- LIVE / native-audio voice (only the gemini-live bots) ---
    if (LIVE_BOTS.includes(name)) {
      const lkey = geminiKeyFor(name);
      const voice = liveVoiceFor(name);
      let anyLive = false;
      for (const lm of liveCandidates) {
        const av = await checkAvailability(lkey, lm);
        if (av.ok) anyLive = true;
        botRows.push({
          name, purpose: 'live (availability)', provider: 'gemini',
          model: norm(lm) + '  [voice:' + voice + ']', key: last4(lkey), ...av,
        });
      }
      purposeWorks[name + '|live'] = anyLive;
    }

    // --- IMAGE (Gemini/Gemi only — the image-capable bot) ---
    if (name === 'Gemini') {
      const ikey = geminiKeyFor(name);
      const imgModel = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
      const ir = await pingGeminiImage(ikey, imgModel);
      botRows.push({ name, purpose: 'image (generateContent)', provider: 'gemini', model: imgModel, key: last4(ikey), ...ir });
      purposeWorks[name + '|image'] = ir.ok;
    }

    // --- TTS (Leo only) ---
    if (name === 'Leo') {
      const ttsModel = process.env.LEO_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
      const tkey = geminiKeyFor('Leo');
      const av = await checkAvailability(tkey, ttsModel);
      botRows.push({ name, purpose: 'tts (availability)', provider: 'gemini', model: ttsModel, key: last4(tkey), ...av });
      purposeWorks['Leo|tts'] = av.ok;

      // --- READING engine (Leo) ---
      const engine = (process.env.LEO_READING_ENGINE || 'live').toLowerCase();
      if (engine === 'edge-tts' || engine === 'edge') {
        botRows.push({ name, purpose: 'reading', provider: 'edge-tts', model: 'edge-tts (local/free)', key: '(n/a)', http: 0, ok: true, err: 'local — no key/network needed' });
        purposeWorks['Leo|reading'] = true;
      } else {
        // reading=live reuses the Live native-audio path
        const av2 = await checkAvailability(geminiKeyFor('Leo'), liveCandidates[0]);
        botRows.push({ name, purpose: 'reading (live)', provider: 'gemini', model: norm(liveCandidates[0]), key: last4(geminiKeyFor('Leo')), ...av2 });
        purposeWorks['Leo|reading'] = av2.ok;
      }
    }
  }

  // --- EMBEDDINGS (shared, via ollama) ---
  {
    const embModel = process.env.EMBED_MODEL || 'nomic-embed-text';
    let er;
    if (!tags.up) er = { http: 0, ok: false, err: 'ollama daemon DOWN' };
    else if (!ollamaHas(ollamaModels, embModel)) er = { http: 404, ok: false, err: 'model not pulled' };
    else er = await ollamaEmbeddings(embModel);
    botRows.push({ name: 'FLEET', purpose: 'embeddings', provider: 'ollama', model: embModel, key: '(local)', ...er });
    purposeWorks['FLEET|embeddings'] = er.ok;
  }

  console.log('--- (a) PER-BOT PER-PURPOSE MODELS ---');
  console.log(pad('BOT', 11) + pad('PURPOSE', 22) + pad('PROVIDER', 9) + pad('MODEL', 46) + pad('KEY', 9) + pad('HTTP', 6) + pad('STATUS', 6) + 'NOTE/ERROR');
  console.log('-'.repeat(150));
  for (const x of botRows) {
    console.log(pad(x.name, 11) + pad(x.purpose, 22) + pad(x.provider, 9) + pad(x.model, 46) + pad(x.key, 9) + pad(x.http, 6) + pad(statusCell(x.ok), 6) + (x.err || ''));
  }

  // ════════════════════════════════════════════════════════════════════════
  // (b) PER-PROVIDER MODEL MATRIX
  // ════════════════════════════════════════════════════════════════════════
  // Candidate model lists per provider.
  // OWNER DECISION — ACTIVE providers only: gemini + groq (+ local ollama).
  // REMOVED from the matrix entirely: moonshot + xAI (gone). SILENCED (keys kept but
  // NOT in rotation): zen + openai + cerebras — labeled below, not presented as active
  // failures. Trimmed gemini text list to the two that work on the free key. Removed
  // the DECOMMISSIONED gemma2-9b-it from groq.
  const PROVIDER_MATRIX = {
    gemini: {
      type: 'gemini',
      models: [
        { m: 'gemini-2.5-flash', kind: 'text' },
        { m: 'gemini-2.5-flash-lite', kind: 'text' },
        { m: 'gemini-2.5-flash-image', kind: 'image (generateContent)' },
        { m: 'gemini-2.5-flash-native-audio-preview-09-2025', kind: 'list-only (live)' },
        { m: 'gemini-2.5-flash-preview-tts', kind: 'list-only (tts)' },
      ],
    },
    groq: {
      type: 'openai',
      models: [
        { m: 'llama-3.3-70b-versatile', kind: 'text' },
        { m: 'llama-3.1-8b-instant', kind: 'text' },
        { m: 'whisper-large-v3-turbo', kind: 'stt (skip-generate)' },
      ],
    },
    // SILENCED (not in active rotation; keys kept, re-enableable later).
    zen:        { type: 'openai', silenced: true, models: [{ m: process.env.ZEN_MODEL || 'kimi-k2.6', kind: 'text' }] },
    openai:     { type: 'openai', silenced: true, models: [{ m: 'gpt-4o-mini', kind: 'text' }] },
    cerebras:   { type: 'openai', silenced: true, models: [{ m: 'llama-3.3-70b', kind: 'text' }] },
  };

  // Resolve a representative key per provider + collect which bots share it.
  function providerKey(provider) {
    switch (provider) {
      case 'gemini':     return process.env.GEMINI_API_KEY || '';
      case 'groq':       return process.env.GROQ_API_KEY || '';
      case 'xai':        return process.env.XAI_API_KEY || '';
      case 'moonshot':   return process.env.MOONSHOT_API_KEY || '';
      case 'zen':        return process.env.OPENCODE_ZEN_KEY || '';
      case 'openai':     return process.env.OPENAI_API_KEY || '';
      case 'cerebras':   return process.env.CEREBRAS_API_KEY || '';
      case 'openrouter': return process.env.OPENROUTER_API_KEY || '';
      default:           return '';
    }
  }

  // For gemini, also gather distinct per-bot keys.
  function geminiDistinctKeys() {
    const map = new Map(); // key -> [labels]
    const add = (label, k) => { if (!k) return; if (!map.has(k)) map.set(k, []); map.get(k).push(label); };
    add('global', process.env.GEMINI_API_KEY);
    for (const b of LIVE_BOTS) add(b, process.env['GEMINI_API_KEY_' + slug(b)]);
    return map; // Map<key, labels[]>
  }

  const providerSummary = {}; // provider -> {ok, fail}

  console.log('\n--- (b) PER-PROVIDER MODEL MATRIX ---');
  for (const [provider, cfg] of Object.entries(PROVIDER_MATRIX)) {
    // Build list of {key, sharedBy} to test. Gemini may have several distinct keys.
    let keySets;
    if (provider === 'gemini') {
      keySets = [...geminiDistinctKeys().entries()].map(([k, labels]) => ({ key: k, sharedBy: labels }));
    } else {
      const k = providerKey(provider);
      keySets = k ? [{ key: k, sharedBy: ['(provider key)'] }] : [];
    }

    const silencedTag = cfg.silenced ? '  [SILENCED — not in rotation]' : '';

    if (!keySets.length) {
      console.log('\n[' + provider + ']' + silencedTag + ' no key in .env — skipped.');
      continue;
    }

    for (const ks of keySets) {
      console.log('\n[' + provider + ']' + silencedTag + ' key ' + last4(ks.key) + '  (used by: ' + ks.sharedBy.join(', ') + ')');
      console.log('  ' + pad('MODEL', 50) + pad('HTTP', 6) + pad('STATUS', 6) + 'KIND / ERROR');
      // gemini availability uses the list; pre-warm once
      for (const item of cfg.models) {
        let res;
        if (cfg.type === 'gemini') {
          if (item.kind.startsWith('list-only')) {
            res = await checkAvailability(ks.key, item.m);
          } else if (item.kind.startsWith('image')) {
            res = await pingGeminiImage(ks.key, item.m);
          } else {
            res = await pingCloud('gemini', item.m, ks.key);
          }
        } else if (item.kind.startsWith('stt')) {
          // whisper STT is not a chat model — only verify the key auths by listing-style ping is N/A;
          // we attempt the chat endpoint but expect a model-type 4xx, so just label.
          res = await pingCloud(provider, item.m, ks.key);
          if (!res.ok) res.err = '(stt model — chat ping not valid) ' + (res.err || '');
        } else {
          res = await pingCloud(provider, item.m, ks.key);
        }
        // SILENCED providers are reported for visibility but NOT counted as active
        // failures in the summary (they are intentionally out of rotation).
        if (!cfg.silenced) {
          const sum = providerSummary[provider] || { ok: 0, fail: 0 };
          if (res.ok) sum.ok++; else sum.fail++;
          providerSummary[provider] = sum;
        }
        const statusLabel = cfg.silenced ? 'SILENCED' : statusCell(res.ok);
        console.log('  ' + pad(item.m, 50) + pad(res.http, 6) + pad(statusLabel, 9) + item.kind + (res.err ? ('  ' + res.err) : ''));
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // (c) OLLAMA model + endpoint tests
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n--- (c) OLLAMA MODEL + ENDPOINT TESTS ---');
  if (!tags.up) {
    console.log('  Ollama daemon DOWN — skipping generate/embeddings tests. (' + (tags.err || '') + ')');
  } else {
    // Sovereign models the bots actually use (from BOT_MODEL_* / resolveRoute).
    const sovereign = [...new Set(FLEET
      .map(n => resolveRoute(n))
      .filter(r => r.provider === 'ollama')
      .map(r => r.model))];
    console.log('  REAL /api/generate {prompt:"ping"} per Sovereign model:');
    console.log('  ' + pad('MODEL', 36) + pad('HTTP', 6) + pad('STATUS', 6) + 'ERROR');
    for (const m of sovereign) {
      let res;
      if (!ollamaHas(ollamaModels, m)) res = { http: 404, ok: false, err: 'not pulled' };
      else res = await ollamaGenerate(m);
      console.log('  ' + pad(m, 36) + pad(res.http, 6) + pad(statusCell(res.ok), 6) + (res.err || ''));
    }
    // embeddings
    const embModel = process.env.EMBED_MODEL || 'nomic-embed-text';
    let er;
    if (!ollamaHas(ollamaModels, embModel)) er = { http: 404, ok: false, err: 'not pulled' };
    else er = await ollamaEmbeddings(embModel);
    console.log('  /api/embeddings (' + embModel + '): HTTP ' + er.http + ' ' + statusCell(er.ok) + ' ' + (er.err || ''));

    // other endpoints
    console.log('  Other ollama endpoints:');
    for (const p of ['/api/tags', '/api/version', '/api/ps']) {
      const r = await ollamaGet(p);
      console.log('    ' + pad(p, 16) + 'HTTP ' + r.http + ' ' + (r.ok ? 'OK' : 'FAIL') + (r.err ? (' ' + r.err) : ''));
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // (d) LOCAL SERVICES
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n--- (d) LOCAL SERVICES ---');
  try {
    const res = await fetch('http://127.0.0.1:3334/api/session', { signal: AbortSignal.timeout(TIMEOUT_LOCAL) });
    console.log('Engine /api/session (3334): HTTP ' + res.status + (res.ok ? ' OK' : ' FAIL'));
  } catch (e) { console.log('Engine /api/session (3334): DOWN (' + (e.message || '') + ')'); }

  for (const [name, info] of Object.entries(AI_REGISTRY)) {
    try {
      const res = await fetch('http://127.0.0.1:' + info.port + '/health', { signal: AbortSignal.timeout(3000) });
      console.log(pad(name, 12) + ' /health (' + info.port + '): HTTP ' + res.status + (res.ok ? ' OK' : ' FAIL'));
    } catch (e) {
      console.log(pad(name, 12) + ' /health (' + info.port + '): DOWN');
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // (e) SUMMARY
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n--- (e) SUMMARY ---');

  // Per-provider working vs failing (from the matrix).
  console.log('Provider model matrix (working/total):');
  for (const [provider, s] of Object.entries(providerSummary)) {
    const total = s.ok + s.fail;
    console.log('  ' + pad(provider, 12) + s.ok + '/' + total + ' models OK' + (s.fail ? ('  (' + s.fail + ' fail)') : ''));
  }

  // Per-bot text brain status.
  const textRows = botRows.filter(r => r.purpose === 'text');
  const textOk = textRows.filter(r => r.ok).length;
  console.log('\nText brains: ' + textOk + '/' + textRows.length + ' bots returned a working primary.');
  const textFails = textRows.filter(r => !r.ok);
  if (textFails.length) console.log('  FAILING text brains: ' + textFails.map(f => f.name + '(' + classify(f.http) + ')').join(', '));

  // Any bot+purpose with NO working model.
  const deadPurposes = [];
  // text per bot
  for (const r of textRows) if (!r.ok) deadPurposes.push(r.name + '/text');
  // live per live-bot
  for (const b of LIVE_BOTS) if (!purposeWorks[b + '|live']) deadPurposes.push(b + '/live');
  if (purposeWorks['Leo|tts'] === false) deadPurposes.push('Leo/tts');
  if (purposeWorks['Leo|reading'] === false) deadPurposes.push('Leo/reading');
  if (purposeWorks['FLEET|embeddings'] === false) deadPurposes.push('FLEET/embeddings');

  if (deadPurposes.length) {
    console.log('\n⚠ Bot purposes with NO working model:');
    console.log('  ' + deadPurposes.join(', '));
  } else {
    console.log('\n✓ Every bot purpose has at least one working model.');
  }

  console.log('\nDone. (Keys shown as last-4 only; live/tts rows are availability checks, not socket calls.)\n');
})().catch(e => {
  console.error('\nFATAL (auditor itself crashed): ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
