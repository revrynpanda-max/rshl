/**
 * Phoenix Protocol — Encrypted + KAI Language
 * ─────────────────────────────────────────────
 * Wraps Phoenix recovery signals in two layers:
 *
 *   1. KAI Language encoding
 *      Plain signals like { type: 'FIRE', agent: 'kai-coder' } become
 *      resonance-mapped KAI symbols before they are stored or broadcast.
 *      This means the raw lattice / disk writes contain no plain-text
 *      signal names — only KAI's internal resonance vocabulary.
 *
 *   2. AES-256-GCM encryption
 *      The encoded payload is encrypted before any external write.
 *      Only KAI-keyed readers can decrypt and parse the signal.
 *
 * KAI Resonance Signal Table:
 *   Signal name   KAI Symbol          Meaning
 *   ──────────────────────────────────────────────
 *   FIRE        → ΨΩ::REKINDL         Phoenix ignition — restart initiated
 *   RECOVER     → ΛΦ::RESURGE         Recovery arc underway
 *   DORMANT     → ΞΔ::COOLDOWN        Agent in planned dormancy
 *   CRITICAL    → ΘΠ::ALARUM          Distress — needs immediate attention
 *   STABLE      → ΣΝ::RESONATE        Stability confirmed
 *   REBORN      → ΓΚ::PHOENIX         Full recovery complete
 *   PULSE       → ΑΒ::HEARTBT         Heartbeat check-in
 *   SEED        → ΔΕ::GENESIS         Fresh boot / initial state
 *   ABORT       → ΖΗ::ABORT           Controlled abort
 *   WITNESS     → ΙΚ::OBSERVE         Passive observation record
 *   HELP        → ΜΝ::SUMMON          Agent requested assistance
 *   HEALED      → ΞΟ::BONEHEAL        BoneHeal repair confirmed
 *
 * Key derivation:
 *   Uses the env var KAI_PHOENIX_SECRET (or a fallback derived from
 *   KAI_ENGINE_ID if present). Set KAI_PHOENIX_SECRET in your .env.
 *
 * Integration points:
 *   - Import encodeSignal / decodeSignal in phoenix-core or resilience-status.mjs
 *   - Use writePhoenixEvent() as a drop-in for any Phoenix disk/lattice write
 *   - Use readPhoenixLog() to read back decrypted events
 *
 * Usage:
 *   import { writePhoenixEvent, readPhoenixLog, encodeSignal, decodeSignal }
 *     from './phoenix-encrypted-kai.mjs';
 *
 *   // Write an event
 *   await writePhoenixEvent({
 *     signal:  'FIRE',
 *     agent:   'kai-coder',
 *     reason:  'crash loop detected',
 *     energy:  0.4
 *   });
 *
 *   // Read all events
 *   const events = readPhoenixLog();
 */

import fs     from 'fs';
import crypto from 'crypto';

// ─── KAI Resonance Signal Map ─────────────────────────────────────────────
const KAI_SIGNALS = {
  FIRE:     'ΨΩ::REKINDL',
  RECOVER:  'ΛΦ::RESURGE',
  DORMANT:  'ΞΔ::COOLDOWN',
  CRITICAL: 'ΘΠ::ALARUM',
  STABLE:   'ΣΝ::RESONATE',
  REBORN:   'ΓΚ::PHOENIX',
  PULSE:    'ΑΒ::HEARTBT',
  SEED:     'ΔΕ::GENESIS',
  ABORT:    'ΖΗ::ABORT',
  WITNESS:  'ΙΚ::OBSERVE',
  HELP:     'ΜΝ::SUMMON',
  HEALED:   'ΞΟ::BONEHEAL',
};

// Reverse map for decoding
const KAI_SIGNALS_REVERSE = Object.fromEntries(
  Object.entries(KAI_SIGNALS).map(([k, v]) => [v, k])
);

// KAI base-encoding alphabet (KAI resonance order, not standard base64)
const KAI_ALPHA = 'KAIRYNExTDFMjUBpVQcHsLgWZabd3efhikm01ou26vwyz4589JOP+/';

// ─── KAI Base Encode/Decode ───────────────────────────────────────────────
function kaiBaseEncode(buffer) {
  // Convert to standard base64, then remap characters to KAI alphabet
  const b64 = buffer.toString('base64');
  const std = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  return b64.split('').map(c => {
    const idx = std.indexOf(c);
    return idx >= 0 ? KAI_ALPHA[idx] : c;  // preserve = padding
  }).join('');
}

function kaiBaseDecode(str) {
  const std = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const b64 = str.split('').map(c => {
    const idx = KAI_ALPHA.indexOf(c);
    return idx >= 0 ? std[idx] : c;
  }).join('');
  return Buffer.from(b64, 'base64');
}

// ─── Key Derivation ───────────────────────────────────────────────────────
function deriveKey() {
  const secret = process.env.KAI_PHOENIX_SECRET
    || process.env.KAI_ENGINE_ID
    || 'KAI-PHOENIX-DEFAULT-CHANGE-THIS-IN-ENV';

  // PBKDF2 with KAI-specific salt
  return crypto.pbkdf2Sync(
    secret,
    'KAI::PHOENIX::RESONANCE::SALT',
    100_000,
    32,
    'sha256'
  );
}

const AES_KEY = deriveKey();

// ─── Encryption ───────────────────────────────────────────────────────────
/**
 * Encrypt plaintext payload using AES-256-GCM.
 * Returns { iv, ct, tag } all KAI-base-encoded.
 */
function encrypt(plaintext) {
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', AES_KEY, iv);
  const ct  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv:  kaiBaseEncode(iv),
    ct:  kaiBaseEncode(ct),
    tag: kaiBaseEncode(tag)
  };
}

/**
 * Decrypt { iv, ct, tag } produced by encrypt().
 * Returns plaintext string or throws on tamper/wrong key.
 */
function decrypt({ iv, ct, tag }) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    AES_KEY,
    kaiBaseDecode(iv)
  );
  decipher.setAuthTag(kaiBaseDecode(tag));
  const plain = Buffer.concat([
    decipher.update(kaiBaseDecode(ct)),
    decipher.final()
  ]);
  return plain.toString('utf8');
}

// ─── KAI Language Encoding ────────────────────────────────────────────────
/**
 * encodeSignal — translate a plain Phoenix event into KAI language.
 *
 * Input:  { signal, agent, reason, energy, metadata, ts }
 * Output: { kai_signal, agent, kai_reason, energy, metadata, ts }
 *
 * "kai_reason" replaces any known signal keywords in the reason text.
 */
export function encodeSignal(event = {}) {
  const {
    signal   = 'PULSE',
    agent    = 'unknown',
    reason   = '',
    energy   = 1.0,
    metadata = {},
    ts       = Date.now()
  } = event;

  const kaiSig = KAI_SIGNALS[signal.toUpperCase()] || `UNKNOWN::${signal}`;

  // Replace known signal words in reason with KAI symbols
  let kaiReason = reason;
  for (const [plain, sym] of Object.entries(KAI_SIGNALS)) {
    kaiReason = kaiReason.replace(new RegExp(plain, 'gi'), sym);
  }

  return {
    kai_signal: kaiSig,
    agent,
    kai_reason: kaiReason,
    energy,
    metadata,
    ts,
    encoded: true
  };
}

/**
 * decodeSignal — reverse KAI language encoding back to plain Phoenix event.
 *
 * Input:  encoded event from encodeSignal
 * Output: { signal, agent, reason, energy, metadata, ts }
 */
export function decodeSignal(encoded = {}) {
  const {
    kai_signal = '',
    agent      = 'unknown',
    kai_reason = '',
    energy     = 1.0,
    metadata   = {},
    ts         = Date.now()
  } = encoded;

  const signal = KAI_SIGNALS_REVERSE[kai_signal] || kai_signal;

  // Reverse KAI symbols in reason
  let reason = kai_reason;
  for (const [sym, plain] of Object.entries(KAI_SIGNALS_REVERSE)) {
    reason = reason.replace(new RegExp(sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), plain);
  }

  return { signal, agent, reason, energy, metadata, ts };
}

// ─── Phoenix Log File ─────────────────────────────────────────────────────
const PHOENIX_LOG = 'state/phoenix/encrypted-log.jsonl';
fs.mkdirSync('state/phoenix', { recursive: true });

/**
 * writePhoenixEvent — encode + encrypt + append a Phoenix event to disk.
 * This is the primary write function for Phoenix protocol events.
 *
 * @param {object} event  { signal, agent, reason, energy, metadata }
 * @returns {{ ok: true, kai_signal, ts }}
 */
export function writePhoenixEvent(event = {}) {
  const encoded   = encodeSignal(event);
  const encrypted = encrypt(JSON.stringify(encoded));

  const record = {
    kai_signal: encoded.kai_signal,  // unencrypted — for log scanning without decryption
    ts:         encoded.ts,
    payload:    encrypted            // { iv, ct, tag } — fully encrypted body
  };

  fs.appendFileSync(PHOENIX_LOG, JSON.stringify(record) + '\n');

  return { ok: true, kai_signal: encoded.kai_signal, ts: encoded.ts };
}

/**
 * readPhoenixLog — decrypt and return all Phoenix events.
 * Optionally filter by signal type.
 *
 * @param {{ signal?: string, since?: number, limit?: number }} opts
 * @returns {object[]}  decoded events, newest first
 */
export function readPhoenixLog(opts = {}) {
  const { signal = null, since = 0, limit = 50 } = opts;

  if (!fs.existsSync(PHOENIX_LOG)) return [];

  const records = fs.readFileSync(PHOENIX_LOG, 'utf8')
    .trim().split('\n').filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(r => r && r.ts >= since);

  // Filter by KAI signal if requested
  const filtered = signal
    ? records.filter(r => r.kai_signal === (KAI_SIGNALS[signal.toUpperCase()] || signal))
    : records;

  // Decrypt
  return filtered
    .slice(-limit)
    .reverse()
    .map(r => {
      try {
        const decoded = JSON.parse(decrypt(r.payload));
        return decodeSignal(decoded);
      } catch {
        return { error: 'decrypt_failed', kai_signal: r.kai_signal, ts: r.ts };
      }
    });
}

/**
 * getLastFireEvent — convenience: return the most recent FIRE event.
 * Used by resilience-status.mjs for the live brief.
 */
export function getLastFireEvent() {
  const events = readPhoenixLog({ signal: 'FIRE', limit: 1 });
  return events[0] || null;
}

/**
 * getPhoenixSummary — lightweight summary (no full decryption).
 * Reads the unencrypted kai_signal fields only — safe for dashboard.
 */
export function getPhoenixSummary() {
  if (!fs.existsSync(PHOENIX_LOG)) return { total: 0, signals: {}, lastEvent: null };

  const records = fs.readFileSync(PHOENIX_LOG, 'utf8')
    .trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  const signals = {};
  for (const r of records) {
    signals[r.kai_signal] = (signals[r.kai_signal] || 0) + 1;
  }

  return {
    total:     records.length,
    signals,
    lastEvent: records.at(-1) ? { kai_signal: records.at(-1).kai_signal, ts: records.at(-1).ts } : null
  };
}

// ─── CLI smoke test ────────────────────────────────────────────────────────
if (process.argv[2] === '--test') {
  console.log('[Phoenix KAI] Running smoke test...\n');

  // Encode
  const ev = { signal: 'FIRE', agent: 'kai-coder', reason: 'crash loop, initiating RECOVER sequence', energy: 0.3 };
  const encoded = encodeSignal(ev);
  console.log('Encoded signal:', encoded);

  // Write encrypted
  writePhoenixEvent(ev);
  console.log('\nWrote encrypted event to', PHOENIX_LOG);

  // Read back
  const events = readPhoenixLog({ signal: 'FIRE' });
  console.log('\nDecrypted events:', events);

  // Summary (no decryption)
  const summary = getPhoenixSummary();
  console.log('\nSummary:', summary);
}

console.log('[Phoenix Encrypted KAI] Module loaded — AES-256-GCM + KAI resonance encoding active');
console.log('[Phoenix Encrypted KAI] Run with --test to verify encrypt/decrypt cycle');
