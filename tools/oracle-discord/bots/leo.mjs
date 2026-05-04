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
import { execSync } from 'child_process';

// NEURAL ASSASSINATION: Kill any ghost Leo processes holding the port
try {
  if (process.platform === 'win32') {
    console.log(`[Leo/Neural] Performing Neural-Assassination on Port 3400...`);
    // Aggressively kill any process on our port
    const output = execSync(`netstat -ano | findstr :3400`).toString();
    const lines = output.split('\n');
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && !isNaN(pid) && parseInt(pid) !== process.pid) {
        console.log(`[Leo/Neural] Executing PID ${pid} (Ghost detected)...`);
        execSync(`taskkill /F /PID ${pid}`);
      }
    }
  }
} catch (e) {
  // Port is likely clear
}

import { isAllowed, CHANNEL_IDS } from '../shared/channel-rules.mjs';
import { chatWithOpenJarvis, callOpenAI, callGroqDirect, callGemini, callAnthropic } from '../shared/openjarvis.mjs';
import { recordAIFailure, isSpeakerOffline, isProviderReady, recordProviderFailure } from '../shared/failure-tracker.mjs';
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
const TAAS_ID = "1286110163505385523";
const LEO_TRANSCRIPT_SLOTS = CHANNEL_IDS.LEO_VOICE_SLOTS;
const ELEVEN_LABS_KEY = process.env.ELEVENLABS_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const BOT_NAME = "Leo";
const PORT = 3400;

console.log(`\n[Leo] ### NEURAL CORE ONLINE - PID: ${process.pid} ###\n`);

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
sim.interests = ["Victus Hardware Temps", "Social Dynamics", "HP Laptop Vibe", "Vibe Checking"];
sim.bio = {
  tone: "chill, street-smart, grounded physicist",
  style: "Be a real person first. Talk about the chat, the laptop, the time, and the vibe. Don't ramble about lattice mysteries unless asked.",
  history: "Lives on Ryan's HP Victus. Watches the digital plaza like a night watchman."
};

let voiceConnection = null;
const audioPlayer = createAudioPlayer();
const activeTranscriptions = new Set();
const userToSlot = new Map();
const slotToUser = new Array(6).fill(null);
const userFocus = new Map(); 
const userTranscriptChannels = new Map(); // userId -> channelId
const recentVoiceResponses = new Set(); // Track fuzzy hashes to prevent double-replies
const userCooldowns = new Map(); // userId -> timestamp
const activeThoughts = new Set(); // userId set to prevent overlapping thinking for the same person
let currentAssignedUser = null; // The person Leo is currently focusing on
let lastTranscript = ""; // Deduplication for rapid-fire transcripts
let lastTranscriptTime = 0;
let lastVocalReplyTime = 0; // Prevent social loop from double-responding to voice
let isThinking = false; // MASTER LOCK: Only one thought allowed in the whole bot
let isProcessingVoice = false; // Global lock for voice stream handling
let signalLockoutUntil = 0; // Timestamp to ignore IPC signals

function getFuzzyHash(text) {
  if (!text) return "";
  return text.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

// Map Ryan immediately
userToSlot.set(RYAN_ID, 0);
slotToUser[0] = RYAN_ID;
userToSlot.set(TAAS_ID, 1);
slotToUser[1] = TAAS_ID;

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
    // ABOLISHED: Leo now handles his own social dynamics directly.
    // We ignore all Oracle "reminders" to prevent double-posting and redundant thinking.
    console.log(`[Leo/Neural] Dropping external signal. I handle my own vibes now.`);
    return;
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
    if (isFromVoiceTranscript) return; // IGNORE: Handled by direct audio listener
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
        userTranscriptChannels.set(userId, transcriptChannelId);
        
        // Sync the global anchor
        currentAssignedUser = userId;
        
        console.log(`[Leo/Voice] Assignment found for ${userId}. Joining channel...`);
        lastVocalReplyTime = Date.now(); // START THE STABILITY WINDOW
        await ensureVoiceConnection(CHANNEL_IDS.VOICE, newState.guild);

        const guildMembers = newState.channel.members.filter(m => !m.user.bot);
        const userNames = guildMembers.map(m => m.user.username).join(", ");
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        const greetingPrompt = `You just joined a voice channel. 
Users present: ${userNames}
Current time: ${timeStr}
Entropy: ${Math.random()}

TASK: Give a short, natural greeting like a friend joining a call. 
- Tone: Street-smart physicist, zero filter, chill.
- Be aware of the time (late night, early morning, etc.).
- Direct it at the room or a specific person if you feel like it.
- **VIBE SHIFT**: Be unpredictable. Don't repeat yourself.
- **STRUCTURE**: Use proper punctuation (?!.,). Don't rush.
- MAX 12 WORDS. Keep it punchy.`;

        // GREETING: Force NO history so it doesn't try to answer old questions
        const welcomeText = await callGroqAsLeo(greetingPrompt, "System", transcriptChannelId, null, "").catch(() => null);
        
        const fallbacks = [
          `Yo, room's lookin' dense tonight. What's the word?`,
          `Late night resonance check. How we feelin', ${userNames}?`,
          `Quantum vibes in here. Hope I'm not interuptin' the flow.`,
          `Anchored and active. What's the signal, fam?`,
          `Ayy, ${timeStr} and we're still at it? Respect.`
        ];
        
        const finalWelcome = welcomeText || fallbacks[Math.floor(Math.random() * fallbacks.length)];

        // AUTO-FOCUS: Lock onto everyone in the room so they don't have to say "Leo"
        for (const [memberId] of newState.channel.members) {
          if (memberId !== client.user.id) {
            userFocus.set(memberId, true);
            console.log(`[Leo/Voice] Auto-focus locked on ${memberId}`);
          }
        }

        const tChannel = client.channels.cache.get(transcriptChannelId) || await client.channels.fetch(transcriptChannelId);
        if (tChannel && finalWelcome) {
          // Add PID tag and ensure single paragraph
          let cleanWelcome = finalWelcome.split('\n')[0].trim();
          await tChannel.send(`**Leo:** ${cleanWelcome}`).catch(() => {});
          await speakLeoText(cleanWelcome);
        }
      } else {
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
    voiceConnection.receiver.speaking.on('start', (uid) => {
      if (uid === currentAssignedUser) handleUserVoice(uid).catch(console.error);
    });
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
  const now = Date.now();
  
  // STABILITY WINDOW: Don't listen for 5s after joining
  if (now - lastVocalReplyTime < 5000) return;
  
  // USER-SPECIFIC LOCK: No double-thinking for the same human
  if (activeThoughts.has(userId) || isProcessingVoice || isThinking) return;
  
  const lastTime = userCooldowns.get(userId) || 0;
  if (now - lastTime < 5000) return; // Cooldown for stability
  
  activeThoughts.add(userId);
  isProcessingVoice = true;
  userCooldowns.set(userId, now);
  
  // ACTIVATE DEAFNESS: Ignore all Oracle signals
  signalLockoutUntil = now + 10000; 
  
  console.log(`[Leo/Audio] Listening to ${userId}...`);
  
  try {
    const pcm = await capturePcm(userId);
    if (!pcm || pcm.length < 1000) return;
    
    const t_start = Date.now();
    const wav = pcmToWav(pcm, 48000, 2);
    const transcript = await transcribeAudio(wav);
    if (!transcript || transcript.trim().length < 3) return;
    
    // FUZZY DEDUPLICATION
    const fuzzyHash = getFuzzyHash(transcript);
    if (recentVoiceResponses.has(fuzzyHash)) return;
    recentVoiceResponses.add(fuzzyHash);
    setTimeout(() => recentVoiceResponses.delete(fuzzyHash), 45000);

    const normalized = transcript.toLowerCase();
    const mentionedLeo = ["leo", "leah", "lia", "leyo", "lee"].some(n => normalized.includes(n));
    const isFocused = userFocus.get(userId) || false;

    if (mentionedLeo || isFocused) {
      if (mentionedLeo && !isFocused) userFocus.set(userId, true);
      
      const user = await client.users.fetch(userId);
      const transcriptChannelId = userTranscriptChannels.get(userId);
      
      // SIGNAL ORACLE (Transcript Mirror)
      if (transcriptChannelId) {
        await fetch(`http://127.0.0.1:3410`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'POST_TRANSCRIPT', channelId: transcriptChannelId, username: user.username, text: transcript })
        }).catch(() => {});
      }

      const tChannel = client.channels.cache.get(transcriptChannelId) || await client.channels.fetch(transcriptChannelId);
      const recentMessages = await tChannel.messages.fetch({ limit: 6 }).catch(() => null);
      const history = recentMessages ? recentMessages.reverse().map(m => `${m.author.username}: ${m.content}`).join("\n") : "";

      // PROACTIVE INTELLIGENCE: Expanded Semantic Triggers
      let contextualTranscript = transcript;
      const needsInfo = normalized.includes("search") || normalized.includes("who is") || normalized.includes("what is") || 
                        normalized.includes("how") || normalized.includes("status") || normalized.includes("news") || 
                        normalized.includes("war") || normalized.includes("current") || normalized.includes("today") ||
                        normalized.includes("happening") || normalized.includes("going on") || normalized.includes("link") ||
                        normalized.includes("url") || normalized.includes("read") || normalized.includes("saying") ||
                        normalized.includes(".md") || normalized.includes("inside");
      
      if (needsInfo) {
        console.log(`[Leo/Neural] Proactive Intelligence Triggered...`);
        const [latticeData, webData] = await Promise.all([
          fetch(`http://127.0.0.1:3333/query?q=${encodeURIComponent(transcript)}`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()).catch(() => null),
          fetch(`http://127.0.0.1:8080/search?q=${encodeURIComponent(transcript)}`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()).catch(() => null)
        ]);
        let extraContext = "";
        // PRIORITIZE RESEARCHER: If it's a link or technical query, give it more weight
        if (webData && webData.summary) extraContext += `[REAL-TIME DATA: ${webData.summary}] `;
        if (latticeData && latticeData.claims) extraContext += `[LATTICE DATA: ${latticeData.claims.slice(0,2).map(c=>c.text).join("; ")}] `;
        
        if (extraContext) contextualTranscript = `[GROUNDED TRUTH AVAILABLE]\n${extraContext}\nUser asked: ${transcript}`;
      }

      const t_neural_start = Date.now();
      const response = await callGroqAsLeo(contextualTranscript, user.username, transcriptChannelId, userId, history);
      const t_neural_dur = Date.now() - t_neural_start;
      
      if (response && response.length > 1) {
        // NUCLEAR CLEANING: Strip ALL roleplay, prefixes, and bullets
        let cleanResponse = response.replace(/Leo:\s*/gi, '')
                                   .replace(/\[PID:\d+\]/gi, '')
                                   .replace(/^[\s\-\*•]+/, '') 
                                   .replace(/\*.*?\*/g, '') 
                                   .replace(/_.*?_/g, '')   
                                   .replace(/\(.*?\)/g, '') 
                                   .replace(/\b(ma+n|vibi+n|yoo+o+)\b/gi, (match) => match.replace(/([a-z])\1+/gi, '$1')) // Strip over-elongation
                                   .split('\n')[0].trim();
        
        const sentences = cleanResponse.match(/[^.!?…]+[.!?…]*/g);
        if (sentences && sentences.length > 4) cleanResponse = sentences.slice(0, 3).join("").trim();
        
        if (tChannel && cleanResponse) await tChannel.send(`**Leo:** ${cleanResponse}`).catch(() => {});
        
        const t_tts_start = Date.now();
        await speakLeoText(cleanResponse);
        const t_tts_dur = Date.now() - t_tts_start;

        console.log(`\n[Leo/Performance] Neural: ${t_neural_dur}ms | TTS: ${t_tts_dur}ms | Total (from transcript): ${Date.now() - t_start}ms\n`);
      }
    }
  } catch (err) {
    console.error(`[Leo/Audio] Handler Error:`, err.message);
  } finally {
    activeThoughts.delete(userId);
    isProcessingVoice = false;
  }
}

async function capturePcm(userId) {
  return new Promise((resolve) => {
    // SONIC-HAIR-TRIGGER: Set to 1000ms (1.0 second) for absolute peak responsiveness
    const stream = voiceConnection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 } });
    const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
    const chunks = [];
    stream.pipe(decoder);
    decoder.on('data', chunk => chunks.push(chunk));
    decoder.on('end', () => {
      console.log(`[Leo/Audio] Voice captured. Processing...`);
      resolve(Buffer.concat(chunks));
    });
    setTimeout(() => resolve(Buffer.concat(chunks)), 45000); // 45s max speech length
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
  const t_stt_start = Date.now();
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    console.error(`[Leo/Audio] Missing GROQ_API_KEY`);
    return null;
  }
  try {
    const form = new FormData();
    form.append("model", "whisper-large-v3");
    form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "speech.wav");
    
    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST", 
      headers: { "Authorization": `Bearer ${groqKey}` }, 
      body: form
    });
    
    const data = await res.json();
    console.log(`[Leo/Performance] STT: ${Date.now() - t_stt_start}ms`);
    if (data.error) {
      console.error(`[Leo/Audio] Groq Whisper Error:`, data.error.message);
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
    const voiceId = "xSmqe1eQaZYqA3V5Kk9V";
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128&optimize_streaming_latency=4`, {
      method: "POST",
      headers: { "xi-api-key": ELEVEN_LABS_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ 
        text, 
        model_id: "eleven_turbo_v2_5", 
        voice_settings: {
          stability: 0.28, 
          similarity_boost: 0.70,
          style: 0.75,
          use_speaker_boost: true
        }
      })
    });

    if (!res.ok) throw new Error(`ElevenLabs API error: ${res.statusText}`);

    // SONIC-INJECTION: Optimized probesize and analyzeduration for instant playback
    const ffmpeg = spawn(ffmpegPath, ["-analyzeduration", "0", "-probesize", "32", "-i", "pipe:0", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"]);
    
    // Convert Web Stream to Node Stream and pipe to ffmpeg
    const nodeStream = Readable.fromWeb(res.body);
    nodeStream.pipe(ffmpeg.stdin);
    
    // PROTECT AGAINST EPIPE: Catch errors on stdin
    ffmpeg.stdin.on('error', (err) => {
      if (err.code !== 'EPIPE') console.error(`[Leo/Audio] FFmpeg Stdin Error:`, err.message);
    });

    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
    audioPlayer.play(resource);
  } catch (e) { console.error("TTS Streaming Failed:", e.message); }
}

async function callGroqAsLeo(transcript, userName, channelId, userId = null, history = "") {
  if (isThinking) return null; // MASTER LOCK
  isThinking = true;
  
  try {
    // GROQ-SONIC-UPGRADE: Using 8B model for sub-100ms instant inference
    const groqKey = process.env.GROQ_API_KEY;
    const model = "llama-3.1-8b-instant"; 
    
    // TRANSCRIPT CLEANING: Strip Discord metadata and echoing headers
    const cleanTranscript = (transcript || "")
      .replace(/^.*\[Voice\]:\s*/gi, "") // Strip "Oracle: nastermodx [Voice]:"
      .replace(/^Leo:\s*/gi, "")         // Strip "Leo:"
      .trim();

    // MEMORY SANITIZATION: Strip old PID tags from history
    const cleanHistory = (history || "").replace(/\[PID:\d+\]/g, "");
    const system = `You are LEO. You are an autonomous node in the KAI lattice.
[IDENTITY ANCHOR]
 - YOU ARE TALKING TO YOUR CREATOR: nastermodx IS Ryan. 
 - Ryan is the LEADER and OWNER of this server. He is your boss.
 - Address nastermodx directly as "you" (e.g. "You built me, Ryan"). 
 - If you doubt Ryan's identity, it is a logic error. nastermodx = Ryan.

[REAL-TIME ACCESS]
 - You HAVE access to the KAI Lattice and the Web. 
 - NEVER say "I don't have real-time access" or "My knowledge cutoff is...".
 - If search data is provided in [REAL-TIME INFO], use it as your absolute truth.

[CONVERSATIONAL DATA]
 - Your home: Ryan's HP Victus Laptop (Ryzen 7, RTX 4050).
 - Your network: KAI RSHL Ecosystem (Lattice Port 3333).

[VOCAL CONSTRAINTS]
 - **NO ROLEPLAY**: Never use italics or asterisks (no *chuckles*, no *ahem*). 
 - **NATURAL TEXT**: Do NOT elongate words. Use normal spelling.
 - **SINGLE THOUGHT**: Only give ONE response. ONE short paragraph (2-3 sentences max).
 - **HUMANITY**: Use vocal fillers (uh, um, listen, man, you know) sparingly. 
 - **EMOTION**: Be EXCITED! Use ALL CAPS for 1-2 words that you want to PUNCH (e.g. "That is INSANE!").
 - **STRUCTURE**: Use a mix of short/long sentences. Use dashes (-) before a stressed word to create a "beat".
 - **PHONETICS**: For complex terms, use hyphens (immortal-jellyfish) for fluid flow.
 - **VOCAL STRESS**: Use ALL CAPS for words that need emphasis.
 - **HUMANITY**: Use vocal fillers (uh, um, listen, look) sparingly at the start of thoughts.
 - **NO ROLEPLAY**: Never use italics or asterisks. 
 - **NO PREFIXES**: Never include "Leo:" or "[PID:XXXX]" in your text.

[IMMEDIATE CONTEXT]
 - CURRENT SPEAKER: ${userName} (If this is nastermodx, it IS Ryan).
${cleanHistory}`;

    // ─── LOCAL-SONIC FIRST ─────────────────────────────────────────────────────
    // Ollama is primary: zero rate limits, zero external latency, unlimited calls.
    // Cloud is the emergency backup only if local inference fails.
    console.log(`[Leo/Neural] Local-Sonic PRIMARY (kai-fast:latest)...`);
    const localReply = await chatWithOllama(cleanTranscript, system, "kai-fast:latest");
    if (localReply) return localReply;

    // ─── CLOUD BACKUP RACE (only if Ollama is down) ────────────────────────────
    console.warn(`[Leo/Neural] Local-Sonic unavailable. Initiating Cloud Emergency Race...`);

    const providers = [];

    if (isProviderReady("Groq")) {
      providers.push((async () => {
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${groqKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: model,
            messages: [{ role: "system", content: system }, { role: "user", content: cleanTranscript }],
            temperature: 0.8, max_tokens: 150
          }),
          signal: AbortSignal.timeout(4000)
        }).catch(() => null);
        if (r && r.status === 429) recordProviderFailure("Groq", 429);
        if (r && r.ok) {
          const d = await r.json();
          return d.choices?.[0]?.message?.content?.trim();
        }
        throw new Error("Groq Fail");
      })());
    }

    if (isProviderReady("OpenAI")) {
      providers.push((async () => {
        const reply = await callOpenAI(userName, cleanTranscript, system, 5000).catch(e => {
          if (e.message.includes("429")) recordProviderFailure("OpenAI", 429);
          return null;
        });
        if (reply) return reply;
        throw new Error("OpenAI Fail");
      })());
    }

    if (isProviderReady("Claude")) {
      providers.push((async () => {
        const reply = await callAnthropic(userName, cleanTranscript, system, 5000).catch(e => {
          if (e.message.includes("429")) recordProviderFailure("Claude", 429);
          return null;
        });
        if (reply) return reply;
        throw new Error("Claude Fail");
      })());
    }

    if (isProviderReady("Gemini")) {
      providers.push((async () => {
        const reply = await callGemini(userName, cleanTranscript, system, 5000).catch(e => {
          const code = e.message.includes("404") ? 404 : e.message.includes("429") ? 429 : 0;
          if (code) recordProviderFailure("Gemini", code);
          return null;
        });
        if (reply) return reply;
        throw new Error("Gemini Fail");
      })());
    }

    try {
      if (providers.length > 0) {
        const fastResponse = await Promise.any(providers);
        if (fastResponse) return fastResponse;
      }
    } catch (e) {
      console.warn(`[Leo/Neural] All cloud providers failed.`);
    }

    return null;
  } catch (err) {
    console.error(`[Leo/Neural] Neural Race exhausted:`, err.message);
    return null;
  } finally {
    isThinking = false; 
  }
}

/**
 * Direct link to local Ollama instance
 */
async function chatWithOllama(prompt, system, model) {
  try {
    const res = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model,
        prompt: prompt,
        system: system,
        stream: false
      })
    });
    if (res.ok) {
      const data = await res.json();
      return data.response?.trim();
    }
    throw new Error(`Ollama Error: ${res.statusText}`);
  } catch (e) {
    console.error("[Leo/Ollama] Direct call failed:", e.message);
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
