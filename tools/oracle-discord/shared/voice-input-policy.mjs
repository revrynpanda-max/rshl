/**
 * Fleet voice-input policy — pure, no I/O, no Discord imports.
 * Leo is the sole mic/STT agent; social/work bots are text (+ radio output only).
 */

const MIC_AGENTS = new Set(['Leo']);
const RADIO_OUTPUT_AGENTS = new Set(['Groq']);

export function allowsMicCapture(botName) {
  return MIC_AGENTS.has(String(botName || '').trim());
}

export function isRadioOutputAgent(botName) {
  return RADIO_OUTPUT_AGENTS.has(String(botName || '').trim());
}

/** Log tag for voice-channel connect lines — Leo=Voice, Groq=RadioOut (no mic ears). */
export function voiceChannelLogTag(botName) {
  return allowsMicCapture(botName) ? 'Voice' : 'RadioOut';
}

/** Essentials placement: only Groq proactively anchors social room for TTS/radio output. */
export function shouldProactiveRadioAnchor(botName) {
  return isRadioOutputAgent(botName);
}

export function shouldAttachSpeakingListener(botName) {
  return allowsMicCapture(botName);
}

/** Social bots must not hold idle Gemini Live sockets (Leo owns mic + Live in leo.mjs). */
export function allowsSocialGeminiLiveSession(botName) {
  const name = String(botName || '').trim();
  if (allowsMicCapture(name)) return false;
  return process.env.KAI_SOCIAL_GEMINI_LIVE === '1' &&
    ['Gemini', 'Claudey', 'Groq', 'X'].includes(name);
}