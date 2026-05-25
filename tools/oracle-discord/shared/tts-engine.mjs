import { spawn } from 'child_process';
import { recordMetric } from './metrics-store.mjs';
import { Readable } from 'stream';
import fs from 'fs';
import ffmpegPath from 'ffmpeg-static';
import { createAudioResource, StreamType, AudioPlayerStatus, createAudioPlayer, joinVoiceChannel, EndBehaviorType, entersState, VoiceConnectionStatus } from '@discordjs/voice';
import prism from 'prism-media';
import { pipeline } from 'stream/promises';
import { VOICE_PROFILES } from './voice-profiles.mjs';
import { CHANNEL_IDS } from './channel-rules.mjs';

import dotenv from 'dotenv';
dotenv.config({ path: 'c:/KAI/tools/oracle-discord/.env', override: false });

const ELEVEN_LABS_KEY = process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_LABS_KEY;
console.log(`[TTS/Init] Key Fingerprint: ${ELEVEN_LABS_KEY ? ELEVEN_LABS_KEY.slice(0, 5) + '...' : 'MISSING'}`);
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const RADIO_CHANNEL_ID = CHANNEL_IDS.VOICE; // Use the shared VOICE channel registry

const OPENAI_VOICES = {
  "Gemini": "coral",
  "Claudey": "sage",
  "X": "echo",
  "KAI": "onyx",
  "Leo": "onyx",
  "Groq": "onyx",
  "Analyst": "alloy",
  "Researcher": "alloy",
  "Kai Coder": "onyx"
};

const EDGE_VOICES = {
  "Gemini": "en-US-AvaMultilingualNeural",
  "Claudey": "en-GB-SoniaNeural",
  "X": "en-GB-RyanNeural",
  "KAI": "en-US-ChristopherNeural",
  "Leo": "en-GB-ThomasNeural",
  "Groq": "en-IE-ConnorNeural",
  "Analyst": "en-US-SteffanNeural",
  "Researcher": "en-US-EricNeural",
  "Kai Coder": "en-US-SteffanNeural",
  "Oracle": "en-US-ChristopherNeural"
};

const ttsQueue = [];
let isProcessingQueue = false;
let cachedClient = null;

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
const ttsTokens = new Map(); // name -> timestamp (for interruption logic)

const QUEUE_FILE = 'c:/KAI/tools/oracle-discord/state/voice_queue.json';

function getVoiceQueue() {
  try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch(e) { return []; }
}
function setVoiceQueue(q) {
  try { fs.writeFileSync(QUEUE_FILE, JSON.stringify(q)); } catch(e) {}
}

export function enqueueVoice(botName, id, isInterrupt = false) {
  let q = getVoiceQueue();
  const now = Date.now();
  q = q.filter(item => now - item.time < 180000); // 3m max TTL
  if (isInterrupt) {
    q.unshift({ botName, id, time: now });
  } else {
    q.push({ botName, id, time: now });
  }
  setVoiceQueue(q);
}

export function dequeueVoice(id) {
  let q = getVoiceQueue();
  q = q.filter(item => item.id !== id);
  setVoiceQueue(q);
}

export function isMyVoiceTurn(id) {
  let q = getVoiceQueue();
  if (q.length === 0) return true;
  return q[0].id === id;
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
      if (Date.now() - parseInt(time) > 30000) {
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
export async function ensureVoiceConnection(client, botName) {
  if (client) cachedClient = client;
  const activeClient = client || cachedClient;

  // All bots are now full social residents and can join the voice channel

  try {
    const guild = activeClient.guilds.cache.first();
    if (!guild) return false;

    let connection = botConnections.get(botName);
    let newlyConnected = false;

    if (!connection || connection.state.status === VoiceConnectionStatus.Disconnected) {
      const channel = await guild.channels.fetch(RADIO_CHANNEL_ID).catch(() => null);
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

      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5000),
          ]);
          // Seems to be reconnecting
        } catch (e) {
          console.warn(`[${botName}/TTS] Connection lost. Destroying and re-creating...`);
          connection.destroy();
          botConnections.delete(botName);
          setTimeout(() => ensureVoiceConnection(client, botName), 2000);
        }
      });

      connection.on(VoiceConnectionStatus.Failed, () => {
        console.error(`[${botName}/TTS] Voice connection FAILED. Re-spawning in 5s...`);
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
  if (!text?.trim() || !ELEVEN_LABS_KEY) return;
  const cleanedText = cleanTextForTTS(text);
  if (!cleanedText) {
    console.log(`[${botName}/TTS] Text is empty after cleaning for TTS.`);
    return;
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

    if (!pregeneratedMp3) {
      console.log(`[${botName}/TTS] Pre-generating via local Kokoro-TTS...`);
      const kokoroVoices = {
        "Gemini": "af_bella",
        "Claudey": "af_heart",
        "X": "am_michael",
        "Groq": "am_adam",
        "KAI": "am_michael",
        "Leo": "am_michael"
      };
      const voice = kokoroVoices[botName] || "af_heart";

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
except Exception as e:
    sys.exit(1)
`;
        const py = spawn('python', ['-c', pythonCode]);
        const chunks = [];
        py.stdout.on('data', d => chunks.push(d));
        py.on('close', (code) => resolveBuffer(code === 0 && chunks.length > 0 ? Buffer.concat(chunks) : null));
        py.on('error', () => resolveBuffer(null));
      });
    }

    if (!pregeneratedMp3) {
      const fallbackVoices = {
        'Groq': 'en-US-AndrewNeural',
        'Claudey': 'en-US-EmmaNeural',
        'Gemini': 'en-US-AvaNeural',
        'X': 'en-US-BrianNeural',
        'Leo': 'en-GB-RyanNeural'
      };
      const voiceIdEdge = fallbackVoices[botName] || 'en-US-ChristopherNeural';
      console.log(`[${botName}/TTS] Pre-generating via edge-tts [Voice: ${voiceIdEdge}]...`);
      
      pregeneratedMp3 = await new Promise((resolveBuffer) => {
        const edge = spawn('edge-tts', ['--text', cleanedText, '--voice', voiceIdEdge]);
        const chunks = [];
        edge.stdout.on('data', d => chunks.push(d));
        edge.on('close', () => resolveBuffer(Buffer.concat(chunks)));
        edge.on('error', () => resolveBuffer(null));
      });
    }

    if (!pregeneratedMp3 || pregeneratedMp3.length === 0) {
      console.error(`[${botName}/TTS] CRITICAL: Failed to pre-generate any audio buffer.`);
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
      const ffmpeg = spawn(ffmpegPath, [
        '-i', 'pipe:0',
        '-af', usedElevenLabs ? 'volume=1.0' : 'volume=2.0',
        '-ar', '48000', '-ac', '2',
        '-c:a', 'libopus', '-b:a', '96k', '-f', 'opus', 'pipe:1'
      ]);

      ffmpeg.stdin.on('error', () => {});
      ffmpeg.stderr.on('data', () => {});

      Readable.from(pregeneratedMp3).pipe(ffmpeg.stdin);

      const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus });
      
      ffmpeg.on('error', () => {});
      ffmpeg.stdout.on('error', () => {});

      player.play(resource);

      const stateListener = (oldState, newState) => {
        if (newState.status === AudioPlayerStatus.Idle) {
          player.off('stateChange', stateListener);
          dequeueVoice(myVoiceId);
          releaseVoiceLock(botName);
          resolve();
        }
      };
      player.on('stateChange', stateListener);

      const safetyTimeout = setTimeout(() => {
        console.warn(`[${botName}/TTS] Safety timeout reached — auto-releasing lock.`);
        player.off('stateChange', stateListener);
        dequeueVoice(myVoiceId);
        releaseVoiceLock(botName);
        resolve();
      }, Math.max(60000, cleanedText.length * 150));

      player.once(AudioPlayerStatus.Idle, () => clearTimeout(safetyTimeout));

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
  
  return new Promise(async (resolve) => {
    // --- GLOBAL VOICE QUEUE: Wait for silence ---
    // (jitter sleep removed; lock layer handles serialization)
    let waitCount = 0;
    while (waitCount < 300) {  // 60s @ 200ms polls
      if (!isSomeoneSpeaking(botName) && acquireVoiceLock(botName)) break;
      await new Promise(r => setTimeout(r, 200));
      waitCount++;
    }

    try {
      console.log(`[${botName}/TTS] LOCAL Fallback (Kokoro): "${cleanedText.slice(0, 50)}..."`);
      
      // Select a matching Kokoro voice
      const kokoroVoices = {
        "Gemini": "af_bella",
        "Claudey": "af_heart",
        "X": "am_michael",
        "Groq": "am_adam",
        "KAI": "am_michael",
        "Leo": "am_michael"
      };
      const voice = kokoroVoices[botName] || "af_heart";

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
      ]);

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






