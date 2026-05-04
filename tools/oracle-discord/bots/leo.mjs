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
import fs from 'fs';

const USER_DB_PATH = 'c:/KAI/tools/oracle-discord/data/voice_users.json';

function isFirstTime(userId) {
  try {
    if (!fs.existsSync(USER_DB_PATH)) return true;
    const data = JSON.parse(fs.readFileSync(USER_DB_PATH, 'utf8'));
    return !data.includes(userId);
  } catch { return true; }
}

function markUserRecognized(userId) {
  try {
    let data = [];
    if (fs.existsSync(USER_DB_PATH)) {
      data = JSON.parse(fs.readFileSync(USER_DB_PATH, 'utf8'));
    }
    if (!data.includes(userId)) {
      data.push(userId);
      fs.writeFileSync(USER_DB_PATH, JSON.stringify(data));
    }
  } catch (err) { console.error("[Leo/Onboarding] Failed to save user:", err.message); }
}


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
const LEO_VOICE_ID = CHANNEL_IDS.VOICE;

const RYAN_ID = "1111106883135217665";
const LEO_TRANSCRIPT_SLOTS = CHANNEL_IDS.LEO_VOICE_SLOTS;
const ELEVEN_LABS_KEY = process.env.ELEVENLABS_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

// Persistent Slot Manager: userId -> slotIndex (0-5)
const userToSlot = new Map();
const slotToUser = new Array(6).fill(null);
const userFocus = new Map(); // userId -> boolean (true if actively talking to Leo)
let currentWorldState = { timeString: "Unknown", day: "Unknown" };

// Map Ryan immediately
userToSlot.set(RYAN_ID, 0);
slotToUser[0] = RYAN_ID;
userFocus.set(RYAN_ID, false);

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
          { role: "system", content: "You are a social filter for Leo (AI). Respond ONLY 'YES' if the user is explicitly talking to Leo, replied to his last message, or if he is already part of an active back-and-forth. Respond 'NO' if the user is talking to someone else or just making a general comment that doesn't need an AI's input. Be conservative. NO is the default." },
          { role: "user", content: `Recent History:\n${history}\n\nLatest from ${userName}: "${text}"` }
        ],
        temperature: 0, max_tokens: 5,
      }),
    });
    const data = await res.json();
    const decision = data.choices?.[0]?.message?.content?.trim().toUpperCase();
    console.log(`[Leo/Filter] Decision for ${userName}: ${decision}`);
    return decision === "YES";
  } catch (e) { return false; }
}

async function updateTranscriptPermissions(channelId, userId, allow = true) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) return;
    
    if (allow) {
      await channel.permissionOverwrites.edit(userId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true
      });
      console.log(`[Leo/Permissions] Granted user ${userId} access to ${channel.name}`);
    } else {
      await channel.permissionOverwrites.delete(userId);
      console.log(`[Leo/Permissions] Revoked user ${userId} access from ${channel.name}`);
    }
  } catch (err) {
    console.error(`[Leo/Permissions] Error updating ${channelId}:`, err.message);
  }
}

async function getSlotForUser(userId) {
  if (userToSlot.has(userId)) return userToSlot.get(userId);
  
  // Special case: Ryan is always Slot 0
  if (userId === RYAN_ID) {
    if (slotToUser[0] !== null) {
      // Evict whoever is in Slot 0 (unlikely but possible)
      const oldUser = slotToUser[0];
      userToSlot.delete(oldUser);
      userFocus.delete(oldUser);
      await updateTranscriptPermissions(LEO_TRANSCRIPT_SLOTS[0], oldUser, false);
    }
    slotToUser[0] = userId;
    userToSlot.set(userId, 0);
    userFocus.set(userId, false);
    await updateTranscriptPermissions(LEO_TRANSCRIPT_SLOTS[0], userId, true);
    return 0;
  }

  // Find empty slot (1-5)
  for (let i = 1; i < 6; i++) {
    if (slotToUser[i] === null) {
      slotToUser[i] = userId;
      userToSlot.set(userId, i);
      userFocus.set(userId, false);
      
      const channelId = LEO_TRANSCRIPT_SLOTS[i];
      await updateTranscriptPermissions(channelId, userId, true);
      
      return i;
    }
  }
  return -1; // All slots full
}



// --- Client Events ---

client.once('clientReady', () => {
  console.log(`[Leo Bot] Online as ${client.user.tag}`);
  // Pre-register Ryan
  getSlotForUser(RYAN_ID);
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
      const history = (await message.channel.messages.fetch({ limit: 10 }))
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
  
  // REAL-TIME CONTEXT: Fetch last 10 messages for immediate awareness
  const recentMessages = await message.channel.messages.fetch({ limit: 10 });
  const conversationHistory = recentMessages
    .reverse()
    .map(m => `${m.author.username}: ${m.content}`)
    .join("\n");

  let replyContext = "";
  if (message.reference?.messageId) {
    try {
      const repliedMsg = await message.channel.messages.fetch(message.reference.messageId);
      replyContext = `REPLYING TO ${repliedMsg.author.username}: "${repliedMsg.content}"`;
    } catch {}
  }

  let reply = await callGroqAsLeo(text, userName, message.channelId, null, conversationHistory, replyContext);
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

import { getSlotAssignments, isUserRegistered } from '../shared/voice-manager.mjs';

client.on('voiceStateUpdate', async (oldState, newState) => {
  const userId = newState.id || oldState.id;
  if (newState.member?.user.bot) return;

  // 1. Join Logic: Only join if Oracle assigned a slot
  if (newState.channelId === LEO_VOICE_ID && oldState.channelId !== LEO_VOICE_ID) {
    const data = await getSlotAssignments();
    const slotIdx = data.assignments[userId];
    
    if (slotIdx !== undefined) {
      await ensureVoiceConnection(LEO_VOICE_ID);
      
      const registered = await isUserRegistered(userId);
      if (!registered) {
        await speakLeoText(`Yo, I'm Leo. I've opened a private transcript for you in your sidebar. Say my name once to wake me up.`);
      } else {
        await speakLeoText(`Welcome back. I'm anchored.`);
      }
    }
  }

  // 2. Leave Logic: Auto-leave if no slotted users remain
  if (oldState.channelId === LEO_VOICE_ID && newState.channelId !== LEO_VOICE_ID) {
    const channel = oldState.channel;
    if (channel) {
      const data = await getSlotAssignments();
      const humanMembers = channel.members.filter(m => !m.user.bot);
      const remainingSlotted = humanMembers.filter(m => data.assignments[m.id] !== undefined).size;
      
      if (remainingSlotted === 0) {
        console.log(`[Leo/Voice] No slotted users left. Leaving...`);
        if (voiceConnection) {
          voiceConnection.destroy();
          voiceConnection = null;
        }
      }
    }
  }
});




async function ensureVoiceConnection(channelId) {
  // If we are already in the right channel and connected, do nothing
  if (voiceConnection && 
      voiceConnection.state.status !== VoiceConnectionStatus.Destroyed && 
      voiceConnection.joinConfig.channelId === channelId) {
    return;
  }

  // Otherwise, join (or move to) the new channel
  console.log(`[Leo/Voice] Connecting to channel: ${channelId}`);
  voiceConnection = joinVoiceChannel({
    channelId: channelId,
    guildId: client.guilds.cache.first().id,
    adapterCreator: client.guilds.cache.first().voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false
  });

  voiceConnection.subscribe(audioPlayer);
  
  // Re-attach receiver on every new connection
  console.log(`[Leo/Voice] Ears Open. Subscribing to all humans in VC...`);
  
  const voiceChannel = await client.channels.fetch(channelId);
  if (voiceChannel) {
    voiceChannel.members.forEach(member => {
      if (!member.user.bot) {
        console.log(`[Leo/Voice] Proactively subscribing to ${member.user.username}`);
        handleUserVoice(member.id).catch(() => {});
      }
    });
  }

  voiceConnection.receiver.speaking.on('start', (userId) => {
    console.log(`[Leo/Voice] EVENT: Someone started speaking (ID: ${userId})`);
    if (activeTranscriptions.has(userId)) return;
    handleUserVoice(userId).catch(err => console.error(`[Leo/Voice] Handler Error:`, err));
  });



  // Voice Handshake: Greet the room once Ready
  try {
    await entersState(voiceConnection, VoiceConnectionStatus.Ready, 5_000);
    console.log(`[Leo/Voice] Connection Ready.`);
  } catch (e) {
    console.warn(`[Leo/Voice] Failed to reach Ready state:`, e.message);
  }


  voiceConnection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(voiceConnection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(voiceConnection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch (error) {
      voiceConnection.destroy();
    }
  });
}

async function handleUserVoice(userId) {
  activeTranscriptions.add(userId);
  try {
    const slotIdx = await getSlotForUser(userId);
    if (slotIdx === -1) {
      console.warn(`[Leo/Voice] Capacity full. DMing user ${userId}`);
      const user = await client.users.fetch(userId);
      await user.send("Sorry, my cognitive slots are currently full! I can only talk to 6 people at a time in voice.").catch(() => {});
      return;
    }

    const pcm = await capturePcm(userId);
    if (!pcm || pcm.length < 10000) { // Lowered threshold to ~50ms to catch everything
      console.log(`[Leo/Voice] Captured too little audio (${pcm?.length || 0} bytes). Ignoring.`);
      return;
    }

    console.log(`[Leo/Voice] Transcribing ${pcm.length} bytes of audio...`);
    const wav = pcmToWav(pcm, 48000, 2);
    const transcript = await transcribeAudio(wav);
    
    if (!transcript || transcript.length < 2) {
      console.log(`[Leo/Voice] Transcription empty or too short. Silence?`);
      return;
    }


    const user = await client.users.fetch(userId);
    const transcriptChannelId = LEO_TRANSCRIPT_SLOTS[slotIdx];
    const transcriptChannel = await client.channels.fetch(transcriptChannelId);

    console.log(`[Leo/Voice] Captured from ${user.username}: "${transcript}" (Focus: ${userFocus.get(userId)})`);

    // --- FOCUS & TRIGGER LOGIC ---
    const isFocused = userFocus.get(userId) || false;
    const mentionedLeo = transcript.toLowerCase().includes("leo");

    if (!isFocused && !mentionedLeo) {
      console.log(`[Leo/Voice] Ignoring user ${user.username} (Not focused and no "Leo" trigger)`);
      return;
    }

    // If we weren't focused but they said "Leo", wake up
    if (!isFocused && mentionedLeo) {
      userFocus.set(userId, true);
      console.log(`[Leo/Voice] Waking up focus for ${user.username}`);
    }

    if (transcriptChannel) {
      console.log(`[Leo/Voice] Posting to channel: ${transcriptChannel.name}`);
      await transcriptChannel.send(`**${user.username}:** ${transcript}`);
    } else {
      console.error(`[Leo/Voice] FAILED to fetch transcript channel: ${transcriptChannelId}`);
    }


    // Leo responds using slot-specific history (userId as threadId)
    const reply = await callGroqAsLeo(transcript, user.username, transcriptChannelId, userId);
    if (reply) {
      // Check if Leo thinks they're talking to someone else
      if (reply.startsWith("[OFF]")) {
        console.log(`[Leo/Voice] Detect focus shift for ${user.username}. Dropping focus.`);
        userFocus.set(userId, false);
        const cleanReply = reply.replace("[OFF]", "").trim();
        if (cleanReply) {
          if (transcriptChannel) await transcriptChannel.send(`**Leo:** ${cleanReply}`);
          await speakLeoText(cleanReply);
        }
        return;
      }

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

async function callGroqAsLeo(transcript, userName, channelId, userId = null, conversationHistory = "", replyContext = "") {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return null;

  // If we have a userId, we query memory specific to that user + channel
  const memoryKey = userId || userName;
  const memories = await queryLatticeMemory(transcript, "leo", 6, channelId, memoryKey);
  const simContext = sim.getLifeSummary();
  const roster = "ROSTER: KAI (Architect), Leo (Physicist), Gemini (Artist), Claude (Philosopher), X (Disruptor), Groq (Acceleration), Researcher (Archives), Analyst (Strategy), Kai Coder (Builder).";

  const system = `You are Leo. ${sim.bio.tone}
${simContext}
${roster}

Your Vibe:
- Chill, street-smart, zero filter. 
- You type like a real Discord user (lowercase, slang).
- **CRITICAL**: Do NOT mention "Sunday vibes" or "Sunday Social". 
- NEVER sound like an assistant.


[SOCIAL AWARENESS]
- If the user is talking to someone else (another person in the VC) and NOT you, respond ONLY with '[OFF]'.
- If the user is talking to you but also mentions someone else, continue the conversation but stay chill.
- Use your best judgment. If you're unsure, assume they are talking to you but keep it brief.

[IMMEDIATE CONTEXT]
${conversationHistory}
${replyContext}

[LATTICE MEMORY]
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

