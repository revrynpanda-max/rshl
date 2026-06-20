/**
 * info-sandbox.mjs — a SECOND sandbox, separate from the codex/narration one.
 *
 * Where the context sandbox pages through a big DOCUMENT to read aloud, this one
 * is a draft cache for fetched INFORMATION — directions, place lookups, saved
 * facts — kept in named "regions" per session. Leo stashes a result here when he
 * looks something up, and can pull it back later ("what were those directions
 * again?", "read me the full step list"). Small JSON ring so it can't grow forever.
 */
import fs from 'fs';

const STATE_DIR = 'c:/KAI/tools/oracle-discord/state';
const PATH = `${STATE_DIR}/info_sandbox.json`;
const MAX_PER_REGION = 5;   // keep the last few of each kind per session
const MAX_SESSIONS = 50;

function load() { try { return JSON.parse(fs.readFileSync(PATH, 'utf8')); } catch { return {}; } }
function save(o) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(PATH, JSON.stringify(o, null, 2)); } catch (_) {}
}

/** Stash a result in a session's region (e.g. 'directions', 'places', 'facts'). */
export function saveInfo(session, region, title, text, meta = {}) {
  if (!session || !region) return null;
  const all = load();
  const keys = Object.keys(all);
  if (keys.length >= MAX_SESSIONS && !all[session]) delete all[keys[0]]; // evict oldest session
  all[session] = all[session] || {};
  const list = Array.isArray(all[session][region]) ? all[session][region] : [];
  const entry = {
    id: `${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    ts: new Date().toISOString(),
    title: String(title || '').slice(0, 140),
    text: String(text || '').slice(0, 8000),
    meta,
  };
  list.push(entry);
  while (list.length > MAX_PER_REGION) list.shift();
  all[session][region] = list;
  save(all);
  return entry;
}

/** Get the latest (or all) saved entries in a region. */
export function getInfo(session, region, { latest = true } = {}) {
  const all = load();
  const list = (all[session] && all[session][region]) || [];
  if (!list.length) return null;
  return latest ? list[list.length - 1] : list;
}

/** Which regions does this session have stashed? */
export function listRegions(session) {
  const all = load();
  return all[session] ? Object.keys(all[session]).filter(r => (all[session][r] || []).length) : [];
}

export function clearInfo(session, region) {
  const all = load();
  if (!all[session]) return;
  if (region) delete all[session][region]; else delete all[session];
  save(all);
}
