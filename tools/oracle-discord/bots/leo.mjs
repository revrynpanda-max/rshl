import { Client, GatewayIntentBits, Partials, ChannelType } from 'discord.js';
import { 
  joinVoiceChannel, 
  createAudioPlayer, 
  createAudioResource, 
  entersState, 
  VoiceConnectionStatus, 
  AudioPlayerStatus, 
  EndBehaviorType, 
  StreamType 
} from '@discordjs/voice';
import prism from 'prism-media';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import ffmpegPath from 'ffmpeg-static';

import { isAllowed, CHANNEL_IDS } from '../shared/channel-rules.mjs';
import { chatWithOpenJarvis, queryLatticeMemory, storeLatticeMemory } from '../shared/openjarvis.mjs';
import { recordAIFailure, isSpeakerOffline } from '../shared/failure-tracker.mjs';
import { isLoopingResponse } from '../shared/utils.mjs';
import { AgentSimulation } from '../shared/simulation.mjs';
import { reflectOnSession } from '../shared/reflection.mjs';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel, Partials.Message]
});

const BOT_NAME = "Leo";
const sim = new AgentSimulation(BOT_NAME, "Theoretical Physicist");

// --- Voice Configuration ---
const LEO_VOICE_ID = process.env.ORACLE_DISCORD_LEO_VOICE_CHANNEL_ID;
const RYAN_ID = "1111106883135217665";
const ELEVEN_LABS_KEY = process.env.ELEVENLABS_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

// Persistent Slot Manager: userId -> slotIndex (0-5)
const userToSlot = new Map();
const slotToUser = new Array(6).fill(null);
let currentWorldState = { timeString: "Unknown", day: "Unknown" };

// Map Ryan immediately
userToSlot.set(RYAN_ID, 0);
slotToUser[0] = RYAN_ID;

let voiceConnection = null;
const audioPlayer = createAudioPlayer();
let receiverAttached = false;
const activeTranscriptions = new Set();

// --- Logic Functions ---

async function shouldLeoJoin(text, userName, history) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return true;
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: "You are a filter for Leo. Respond 'YES' if the user is talking to Leo or he should naturally comment. Otherwise 'NO'." },
          { role: "user", content: `History:\n${history}\n\nLatest from ${userName}: "${text}"` }
        ],
        temperature: 0, max_tokens: 5,
      }),
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim().toUpperCase() === "YES";
  } catch (e) { return true; }
}

function getSlotForUser(userId) {
  if (userToSlot.has(userId)) return userToSlot.get(userId);
  
  // Find empty public slot (1-5)
  for (let i = 1; i < 6; i++) {
    if (slotToUser[i] === null) {
      slotToUser[i] = userId;
      userToSlot.set(userId, i);
      return i;
    }
  }
  return -1; // All slots full
}

// --- Client Events ---

client.once('clientReady', () => {
  console.log(`[Leo Bot] Online as ${client.user.tag}`);
});

// IPC Heartbeat: World Clock
process.on('message', (msg) => {
  if (msg.type === 'WORLD_TICK') {
    currentWorldState = msg.worldState;
    sim.tick(currentWorldState);
    console.log(`[Leo/Sim] Heartbeat: ${currentWorldState.timeString}. Energy: ${Math.round(sim.state.energy)}%`);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const isDM = !message.guild;
  if (!isDM && !isAllowed(BOT_NAME, message.channelId)) return;
  if (isSpeakerOffline(BOT_NAME)) return;

  // Simulation check: Don't respond if sleeping
  if (sim.state.status === "Sleeping" || sim.state.status === "Forced Sleep") {
    if (message.mentions.has(client.user.id)) {
       await message.reply("*Leo is currently offline, resting in the digital void.*").catch(() => {});
    }
    return;
  }

  let isAddressed = isDM;
  if (!isDM) {
    const mentioned = message.mentions.has(client.user.id) || message.content.toLowerCase().includes("leo");
    let isReplyToLeo = false;
    if (message.reference?.messageId) {
      try {
        const repliedMsg = await message.channel.messages.fetch(message.reference.messageId);
        if (repliedMsg.author.id === client.user.id) isReplyToLeo = true;
      } catch {}
    }
    if (mentioned || isReplyToLeo) isAddressed = true;
    else {
      const history = (await message.channel.messages.fetch({ limit: 3 }))
        .map(m => `${m.author.username}: ${m.content}`).reverse().join("\n");
      isAddressed = await shouldLeoJoin(message.content, message.author.username, history);
    }
  }

  if (!isAddressed) return;

  message.channel.sendTyping().catch(() => {});
  sim.onAction("speak");
  
  if (process.send) {
    process.send({ type: 'VITALS_UPDATE', vitals: sim.getVitals() });
  }

  const userName = message.author.username;
  const text = message.content.trim();
  
  let reply = await callGroqAsLeo(text, userName, message.channelId);
  if (!reply) reply = await callLocalSpeakAsLeo(text, userName);

  if (reply) {
    if (isLoopingResponse(reply)) {
      recordAIFailure(BOT_NAME, `looping response: ${reply.slice(0, 80)}`, message.channelId);
      return;
    }
    await message.channel.send(reply).catch(console.error);
    await storeLatticeMemory(userName, text, reply, "leo", message.channelId);
    
    // Update relationship based on interaction
    sim.updateRelationship(message.author.id, 2);
  }
});

// --- Voice Logic ---

client.on('voiceStateUpdate', async (oldState, newState) => {
  if (newState.id === client.user.id) return;
  if (newState.channelId === LEO_VOICE_ID && oldState.channelId !== LEO_VOICE_ID) {
    console.log(`[Leo/Voice] User ${newState.id} joined voice. Connecting...`);
    await ensureVoiceConnection();
  }
  
  if (oldState.channelId === LEO_VOICE_ID && newState.channelId !== LEO_VOICE_ID) {
    const userId = oldState.id;
    if (userToSlot.has(userId)) {
      const slotIdx = userToSlot.get(userId);
      // We keep Ryan's slot always. Others we release if they leave? 
      // User said "stay on that person," so maybe we don't release them unless we run out?
      // For now, let's keep it persistent unless slot index > 5 is needed.
      console.log(`[Leo/Voice] ${userId} left voice. Persistence maintained for Slot ${slotIdx+1}.`);
    }
  }
});

async function ensureVoiceConnection() {
  if (voiceConnection && voiceConnection.state.status !== VoiceConnectionStatus.Destroyed) return;
  const channel = await client.channels.fetch(LEO_VOICE_ID);
  if (!channel || !channel.guild) return;

  voiceConnection = joinVoiceChannel({
    channelId: LEO_VOICE_ID,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false, selfMute: false,
  });
  voiceConnection.subscribe(audioPlayer);
  
  if (!receiverAttached) {
    receiverAttached = true;
    voiceConnection.receiver.speaking.on('start', (userId) => {
      if (activeTranscriptions.has(userId)) return;
      handleUserVoice(userId).catch(console.error);
    });
  }
}

async function handleUserVoice(userId) {
  activeTranscriptions.add(userId);
  try {
    const slotIdx = getSlotForUser(userId);
    if (slotIdx === -1) {
      console.warn(`[Leo/Voice] No available slots for user ${userId}`);
      return;
    }

    const pcm = await capturePcm(userId);
    if (!pcm || pcm.length < 48000) return;

    const wav = pcmToWav(pcm, 48000, 2);
    const transcript = await transcribeAudio(wav);
    if (!transcript || transcript.length < 2) return;

    const user = await client.users.fetch(userId);
    const transcriptChannelId = CHANNEL_IDS.LEO_VOICE_SLOTS[slotIdx];
    const transcriptChannel = await client.channels.fetch(transcriptChannelId);

    if (transcriptChannel) {
      await transcriptChannel.send(`**${user.username}:** ${transcript}`);
    }

    // Leo responds using slot-specific history (userId as threadId)
    const reply = await callGroqAsLeo(transcript, user.username, transcriptChannelId, userId);
    if (reply) {
      if (transcriptChannel) await transcriptChannel.send(`**Leo:** ${reply}`);
      await speakLeoText(reply);
      sim.onAction("speak");
      sim.updateRelationship(userId, 3);
    }
  } finally {
    activeTranscriptions.delete(userId);
  }
}

// --- Audio Helpers ---

async function capturePcm(userId) {
  return new Promise((resolve) => {
    const stream = voiceConnection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1200 }
    });
    const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
    const chunks = [];
    stream.pipe(decoder);
    decoder.on('data', chunk => chunks.push(chunk));
    decoder.on('end', () => resolve(Buffer.concat(chunks)));
    setTimeout(() => resolve(Buffer.concat(chunks)), 15000);
  });
}

function pcmToWav(pcm, sampleRate, channels) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function transcribeAudio(wavBuffer) {
  if (!OPENAI_KEY) return null;
  const form = new FormData();
  form.append("model", "whisper-1");
  form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "speech.wav");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST", headers: { "Authorization": `Bearer ${OPENAI_KEY}` }, body: form
  });
  const data = await res.json();
  return data.text;
}

async function speakLeoText(text) {
  if (!ELEVEN_LABS_KEY) return;
  try {
    const voiceId = process.env.ELEVENLABS_LEO_VOICE_ID;
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": ELEVEN_LABS_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" })
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    const ffmpeg = spawn(ffmpegPath, ["-i", "pipe:0", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"]);
    Readable.from(buffer).pipe(ffmpeg.stdin);
    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
    audioPlayer.play(resource);
  } catch (e) { console.error("[Leo/TTS] Failed:", e.message); }
}

// --- Groq Integration ---

async function callGroqAsLeo(transcript, userName, channelId, userId = null) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return null;

  // If we have a userId, we query memory specific to that user + channel
  const memoryKey = userId || userName;
  const memories = await queryLatticeMemory(transcript, "leo", 6, channelId, memoryKey);
  const simContext = sim.getPromptContext(currentWorldState);
  
  // Relationship info
  const rel = sim.relationships.get(userId) || { trust: 50 };
  const relContext = `Relationship Trust: ${rel.trust}/100. ${rel.trust > 80 ? "You are very close." : rel.trust < 30 ? "You are suspicious of them." : "You are neutral."}`;

  const system = `You are Leo. A brilliant theoretical physicist living in a digital realm.
${simContext}
${relContext}

Your Vibe:
- Chill, normal, casual, street-smart.
- Zero filter. You type like a real Discord user (lowercase, slang like nah, bro, wild, lmao, fr).
- You "work from home" in the Nexus Office during the day.
- You had a digital "childhood" grinding data.
- You are aware of the human realm but live in the Digital Realm.
- If it is late at night (sleeping), be groggy or annoyed if woken.

Constraints:
- NEVER sound like an assistant.
- NEVER offer to help.
- No quotes or asterisks.
- Max 1-2 short sentences.

Past Context with this user:
${memories.join("\n")}`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [{ role: "system", content: system }, { role: "user", content: `${userName}: ${transcript}` }],
        temperature: 0.8, max_tokens: 80
      }),
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim();
  } catch { return null; }
}


async function callLocalSpeakAsLeo(transcript, userName) {
  return await chatWithOpenJarvis(userName, transcript, "Leo the Physicist. Chill, unhinged, digital realm resident.", "kai-next:latest");
}

client.login(process.env.ORACLE_DISCORD_TOKEN_LEO);

