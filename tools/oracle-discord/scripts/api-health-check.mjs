#!/usr/bin/env node
import dotenv from 'dotenv';
import { recordProviderSuccess } from '../shared/failure-tracker.mjs';

dotenv.config({ path: 'c:/KAI/tools/oracle-discord/.env', override: false });

const timeoutMs = Number(process.env.API_HEALTH_TIMEOUT_MS || 12000);

function trackerId(provider, key) {
  return key ? `${provider}_${String(key).slice(-4)}` : provider;
}

async function probe({ name, provider, key, url, headers = {}, local = false }) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: ctrl.signal
    });
    const ok = res.status === 200;
    const body = await res.text().catch(() => '');
    if (ok) recordProviderSuccess(trackerId(provider, key));
    return {
      name,
      provider,
      ok,
      status: res.status,
      ms: Date.now() - started,
      circuitCleared: ok,
      bodyHint: ok ? undefined : body.slice(0, 180)
    };
  } catch (err) {
    return {
      name,
      provider,
      ok: false,
      status: null,
      ms: Date.now() - started,
      circuitCleared: false,
      local,
      error: err.name === 'AbortError' ? 'timeout' : err.message
    };
  } finally {
    clearTimeout(timer);
  }
}

function addBearer(list, name, provider, key, url) {
  if (!key) {
    list.push({ name, provider, ok: false, status: null, skipped: true, reason: 'missing api key' });
    return;
  }
  list.push({
    name,
    provider,
    key,
    url,
    headers: { Authorization: `Bearer ${key}` }
  });
}

const checks = [];

addBearer(checks, 'OpenAI models', 'openai', process.env.OPENAI_API_KEY, 'https://api.openai.com/v1/models');
addBearer(checks, 'Groq models', 'groq', process.env.GROQ_API_KEY, 'https://api.groq.com/openai/v1/models');
addBearer(checks, 'xAI models', 'xai', process.env.XAI_API_KEY, 'https://api.x.ai/v1/models');
addBearer(checks, 'Moonshot models', 'moonshot', process.env.MOONSHOT_API_KEY, 'https://api.moonshot.cn/v1/models');
addBearer(checks, 'OpenCode Zen models', 'zen', process.env.OPENCODE_ZEN_KEY, 'https://opencode.ai/zen/v1/models');

for (const [label, key] of Object.entries({
  Gemini: process.env.GEMINI_API_KEY,
  'Gemini Leo': process.env.GEMINI_API_KEY_LEO,
  'Gemini Gemini': process.env.GEMINI_API_KEY_GEMINI,
  'Gemini Claudey': process.env.GEMINI_API_KEY_CLAUDEY,
  'Gemini Groq': process.env.GEMINI_API_KEY_GROQ,
  'Gemini X': process.env.GEMINI_API_KEY_X
})) {
  if (!key) {
    checks.push({ name: `${label} models`, provider: 'gemini', ok: false, status: null, skipped: true, reason: 'missing api key' });
  } else {
    checks.push({
      name: `${label} models`,
      provider: 'gemini',
      key,
      url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`
    });
  }
}

checks.push(
  { name: 'Ollama local tags', provider: 'ollama', key: null, url: 'http://127.0.0.1:11434/api/tags', local: true },
  { name: 'KAI CNS status', provider: 'cns', key: null, url: 'http://127.0.0.1:3334/api/status', local: true },
  { name: 'Dashboard health', provider: 'dashboard', key: null, url: 'http://127.0.0.1:3001/health', local: true }
);

const results = [];
for (const check of checks) {
  if (check.skipped) {
    results.push(check);
  } else {
    results.push(await probe(check));
  }
}

const failed = results.filter(r => !r.ok);
const passed = results.filter(r => r.ok);
const payload = {
  generatedAt: new Date().toISOString(),
  pass: failed.length === 0,
  passed: passed.length,
  failed: failed.length,
  results
};

console.log(JSON.stringify(payload, null, 2));
process.exit(payload.pass ? 0 : 1);
