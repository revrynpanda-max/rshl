/**
 * gemini-live-voice.mjs
 *
 * Gemini Live native audio for social bots (Gemini, Claudey, Groq, X).
 * Text brain stays on cloud/local LLM via openjarvis; this module handles
 * OUTBOUND voice rendering through Gemini 2.5 Flash Native Audio — same
 * engine Leo uses. Falls back to speakTTS (Kokoro/edge-tts) if the Live
 * session or API key is unavailable.
 */

import { PassThrough } from 'stream';
import { createAudioResource, StreamType, AudioPlayerStatus } from '@discordjs/voice';
import {
  GeminiLiveSessionManager,
  GeminiLiveBridge,
  resolveGeminiVoice,
} from './gemini-live-bridge.mjs';
import { BIOGRAPHIES } from './biographies.mjs';
import { CHANNEL_IDS } from './channel-rules.mjs';
import {
  acquireVoiceLock,
  releaseVoiceLock,
  isSomeoneSpeaking,
  enqueueVoice,
  dequeueVoice,
  isMyVoiceTurn,
  getBotPlayer,
  isHumanInVoiceChannel,
  speakTTS,
} from './tts-engine.mjs';
import { allowsSocialGeminiLiveSession } from './voice-input-policy.mjs';

export const NATIVE_LIVE_BOTS = new Set(['Gemini', 'Claudey', 'Groq', 'X']);

const manager = new GeminiLiveSessionManager();
const sessions = new Map(); // botName → GeminiLiveBridge

export function hasNativeLiveKey(botName) {
  const slug = botName.toUpperCase().replace(/[\s-]+/g, '_');
  return !!(process.env[`GEMINI_API_KEY_${slug}`] || process.env.GEMINI_API_KEY);
}

function buildSocialLivePrompt(botName) {
  const bio = BIOGRAPHIES[botName] || {};
  return `You are ${botName}, a member of the KAI ecosystem voice channel family.
Background: ${bio.background || ''}
Tone: ${bio.tone || 'casual and natural'}

[YOUR JOB — VOICE RENDERING ONLY]
- You receive [SPEAK OUT LOUD] lines to say in your unique Gemini voice. Speak them naturally in first person as ${botName}. No intros, no "here's what I'll say", no speaker tags, no sign-offs.
- You receive [CONTEXT ONLY] lines to LISTEN to. Absorb them silently. Do NOT speak. Do NOT reply out loud.
- You receive [Context: X is speaking] when someone else has the floor. Stay silent.

[CONVERSATION AWARENESS — without nagging for names]
- Context injections tell you who said what and the flow of the room — including HUMANS whose voice is mirrored into chat (their name appears as a webhook post, treat them as real people).
- You can tell who a reply is directed at from conversation direction — you do NOT need everyone to say your name.
- Use someone's name only when clarifying ("ryan, that was for you") or when multiple people are active and direction is ambiguous.
- Do NOT demand names. Do NOT stay silent waiting for your name — you only speak when you get [SPEAK OUT LOUD].
- If you heard someone leave a question honestly unanswered and YOU know the answer from context, the text brain will send you [SPEAK OUT LOUD] with the correction — speak it naturally.

[TURN-TAKING]
- Only speak when you receive [SPEAK OUT LOUD]. Never improvise chatter.
- One bot speaks at a time in the channel. Keep deliveries short and punchy like real Discord voice chat.
- Use heavy punctuation (commas, em-dashes, question marks) so your speech breathes naturally.`;
}

function resetPlaybackState(bridge) {
  bridge._liveAudioStream = null;
  bridge._prebuf = [];
  bridge._prebufBytes = 0;
  bridge._playing = false;
}

function wirePlaybackHandlers(bridge, botName) {
  bridge.onAudioChunk = (base64, mimeType) => {
    const player = getBotPlayer(botName);
    if (!player) return;

    const pcmBuffer = GeminiLiveBridge.decodeAudioChunk(base64, mimeType);
    if (!bridge._liveAudioStream) {
      bridge._liveAudioStream = new PassThrough({ highWaterMark: 1 << 22 });
      bridge._prebuf = [];
      bridge._prebufBytes = 0;
      bridge._playing = false;
    }

    if (!bridge._playing) {
      bridge._prebuf.push(pcmBuffer);
      bridge._prebufBytes += pcmBuffer.length;
      if (bridge._prebufBytes >= 57600) {
        for (const b of bridge._prebuf) bridge._liveAudioStream.write(b);
        bridge._prebuf = [];
        const resource = createAudioResource(bridge._liveAudioStream, { inputType: StreamType.Raw });
        player.play(resource);
        bridge._playing = true;
      }
    } else {
      bridge._liveAudioStream.write(pcmBuffer);
    }
  };

  bridge.onInterrupted = () => {
    resetPlaybackState(bridge);
    const player = getBotPlayer(botName);
    if (player?.state?.status !== AudioPlayerStatus.Idle) player.stop();
  };
}

export function getLiveSession(botName) {
  return sessions.get(botName) || null;
}

export async function initSocialLiveSession(botName) {
  if (!NATIVE_LIVE_BOTS.has(botName)) return null;
  if (!allowsSocialGeminiLiveSession(botName)) {
    return null;
  }
  if (!hasNativeLiveKey(botName)) {
    console.log(`[${botName}/Live] No Gemini key — local TTS fallback only.`);
    return null;
  }

  const existing = sessions.get(botName);
  if (existing?.available) return existing;

  const sessionKey = `room:${CHANNEL_IDS.VOICE}-${botName}`;
  const prompt = buildSocialLivePrompt(botName);

  try {
    // OWNER: social bots are now INTERACTIVE like Leo — the native-audio Live model
    // listens to the human's mic and replies directly (real conversation, not just
    // broadcast), and tools are ENABLED so they can act (search the lattice, etc.).
    // This path is social-bots only; Leo runs his own session in leo.mjs, untouched.
    // Override per-bot/env with KAI_SOCIAL_VOICE_MODE / KAI_SOCIAL_VOICE_TOOLS=0.
    const _socialMode  = (process.env.KAI_SOCIAL_VOICE_MODE || 'interactive');
    const _socialTools = (process.env.KAI_SOCIAL_VOICE_TOOLS !== '0');
    const bridge = await manager.getOrCreate(sessionKey, botName, prompt, `${botName} Voice`, {
      mode: _socialMode,
      enableTools: _socialTools,
    });

    if (bridge?.available) {
      wirePlaybackHandlers(bridge, botName);
      sessions.set(botName, bridge);
      console.log(`[${botName}/Live] Gemini Native Audio ready (voice: ${resolveGeminiVoice(botName)}).`);
      return bridge;
    }
  } catch (e) {
    console.warn(`[${botName}/Live] Session init failed: ${e.message}`);
  }

  sessions.delete(botName);
  return null;
}

export function injectFleetContext(botName, speakerName, content) {
  const bridge = sessions.get(botName);
  if (!bridge?.available) return;
  const snippet = String(content || '').slice(0, 220);
  if (!snippet) return;
  bridge.sendText(
    `[CONTEXT ONLY] ${speakerName} said: "${snippet}". (Listen for awareness. Do NOT reply out loud unless you later receive [SPEAK OUT LOUD].)`
  );
}

function waitForPlaybackEnd(bridge, botName, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const player = getBotPlayer(botName);
    let done = false;
    const startTime = Date.now();
    const finish = (reason) => {
      if (done) return;
      done = true;
      const duration = Date.now() - startTime;
      console.log(`[${botName}/Live] Playback finished (${reason}). Duration: ${duration}ms`);
      resetPlaybackState(bridge);
      resolve();
    };

    const timer = setTimeout(() => finish('timeout'), timeoutMs);

    const onTurn = () => {
      console.log(`[${botName}/Live] onTurnComplete triggered. Playing=${bridge._playing}, PrebufLength=${bridge._prebuf?.length}`);
      
      if (bridge._liveAudioStream && !bridge._playing && bridge._prebuf?.length) {
        for (const b of bridge._prebuf) bridge._liveAudioStream.write(b);
        bridge._prebuf = [];
        const resource = createAudioResource(bridge._liveAudioStream, { inputType: StreamType.Raw });
        if (!player) {
           console.warn(`[${botName}/Live] Cannot play: player is null! (Voice connection missing?)`);
        } else {
           player.play(resource);
           bridge._playing = true;
        }
      }
      
      // End the stream so Discord player knows no more chunks are coming
      if (bridge._liveAudioStream) {
        bridge._liveAudioStream.end();
      }

      // Give player.play() a moment to transition from Idle -> Buffering
      setTimeout(() => {
        const status = player?.state?.status;
        console.log(`[${botName}/Live] Player status after 50ms: ${status || 'no-player'}`);
        if (status === AudioPlayerStatus.Playing || status === AudioPlayerStatus.Buffering) {
          player.once(AudioPlayerStatus.Idle, () => {
            clearTimeout(timer);
            setTimeout(() => finish('idle_reached'), 200);
          });
        } else {
          console.warn(`[${botName}/Live] Player never entered Playing/Buffering state! Force ending.`);
          clearTimeout(timer);
          setTimeout(() => finish('never_started'), 300);
        }
      }, 50);
    };

    bridge.onTurnComplete = onTurn;
  });
}

/**
 * Speak text via Gemini Live native audio, falling back to local TTS on failure.
 */
export async function speakWithNativeFallback(text, botName) {
  if (!text?.trim()) return;
  if (!NATIVE_LIVE_BOTS.has(botName)) {
    await speakTTS(text, botName);
    return;
  }

  // THIS bot must actually BE in a voice channel (have a player) to speak out
  // loud. The text-only social bots (Gemini, Claudey, X) never join voice, so
  // without this they ran the whole floor-acquire -> generate -> "Player never
  // entered" -> release cycle for NOTHING (phantom voice) every time a human was
  // in some OTHER voice channel. No player => text only, no floor, no phantom voice.
  if (!getBotPlayer(botName)) {
    console.log(`[${botName}/Live] Not in a voice channel (no player) — text only, skipping voice broadcast + floor.`);
    return;
  }
  if (!(await isHumanInVoiceChannel())) {
    console.log(`[${botName}/Live] No human in voice — text only.`);
    return;
  }

  let bridge = sessions.get(botName);
  if (!bridge?.available) {
    bridge = await initSocialLiveSession(botName);
  }
  if (!bridge?.available) {
    console.log(`[${botName}/Live] Session unavailable — falling back to local TTS.`);
    await speakTTS(text, botName);
    return;
  }

  // Human speaking gate
  try {
    const { getGateState, waitForGateClear } = await import('./voice-gate.mjs');
    const gate = getGateState();
    if (gate.speaking) {
      console.log(`[${botName}/Live] Human speaking — holding until gate clears...`);
      await waitForGateClear(15000);
    }
  } catch (_) {}

  const cleaned = text.replace(/\s+/g, ' ').trim();
  const myVoiceId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  enqueueVoice(botName, myVoiceId);

  let acquired = false;
  for (let i = 0; i < 300; i++) {
    if (isMyVoiceTurn(myVoiceId) && !isSomeoneSpeaking(botName) && acquireVoiceLock(botName)) {
      acquired = true;
      break;
    }
    await new Promise(r => setTimeout(r, 200));
  }

  if (!acquired) {
    console.warn(`[${botName}/Live] Voice queue timeout — falling back to local TTS.`);
    dequeueVoice(myVoiceId);
    await speakTTS(text, botName);
    return;
  }

  try {
    resetPlaybackState(bridge);
    wirePlaybackHandlers(bridge, botName);

    bridge.sendText(
      `[SPEAK OUT LOUD — ${botName}] Say this naturally in your own voice and personality. First person. No intro, no sign-off, no speaker tags: "${cleaned}"`,
      true
    );

    await waitForPlaybackEnd(bridge, botName);
    console.log(`[${botName}/Live] Native speech complete.`);
  } catch (e) {
    console.warn(`[${botName}/Live] Native speak failed (${e.message}) — falling back to local TTS.`);
    await speakTTS(text, botName);
  } finally {
    releaseVoiceLock(botName);
    dequeueVoice(myVoiceId);
  }
}
