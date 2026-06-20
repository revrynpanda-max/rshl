/**
 * gemini-tts.mjs — DEDICATED Gemini Text-to-Speech for VERBATIM reading.
 *
 * Why this exists (and is NOT the Live API):
 *   Leo's normal conversation uses the bidirectional Gemini LIVE API (native-audio
 *   "Charon"). The Live model is a CONVERSATIONALIST — for long verbatim reading it
 *   paraphrases/invents, fires phantom VAD interrupts that truncate sections, hits a
 *   ~10-minute session limit (GoAway / 1008 / 1007), and repeats lines at the seams.
 *
 *   Google's guidance: for EXACT, deterministic text→audio (an audiobook), use the
 *   dedicated TTS endpoint, not Live. This module does exactly that: one HTTP request
 *   per section, the EXACT text in → PCM audio out, in the SAME voice Leo uses on Live
 *   ("Charon") so it still sounds like Leo.
 *
 * Endpoint (REST, generateContent on a *-tts model):
 *   POST https://generativelanguage.googleapis.com/v1beta/models/<MODEL>:generateContent?key=<KEY>
 *   body.generationConfig.responseModalities = ["AUDIO"]
 *   body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName = "Charon"
 *   body.contents = [{ parts: [{ text: <section text> }] }]
 *
 * Response (success): candidates[0].content.parts[0].inlineData.data = base64 PCM,
 *   24kHz, 16-bit, signed little-endian, MONO. (mimeType like "audio/L16;rate=24000".)
 *
 * Returns a Node Buffer of RAW PCM (s16le, 24kHz, mono) — the caller resamples to
 * Discord's 48k stereo (we feed it through ffmpeg in leo.mjs). On ANY failure this
 * returns null with a clear console message; it never throws into the voice loop.
 */

const TTS_ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** PCM format Gemini TTS emits — the caller needs these to wrap/resample correctly. */
export const TTS_PCM = Object.freeze({ sampleRate: 24000, channels: 1, bitDepth: 16 });

/**
 * PACING: Gemini FREE tier throttles at 15 requests/minute. A ~94-section read
 * fired back-to-back slams that limit → 429 storm. Space calls ~4000ms apart
 * (≈15/min) so a long read stays under the ceiling. Override with LEO_TTS_PACE_MS.
 * Caller usage:  await ttsPace();  before each synthesizeSpeech() call.
 */
export const TTS_PACE_MS = Number(process.env.LEO_TTS_PACE_MS) > 0
  ? Number(process.env.LEO_TTS_PACE_MS) : 4000;
let _lastTtsCallAt = 0;
/** Await this BEFORE each synthesizeSpeech() to keep the read under 15 RPM. */
export async function ttsPace(minGapMs = TTS_PACE_MS) {
  const now = Date.now();
  const wait = Math.max(0, _lastTtsCallAt + minGapMs - now);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastTtsCallAt = Date.now();
}
const _sleep = (ms) => new Promise(r => setTimeout(r, ms));
/** 429 backoff before a single same-model retry. Override with LEO_TTS_BACKOFF_MS. */
const TTS_BACKOFF_MS = Number(process.env.LEO_TTS_BACKOFF_MS) > 0
  ? Number(process.env.LEO_TTS_BACKOFF_MS) : 30000;

/**
 * Synthesize ONE block of text to speech with the dedicated Gemini TTS API.
 *
 * @param {string} text  The EXACT words to speak (verbatim — TTS reads them as given).
 * @param {object} opts
 * @param {string} [opts.voice='Charon']  Prebuilt voice name (same as Leo's Live voice).
 * @param {string} [opts.model]           TTS model id; defaults to LEO_TTS_MODEL or the flash preview.
 * @param {string} [opts.apiKey]          Gemini API key (Leo's). Falls back to env if omitted.
 * @param {number} [opts.timeoutMs=45000] Per-request timeout.
 * @returns {Promise<Buffer|null>}        Raw PCM (s16le 24kHz mono) or null on failure.
 */
export async function synthesizeSpeech(text, {
  voice = 'Charon',
  model = process.env.LEO_TTS_MODEL || 'gemini-2.5-flash-preview-tts',
  apiKey,
  timeoutMs = 45000,
  style,
} = {}) {
  const raw = String(text || '').trim();
  if (!raw) { console.warn('[Leo/TTS] synthesizeSpeech called with empty text — skipped.'); return null; }
  // STYLE: Gemini TTS speaks the supplied text, but a natural-language LEAD INSTRUCTION
  // controls accent / tone / pacing (it is interpreted as direction, NOT read aloud).
  // This is what turns the flat default voice into LEO — a warm, streetwise South-London
  // man narrating like an audiobook, instead of the generic "eww" default. Override per
  // call with opts.style, or globally with the LEO_TTS_STYLE env var.
  const styleLead = style || process.env.LEO_TTS_STYLE ||
    'Read the following aloud in the warm, streetwise voice of a South-London British man narrating an audiobook with real feeling — natural, expressive, and unhurried, speaking it exactly word for word';
  const clean = `${styleLead}:\n\n${raw}`;

  const key = apiKey
    || process.env.LEO_GEMINI_KEY
    || process.env.GEMINI_API_KEY_LEO
    || process.env.GEMINI_API_KEY;
  if (!key) { console.error('[Leo/TTS] No Gemini API key (LEO_GEMINI_KEY / GEMINI_API_KEY_LEO / GEMINI_API_KEY) — cannot synthesize.'); return null; }

  const body = {
    contents: [{ parts: [{ text: clean }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voice },
        },
      },
    },
  };

  // ROBUST MODEL FALLBACK: try the requested model, then known-good Gemini TTS models.
  // PRIMARY is gemini-2.5-flash-preview-tts (PROVEN working on Leo's key). The bare
  // gemini-3.1-flash-tts was REMOVED (always 404s — no -preview suffix). A 3.1 option is
  // only the -preview id AND only AFTER the working 2.5 model. The 2.5-pro-preview-tts
  // model is DELIBERATELY EXCLUDED from the reading chain — its 50/day cap kills mid-book.
  const candidates = [model, 'gemini-2.5-flash-preview-tts', 'gemini-3.1-flash-tts-preview']
    .filter((m, i, a) => m && a.indexOf(m) === i);

  for (const m of candidates) {
    // 429 handling: a long read must NOT cascade through every model on a rate-limit.
    // Pause (backoff), retry the SAME model once, and if STILL 429, STOP gracefully
    // (return null) so the caller halts the read instead of firing 94×3 requests.
    let retriedFor429 = false;
    const url = `${TTS_ENDPOINT_BASE}/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(key)}`;
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      console.error(`[Leo/TTS] Request failed on model "${m}": ${e?.message || e} — trying next.`);
      continue;
    }
    if (res.status === 429) {
      if (!retriedFor429) {
        // First 429 on this model: back off, then retry the SAME model ONCE.
        retriedFor429 = true;
        console.warn(`[Leo/TTS] HTTP 429 (rate limit) on "${m}" — pausing ${TTS_BACKOFF_MS}ms then retrying SAME model once.`);
        await _sleep(TTS_BACKOFF_MS);
        _lastTtsCallAt = Date.now(); // reset pacing clock after the long backoff
        // Re-run the SAME model by reprocessing this candidate.
        // (achieved by re-entering the loop body via a manual retry below)
        let res2;
        try {
          res2 = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (e) {
          console.error(`[Leo/TTS] Retry request failed on "${m}": ${e?.message || e} — STOPPING read.`);
          return null;
        }
        if (res2.status === 429) {
          console.error('[Leo/TTS] STILL 429 after backoff+retry — STOPPING read gracefully (returning null). Caller should halt and resume later (quota / 15 RPM).');
          return null;
        }
        res = res2; // retry succeeded (or returned a different status) — fall through
      } else {
        console.error('[Leo/TTS] Repeated 429 — STOPPING read gracefully (returning null).');
        return null;
      }
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch (_) {}
      console.error(`[Leo/TTS] HTTP ${res.status} on model "${m}" — trying next. ${detail}`);
      continue;
    }
    let json;
    try { json = await res.json(); } catch (e) {
      console.error(`[Leo/TTS] JSON parse failed on "${m}": ${e?.message || e} — trying next.`);
      continue;
    }
    const parts = json?.candidates?.[0]?.content?.parts;
    const inline = Array.isArray(parts) ? (parts.find(p => p?.inlineData?.data)?.inlineData || null) : null;
    if (!inline?.data) {
      const finish = json?.candidates?.[0]?.finishReason || '';
      const promptBlock = json?.promptFeedback?.blockReason || '';
      console.error(`[Leo/TTS] No audio from "${m}" (finishReason="${finish}" block="${promptBlock}") — trying next.`);
      continue;
    }
    let pcm;
    try { pcm = Buffer.from(inline.data, 'base64'); } catch (e) {
      console.error(`[Leo/TTS] base64 decode failed on "${m}": ${e?.message || e} — trying next.`);
      continue;
    }
    if (pcm && pcm.length >= 2) {
      if (m !== model) console.warn(`[Leo/TTS] Requested model "${model}" unavailable — using working fallback "${m}".`);
      return pcm;
    }
  }
  console.error('[Leo/TTS] All TTS models failed — no audio (check your key has a TTS model enabled). LEO_TTS_READING=0 reverts to the Live reader.');
  return null;
}
