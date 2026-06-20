/**
 * voice-gate.mjs
 *
 * Human Speaking Gate — cross-process signal system.
 *
 * When a human starts speaking in the voice channel, Leo (the only bot
 * connected to voice) writes this gate file. All other bots check this
 * file before sending voice-triggered replies. If the gate is open
 * (human is speaking), they buffer their reply and wait.
 *
 * When the human finishes, Leo clears the gate and writes their transcript.
 * Waiting bots then get the updated context and can rewrite/send.
 *
 * Uses the filesystem as the cross-process bus (same approach as social_locks).
 */

import fs from 'fs';
import { recordHumanActivity } from './presence-gate.mjs';

const GATE_PATH = 'c:/KAI/tools/oracle-discord/state/voice_gate.json';
const SHORT_REAL_UTTERANCES = new Set([
  'yes', 'yeah', 'yep', 'no', 'nope', 'stop', 'wait', 'okay', 'ok', 'go'
]);

const NOISE_TRANSCRIPTS = new Set([
  'you', 'um', 'uh', 'hmm', 'mm', 'mmm', 'oh', 'ah', 'the', 'a',
  'bye', 'thanks', 'thank you', '[music]', '[applause]', '[laughter]',
  '(music)', '(sound)', '...'
]);

function normalizeTranscript(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\s'[\]()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyHumanWords(transcript) {
  const normalized = normalizeTranscript(transcript);
  if (!normalized) return false;
  if (NOISE_TRANSCRIPTS.has(normalized)) return false;
  if (SHORT_REAL_UTTERANCES.has(normalized)) return true;

  const words = normalized
    .split(/\s+/)
    .filter(w => /[a-z0-9]/i.test(w) && w.replace(/[^a-z0-9]/gi, '').length > 1);

  if (words.length < 2) return false;
  if (normalized.length < 8) return false;
  return true;
}
const GATE_STALE_MS = 30000; // 30s — if Leo crashes mid-speech, auto-clear

/**
 * Leo calls this when a human starts speaking in voice.
 */
export function setHumanSpeaking(speakerId, speakerName) {
  // PRESENCE: talking in voice counts as human activity — keeps the social
  // fleet awake and chatty while you're in a voice channel, not just text.
  try { recordHumanActivity(); } catch (_) {}
  try {
    fs.mkdirSync('c:/KAI/tools/oracle-discord/state', { recursive: true });
    fs.writeFileSync(GATE_PATH, JSON.stringify({
      humanSpeaking: true,
      speakerId,
      speakerName,
      startedAt: Date.now()
    }));
    console.log(`[VoiceGate] 🔴 GATE OPEN — ${speakerName} is speaking`);
  } catch (e) {
    console.warn('[VoiceGate] Failed to write gate:', e.message);
  }
}

/**
 * Leo calls this when the human finishes speaking.
 * Optionally includes the transcript so waiting bots can update their replies.
 */
export function clearHumanSpeaking(transcript = null, speakerName = null) {
  let cleanTranscript = transcript;
  if (transcript && !isLikelyHumanWords(transcript)) {
    console.log(`[VoiceGate] Ignoring noisy/non-word transcript "${String(transcript).slice(0, 40)}".`);
    cleanTranscript = null;
  }

  try {
    fs.writeFileSync(GATE_PATH, JSON.stringify({
      humanSpeaking: false,
      lastHumanTranscript: cleanTranscript || null,
      speakerName: speakerName || null,
      clearedAt: Date.now()
    }));
    console.log(`[VoiceGate] 🟢 GATE CLEAR${cleanTranscript ? ` — transcript ready (${cleanTranscript.length} chars)` : ' (no valid transcript)'}`);
  } catch (e) {
    console.warn('[VoiceGate] Failed to clear gate:', e.message);
  }
}

/**
 * All bots call this before sending a voice-triggered reply.
 * Returns: { speaking: bool, speakerName: string|null, transcript: string|null }
 */
export function getGateState() {
  try {
    if (!fs.existsSync(GATE_PATH)) return { speaking: false, speakerName: null, transcript: null };
    const raw = JSON.parse(fs.readFileSync(GATE_PATH, 'utf8'));

    // Auto-clear stale gate (protects against Leo crash mid-speech)
    if (raw.humanSpeaking && (Date.now() - raw.startedAt) > GATE_STALE_MS) {
      console.warn('[VoiceGate] Gate stale — auto-clearing');
      fs.unlinkSync(GATE_PATH);
      return { speaking: false, speakerName: null, transcript: null };
    }

    return {
      speaking: raw.humanSpeaking === true,
      speakerName: raw.speakerName || null,
      transcript: raw.lastHumanTranscript || null
    };
  } catch {
    return { speaking: false, speakerName: null, transcript: null };
  }
}

/**
 * Polls until the gate clears, then returns the human's transcript.
 * Used by bots that have a buffered reply and are waiting for context.
 * @param {number} maxWaitMs - Max time to wait before giving up (default 12s)
 * @returns {Promise<string|null>} The human's transcript, or null if timed out
 */
export async function waitForGateClear(maxWaitMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const state = getGateState();
    if (!state.speaking) return state.transcript;
    await new Promise(r => setTimeout(r, 300)); // Poll every 300ms
  }
  console.warn('[VoiceGate] waitForGateClear timed out — sending original reply');
  return null;
}
