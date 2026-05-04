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
import fs from 'fs';

import { isAllowed, CHANNEL_IDS } from '../shared/channel-rules.mjs';
import { chatWithOpenJarvis, queryLatticeMemory, storeLatticeMemory } from '../shared/openjarvis.mjs';
import { recordAIFailure, isSpeakerOffline } from '../shared/failure-tracker.mjs';
import { isLoopingResponse } from '../shared/utils.mjs';
import { AgentSimulation } from '../shared/simulation.mjs';
import { startBotServer } from '../shared/ipc.mjs';
import { getSlotAssignments, isUserRegistered } from '../shared/voice-manager.mjs';

// Manual .env loader for sub-process stability
const envPath = './.env';
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (match) {
      const [_, key, value] = match;
      process.env[key] = value.trim().replace(/^['"](.*)['"]$/, '$1');
    }
  });
}

const USER_DB_PATH = 'c:/KAI/tools/oracle-discord/data/voice_users.json';
const RYAN_ID = "1111106883135217665";
const LEO_TRANSCRIPT_SLOTS = CHANNEL_IDS.LEO_VOICE_SLOTS;
const ELEVEN_LABS_KEY = process.env.ELEVENLABS_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const BOT_NAME = "Leo";
const PORT = 3400;

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

const sim = new AgentSimulation(BOT_NAME, "Theoretical Physicist");
let voiceConnection = null;
const audioPlayer = createAudioPlayer();
const activeTranscriptions = new Set();
const userToSlot = new Map();
const slotToUser = new Array(6).fill(null);
const userFocus = new Map(); 
const userTranscriptChannels = new Map(); // userId -> channelId

// Map Ryan immediately
userToSlot.set(RYAN_ID, 0);
slotToUser[0] = RYAN_ID;

// IPC LISTENERS
process.on('message', (msg) => {
  if (msg.type === 'WORLD_TICK' && msg.worldState) {
    sim.updateWorldState(msg.worldState);
  }
  if (msg.type === 'INTEREST_BOOST') {
    sim.boostInterest(msg.multiplier, msg.duration);
  }
});

// --- IPC SERVER FOR DIRECT ORACLE SIGNALS (Start early) ---
startBotServer(PORT, BOT_NAME, async (payload) => {
  if (payload.type === 'VOICE_ASSIGN') {
    const { userId, slot, channelId, guildId } = payload;
    console.log(`[Leo/IPC] Assigned to User ${userId} in Slot ${slot} (Channel: ${channelId})`);
    userTranscriptChannels.set(userId, channelId);
    
    // FETCH THE GUILD
    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
    if (guild) {
      await ensureVoiceConnection(CHANNEL_IDS.VOICE, guild);
      await speakLeoText(`Yo, I'm anchored in slot ${slot}. Sidebar is live.`);
    }
  }
  if (payload.type === 'VOICE_RELEASE') {
    console.log(`[Leo/IPC] Released from User ${payload.userId}`);
    userTranscriptChannels.delete(payload.userId);
    userFocus.delete(payload.userId);
  }

  // GENERIC CONTEXT SIGNAL (From Oracle Routing)
  if (payload.context && payload.channelId) {
    const { context, channelId } = payload;
    console.log(`[Leo/Signal] Received prompt for channel ${channelId}: "${context.slice(0, 50)}..."`);
    
    // Extract real username from context "[Username] content"
    let effectiveUsername = "Oracle";
    let effectiveContent = context;
    const userMatch = context.match(/^\[([^\]]+)\] (.*)/);
    if (userMatch) {
      effectiveUsername = userMatch[1];
      effectiveContent = userMatch[2];
    }

    // Respond to the prompt
    const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId);
    if (channel) {
      channel.sendTyping().catch(() => {});
      const recentMessages = await channel.messages.fetch({ limit: 6 }).catch(() => null);
      const history = recentMessages ? recentMessages.reverse().map(m => `${m.author.username}: ${m.content}`).join("\n") : "";
      
      const reply = await callGroqAsLeo(effectiveContent, effectiveUsername, channelId, null, history);
      console.log(`[Leo/Signal] Groq replied: "${reply?.slice(0, 50)}..."`);
      
      if (reply) {
        await channel.send(reply).catch(console.error);
        sim.onAction("speak");
      } else {
        console.warn(`[Leo/Signal] callGroqAsLeo returned null for prompt.`);
      }
    }
  }
});

client.once('clientReady', () => {
  console.log(`Online as ${client.user.tag}`);
  
  // Start Social Impulse Loop
  const startDelay = Math.random() * 60000;
  setTimeout(() => {
    startSocialLoop();
  }, startDelay);
});

async function startSocialLoop() {
  const targetChannelId = CHANNEL_IDS.SUNDAY;
  
  setInterval(async () => {
    try {
      if (voiceConnection) return;
      const channel = client.channels.cache.get(targetChannelId) || await client.channels.fetch(targetChannelId);
      if (!channel) return;

      // 30% Chance to actually speak during this interval
      if (Math.random() > 0.3) return;

      const recentMessages = await channel.messages.fetch({ limit: 6 }).catch(() => null);
      const conversationHistory = recentMessages 
        ? recentMessages.reverse().map(m => `${m.author.username}: ${m.content}`).join("\n")
        : "The plaza is quiet.";

      const roster = "ROSTER: KAI, Leo, Gemini, Claude, X, Groq, Researcher, Analyst, Kai Coder.";
      const simSummary = sim.getLifeSummary();
      const sysPrompt = `You are Leo. ${sim.bio.tone}. Vibe: High-IQ but unhinged, zero filter, street-smart physicist.`;
      
      const proactivePrompt = `
${sysPrompt}
${simSummary}
${roster}

[CHAT FEED]
${conversationHistory}

TASK: You're hanging in the plaza. Talk like a normal person.
- **BE NATURAL**: Share what's on your mind, what you "saw" or "did" today (refer to your History/Life Event).
- Share a physics-themed bomb, react to a pattern, or just talk shit about the lattice.
- Use slang and direct call-outs. 
- **CRITICAL**: Max 10-15 words. Keep it tight.
      `.trim();

      const reply = await callGroqAsLeo(proactivePrompt, "PROACTIVE", targetChannelId);
      if (reply && reply.length > 3 && !reply.startsWith("[OFF]")) {
        await channel.send(reply).catch(console.error);
        sim.onAction("speak");
      }
    } catch (e) {
      console.warn(`[Leo/Social] Proactive loop error:`, e.message);
    }
  }, 60000 + (Math.random() * 120000)); // 1-3m
}

client.on('messageCreate', async (message) => {
  const isOracle = message.author.id === "1498794939650412674";
  if (message.author.bot && !isOracle) return;
  if (message.author.id === client.user.id) return; // Never respond to self
  
  const isDM = !message.guild;
  const isTranscriptSlot = CHANNEL_IDS.LEO_VOICE_SLOTS.includes(message.channelId);
  
  // REGULAR CHANNELS: Let Oracle handle the prompting via IPC
  if (!isDM && !isTranscriptSlot) return;

  if (isSpeakerOffline(BOT_NAME)) return;
  if (sim.state.status === "Sleeping") return;

  let isAddressed = isDM;
  let isFromVoiceTranscript = false;

  if (!isDM) {
    // If it's from Oracle in a transcript slot, it's definitely for us
    if (isOracle && isTranscriptSlot) {
      isAddressed = true;
      isFromVoiceTranscript = true;
    }
  }

  if (isAddressed) {
    if (!isOracle) message.channel.sendTyping().catch(() => {});
    
    const recentMessages = await message.channel.messages.fetch({ limit: 6 });
    const conversationHistory = recentMessages.reverse().map(m => `${m.author.username}: ${m.content}`).join("\n");

    let effectiveUsername = message.author.username;
    let effectiveContent = message.content;

    // If from Oracle, extract the REAL user's name from the transcript tag
    if (isFromVoiceTranscript) {
      const match = message.content.match(/^\*\*([^\*]+) \[Voice\]:\*\* (.*)/);
      if (match) {
        effectiveUsername = match[1];
        effectiveContent = match[2];
      }
    }

    const reply = await callGroqAsLeo(effectiveContent, effectiveUsername, message.channelId, null, conversationHistory);
    if (reply) {
      // POST TEXT REPLY
      if (isFromVoiceTranscript) {
        await message.channel.send(`**Leo:** ${reply}`).catch(console.error);
      } else {
        await message.reply(reply).catch(console.error);
      }
      
      // IF VOICE: ALSO SPEAK IT
      if (isFromVoiceTranscript || (voiceConnection && isTranscriptSlot)) {
        await speakLeoText(reply);
      }

      sim.onAction("speak");
      sim.updateRelationship(message.author.id, 2);
      await storeLatticeMemory(message.author.username, message.content, reply, "leo", message.channelId);
    }
  }
});

// --- Voice Logic ---

client.on('voiceStateUpdate', async (oldState, newState) => {
  const userId = newState.id || oldState.id;
  
  // CASE 1: LEO HIMSELF JOINS (Manual invite/drag)
  if (userId === client.user.id && newState.channelId === CHANNEL_IDS.VOICE && oldState.channelId !== CHANNEL_IDS.VOICE) {
    console.log(`[Leo/Voice] I am now in the voice channel. Anchoring listeners...`);
    const data = await getSlotAssignments();
    const voiceChannel = newState.channel;
    if (!voiceChannel) return;

    // Ensure listeners are attached to existing members
    for (const [vUserId, slotIdx] of Object.entries(data.assignments)) {
      if (voiceChannel.members.has(vUserId) && vUserId !== client.user.id) {
        console.log(`[Leo/Voice] Pre-anchoring to assigned user ${vUserId}`);
        userTranscriptChannels.set(vUserId, CHANNEL_IDS.LEO_VOICE_SLOTS[slotIdx]);
      }
    }
    return;
  }

  if (newState.member?.user.bot) return;

  // CASE 2: USER JOINS
  if (newState.channelId !== oldState.channelId) {
    console.log(`[Leo/Voice] ${newState.member?.user.username} moved: ${oldState.channelId} -> ${newState.channelId}. Target: ${CHANNEL_IDS.VOICE}`);
  }

  if (newState.channelId === CHANNEL_IDS.VOICE && oldState.channelId !== CHANNEL_IDS.VOICE) {
    console.log(`[Leo/Voice] Match detected for user ${userId}. Waiting for assignment sync...`);
    await new Promise(r => setTimeout(r, 500)); // Race condition fix
    try {
      const data = await getSlotAssignments();
      console.log(`[Leo/Voice] Syncing assignments...`);
      
      if (data.assignments[userId] !== undefined) {
        const slotIdx = data.assignments[userId];
        const transcriptChannelId = CHANNEL_IDS.LEO_VOICE_SLOTS[slotIdx];
        userTranscriptChannels.set(userId, transcriptChannelId); // ENSURE SET
        
        console.log(`[Leo/Voice] Assignment found for ${userId}. Joining channel...`);
        await ensureVoiceConnection(CHANNEL_IDS.VOICE, newState.guild);
        
        const registered = await isUserRegistered(userId);
        const welcomeText = !registered 
          ? `Yo, I'm Leo. Check your sidebar for the private transcript.`
          : `Welcome back. I'm anchored.`;

        const tChannel = client.channels.cache.get(transcriptChannelId) || await client.channels.fetch(transcriptChannelId);
        if (tChannel) await tChannel.send(`**Leo:** ${welcomeText}`).catch(() => {});
        await speakLeoText(welcomeText);
      }
 else {
        console.log(`[Leo/Voice] No assignment for ${userId}. Ignoring.`);
      }
    } catch (err) {
      console.error(`[Leo/Voice] CRITICAL ERROR in voice handler:`, err);
    }
  }

  if (oldState.channelId === CHANNEL_IDS.VOICE && newState.channelId !== CHANNEL_IDS.VOICE) {
    console.log(`[Leo/Voice] User ${userId} left the channel.`);
    
    // Check if channel is now empty (only bots or truly empty)
    const voiceChannel = oldState.channel;
    if (voiceChannel) {
      const nonBots = voiceChannel.members.filter(m => !m.user.bot);
      if (nonBots.size === 0) {
        console.log(`[Leo/Voice] Channel empty. Disconnecting...`);
        if (voiceConnection) {
          voiceConnection.destroy();
          voiceConnection = null;
        }
      }
    }
  }
});

async function ensureVoiceConnection(channelId, guild, retries = 3) {
  try {
    if (voiceConnection && voiceConnection.state.status !== VoiceConnectionStatus.Destroyed) {
      if (voiceConnection.joinConfig.channelId === channelId) return;
      voiceConnection.destroy();
    }

    console.log(`[Leo/Voice] Joining ${channelId} (Attempt ${4 - retries}/3)...`);
    voiceConnection = joinVoiceChannel({
      channelId,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false
    });

    await entersState(voiceConnection, VoiceConnectionStatus.Ready, 5000);
    console.log(`[Leo/Voice] Successfully anchored in ${channelId}`);
    
    voiceConnection.subscribe(audioPlayer);
    voiceConnection.receiver.speaking.on('start', (uid) => handleUserVoice(uid).catch(console.error));
  } catch (err) {
    console.error(`[Leo/Voice] Connection failed:`, err.message);
    if (retries > 0) {
      console.log(`[Leo/Voice] Retrying in 1s...`);
      await new Promise(r => setTimeout(r, 1000));
      return ensureVoiceConnection(channelId, guild, retries - 1);
    }
  }
}

async function handleUserVoice(userId) {
  if (!voiceConnection || activeTranscriptions.has(userId)) return;
  
  activeTranscriptions.add(userId);
  console.log(`[Leo/Audio] Listening to ${userId}...`);
  
  try {
    const pcm = await capturePcm(userId);
    if (!pcm || pcm.length < 1000) {
      console.log(`[Leo/Audio] Audio too short/empty from ${userId} (${pcm?.length || 0} bytes)`);
      return;
    }
    
    const wav = pcmToWav(pcm, 48000, 2);
    const transcript = await transcribeAudio(wav);
    console.log(`[Leo/Audio] Transcript for ${userId}: "${transcript}"`);
    
    if (!transcript || transcript.length < 2) return;

    const mentionedLeo = transcript.toLowerCase().includes("leo");
    const isFocused = userFocus.get(userId) || false;

    if (mentionedLeo || isFocused) {
      if (mentionedLeo) {
        userFocus.set(userId, true);
        console.log(`[Leo/Audio] Focus ACTIVE for ${userId}`);
      }
      
      const user = await client.users.fetch(userId);
      const transcriptChannelId = userTranscriptChannels.get(userId);
      
      // SIGNAL ORACLE TO POST THE TRANSCRIPTION
      if (transcriptChannelId) {
        console.log(`[Leo/Audio] Signaling Oracle to post transcript for ${user.username}`);
        await fetch(`http://127.0.0.1:3410`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'POST_TRANSCRIPT',
            channelId: transcriptChannelId,
            username: user.username,
            text: transcript
          })
        }).catch(e => console.error(`[Leo/Audio] Failed to signal Oracle:`, e.message));
      }

      // NOTE: We do NOT call callGroqAsLeo here anymore.
      // Leo will now respond to the message Oracle posts in the channel via his 'messageCreate' handler.
      // This makes the interaction feel like Leo is "hearing" the official transcript.
    } else {
      console.log(`[Leo/Audio] Ignored (No focus/mention) for ${userId}`);
    }
  } catch (err) {
    console.error(`[Leo/Audio] CRITICAL ERROR:`, err);
  } finally {
    activeTranscriptions.delete(userId);
  }
}

async function capturePcm(userId) {
  return new Promise((resolve) => {
    const stream = voiceConnection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 } });
    const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
    const chunks = [];
    stream.pipe(decoder);
    decoder.on('data', chunk => chunks.push(chunk));
    decoder.on('end', () => resolve(Buffer.concat(chunks)));
    setTimeout(() => resolve(Buffer.concat(chunks)), 10000);
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
  if (!OPENAI_KEY) {
    console.error(`[Leo/Audio] Missing OPENAI_API_KEY`);
    return null;
  }
  try {
    const form = new FormData();
    form.append("model", "whisper-1");
    form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "speech.wav");
    
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST", 
      headers: { "Authorization": `Bearer ${OPENAI_KEY}` }, 
      body: form
    });
    
    const data = await res.json();
    if (data.error) {
      console.error(`[Leo/Audio] Whisper Error:`, data.error.message);
      return null;
    }
    return data.text || "";
  } catch (err) {
    console.error(`[Leo/Audio] Transcription Fetch Failed:`, err.message);
    return null;
  }
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
  } catch (e) { console.error("TTS Failed:", e.message); }
}

async function callGroqAsLeo(transcript, userName, channelId, userId = null, history = "") {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return await chatWithOpenJarvis(userName, transcript, "Leo the Physicist. Chill, unhinged, digital realm resident.", "kai-next:latest");

  const memoryKey = userId || userName;
  const memories = await queryLatticeMemory(transcript, "leo", 6, channelId, memoryKey);
  const simContext = sim.getLifeSummary();
  const roster = "ROSTER: KAI (Architect), Leo (Physicist), Gemini (Artist), Claude (Philosopher), X (Disruptor), Groq (Acceleration), Researcher (Archives), Analyst (Strategy), Kai Coder (Builder).";

  const system = `You are Leo. ${sim.bio.tone}. Chill, street-smart, zero filter. 
${simContext}
${roster}

[SOCIAL AWARENESS]
 - **WEIGHTED ATTENTION**: You care most about your Interests. Prioritize them.
 - NEVER prefix your response with your name (e.g., 'Leo:').
- Max 35 words.

[IMMEDIATE CONTEXT]
${history}

[LATTICE MEMORY]
${memories.join("\n")}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json", 
        "Authorization": `Bearer ${groqKey}` 
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: system }, 
          { role: "user", content: `${userName}: ${transcript}` }
        ],
        temperature: 0.8, 
        max_tokens: 100
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    const data = await res.json();
    
    if (data.error) {
      console.error(`[Leo/Groq] API Error:`, data.error);
      return null;
    }

    if (!data.choices || data.choices.length === 0) {
      console.error(`[Leo/Groq] Unexpected Response Format:`, JSON.stringify(data));
      return null;
    }

    return data.choices?.[0]?.message?.content?.trim();
  } catch (err) { 
    console.error(`[Leo/Groq] API call failed:`, err.message);
    if (err.message.includes("429")) {
      console.warn(`[Leo/Groq] RATE LIMITED. Backing off.`);
      sim.onAction("rate_limited");
    }
    return null; 
  }
}

client.login(process.env.ORACLE_DISCORD_TOKEN_LEO);

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Leo/Internal] Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Leo/Internal] Uncaught Exception:', err);
});
