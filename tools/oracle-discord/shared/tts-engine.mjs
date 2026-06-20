import { spawn } from 'child_process';
import { recordMetric } from './metrics-store.mjs';
import { Readable } from 'stream';
import fs from 'fs';
import ffmpegPath from 'ffmpeg-static';
import { createAudioResource, StreamType, AudioPlayerStatus, createAudioPlayer, joinVoiceChannel, EndBehaviorType, entersState, VoiceConnectionStatus, getVoiceConnection } from '@discordjs/voice';
import prism from 'prism-media';
import { pipeline } from 'stream/promises';
import { VOICE_PROFILES } from './voice-profiles.mjs';
import { CHANNEL_IDS } from './channel-rules.mjs';

import dotenv from 'dotenv';
dotenv.config({ path: 'c:/KAI/tools/oracle-discord/.env', override: false });

const ELEVEN_LABS_KEY = null; // ElevenLabs subscription inactive — using Kokoro/edge-tts
console.log(`[TTS/Init] ElevenLabs disabled; using Kokoro/edge-tts fallback.`);
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const RADIO_CHANNEL_ID = CHANNEL_IDS.VOICE; // Use the shared VOICE channel registry
const voiceFailureCounts = new Map();

const OPENAI_VOICES = {
  "Gemini": "coral",
  "Claudey": "shimmer",
  "X": "echo",
  "KAI": "onyx",
  "Leo": "echo",
  "Groq": "onyx",
  "Analyst": "alloy",
  "Researcher": "alloy",
  "Kai Coder": "onyx"
};

const EDGE_VOICES = {
  "Gemini": "en-US-AvaMultilingualNeural",
  "Claudey": "en-GB-SoniaNeural",
  "X": "en-US-BrianNeural",
  "KAI": "en-US-ChristopherNeural",
  "Leo": "en-US-GuyNeural",
  "Groq": "en-US-EricNeural",
  "Analyst": "en-US-SteffanNeural",
  "Researcher": "en-US-EricNeural",
  "Kai Coder": "en-US-SteffanNeural",
  "Oracle": "en-US-ChristopherNeural"
};

const ttsQueue = [];
let isProcessingQueue = false;
let cachedClient = null;

export function setCachedClient(client) {
  if (client) cachedClient = client;
}

// ── HUMAN-IN-VOICE GATE ─────────────────────────────────────────────────────
// TTS generation (Kokoro on GPU) is the single biggest spike source. If no
// human is sitting in the voice channel, nobody hears the audio anyway —
// so skip generation entirely. Cached for 15s to avoid hammering Discord.
// Override with KAI_TTS_ALWAYS=1 to restore old always-on behavior.
// ── GPU GENERATION LOCK (cross-process) ─────────────────────────────────────
// Only ONE Kokoro TTS generation runs at a time across the whole fleet.
// Playback is already serialized (one voice at a time), so serializing
// generation adds almost no latency but turns simultaneous GPU spikes
// into a smooth, steady single-job queue.
const GEN_LOCK_PATH = 'c:/KAI/tools/oracle-discord/state/tts_gen.lock';
const GEN_LOCK_STALE_MS = 90_000;
async function acquireGenLock(botName, maxWaitMs = 45_000) {
  const start = Date.now();
  while (true) {
    try {
      const st = fs.statSync(GEN_LOCK_PATH);
      if (Date.now() - st.mtimeMs > GEN_LOCK_STALE_MS) {
        try { fs.unlinkSync(GEN_LOCK_PATH); } catch (_) {}
      }
    } catch (_) {}
    try {
      fs.writeFileSync(GEN_LOCK_PATH, JSON.stringify({ botName, at: Date.now() }), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return true; // fs trouble — don't block speech
      if (Date.now() - start > maxWaitMs) return false;
      await new Promise(r => setTimeout(r, 400));
    }
  }
}
function releaseGenLock(botName) {
  try {
    const data = JSON.parse(fs.readFileSync(GEN_LOCK_PATH, 'utf8'));
    if (data.botName === botName) fs.unlinkSync(GEN_LOCK_PATH);
  } catch (_) {}
}

let humanVoiceCache = { value: false, at: 0 };
export async function isHumanInVoiceChannel() {
  if (process.env.KAI_TTS_ALWAYS === '1') return true;
  const now = Date.now();
  if (now - humanVoiceCache.at < 15000) return humanVoiceCache.value;
  humanVoiceCache.at = now;
  try {
    // Scan EVERY voice channel in every guild the bot can see (covers the
    // radio channel, Leo's voice channel, and anything else) for a human.
    let hasHuman = false;
    for (const guild of cachedClient?.guilds?.cache?.values?.() || []) {
      for (const channel of guild.channels.cache.values()) {
        if (typeof channel.isVoiceBased === 'function' && channel.isVoiceBased()) {
          if (channel.members?.some?.(m => !m.user?.bot)) { hasHuman = true; break; }
        }
      }
      if (hasHuman) break;
    }
    humanVoiceCache.value = hasHuman;
    return hasHuman;
  } catch (_) {
    humanVoiceCache.value = false;
    return false;
  }
}

async function processTTSQueue() {
  if (isProcessingQueue || ttsQueue.length === 0) return;
  isProcessingQueue = true;
  
  while (ttsQueue.length > 0) {
    const { text, botName, resolve } = ttsQueue.shift();
    await performOpenAITTS(text, botName);
    // Wait 200ms between requests for snappier social interaction
    await new Promise(r => setTimeout(r, 200));
  }
  
  isProcessingQueue = false;
}

const botPlayers = new Map();
const botConnections = new Map();

export function getBotPlayer(botName) {
  return botPlayers.get(botName) || null;
}
const ttsTokens = new Map(); // name -> timestamp (for interruption logic)

const QUEUE_DIR = 'c:/KAI/tools/oracle-discord/state/voice_queue';

function initQueueDir() {
  if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true });
}

export function enqueueVoice(botName, id, isInterrupt = false) {
  initQueueDir();
  const now = Date.now();
  
  // Garbage collect tickets > 3 mins old
  try {
    const files = fs.readdirSync(QUEUE_DIR);
    for (const f of files) {
        const parts = f.split('_');
        if (parts.length >= 2) {
          let time = parseInt(parts[0]);
          if (time === 0) {
            // It's an interrupt ticket. The actual timestamp is in the second part.
            time = parseInt(parts[1].substring(0, 13));
          }
          if (now - time > 180000) {
            try { fs.unlinkSync(`${QUEUE_DIR}/${f}`); } catch(e) {}
          }
        }
    }
  } catch(e) {}

  const prefix = isInterrupt ? "0000000000000" : now.toString();
  const file = `${QUEUE_DIR}/${prefix}_${id}.ticket`;
  try { fs.writeFileSync(file, botName); } catch(e) {}
}

export function dequeueVoice(id) {
  initQueueDir();
  try {
    const files = fs.readdirSync(QUEUE_DIR);
    for (const f of files) {
      if (f.includes(`_${id}.ticket`)) {
        try { fs.unlinkSync(`${QUEUE_DIR}/${f}`); } catch (e) {}
      }
    }
  } catch(e) {}
}

export function isMyVoiceTurn(id) {
  initQueueDir();
  try {
    const files = fs.readdirSync(QUEUE_DIR).sort();
    if (files.length === 0) return true;
    return files[0].includes(`_${id}.ticket`);
  } catch(e) { return true; }
}

const LOCK_FILE = 'c:/KAI/tools/oracle-discord/state/voice_lock.flag';

export function isSomeoneSpeaking(selfBotName = null) {
  // 1. Check local players first
  for (const [name, player] of botPlayers.entries()) {
    if (name === selfBotName) continue;
    if (player.state.status === AudioPlayerStatus.Playing || player.state.status === AudioPlayerStatus.Buffering) return true;
  }
  // 2. Check Global Lock File (Cross-Process)
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const data = fs.readFileSync(LOCK_FILE, 'utf8');
      const [name, time] = data.split('|');
      if (name === selfBotName) return false;
      if (Date.now() - parseInt(time) < 30000) return true; // Increase to 30s
    }
  } catch {}
  return false;
}

export function acquireVoiceLock(botName) {
  try {
    // 0. Same-Bot Exception: If WE already hold the lock, just update the time
    if (fs.existsSync(LOCK_FILE)) {
      const data = fs.readFileSync(LOCK_FILE, 'utf8');
      if (data.startsWith(botName)) {
        fs.writeFileSync(LOCK_FILE, `${botName}|${Date.now()}`);
        return true;
      }
    }

    // ATOMIC LOCK: Try to create file with 'wx' (exclusive) flag
    fs.writeFileSync(LOCK_FILE, `${botName}|${Date.now()}`, { flag: 'wx' });
    console.log(`[${botName}/Lock] 🗝️ Floor acquired.`);
    return true;
  } catch (e) {
    // If it exists, check if it's stale (older than 30s)
    try {
      const data = fs.readFileSync(LOCK_FILE, 'utf8');
      const [name, time] = data.split('|');
      if (Date.now() - parseInt(time) > 120000) {
        fs.unlinkSync(LOCK_FILE);
        return acquireVoiceLock(botName); 
      }
    } catch {}
    return false;
  }
}

export function releaseVoiceLock(botName) {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const data = fs.readFileSync(LOCK_FILE, 'utf8');
      if (data.startsWith(botName)) {
        fs.unlinkSync(LOCK_FILE);
        console.log(`[${botName}/Lock] 🔓 Floor released.`);
      }
    }
  } catch {}
}

/**
 * Ensures the bot is connected to the radio voice channel and has an audio player.
 */
export async function ensureVoiceConnection(client, botName, targetChannelId = null) {
  if (client) cachedClient = client;
  const activeClient = client || cachedClient;

  // All bots are now full social residents and can join the voice channel

  try {
    const guild = activeClient.guilds.cache.first();
    if (!guild) return false;

    let connection = botConnections.get(botName);
    let newlyConnected = false;

    if (!connection || connection.state.status === VoiceConnectionStatus.Disconnected) {
      const channelToJoin = targetChannelId || RADIO_CHANNEL_ID;
      const channel = await guild.channels.fetch(channelToJoin).catch(() => null);
      if (!channel) return false;

      console.log(`[${botName}/TTS] Re-anchoring voice connection...`);
      connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });
      newlyConnected = true;

      connection.on(VoiceConnectionStatus.Ready, () => {
        voiceFailureCounts.set(botName, 0);
      });

      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5000),
          ]);
          // Seems to be reconnecting
        } catch (e) {
          const failures = (voiceFailureCounts.get(botName) || 0) + 1;
          voiceFailureCounts.set(botName, failures);
          console.warn(`[${botName}/TTS] Connection lost (Failure ${failures}/5). Destroying and re-creating...`);
          
          if (failures >= 5) {
            console.error(`[${botName}/TTS] 🚨 CRITICAL: Infinite Voice Loop Detected. Crashing process for Ecosystem respawn.`);
            process.exit(1);
          }

          connection.destroy();
          botConnections.delete(botName);
          setTimeout(() => ensureVoiceConnection(client, botName), 2000);
        }
      });

      connection.on(VoiceConnectionStatus.Failed, () => {
        const failures = (voiceFailureCounts.get(botName) || 0) + 1;
        voiceFailureCounts.set(botName, failures);
        console.error(`[${botName}/TTS] Voice connection FAILED (Failure ${failures}/5). Re-spawning in 5s...`);
        
        if (failures >= 5) {
          console.error(`[${botName}/TTS] 🚨 CRITICAL: Infinite Voice Loop Detected. Crashing process for Ecosystem respawn.`);
          process.exit(1);
        }

        connection.destroy();
        botConnections.delete(botName);
        setTimeout(() => ensureVoiceConnection(client, botName), 5000);
      });

      const player = createAudioPlayer();
      connection.subscribe(player);
      
      botConnections.set(botName, connection);
      botPlayers.set(botName, player);

      if (botName === "Gemini") {
        setupVoiceListener(connection, client);
      }
    }
    return newlyConnected;
  } catch (e) {
    console.error(`[${botName}/TTS] Voice stability error:`, e.message);
    return false;
  }
}


export function stopTTS(botName) {
  const player = botPlayers.get(botName);
  if (player && player.state.status !== AudioPlayerStatus.Idle) {
    player.stop();
    console.log(`[${botName}/TTS] 🛑 Audio playback interrupted by another AI.`);
  }
}

/**
 * Strips code blocks, URLs, markdown formatting, and bracket tags so
 * the voice synthesizer reads purely conversational human language.
 */
export function cleanTextForTTS(text) {
  if (!text) return "";
  return text
    // 1. Remove Markdown Code Blocks (```javascript ... ```)
    .replace(/```[\s\S]*?```/g, "")
    // 2. Remove Inline Code (`...`)
    .replace(/`[\s\S]*?`/g, "")
    // 3. Remove URLs
    .replace(/https?:\/\/\S+/g, "")
    // 4. Remove Markdown formatting characters (asterisks, hashtags, tildes, underscores)
    .replace(/[*_#~]/g, "")
    // 5. Remove brackets like [Search: ...] or [Autonomic State: ...]
    .replace(/\[.*?\]/g, "")
    // 6. Replace multiple spaces/newlines with a single space
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Generates ElevenLabs TTS and plays it through the bot's AudioPlayer.
 */
export async function speakTTS(text, botName) {
  if (!text?.trim()) return;
  const cleanedText = cleanTextForTTS(text);
  if (!cleanedText) {
    console.log(`[${botName}/TTS] Text is empty after cleaning for TTS.`);
    return;
  }

  // HUMAN-IN-VOICE GATE: no human listening = no GPU spent on audio.
  if (!(await isHumanInVoiceChannel())) {
    console.log(`[${botName}/TTS] 💤 No human in voice channel — skipping TTS generation (text-only).`);
    return;
  }

  // HUMAN SPEAKING GATE: If a human is actively talking in voice right now,
  // hold TTS until they are done. Bots should NEVER talk over a human.
  try {
    const { getGateState, waitForGateClear } = await import('./voice-gate.mjs');
    const gate = getGateState();
    if (gate.speaking) {
      console.log(`[${botName}/TTS] 🔴 Human speaking — TTS on hold until gate clears...`);
      await waitForGateClear(15000); // Up to 15s — then proceed anyway
      console.log(`[${botName}/TTS] 🟢 Gate cleared — resuming TTS.`);
    }
  } catch {
    // voice-gate missing or failed to import — don't block TTS
  }

  
  return new Promise(async (resolve) => {
    // --- MASTER NARRATOR RELAY: Master handles all social voices through its OWN connection ---
    let targetPlayerName = botName;
    const IS_MASTER = process.env.IS_MASTER === "true";
    
    if (IS_MASTER) {
       // If we are the Master (KAI), we MUST use our own connection name for the player
       targetPlayerName = process.env.BOT_NAME || "KAI"; 
    }
    
    let player = botPlayers.get(targetPlayerName);
    
    if (!player) {
      // AUTO-REPAIR: Try to establish connection if player is missing
      console.log(`[${botName}/TTS] Voice player missing (Target: ${targetPlayerName}). Attempting emergency anchor...`);
      await ensureVoiceConnection(cachedClient, targetPlayerName);
      player = botPlayers.get(targetPlayerName);
      
      if (!player) {
        console.warn(`[${botName}/TTS] Emergency anchor failed. No voice player available.`);
        resolve();
        return;
      }
    }
    
    const voiceId = VOICE_PROFILES[botName] || VOICE_PROFILES["X"];
    
    // --- GLOBAL VOICE QUEUE: TAKE TICKET IMMEDIATELY ---
    // Take the ticket BEFORE generation so the voice order perfectly matches text chat order.
    const isInterrupt = /^(wait|stop|hold on|hold up|actually|whoa|hang on|excuse me)\b/i.test(cleanedText);
    const myVoiceId = Date.now().toString() + Math.random().toString();
    enqueueVoice(botName, myVoiceId, isInterrupt);

    if (isInterrupt) {
      console.log(`[${botName}/TTS] ⚡ BARGE-IN DETECTED! Interrupting current speaker!`);
      if (process.send) process.send({ type: 'INTERRUPT_TTS', botName });
    }

    // SOCIAL CUES: Signal to the ecosystem that we are speaking (Wait for Silence handles clashing)
    if (process.send) {
      process.send({ type: 'SOCIAL_STIMULUS', botName });
    }

    // --- PRE-GENERATE AUDIO BEFORE QUEUEING ---
    let pregeneratedMp3 = null;
    let usedElevenLabs = false;

    if (ELEVEN_LABS_KEY) {
      console.log(`[${botName}/TTS] Pre-generating [Voice: ${voiceId}]: "${cleanedText.slice(0, 50)}..."`);
      try {
        const res = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3&output_format=mp3_44100_128`,
          {
            method: 'POST',
            headers: { 'xi-api-key': ELEVEN_LABS_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: cleanedText,
              model_id: 'eleven_flash_v2_5',
              voice_settings: { stability: 0.40, similarity_boost: 0.80 }
            })
          }
        );
        if (res.ok) {
          pregeneratedMp3 = Buffer.from(await res.arrayBuffer());
          usedElevenLabs = true;
          recordMetric('tts-engine', 'tts_status', 200, { bot: botName, provider: 'elevenlabs' });
        } else {
          console.warn(`[${botName}/TTS] ElevenLabs failed (Status: ${res.status}). Falling back to edge-tts...`);
        }
      } catch (e) {
        console.warn(`[${botName}/TTS] ElevenLabs fetch error: ${e.message}. Falling back to edge-tts...`);
      }
    }

    const socialBots = ['Gemini', 'Claudey', 'X', 'Groq'];
    const skipKokoro = socialBots.includes(botName);

    if (!pregeneratedMp3 && !skipKokoro) {
      console.log(`[${botName}/TTS] Pre-generating via local Kokoro-TTS...`);
      // GPU LOCK: wait our turn so parallel bot replies can't stack
      // multiple Kokoro jobs on the GPU at once.
      await acquireGenLock(botName);
      const kokoroVoices = {
        "Gemini": "af_bella",
        "Claudey": "af_nicole",
        "X": "am_michael",
        "Groq": "am_onyx",
        "KAI": "am_michael",
        "Leo": "am_puck"
      };
      let voice = kokoroVoices[botName] || "af_heart";
      // Leo's fallback voice is user-selectable via Discord ("set leo's
      // fallback voice to am_onyx") — stored in state/leo_voice.json.
      if (botName === "Leo") {
        try {
          const stv = JSON.parse(fs.readFileSync('c:/KAI/tools/oracle-discord/state/leo_voice.json', 'utf8'));
          if (stv.kokoro) voice = stv.kokoro;
        } catch (_) {}
      }

      pregeneratedMp3 = await new Promise((resolveBuffer) => {
        const pythonCode = `
import sys, io, soundfile as sf
import warnings
warnings.filterwarnings('ignore')
try:
    from kokoro import KPipeline
    import numpy as np
    pipeline = KPipeline(lang_code='a')
    generator = pipeline('''${cleanedText.replace(/'/g, "\\'")}''', voice='${voice}', speed=1)
    samples = [audio for _, _, audio in generator]
    if samples:
        combined = np.concatenate(samples)
        sf.write(sys.stdout.buffer, combined, 24000, format='WAV')
        sys.stdout.buffer.flush()
except Exception as e:
    sys.exit(1)
`;
        // windowsHide stops a console window from flashing on EVERY spoken
        // line — the source of the random PowerShell/cmd popups and part of
        // the per-utterance CPU spike the user saw.
        const py = spawn('python', ['-c', pythonCode], { windowsHide: true });
        const chunks = [];
        py.stdout.on('data', d => chunks.push(d));
        py.on('close', (code) => resolveBuffer(code === 0 && chunks.length > 0 ? Buffer.concat(chunks) : null));
        py.on('error', () => resolveBuffer(null));
      });
      releaseGenLock(botName);
    }

    if (!pregeneratedMp3) {
      const fallbackVoices = {
        'Groq': 'en-US-EricNeural',
        'Claudey': 'en-GB-SoniaNeural',
        'Gemini': 'en-US-AvaNeural',
        'X': 'en-US-BrianNeural',
        'Leo': 'en-US-GuyNeural'
      };
      const voiceIdEdge = fallbackVoices[botName] || 'en-US-ChristopherNeural';
      console.log(`[${botName}/TTS] Pre-generating via edge-tts [Voice: ${voiceIdEdge}]...`);
      
      pregeneratedMp3 = await new Promise((resolveBuffer) => {
        const edge = spawn('edge-tts', ['--text', cleanedText, '--voice', voiceIdEdge], { windowsHide: true });
        const chunks = [];
        edge.stdout.on('data', d => chunks.push(d));
        edge.on('close', () => resolveBuffer(Buffer.concat(chunks)));
        edge.on('error', () => resolveBuffer(null));
      });
    }

    if (!pregeneratedMp3 || pregeneratedMp3.length === 0) {
      console.error(`[${botName}/TTS] CRITICAL: Failed to pre-generate any audio buffer.`);
      dequeueVoice(myVoiceId);
      resolve();
      return;
    }

    // --- PRE-GENERATE AUDIO BEFORE QUEUEING ---
    // The ticket is already held in the queue. Audio generation runs in background.

    const _lockWaitStart = Date.now();
    let waitCount = 0;
    let hasLock = false;
    while (waitCount < 1800) { // 180 seconds max
      if (isMyVoiceTurn(myVoiceId)) {
        if (acquireVoiceLock(botName)) {
          if (player && player.state.status !== AudioPlayerStatus.Idle) {
            await new Promise(r => setTimeout(r, 100));
            waitCount++;
            continue;
          }
          hasLock = true;
          break;
        }
      }
      await new Promise(r => setTimeout(r, 100));
      waitCount++;
    }

    if (!hasLock) {
      dequeueVoice(myVoiceId);
      recordMetric('tts-engine', 'lock_wait_timeout', 1, { bot: botName });
      console.log(`[${botName}/TTS] Lock wait timed out (180s) — yielding turn to avoid overlap.`);
      resolve();
      return;
    }
    const _lockAcquireTs = Date.now();
    // Lock acquired, and audio is generated. Time to speak.

    // Ensure we are connected
    const newlyConnected = await ensureVoiceConnection(cachedClient, botName);
    if (newlyConnected) {
      await new Promise(r => setTimeout(r, 1000));
    }
    
    player = botPlayers.get(targetPlayerName);
    if (!player) {
      console.error(`[${botName}/TTS] ERROR: No voice player configured after lock acquired.`);
      dequeueVoice(myVoiceId);
      releaseVoiceLock(botName);
      resolve();
      return;
    }

    // HUMAN PACING: Add a randomized breath delay before playback starts
    const breathDelay = 200 + Math.random() * 300;
    console.log(`[${botName}/TTS] Taking a breath for ${Math.round(breathDelay)}ms...`);
    await new Promise(r => setTimeout(r, breathDelay));

    // Check interruption one last time after breath (removed token check)

    try {
      const resource = createAudioResource(Readable.from(pregeneratedMp3), { inlineVolume: true });
      resource.volume.setVolume(usedElevenLabs ? 1.0 : 2.0);

      let safetyTimeout;

      // Register stateListener BEFORE play() to avoid race condition
      const stateListener = (oldState, newState) => {
        console.log(`[${botName}/TTS] AudioPlayer: ${oldState.status} -> ${newState.status}`);
        if (newState.status === AudioPlayerStatus.Idle) {
          clearTimeout(safetyTimeout);
          player.off('stateChange', stateListener);
          dequeueVoice(myVoiceId);
          releaseVoiceLock(botName);
          resolve();
        }
      };
      player.on('stateChange', stateListener);

      player.play(resource);
      console.log(`[${botName}/TTS] 🔊 play() called. Buffer=${pregeneratedMp3.length}b, playerState=${player.state.status}`);

      safetyTimeout = setTimeout(() => {
        console.warn(`[${botName}/TTS] Safety timeout reached — auto-releasing lock.`);
        player.off('stateChange', stateListener);
        dequeueVoice(myVoiceId);
        releaseVoiceLock(botName);
        resolve();
      }, Math.max(60000, cleanedText.length * 150));

    } catch (e) {
      console.warn(`[${botName}/TTS] Failed to speak:`, e.message);
      dequeueVoice(myVoiceId);
      releaseVoiceLock(botName);
      resolve();
    }
  });
}

/**
 * Listens to the voice channel, captures speech, transcribes it, and posts it to the text channel.
 */
function setupVoiceListener(connection, client) {
  console.log(`[Ear] Live Voice Channel listening activated.`);
  
  connection.receiver.speaking.on('start', async (userId) => {
    // Only capture from humans
    let user = client.users.cache.get(userId);
    if (!user) user = await client.users.fetch(userId).catch(() => null);
    if (!user || user.bot) return;

    console.log(`[Ear] ${user.username} started speaking...`);
    
    // Update Interaction Flag (Resource Saver Bypass)
    try {
      const flagPath = 'c:/KAI/tools/oracle-discord/state/user_interaction.flag';
      fs.writeFileSync(flagPath, Date.now().toString());
    } catch {}

    const audioStream = connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 1500, // 1.5 seconds of silence ends the capture
      },
    });

    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    
    // Pipe the raw decoded PCM audio through FFmpeg to wrap it in a proper OGG container for Whisper
    const ffmpegProcess = spawn(ffmpegPath, [
      '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
      '-f', 'ogg', '-c:a', 'libopus', 'pipe:1'
    ]);

    const chunks = [];
    ffmpegProcess.stdout.on('data', chunk => chunks.push(chunk));
    
    ffmpegProcess.stderr.on('data', () => {}); // Ignore FFmpeg warnings

    audioStream.pipe(decoder).pipe(ffmpegProcess.stdin);

    ffmpegProcess.on('close', async () => {
      console.log(`[Ear] ${user.username} stopped speaking. Processing...`);
      const buffer = Buffer.concat(chunks);
      
      // Minimum audio length filter
      if (buffer.length < 5000) return; 

      const { transcribeBuffer } = await import('./openjarvis.mjs');
      const text = await transcribeBuffer(buffer);
      if (text && text.trim().length > 2) {
        console.log(`[Ear/Transcript] ${user.username}: "${text}"`);
        
        // SILENT INGESTION: Instead of posting to Discord, inject into the ecosystem's neural memory.
        // This lets the bots "hear" the user without cluttering the chat with transcripts.
        const { ingestMessage } = await import('./transcript-memory.mjs');
        ingestMessage(user.username, user.id, `🎙️ (Voice): ${text.trim()}`, CHANNEL_IDS.SUNDAY);
        
        // Signal social bots to react to the fresh voice intent
        if (process.send) {
          process.send({ 
            type: 'VOICE_TRANSCRIPT', 
            username: user.username, 
            userId: user.id, 
            text: text.trim() 
          });
        }
      }
    });
  });
}

/**
 * OpenAI TTS Fallback with Queue
 */
async function speakOpenAITTS(text, botName) {
  ttsQueue.push({ text, botName });
  processTTSQueue();
}

async function performOpenAITTS(text, botName) {
  const cleanedText = cleanTextForTTS(text);
  if (!cleanedText) return;
  const voice = OPENAI_VOICES[botName] || "alloy";

  return new Promise(async (resolve) => {
    // GLOBAL FLOOR LOCK: acquire the same cross-bot lock speakTTS uses so the
    // OpenAI fallback never barges over another bot's audio. 60s @ 100ms polls.
    let lockWait = 0;
    let hasLock = false;
    while (lockWait < 600) {
      if (acquireVoiceLock(botName)) { hasLock = true; break; }
      await new Promise(r => setTimeout(r, 100));
      lockWait++;
    }
    if (!hasLock) {
      console.log(`[${botName}/TTS] OpenAI fallback yielded — couldn't acquire global voice lock.`);
      resolve();
      return;
    }

    try {
      // ULTRA-SNAPPY RESPONSE: 95% chance
      if (Math.random() > 0.05) {
        // Human-like Pacing: Snappier for social chat
        const msgWordCount = cleanedText.split(/\s+/).length;
        const readTimeMs = Math.min(msgWordCount * 80, 2000); // 80ms per word, max 2s
        const jitter = readTimeMs + (50 + Math.random() * 200); 
        console.log(`[${botName}/Social] Rapid interjection triggered (delay: ${Math.round(jitter)}ms)`);
        await new Promise(r => setTimeout(r, jitter));
      }

      console.log(`[${botName}/TTS] OpenAI (gpt-4o-mini-tts) [Voice: ${voice}]: "${cleanedText.slice(0, 50)}..."`);

      // --- QUEUE SYNC: Wait for previous audio to finish ---
      let waitCount = 0;
      let player = botPlayers.get(botName);
      while (waitCount < 60 && player && player.state.status !== AudioPlayerStatus.Idle) {
        await new Promise(r => setTimeout(r, 250));
        waitCount++;
      }

      const res = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4o-mini-tts",
          voice,
          input: cleanedText
        })
      });

      if (!res.ok) {
        console.error(`[${botName}/TTS] OpenAI Error ${res.status}: ${res.statusText}`);
        // FALLBACK: Removed per user request.
        releaseVoiceLock(botName);
        resolve();
        return;
      }

      const ffmpeg = spawn(ffmpegPath, [
        '-i', 'pipe:0',
        '-af', 'volume=1.0',
        '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
      ]);

      player = botPlayers.get(botName); // refresh in case ensureVoiceConnection populated it during the OpenAI await
      if (!player) { releaseVoiceLock(botName); resolve(); return; }

      const arrayBuffer = await res.arrayBuffer();
      const audioBuffer = Buffer.from(arrayBuffer);
      ffmpeg.stdin.write(audioBuffer);
      ffmpeg.stdin.end();

      const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
      player.play(resource);

      // Safety Timeout
      const safetyTimeout = setTimeout(() => {
        console.warn(`[${botName}/TTS] Safety timeout reached (OpenAI) — auto-releasing lock.`);
        releaseVoiceLock(botName);
        resolve();
      }, Math.max(15000, cleanedText.length * 80));

      // Release the global voice lock when this playback finishes, mirroring
      // what speakTTS does for the ElevenLabs path.
      player.once(AudioPlayerStatus.Idle, () => {
        clearTimeout(safetyTimeout);
        
        // Conversational breath pause before releasing lock and resolving
        const breathPause = 200 + Math.random() * 100;
        setTimeout(() => {
          releaseVoiceLock(botName);
          resolve();
        }, breathPause);
      });

    } catch (err) {
      releaseVoiceLock(botName);
      console.error(`[${botName}/TTS] OpenAI Fallback failed:`, err.message);
      resolve();
    }
  });
}





/**
 * Local Kokoro-TTS Fallback (Premium Local / Lightweight)
 */
async function speakLocalKokoro(text, botName) {
  const cleanedText = cleanTextForTTS(text);
  if (!cleanedText) return;
  
  const socialBots = ['Gemini', 'Claudey', 'X', 'Groq'];
  if (socialBots.includes(botName)) {
      // Force edge-tts for social bots to prevent GPU slamming
      return new Promise(async (resolve) => {
        let waitCount = 0;
        while (waitCount < 300) {
          if (!isSomeoneSpeaking(botName) && acquireVoiceLock(botName)) break;
          await new Promise(r => setTimeout(r, 200));
        }
        const fallbackVoices = {
          'Groq': 'en-US-EricNeural',
          'Claudey': 'en-GB-SoniaNeural',
          'Gemini': 'en-US-AvaNeural',
          'X': 'en-US-BrianNeural',
          'Leo': 'en-US-GuyNeural'
        };
        const voiceIdEdge = fallbackVoices[botName] || 'en-US-ChristopherNeural';
        console.log(`[${botName}/TTS] Cloud Fallback (edge-tts): "${cleanedText.slice(0, 50)}..."`);
        
        try {
          const edge = spawn('edge-tts', ['--text', cleanedText, '--voice', voiceIdEdge], { windowsHide: true });
          const ffmpegArgs = ['-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'];
          const ffmpeg = spawn('ffmpeg', ffmpegArgs, { windowsHide: true });
          
          edge.stdout.pipe(ffmpeg.stdin);
          
          const player = botPlayers.get(botName);
          if (!player) {
            releaseVoiceLock(botName);
            resolve();
            return;
          }
          
          const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
          player.play(resource);
          
          player.once(AudioPlayerStatus.Idle, () => {
            setTimeout(() => { releaseVoiceLock(botName); resolve(); }, 300);
          });
          
          edge.on('error', () => { releaseVoiceLock(botName); resolve(); });
          ffmpeg.on('error', () => { releaseVoiceLock(botName); resolve(); });
        } catch (e) {
          releaseVoiceLock(botName);
          resolve();
        }
      });
  }

  return new Promise(async (resolve) => {
    // --- GLOBAL VOICE QUEUE: Wait for silence ---
    // (jitter sleep removed; lock layer handles serialization)
    let waitCount = 0;
    while (waitCount < 300) {  // 60s @ 200ms polls
      if (!isSomeoneSpeaking(botName) && acquireVoiceLock(botName)) break;
      await new Promise(r => setTimeout(r, 200));
      waitCount++;
    }

    if (waitCount >= 300) {
      console.warn(`[${botName}/TTS] Global voice lock timeout. Bypassing lock for local Kokoro.`);
      acquireVoiceLock(botName, true); 
    }

    try {
      console.log(`[${botName}/TTS] LOCAL Fallback (Kokoro): "${cleanedText.slice(0, 50)}..."`);
      
      // Select a matching Kokoro voice
      const kokoroVoices = {
        "Gemini": "af_bella",
        "Claudey": "af_nicole",
        "X": "am_michael",
        "Groq": "am_onyx",
        "KAI": "am_michael",
        "Leo": "am_puck"
      };
      let voice = kokoroVoices[botName] || "af_heart";
      // Leo's fallback voice is user-selectable via Discord ("set leo's
      // fallback voice to am_onyx") — stored in state/leo_voice.json.
      if (botName === "Leo") {
        try {
          const stv = JSON.parse(fs.readFileSync('c:/KAI/tools/oracle-discord/state/leo_voice.json', 'utf8'));
          if (stv.kokoro) voice = stv.kokoro;
        } catch (_) {}
      }

      // Simple Python bridge to the Kokoro library
      const pythonCode = `
import sys, io, soundfile as sf
try:
    from kokoro import KPipeline
    import numpy as np
    pipeline = KPipeline(lang_code='a')
    generator = pipeline('''${cleanedText.replace(/'/g, "\\'")}''', voice='${voice}', speed=1)
    samples = [audio for _, _, audio in generator]
    if samples:
        combined = np.concatenate(samples)
        sf.write(sys.stdout.buffer, combined, 24000, format='WAV')
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
`;

      const ffmpeg = spawn(ffmpegPath, [
        '-i', 'pipe:0',
        '-af', 'volume=1.4',
        '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
      ], { windowsHide: true });

      const py = spawn('python', ['-c', pythonCode]);
      
      const player = botPlayers.get(botName);
      if (!player) {
        releaseVoiceLock(botName);
        resolve();
        return;
      }

      py.stdout.on('error', () => {});
      ffmpeg.stdin.on('error', (e) => {
        if (e.code === 'EPIPE') return;
        console.error(`[${botName}/TTS] FFmpeg stdin error:`, e.message);
      });

      // Establish pipe FIRST before createAudioResource starts consuming stdout
      py.stdout.pipe(ffmpeg.stdin);

      const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
      player.play(resource);
      
      // Safety Timeout
      const safetyTimeout = setTimeout(() => {
        console.warn(`[${botName}/TTS] Safety timeout reached (Kokoro) — auto-releasing lock.`);
        releaseVoiceLock(botName);
        resolve();
      }, Math.max(15000, cleanedText.length * 80));

      // Use .once to prevent event listener leak and ensure single-trigger floor release
      player.once(AudioPlayerStatus.Idle, () => {
        clearTimeout(safetyTimeout);
        
        // Conversational breath pause before releasing lock and resolving
        const breathPause = 200 + Math.random() * 100;
        setTimeout(() => {
          releaseVoiceLock(botName);
          resolve();
        }, breathPause);
      });

      py.stderr.on('data', (data) => {
        console.error(`[${botName}/TTS] Kokoro Python Error:`, data.toString());
      });

      py.on('close', async (code) => {
        if (code !== 0) {
          console.warn(`[${botName}/TTS] Kokoro failed (code ${code}). Skipping TTS.`);
          releaseVoiceLock(botName);
          resolve();
        }
      });

    } catch (err) {
      console.error(`[${botName}/TTS] Kokoro Logic failed:`, err.message);
      releaseVoiceLock(botName);
      resolve();
    }
  });
}





