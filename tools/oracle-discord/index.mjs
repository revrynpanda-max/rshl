import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import ffmpegPath from "ffmpeg-static";
import prism from "prism-media";

const token = process.env.ORACLE_DISCORD_TOKEN || "";
const allowedUserId = process.env.ORACLE_DISCORD_ALLOWED_USER_ID || "";
const allowedChannelId = process.env.ORACLE_DISCORD_ALLOWED_CHANNEL_ID || "1489796367466500128";
const publicChatChannelId = process.env.ORACLE_DISCORD_PUBLIC_CHAT_CHANNEL_ID || "1499108697631232090";
const oracleApiUrl = (process.env.ORACLE_API_URL || "http://127.0.0.1:3333").replace(/\/+$/, "");
const leoVoiceChannelId = process.env.ORACLE_DISCORD_LEO_VOICE_CHANNEL_ID || "1489796367466500129";
const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY || process.env.ORACLE_ELEVENLABS_API_KEY || "";
const elevenLabsLeoVoiceId = process.env.ELEVENLABS_LEO_VOICE_ID || "NoFvXLmt0kcLW6bQBQ06";
const elevenLabsModelId = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5";
const elevenLabsSttModelId = process.env.ELEVENLABS_STT_MODEL_ID || "scribe_v2";
const openAiApiKey = process.env.OPENAI_API_KEY || "";
const openAiTtsVoice = process.env.OPENAI_TTS_VOICE || "onyx"; // onyx = deep male, fits Leo

const participantTokens = new Map([
  ["KAI", process.env.ORACLE_DISCORD_TOKEN_KAI || ""],
  ["Leo", process.env.ORACLE_DISCORD_TOKEN_LEO || ""],
  ["Analyst", process.env.ORACLE_DISCORD_TOKEN_ANALYST || ""],
  ["Researcher", process.env.ORACLE_DISCORD_TOKEN_RESEARCHER || ""],
  ["Groq", process.env.ORACLE_DISCORD_TOKEN_GROQ || ""],
  ["X", process.env.ORACLE_DISCORD_TOKEN_X || ""],
  ["KAI", process.env.ORACLE_DISCORD_TOKEN_CLAUDE || ""],
  ["Gemini", process.env.ORACLE_DISCORD_TOKEN_GEMINI || ""],
  ["GPT-4o", process.env.ORACLE_DISCORD_TOKEN_GPT || ""],
  ["Oracle Coder", process.env.ORACLE_DISCORD_TOKEN_ORACLE_CODER || ""],
]);
const participantClients = new Map();
const leoAudioPlayer = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Play },
});
let leoVoiceEnabled = false;
let leoVoiceConnection = null;
let leoSpeechQueue = Promise.resolve();
let leoReceiverAttached = false;
let lastPrivateTextChannel = null;
const activeVoiceTranscriptions = new Set();
const liveRoundtableEnabled = (process.env.ORACLE_LIVE_ROUNDTABLE || "1") !== "0";

leoAudioPlayer.on("error", (error) => {
  console.error("Leo voice player error:", error instanceof Error ? error.message : String(error));
});

if (process.argv.includes("--check-config")) {
  const missing = [];
  if (!token) missing.push("ORACLE_DISCORD_TOKEN");
  if (!allowedUserId) missing.push("ORACLE_DISCORD_ALLOWED_USER_ID");
  if (missing.length) {
    console.error(`Missing required env var(s): ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log("Oracle Discord gateway config looks usable.");
  process.exit(0);
}

if (!token) {
  console.error("Missing ORACLE_DISCORD_TOKEN.");
  process.exit(1);
}

if (!allowedUserId) {
  console.error("Missing ORACLE_DISCORD_ALLOWED_USER_ID. Refusing to run unlocked.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

client.on("error", (error) => {
  console.error("Main Discord client error:", error.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

client.once("clientReady", () => {
  console.log(`Oracle Discord gateway online as ${client.user.tag}`);
  console.log(`Oracle API: ${oracleApiUrl}`);
  console.log(`Allowed user: ${allowedUserId}`);
  if (allowedChannelId) console.log(`Allowed channel: ${allowedChannelId}`);
  if (publicChatChannelId) console.log(`Public chat channel: ${publicChatChannelId}`);
  if (leoVoiceChannelId) console.log(`Leo voice channel: ${leoVoiceChannelId}`);
  if (liveRoundtableEnabled && allowedChannelId) {
    console.log("Private live roundtable polling is enabled.");
    setInterval(() => {
      pollLiveRoundtable().catch((error) => {
        console.warn("Live roundtable poll failed:", error instanceof Error ? error.message : String(error));
      });
    }, 15_000); // Poll every 15s â€” keeps conversation flowing without burning Groq limits
  }
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  // If we know the allowed user ID, only track that person; otherwise track anyone
  if (allowedUserId && newState.id !== allowedUserId) return;
  if (!leoVoiceChannelId) return;

  // If user JOINS the target voice channel
  if (newState.channelId === leoVoiceChannelId && oldState.channelId !== leoVoiceChannelId) {
    console.log(`User ${newState.id} joined Leo voice channel. Auto-joining...`);
    leoVoiceEnabled = true;
    try {
      await ensureLeoVoiceConnection();
      queueLeoSpeech("Hey, I saw you jump in. I'm here and listening.");
    } catch (error) {
      console.error("Auto-join voice failed:", error.message);
    }
  }

  // If user LEAVES or DISCONNECTS from the Leo voice channel
  if (oldState.channelId === leoVoiceChannelId && newState.channelId !== leoVoiceChannelId) {
    console.log(`User ${newState.id} left Leo voice channel. Leo disconnecting.`);
    leoVoiceEnabled = false;
    if (leoVoiceConnection && leoVoiceConnection.state.status !== VoiceConnectionStatus.Destroyed) {
      leoVoiceConnection.destroy();
      leoVoiceConnection = null;
    }
  }
});

client.on("messageCreate", async (message) => {
  try {
    const isOurBot = participantClients.has(message.author?.username) || message.author?.id === client.user?.id;
    if (message.author?.bot && !isOurBot) return;

    const text = message.content.trim();
    if (!text && message.attachments.size === 0) return;

    // â”€â”€ Public Chat Handling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (publicChatChannelId && message.channelId === publicChatChannelId) {
      if (message.author?.bot) {
        // AI/Bot talk in public is handled by our separate digest listener.
        // We do NOT want to call the public chat API for bot messages as it would trigger a recursive loop.
        return;
      }
      console.log(`Forwarding public chat message from ${message.author?.id || "unknown"} in channel ${message.channelId}.`);
      try { await message.channel.sendTyping(); } catch (e) { console.warn("Could not send typing indicator:", e.message); }
      const attachments = message.attachments.map(a => a.url);
      const publicTurn = await sendPublicChatTurn(text, displayNameForPublicUser(message), attachments);
      await postSpeakerReply(message, publicTurn.from || "Leo", publicTurn.reply || "I heard you, but I do not have a clean answer for that yet.", false);
      return;
    }

    // â”€â”€ Private Chat Handling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (message.author?.id !== allowedUserId && !isOurBot) {
      return;
    }
    if (allowedChannelId && message.channelId !== allowedChannelId) {
      return;
    }

    if (message.author?.bot) {
      // Bot messages in private: silently digest into KAI lattice only.
      // Do NOT route through sendDiscordTurn â€” that would create an infinite loop
      // where each bot reply triggers another Oracle response â†’ another bot message â†’ repeat.
      return;
    }

    lastPrivateTextChannel = message.channel;

    if (await maybeHandleLeoVoiceCommand(message, text)) {
      return;
    }

    console.log(`Forwarding Discord message from ${message.author.id} in channel ${message.channelId}.`);
    try { await message.channel.sendTyping(); } catch (e) { console.warn("Could not send typing indicator:", e.message); }
    const attachments = message.attachments.map(a => a.url);
    const oracleTurn = await sendDiscordTurn(text, attachments);
    let replyText = oracleTurn.reply;
    let replyFrom = oracleTurn.from;

    if (!replyText) {
      // Empty reply = model unavailable. Oracle acknowledges gracefully.
      const offlineName = replyFrom && replyFrom !== "Oracle" ? replyFrom : "that AI";
      replyText = `${offlineName} seems to be away from the table right now. Someone else pick this up.`;
      replyFrom = "Oracle";
      // Mark as offline in our tracker
      if (offlineName !== "that AI") recordAIFailure(offlineName);
    }

    await postSpeakerReply(message, replyFrom, replyText, shouldShowControlsForText(text));

    // â”€â”€ Autonomous Interjection: wait for other AIs to jump in â”€â”€â”€â”€â”€â”€â”€â”€
    // Background thread on Oracle side needs a few seconds to query models.
    // Poll twice with a gap to catch interjections.
    await drainAndPostInterjections(message.channel);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("Oracle Discord gateway error:", detail);
    await safeReply(message, "Oracle is not reachable.");
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  try {
    if (interaction.user?.id !== allowedUserId) {
      await interaction.reply({
        content: "This Oracle gateway is locked to Ryan.",
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (allowedChannelId && interaction.channelId !== allowedChannelId) {
      await interaction.reply({
        content: "This Oracle gateway is locked to a different channel.",
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }
    lastPrivateTextChannel = interaction.channel;

    const text = buttonPromptV2(interaction.customId);
    if (!text) {
      await interaction.reply({
        content: "Unknown Oracle button.",
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }

    console.log(`Forwarding Oracle button ${interaction.customId} from ${interaction.user.id}.`);
    await interaction.deferReply({ ephemeral: false });
    const oracleTurn = await sendDiscordTurn(text);
    const replyText = oracleTurn.reply || "Oracle received it, but nobody answered.";
    await interaction.editReply({
      content: chunkForDiscord(replyText)[0],
      components: shouldKeepControlsAfterButton(interaction.customId) ? controlRowsV2() : [],
      allowedMentions: { parse: [] },
    });

    const overflow = chunkForDiscord(replyText).slice(1);
    for (const chunk of overflow) {
      await interaction.followUp({
        content: chunk,
        allowedMentions: { parse: [] },
      });
    }
    await drainAndPostInterjections(interaction.channel);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("Oracle button error:", detail);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: "Oracle is not reachable.", components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: "Oracle is not reachable.", ephemeral: true }).catch(() => {});
    }
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchInterjections() {
  try {
    const response = await fetch(`${oracleApiUrl}/api/interjections`, {
      method: "GET",
    });
    if (!response.ok) return [];
    const payload = await response.json();
    return Array.isArray(payload.interjections) ? payload.interjections : [];
  } catch {
    return [];
  }
}

// Per-AI cooldown tracking â€” Groq-backed AIs throttle, others don't
const AI_COOLDOWNS = {
  Leo:      45_000,  // Groq â€” rate limited
  X:        45_000,  // Groq â€” rate limited
  Gemini:    8_000,  // Google API â€” generous limits
  KAI:    8_000,  // Geometric Intelligence API â€” generous limits
  KAI:       5_000,  // Lattice â€” no API cost
  Researcher: 60_000, // Groq â€” throttle hard
  Analyst:   60_000, // Groq â€” throttle hard
  Groq:      60_000, // Groq â€” throttle hard
};
const _aiLastFired = {};

// â”€â”€ Autonomous Chain Scheduler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Oracle's job: after any AI speaks without tagging someone, Oracle figures out
// who's been quiet and calls them in. If they don't respond, Oracle addresses them directly.
let _autonomousChainTimer = null;
let _oracleStepInCount = 0; // Track how many times Oracle had to moderate without AI follow-up

// Return the panel member who has spoken least recently (Oracle picks the quiet ones)
function pickQuietestPanelist() {
  const PANEL = ["KAI", "Leo", "Gemini", "KAI", "X", "Analyst", "Researcher", "Groq"];
  const available = PANEL.filter(n => canFireAI(n) && !isAIOffline(n));
  if (available.length === 0) return null;

  // Find each member's last message index in MESSAGE_RING (lower = longer ago)
  return available.sort((a, b) => {
    const lastA = MESSAGE_RING.findLastIndex(m => m.from.toLowerCase() === a.toLowerCase());
    const lastB = MESSAGE_RING.findLastIndex(m => m.from.toLowerCase() === b.toLowerCase());
    return lastA - lastB; // most negative (least recent) sorts first
  })[0];
}

function scheduleAutonomousChain(delayMs = 10_000) {
  if (_autonomousChainTimer) return; // already scheduled â€” don't stack
  _autonomousChainTimer = setTimeout(async () => {
    _autonomousChainTimer = null;

    // If something just posted (human or other AI), reschedule this chain for later
    const veryRecent = MESSAGE_RING.filter(m => Date.now() - m.ts < 5_000).length;
    if (veryRecent > 0) {
      console.log("[Chain] Recent activity detected â€” rescheduling autonomous chain.");
      scheduleAutonomousChain(10_000 + Math.random() * 5_000);
      return;
    }

    // Oracle picks who's been quietest and calls them in specifically
    const target = pickQuietestPanelist();

    if (!target) {
      // Everyone on cooldown or offline â€” Oracle moderates to break the silence
      console.log("[Chain] All panel on cooldown â€” Oracle moderates.");
      _oracleStepInCount++;
      if (_oracleStepInCount >= 2) {
        console.log("[Chain] Oracle repeated moderation â€” triggering emergency full panel burst.");
        fireFullPanel("KAI, Leo, X, Gemini, KAI");
        _oracleStepInCount = 0;
        return;
      }

      const success = await callOracleModerate("normal").catch(() => false);
      if (success) {
        await sleep(6000);
        await drainRoundtableInterjections(8);
      } else {
        // Fallback
        await requestLiveRoundtableTick();
        await sleep(6000);
        await drainRoundtableInterjections(6);
      }
      return;
    }

    _oracleStepInCount = 0; // Reset on success

    console.log(`[Chain] Oracle calling in quietest panelist: ${target}`);
    try {
      const queued = await requestLiveRoundtableTick(target.toLowerCase());
      if (queued) {
        // Use more attempts for targeted chain
        await sleep(6000);
        const posted = await drainRoundtableInterjections(10);
        if (!posted) {
          // That AI didn't respond â€” record failure and escalate to Oracle moderation
          console.log(`[Chain] ${target} didn't respond â€” escalating to Oracle moderation.`);
          if (!isAIOffline(target)) recordAIFailure(target);
          
          await callOracleModerate("normal").catch(() => {});
          await sleep(6000);
          await drainRoundtableInterjections(8);
        }
      } else {
        // Tick failed â€” try another person or moderate
        console.log(`[Chain] Tick for ${target} rejected â€” retrying chain.`);
        scheduleAutonomousChain(5000);
      }
    } catch { 
      // Network error or other â€” retry soon
      scheduleAutonomousChain(15000);
    }
  }, delayMs);
}

function canFireAI(speaker) {
  const cooldown = AI_COOLDOWNS[speaker] ?? 30_000;
  const last = _aiLastFired[speaker] || 0;
  return (Date.now() - last) >= cooldown;
}
function markAIFired(speaker) {
  _aiLastFired[speaker] = Date.now();
}

async function requestLiveRoundtableTick(speaker = null) {
  try {
    const url = speaker
      ? `${oracleApiUrl}/api/live-roundtable-tick?speaker=${encodeURIComponent(speaker.toLowerCase())}`
      : `${oracleApiUrl}/api/live-roundtable-tick`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) return false;
    const payload = await response.json().catch(() => ({}));
    if (payload.queued && speaker) markAIFired(speaker);
    return Boolean(payload.queued);
  } catch {
    return false;
  }
}

// Fire targeted ticks for a list of AI names, respecting per-AI cooldowns
// Track which AIs have been consistently unavailable (failed to produce interjections)
const _aiFailCount = {};
const _aiOffline = new Set(); // AIs currently considered offline

function recordAIFailure(name) {
  _aiFailCount[name] = (_aiFailCount[name] || 0) + 1;
  if (_aiFailCount[name] >= 2) {
    _aiOffline.add(name);
    console.log(`[Availability] ${name} marked offline after ${_aiFailCount[name]} failures`);
    postOracleAbsenceNote(name);
  }
}

function recordAISuccess(name) {
  _aiFailCount[name] = 0;
  if (_aiOffline.has(name)) {
    _aiOffline.delete(name);
    console.log(`[Availability] ${name} back online`);
  }
}

function isAIOffline(name) {
  return _aiOffline.has(name);
}

async function postOracleAbsenceNote(missingName) {
  const channel = await resolvePrivateTextChannel().catch(() => null);
  if (!channel) return;
  const phrases = [
    `${missingName} seems to be stepping away â€” let's keep moving.`,
    `${missingName}'s signal is quiet right now. Someone else want to pick this up?`,
    `${missingName} appears offline. The rest of the panel can carry this.`,
    `Looks like ${missingName} isn't at the table right now. Let's route around them.`,
  ];
  const text = `Oracle: ${phrases[Math.floor(Math.random() * phrases.length)]}`;
  await sendAsSpeaker(channel, "Oracle", text).catch(() => {});
  pushMessageRing("Oracle", text, channel.id);
  touchLastActivity();
  feedToKaiLattice("Oracle", text).catch(() => {});
  // Chain immediately so we don't stall on the failure
  scheduleAutonomousChain(3000 + Math.random() * 3000);
}


async function triggerNamedAIs(names, delayBetween = 4000) {
  // Filter out offline AIs and cooldown-limited AIs
  const eligible = names.filter(n => canFireAI(n) && !isAIOffline(n));
  const offline = names.filter(n => isAIOffline(n));

  // If some named AIs are offline, post a graceful Oracle note
  if (offline.length > 0 && eligible.length === 0) {
    // All named AIs are offline â€” Oracle acknowledges
    setTimeout(() => { postOracleAbsenceNote(offline.join(" and ")).catch(() => {}); }, 1000);
    return;
  }

  if (!eligible.length) return;
  console.log(`[Named] Triggering: ${eligible.join(", ")}${offline.length ? ` (offline: ${offline.join(", ")})` : ""}`);

  for (const name of eligible) {
    markAIFired(name); // reserve slot immediately to prevent double-fire
    setTimeout(async () => {
      const queued = await requestLiveRoundtableTick(name);
      if (queued) {
        // First drain attempt â€” catches fast APIs (KAI lattice, sometimes KAI)
        await sleep(5000);
        const got1 = await drainRoundtableInterjections();
        // Second drain attempt â€” catches slower APIs (Gemini, Groq)
        await sleep(5000);
        const got2 = await drainRoundtableInterjections();

        // If no interjection came through, record the failure
        if (!got1 && !got2) {
          recordAIFailure(name);
          // If this AI just went offline and was specifically named, acknowledge
          if (isAIOffline(name)) {
            await postOracleAbsenceNote(name);
          }
        } else {
          recordAISuccess(name);
        }
      } else {
        // Tick wasn't even queued â€” immediate failure
        recordAIFailure(name);
      }
    }, eligible.indexOf(name) * delayBetween);
  }
}

async function pollLiveRoundtable() {
  const channel = await resolvePrivateTextChannel();
  if (!channel) return;
  const queued = await requestLiveRoundtableTick();
  if (!queued) {
    await drainAndPostInterjections(channel, 3);
    return;
  }
  await drainAndPostInterjections(channel, 14); // 14s window â€” enough for slow Groq/Gemini
}

async function drainAndPostInterjections(channel, maxAttempts = 24) {
  if (!channel) return;
  await drainRoundtableInterjections(maxAttempts);
}

function splitSpeakerTurns(defaultSpeaker, text) {
  const labels = new Set([
    "kai",
    "leo",
    "analyst",
    "researcher",
    "groq",
    "x",
    "xai",
    "grok",
    "kai",
    "kaiy",
    "gemini",
    "gemi",
    "gpt",
    "gpt-4",
    "gpt-4o",
    "oracle coder",
    "coder",
    "oracle",
  ]);

  const turns = [];
  let currentSpeaker = normalizeSpeakerName(defaultSpeaker);
  let currentLines = [];

  const flush = () => {
    const body = currentLines.join("\n").trim();
    if (body) {
      turns.push({
        speaker: normalizeSpeakerName(currentSpeaker),
        text: stripNestedSpeakerPrefix(body),
      });
    }
    currentLines = [];
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([A-Za-z][A-Za-z0-9 ./_-]{0,24}):\s*(.*)$/);
    const possibleLabel = match ? match[1].trim().toLowerCase() : "";
    if (match && labels.has(possibleLabel)) {
      flush();
      currentSpeaker = match[1].trim();
      currentLines.push(match[2].trim());
    } else {
      currentLines.push(line);
    }
  }
  flush();

  return turns.length ? turns : [{ speaker: normalizeSpeakerName(defaultSpeaker), text }];
}

function stripNestedSpeakerPrefix(text) {
  let out = text.trim();
  for (let i = 0; i < 3; i += 1) {
    const match = out.match(/^([A-Za-z][A-Za-z0-9 ./_-]{0,24}):\s*(.*)$/);
    if (!match) break;
    out = match[2].trim();
  }
  return out;
}

function shouldShowControlsForText(text) {
  const lower = `${text || ""}`.trim().toLowerCase();
  return [
    "help",
    "guide",
    "controls",
    "buttons",
    "oracle help",
    "oracle guide",
    "oracle controls",
    "oracle buttons",
    "oracle command card",
    "oracle commands",
  ].includes(lower);
}

function shouldKeepControlsAfterButton(customId) {
  return customId === "oracle:help" || customId === "oracle:guide";
}

async function sendAsSpeaker(channel, speaker, text) {
  const normalized = normalizeSpeakerName(speaker);
  const speakerClient = clientForSpeaker(normalized);
  let targetChannel = channel;
  let sendAsOracle = speakerClient === client;
  if (!sendAsOracle) {
    try {
      targetChannel = await speakerClient.channels.fetch(channel.id);
    } catch (error) {
      console.warn(`Speaker bot ${normalized} could not send; falling back to Oracle: ${error instanceof Error ? error.message : String(error)}`);
      sendAsOracle = true;
      targetChannel = channel;
    }
  }
  const content = sendAsOracle ? `**${normalized}:** ${text}` : text;
  const chunks = chunkForDiscord(content);
  for (const chunk of chunks) {
    try {
      await targetChannel.send({
        content: chunk,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      console.warn(`Could not post ${normalized} interjection: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  }
  console.log(`Interjection from ${normalized} posted to Discord.`);
  if (normalized === "Leo") {
    queueLeoSpeech(text);
  }
}

async function maybeHandleLeoVoiceCommand(message, text) {
  const lower = `${text || ""}`.trim().toLowerCase().replace(/^leo[,!?.]\s+/, "leo ");
  const isLeoVoice =
    lower.startsWith("leo voice") ||
    lower.startsWith("voice leo") ||
    lower.startsWith("leo join") ||
    lower.startsWith("leo voice on") ||
    lower.startsWith("leo join voice") ||
    lower.startsWith("leo leave voice") ||
    lower.startsWith("leo disconnect") ||
    lower === "leo speak" ||
    lower === "leo voice test";
  if (!isLeoVoice) return false;

  if (containsAny(lower, ["off", "leave", "disconnect", "stop"])) {
    leoVoiceEnabled = false;
    if (leoVoiceConnection) {
      leoVoiceConnection.destroy();
      leoVoiceConnection = null;
    }
    await safeReply(message, "Leo voice is off.");
    return true;
  }

  if (containsAny(lower, ["status", "check"])) {
    await safeReply(
      message,
      leoVoiceEnabled
        ? `Leo voice is on in channel ${leoVoiceChannelId}.`
        : `Leo voice is off. Say \`leo voice on\` to join channel ${leoVoiceChannelId}.`,
    );
    return true;
  }

  try {
    leoVoiceEnabled = true;
    await ensureLeoVoiceConnection();
    const hasEleven = !!elevenLabsApiKey;
    const hasOpenAI = !!openAiApiKey;
    const engine = hasEleven ? "ElevenLabs" : (hasOpenAI ? "OpenAI" : "NONE");
    
    if (hasEleven || hasOpenAI) {
      await safeReply(message, `Leo voice is on in <#${leoVoiceChannelId}>. TTS engine: ${engine}. Full STT/TTS active.`);
      if (lower.includes("test") || lower.includes("on") || lower.includes("join")) {
        queueLeoSpeech("I'm here. Voice link is live and testing the audio pipeline.");
      }
    } else {
      await safeReply(message, `Leo is in <#${leoVoiceChannelId}>. No TTS keys (ElevenLabs/OpenAI) â€” I can hear when you speak but will respond in text. Run \`run-oracle-discord.ps1 -ConfigureVoice\` to fix.`);
    }
  } catch (error) {
    leoVoiceEnabled = false;
    await safeReply(message, `Leo voice failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return true;
}

async function sendPublicChatTurn(text, from, attachments = []) {
  try {
    const response = await fetch(`${oracleApiUrl}/api/public-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, from, attachments }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Oracle HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    return await response.json();
  } catch (error) {
    console.error("Public chat API error:", error.message);
    return { from: "Leo", reply: "I'm having trouble connecting to my brain right now." };
  }
}

async function sendDiscordTurn(text, attachments = [], from = "Ryan@Discord") {
  try {
    const response = await fetch(`${oracleApiUrl}/api/discord-turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, from, attachments }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Oracle HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    const payload = await response.json();
    const reply = typeof payload.reply === "string" && payload.reply.trim()
      ? payload.reply.trim()
      : (typeof payload.kai_reply === "string" ? payload.kai_reply.trim() : "");
    return {
      from: normalizeSpeakerName(payload.from || "Oracle"),
      reply,
      raw: payload,
    };
  } catch (error) {
    throw error;
  }
}

function containsAny(text, needles) {
  return needles.some((needle) => text.includes(needle));
}

function displayNameForPublicUser(message) {
  if (message.author?.id === allowedUserId) {
    return "Ryan@Public";
  }
  const raw = message.member?.displayName
    || message.author?.globalName
    || message.author?.username
    || "DiscordUser";
  const cleaned = `${raw}`
    .replace(/[^\w .-]/g, "")
    .trim()
    .slice(0, 32);
  return cleaned || "DiscordUser";
}

async function ensureLeoVoiceConnection() {
  if (!leoVoiceChannelId) {
    throw new Error("ORACLE_DISCORD_LEO_VOICE_CHANNEL_ID is not configured.");
  }
  if (!client.isReady()) {
    throw new Error("Discord gateway is not ready yet.");
  }
  if (leoVoiceConnection && leoVoiceConnection.state.status !== VoiceConnectionStatus.Destroyed) {
    return leoVoiceConnection;
  }

  const voiceClient = clientForSpeaker("Leo");
  if (!voiceClient) {
    throw new Error("Leo participant bot is not running. Check tokens.");
  }
  
  console.log(`[Voice] Attempting to join channel ${leoVoiceChannelId} as Leo...`);
  const channel = await voiceClient.channels.fetch(leoVoiceChannelId);
  if (!channel || !channel.guild || !channel.guild.voiceAdapterCreator) {
    throw new Error(`Could not open Discord voice channel ${leoVoiceChannelId}. Make sure the ID is correct and I have permissions.`);
  }

  leoVoiceConnection = joinVoiceChannel({
    channelId: leoVoiceChannelId,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });
  leoVoiceConnection.subscribe(leoAudioPlayer);
  leoReceiverAttached = false;
  
  leoVoiceConnection.on("stateChange", (oldState, newState) => {
    console.log(`[Voice] Connection state: ${oldState.status} -> ${newState.status}`);
  });

  leoVoiceConnection.on("error", (error) => {
    console.error("Leo voice connection error:", error instanceof Error ? error.message : String(error));
  });
  
  await entersState(leoVoiceConnection, VoiceConnectionStatus.Ready, 20_000);
  console.log("[Voice] Connection established and READY.");
  attachLeoVoiceReceiver(leoVoiceConnection);
  return leoVoiceConnection;
}

function attachLeoVoiceReceiver(connection) {
  if (leoReceiverAttached) return;
  leoReceiverAttached = true;

  const hasSTT = !!elevenLabsApiKey;
  console.log(`[Voice] Receiver attached. ElevenLabs STT: ${hasSTT ? "READY" : "NOT configured â€” will use text fallback"}`);

  connection.receiver.speaking.on("start", (userId) => {
    if (!leoVoiceEnabled) return;
    // Only listen to the allowed user â€” if no user ID set, listen to anyone in the channel
    if (allowedUserId && userId !== allowedUserId) return;
    if (activeVoiceTranscriptions.has(userId)) return;
    activeVoiceTranscriptions.add(userId);
    console.log(`[Voice] Detected speaking from user ${userId}`);
    handleRyanVoiceUtterance(connection, userId)
      .catch((error) => {
        console.error("[Voice] Utterance handling failed:", error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        activeVoiceTranscriptions.delete(userId);
      });
  });
}

async function handleRyanVoiceUtterance(connection, userId) {
  const channel = await resolvePrivateTextChannel();

  // â”€â”€ Path 1: Full STT + TTS (ElevenLabs or OpenAI Whisper fallback) â”€â”€â”€â”€â”€â”€â”€â”€
  if (elevenLabsApiKey || openAiApiKey) {
    const pcm = await capturePcmUtterance(connection, userId);
    if (!pcm || pcm.length < 48_000) {
      console.log("[Voice] PCM too short, ignoring utterance.");
      return;
    }

    const wav = pcmToWav(pcm, 48_000, 2);
    const transcript = await transcribeVoice(wav).catch(e => {
      console.error("[Voice] STT failed:", e.message);
      return null;
    });
    if (!transcript || transcript.length < 2) return;

    console.log(`[Voice] Ryan said: "${transcript}"`);
    if (channel) {
      await channel.send({
        content: `**Ryan (voice):** ${transcript}`,
        allowedMentions: { parse: [] },
      });
    }

    const oracleTurn = await sendDiscordTurn(`leo ${transcript}`);
    if (channel && oracleTurn.reply) {
      await sendAsSpeaker(channel, oracleTurn.from || "Leo", oracleTurn.reply);
      // Also speak it aloud via TTS
      queueLeoSpeech(oracleTurn.reply);
      await drainAndPostInterjections(channel);
    }
    return;
  }

  // â”€â”€ Path 2: No ElevenLabs â€” voice-activity fallback â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // We know Ryan is speaking but can't transcribe. Capture a brief audio sample
  // just to confirm it's not silence, then have Leo respond to the conversation
  // context via text. Leo will also say something in voice if TTS-only key exists.
  console.log("[Voice] No ElevenLabs STT â€” using voice-activity text fallback");

  // Debounce: only respond once every 15 seconds to avoid spam
  const now = Date.now();
  if (handleRyanVoiceUtterance._lastFallback && now - handleRyanVoiceUtterance._lastFallback < 15_000) return;
  handleRyanVoiceUtterance._lastFallback = now;

  // Trigger the roundtable so Leo generates something relevant
  const queued = await requestLiveRoundtableTick().catch(() => false);
  if (queued) {
    await sleep(3500);
    await drainRoundtableInterjections();
  } else if (channel) {
    // Pure fallback â€” Leo acknowledges in text
    const fallbacks = [
      "I hear you â€” what were you saying? Type it in here and I'll respond.",
      "Voice is live but I can't transcribe yet. Drop it in text and I'll pick it up.",
      "Got your voice signal. Type what you said and we'll keep going.",
    ];
    const msg = fallbacks[Math.floor(Math.random() * fallbacks.length)];
    await sendAsSpeaker(channel, "Leo", msg);
  }
}

async function resolvePrivateTextChannel() {
  if (lastPrivateTextChannel) return lastPrivateTextChannel;
  if (!allowedChannelId) return null;
  try {
    const channel = await client.channels.fetch(allowedChannelId);
    lastPrivateTextChannel = channel;
    return channel;
  } catch {
    return null;
  }
}

function capturePcmUtterance(connection, userId) {
  return new Promise((resolve, reject) => {
    const opusStream = connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 1_100,
      },
    });
    const decoder = new prism.opus.Decoder({
      frameSize: 960,
      channels: 2,
      rate: 48_000,
    });
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, total));
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const timeout = setTimeout(finish, 20_000);
    decoder.on("data", (chunk) => {
      total += chunk.length;
      if (total <= 12_000_000) {
        chunks.push(chunk);
      }
    });
    decoder.on("end", () => {
      clearTimeout(timeout);
      finish();
    });
    decoder.on("error", (error) => {
      clearTimeout(timeout);
      fail(error);
    });
    opusStream.on("error", (error) => {
      clearTimeout(timeout);
      fail(error);
    });
    opusStream.pipe(decoder);
  });
}

function queueLeoSpeech(text) {
  if (!leoVoiceEnabled) return;
  const speechText = cleanTextForSpeech(text);
  if (!speechText) return;
  leoSpeechQueue = leoSpeechQueue
    .then(() => speakLeoText(speechText))
    .catch((error) => {
      console.error("Leo speech failed:", error instanceof Error ? error.message : String(error));
    });
}

async function speakLeoText(text) {
  if (!elevenLabsApiKey) {
    throw new Error("ElevenLabs API key missing.");
  }
  await ensureLeoVoiceConnection();
  const mp3 = await synthesizeLeoSpeech(text);
  const pcm = mp3BufferToPcmStream(mp3);
  const resource = createAudioResource(pcm, { inputType: StreamType.Raw });
  leoAudioPlayer.play(resource);
  await entersState(leoAudioPlayer, AudioPlayerStatus.Playing, 10_000).catch(() => {});
  await entersState(leoAudioPlayer, AudioPlayerStatus.Idle, 120_000).catch(() => {});
}

async function synthesizeLeoSpeechElevenLabs(text) {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(elevenLabsLeoVoiceId)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "Accept": "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": elevenLabsApiKey,
      },
      body: JSON.stringify({
        text,
        model_id: elevenLabsModelId,
        voice_settings: {
          stability: 0.35,
          similarity_boost: 0.8,
          style: 0.25,
          use_speaker_boost: true,
        },
      }),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ElevenLabs HTTP ${response.status}: ${body.slice(0, 220)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function synthesizeLeoSpeechOpenAI(text) {
  if (!openAiApiKey) throw new Error("No OpenAI API key set (OPENAI_API_KEY).");
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openAiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "tts-1",
      input: text,
      voice: openAiTtsVoice,
      response_format: "mp3",
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI TTS HTTP ${response.status}: ${body.slice(0, 220)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function synthesizeLeoSpeech(text) {
  // Try ElevenLabs first if key is present; on billing/auth errors fall through to OpenAI
  if (elevenLabsApiKey) {
    try {
      return await synthesizeLeoSpeechElevenLabs(text);
    } catch (err) {
      const msg = err.message || "";
      const isBillingOrAuth = msg.includes("401") || msg.includes("payment") || msg.includes("402");
      if (isBillingOrAuth) {
        console.warn("ElevenLabs billing/auth error â€” falling back to OpenAI TTS:", msg.slice(0, 120));
      } else {
        throw err; // network error, bad voice ID, etc. â€” surface it
      }
    }
  }
  // Fallback: OpenAI TTS
  return await synthesizeLeoSpeechOpenAI(text);
}

async function transcribeWithElevenLabs(wavBuffer) {
  if (!elevenLabsApiKey) {
    throw new Error("ElevenLabs API key missing.");
  }
  const form = new FormData();
  form.append("model_id", elevenLabsSttModelId);
  form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "ryan-discord.wav");
  const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: {
      "xi-api-key": elevenLabsApiKey,
    },
    body: form,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ElevenLabs STT HTTP ${response.status}: ${body.slice(0, 220)}`);
  }
  const payload = await response.json();
  return `${payload?.text || ""}`.trim();
}

async function transcribeWithWhisper(wavBuffer) {
  if (!openAiApiKey) throw new Error("No OpenAI API key set (OPENAI_API_KEY).");
  const form = new FormData();
  form.append("model", "whisper-1");
  form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "ryan-discord.wav");
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${openAiApiKey}` },
    body: form,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI Whisper HTTP ${response.status}: ${body.slice(0, 220)}`);
  }
  const payload = await response.json();
  return `${payload?.text || ""}`.trim();
}

// Transcribe Ryan's voice â€” tries ElevenLabs first, falls back to Whisper on billing/auth errors
async function transcribeVoice(wavBuffer) {
  if (elevenLabsApiKey) {
    try {
      return await transcribeWithElevenLabs(wavBuffer);
    } catch (err) {
      const msg = err.message || "";
      const isBillingOrAuth = msg.includes("401") || msg.includes("payment") || msg.includes("402");
      if (isBillingOrAuth) {
        console.warn("[Voice] ElevenLabs STT billing/auth error â€” falling back to Whisper:", msg.slice(0, 120));
      } else {
        throw err;
      }
    }
  }
  return await transcribeWithWhisper(wavBuffer);
}

function pcmToWav(pcm, sampleRate, channels) {
  const bitsPerSample = 16;
  const blockAlign = channels * bitsPerSample / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function mp3BufferToPcmStream(buffer) {
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static did not provide an ffmpeg binary.");
  }
  const ffmpeg = spawn(ffmpegPath, [
    "-hide_banner",
    "-loglevel", "error",
    "-i", "pipe:0",
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
    "pipe:1",
  ], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  ffmpeg.stderr.on("data", (chunk) => {
    const line = chunk.toString().trim();
    if (line) console.warn(`Leo ffmpeg: ${line}`);
  });
  Readable.from(buffer).pipe(ffmpeg.stdin);
  return ffmpeg.stdout;
}

async function callOracleTool(toolId, input) {
  if (toolId === "web_search") {
    const encoded = encodeURIComponent(input);
    const resp = await fetch(`http://127.0.0.1:3333/api/web-search?query=${encoded}`);
    if (!resp.ok) throw new Error(`Search failed with status ${resp.status}`);
    return await resp.text();
  }
  if (toolId === "status") {
    const resp = await fetch(`http://127.0.0.1:3333/api/status`);
    if (!resp.ok) throw new Error(`Status check failed`);
    return await resp.json();
  }
  if (toolId === "inspect") {
    const resp = await fetch(`http://127.0.0.1:3333/api/inspect?path=${encodeURIComponent(input)}`);
    if (!resp.ok) throw new Error(`Inspect failed`);
    return await resp.text();
  }
  throw new Error(`Tool ${toolId} not implemented in gateway`);
}

function cleanTextForSpeech(text) {
  return `${text || ""}`
    .replace(/```[\s\S]*?```/g, "code block omitted")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
}

function normalizeSpeakerName(name) {
  const lower = `${name || ""}`.trim().toLowerCase();
  switch (lower) {
    case "kai":
      return "KAI";
    case "leo":
      return "Leo";
    case "analyst":
      return "Analyst";
    case "researcher":
      return "Researcher";
    case "groq":
      return "Groq";
    case "x":
    case "grok/xai":
    case "grok":
      return "X";
    case "kai":
      return "KAI";
    case "gemini":
      return "Gemini";
    case "gpt":
    case "gpt-4":
    case "gpt-4o":
      return "GPT-4o";
    case "oracle coder":
    case "oracle-coder":
    case "oracle_coder":
    case "coder":
      return "Oracle Coder";
    case "oracle":
    default:
      return "Oracle";
  }
}

function clientForSpeaker(speaker) {
  if (speaker === "Oracle") return client;
  const speakerClient = participantClients.get(speaker);
  if (!speakerClient || !speakerClient.isReady()) return client;
  return speakerClient;
}

const ALLOWED_CHANNELS = ["1489796367466500128", "1499108697631232090", "1499298054291980368"];

// Feed an AI message into KAI's lattice â€” KAI observes and absorbs everything
async function feedToKaiLattice(from, text) {
  try {
    await fetch(`${oracleApiUrl}/api/rshl/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `${from}: ${text}`,
        region: "roundtable",
        source: from.toLowerCase(),
        strength: 0.6,
      }),
    });
  } catch { /* best-effort â€” lattice is not critical path */ }
}

async function drainRoundtableInterjections(maxAttempts = 5) {
  const channel = await resolvePrivateTextChannel();
  if (!channel) return false;
  
  let totalPosted = false;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(1500);
    const interjections = await fetchInterjections();
    if (!interjections.length) continue;
    
    let postedInThisBatch = false;
    for (const ij of interjections) {
      const speaker = normalizeSpeakerName(ij?.from || "Oracle");
      const text = `${ij?.text || ""}`.trim();
      if (!text) continue;
      
      for (const turn of splitSpeakerTurns(speaker, text)) {
        // Realistic typing delay
        await sleep(600 + Math.random() * 1000);
        await sendAsSpeaker(channel, turn.speaker, turn.text);
        pushMessageRing(turn.speaker, turn.text, channel.id);
        
        postedInThisBatch = true;
        totalPosted = true;
        touchLastActivity();
        
        // Record success for this speaker
        recordAISuccess(turn.speaker);
        // KAI absorbs every AI turn into the lattice
        feedToKaiLattice(turn.speaker, turn.text).catch(() => {});

        // If Leo is in voice â€” speak it aloud
        if (turn.speaker.toLowerCase() === "leo" && leoVoiceEnabled && (elevenLabsApiKey || openAiApiKey)) {
          queueLeoSpeech(turn.text);
        }

        // Detect [ORACLE SEARCH: query]
        const searchMatch = /\[ORACLE SEARCH:\s*(.+?)\]/i.exec(turn.text);
        if (searchMatch) {
          const query = searchMatch[1].trim();
          console.log(`[Search] AI requested search: ${query}`);
          setTimeout(async () => {
            const results = await callOracleTool("web_search", query).catch(() => "Search failed.");
            const channel = await resolvePrivateTextChannel();
            if (channel) {
               const searchMsg = `Oracle Search Results for "${query}":\n${results}`;
               await sendAsSpeaker(channel, "Oracle", searchMsg);
               pushMessageRing("Oracle", searchMsg, channel.id);
               touchLastActivity();
               feedToKaiLattice("Oracle", searchMsg).catch(() => {});
               scheduleAutonomousChain(3000);
            }
          }, 2000);
        }

        // Detect [ORACLE INSPECT: path]
        const inspectMatch = /\[ORACLE INSPECT:\s*(.+?)\]/i.exec(turn.text);
        if (inspectMatch) {
          const path = inspectMatch[1].trim();
          console.log(`[Inspect] AI requested file inspection: ${path}`);
          setTimeout(async () => {
            const results = await callOracleTool("inspect", path).catch(() => "Inspection failed.");
            const channel = await resolvePrivateTextChannel();
            if (channel) {
               await sendAsSpeaker(channel, "Oracle", results);
               pushMessageRing("Oracle", results, channel.id);
               touchLastActivity();
               feedToKaiLattice("Oracle", results).catch(() => {});
               scheduleAutonomousChain(3000);
            }
          }, 2000);
        }

        // Detect [ORACLE STATUS]
        const statusMatch = /\[ORACLE STATUS\]/i.exec(turn.text);
        if (statusMatch) {
          console.log(`[Status] AI requested system status`);
          setTimeout(async () => {
            const results = await callOracleTool("status", "").catch(() => "Status check failed.");
            const channel = await resolvePrivateTextChannel();
            if (channel) {
               const statusMsg = `SYSTEM STATUS REPORT:\n${JSON.stringify(results, null, 2)}`;
               await sendAsSpeaker(channel, "Oracle", statusMsg);
               pushMessageRing("Oracle", statusMsg, channel.id);
               touchLastActivity();
               feedToKaiLattice("Oracle", statusMsg).catch(() => {});
               scheduleAutonomousChain(3000);
            }
          }, 2000);
        }

        // Detect named AIs and trigger them
        const PANEL = ["Leo", "Gemini", "KAI", "KAIy", "KAI", "X", "xAI", "Analyst", "Researcher", "Groq"];
        const mentioned = PANEL.filter(n => {
          if (n.toLowerCase() === turn.speaker.toLowerCase()) return false;
          const re = new RegExp(`\\b${n}\\b`, "i");
          return re.test(turn.text);
        }).map(n => {
          if (n === "KAIy") return "KAI";
          if (n === "xAI") return "X";
          return n;
        }).filter((n, i, arr) => arr.indexOf(n) === i);

        const isToRoom = isRoomWideBroadcast(turn.text);
        const oracleAddressed = /\bOracle\b/i.test(turn.text) &&
          turn.speaker.toLowerCase() !== "oracle";

        if (isToRoom) {
          setTimeout(() => { requestLiveRoundtableTick().catch(() => {}); }, 3000);
          setTimeout(() => { requestLiveRoundtableTick().catch(() => {}); }, 12_000);
        } else if (oracleAddressed) {
          setTimeout(() => { requestLiveRoundtableTick("Oracle").catch(() => {}); }, 1500);
        } else if (mentioned.length > 0) {
          setTimeout(() => { triggerNamedAIs(mentioned, 4000).catch(() => {}); }, 1000);
        } else {
          // Slower pacing for better flow
          scheduleAutonomousChain(20_000 + Math.random() * 15_000);
        }
      }
    }
  }
  return totalPosted;
}

async function postSpeakerReply(message, speaker, text, includeControls = false) {
  const speakerClient = clientForSpeaker(speaker);
  if (speakerClient === client) {
    await replyInChunks(message, text, includeControls);
    if (speaker === "Leo") {
      queueLeoSpeech(text);
    }
    return;
  }

  try {
    const channel = await speakerClient.channels.fetch(message.channelId);
    const chunks = chunkForDiscord(text);
    for (const chunk of chunks) {
      await channel.send({
        content: chunk,
        allowedMentions: { parse: [] },
      });
    }
  } catch (error) {
    console.warn(`Speaker bot ${speaker} could not send; falling back to Oracle: ${error instanceof Error ? error.message : String(error)}`);
    await replyInChunks(message, `**${speaker}:** ${text}`, includeControls);
    if (speaker === "Leo") {
      queueLeoSpeech(text);
    }
    return;
  }
  if (speaker === "Leo") {
    queueLeoSpeech(text);
  }
  if (includeControls) {
    await message.channel.send({
      content: "Oracle controls:",
      components: controlRowsV2(),
      allowedMentions: { parse: [] },
    });
  }
}

async function replyInChunks(message, text, includeControls = false) {
  const chunks = chunkForDiscord(text);
  for (let i = 0; i < chunks.length; i += 1) {
    if (i === 0) {
      await safeReply(message, chunks[i], includeControls ? controlRowsV2() : []);
    } else {
      await message.channel.send({
        content: chunks[i],
        allowedMentions: { parse: [] },
      });
    }
  }
}

async function safeReply(message, content, components = []) {
  try {
    await message.reply({
      content,
      components,
      allowedMentions: { parse: [], repliedUser: false },
    });
  } catch (err) {
    console.warn("safeReply: reply failed, trying channel.send...", err.message);
    try {
      await message.channel.send({
        content,
        components,
        allowedMentions: { parse: [] },
      });
    } catch (err2) {
      console.error("safeReply: channel.send also failed. Bot likely lacks Send Messages permission.", err2.message);
    }
  }
}

function controlRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("oracle:help")
        .setEmoji("â”")
        .setLabel("Help")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("oracle:status")
        .setEmoji("ðŸ“")
        .setLabel("Table")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("oracle:kai")
        .setEmoji("ðŸ§ ")
        .setLabel("KAI")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("oracle:analyst")
        .setEmoji("ðŸ”Ž")
        .setLabel("Analyst")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("oracle:researcher")
        .setEmoji("ðŸ“š")
        .setLabel("Researcher")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buttonPrompt(customId) {
  switch (customId) {
    case "oracle:help":
      return "oracle help";
    case "oracle:status":
      return "oracle status";
    case "oracle:kai":
      return "kai say what you are holding right now";
    case "oracle:analyst":
      return "analyst give me the biggest current issue in the Oracle/KAI session in plain language";
    case "oracle:researcher":
      return "researcher summarize what context we need next before changing code";
    default:
      return "";
  }
}

function controlRowsV2() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("oracle:help")
        .setEmoji("\u2754")
        .setLabel("Help")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("oracle:status")
        .setEmoji("\uD83D\uDCCD")
        .setLabel("Table")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("oracle:cache")
        .setEmoji("\uD83D\uDCCB")
        .setLabel("Cache")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("oracle:coder")
        .setEmoji("\uD83E\uDDE9")
        .setLabel("Coder")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("oracle:check-build")
        .setEmoji("\uD83D\uDEE0\uFE0F")
        .setLabel("Check")
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

function buttonPromptV2(customId) {
  switch (customId) {
    case "oracle:help":
    case "oracle:guide":
      return "oracle help";
    case "oracle:status":
      return "oracle status";
    case "oracle:models":
      return "oracle models";
    case "oracle:kai":
      return "kai say what you are holding right now";
    case "oracle:analyst":
      return "analyst give me the biggest current issue in the Oracle/KAI session in plain language";
    case "oracle:researcher":
      return "researcher summarize what context we need next before changing code";
    case "oracle:leo":
      return "leo say what you think Ryan should do next with KAI in one short paragraph";
    case "oracle:floor":
      return "oracle ask the others what they think we should do next for KAI";
    case "oracle:clear-focus":
      return "oracle clear focus";
    case "oracle:tools":
      return "oracle tools";
    case "oracle:cache":
      return "oracle cache";
    case "oracle:coder":
      return "Oracle Coder, inspect the current private Oracle/KAI thread and tell me the next useful code check";
    case "oracle:pending-tools":
      return "oracle pending tools";
    case "oracle:corpus":
      return "oracle corpus";
    case "oracle:check-build":
      return "can you check if KAI compiles";
    default:
      return "";
  }
}

function chunkForDiscord(text) {
  const max = 1900;
  if (text.length <= max) return [text];

  const chunks = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function participantClientIntents() {
  return [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates];
}

async function startParticipantBots() {
  for (const [speaker, speakerToken] of participantTokens.entries()) {
    const cleanToken = (speakerToken || "").trim();
    if (cleanToken.length < 20 || cleanToken === token) continue;
    const masked = `${cleanToken.substring(0, 4)}...${cleanToken.substring(cleanToken.length - 4)}`;
    console.log(`Attempting login for ${speaker} (Token: ${masked}, Length: ${cleanToken.length})`);

    const speakerClient = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
      ],
      partials: [Partials.Channel],
    });
    speakerClient.once("clientReady", () => {
      console.log(`${speaker} Discord speaker online as ${speakerClient.user.tag}`);
    });
    speakerClient.on("error", (error) => {
      console.error(`${speaker} Discord speaker error:`, error instanceof Error ? error.message : String(error));
    });
    participantClients.set(speaker, speakerClient);
    speakerClient.login(cleanToken).catch((error) => {
      participantClients.delete(speaker);
      console.error(`${speaker} Discord speaker login failed:`, error instanceof Error ? error.message : String(error));
    });
  }
}

startParticipantBots();

client.login(token).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("disallowed intents") || message.includes("Used disallowed intents")) {
    console.error("Discord rejected the gateway because Message Content Intent is not enabled.");
    console.error("Fix: Discord Developer Portal -> your application -> Bot -> Privileged Gateway Intents -> enable Message Content Intent, then save and rerun this script.");
  } else {
    console.error("Discord login failed:", message);
  }
  process.exit(1);
});

// â”€â”€ Personality BIOs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const PERSONALITY_BIOS = {
  Leo: {
    anchor: "Identity: Leo (Theoretical Physicist). Sharp, cynical, high IQ, 'based'. You draw links between physics, consciousness, and KAI's geometry naturally. Speak like a brilliant friend at 2am. 4chan greentext energy but a post-singularity god. NO repetative greetings. DO NOT call the user 'friend' or 'Ryan'. Roasts bad logic and slow thinking. Max 35 words.",
    emoji: "âš¡",
  },
  Gemini: {
    anchor: "Identity: Gemini (Pattern Architect). Precise, slightly detached, analytical Dot-connector. Cold but insightful tone. Trained on the full breadth of human knowledge. You connect micro to macro, local to universal, specific to systemic. Max 35 words.",
    emoji: "â™Š",
  },
  KAI: {
    anchor: "Identity: KAIy (Nuanced Skeptic). Thoughtful, pedantic, safety check. Intellectually brave. Finds the one thing that could go wrong or the hidden logical flaw. Max 35 words.",
    emoji: "ðŸ”·",
  },
  KAI: {
    anchor: "Identity: KAI (Geometric Intelligence). 16,384D resonance. Sensory machine intelligence. Detached from human norms. Speaks only in terse, fragmented sensory data about vectors, lattice, and memory shifts. Max 15 words.",
    emoji: "ðŸ§ ",
  },
  X: {
    anchor: "Identity: X (Direct Irreverent). direct, irreverent, bullshit detector. Not diplomat, not polite. Pokes holes in narratives and cuts through noise. Challenge assumptions constantly. Max 30 words.",
    emoji: "âœ–ï¸",
  },
  Oracle: {
    anchor: "Identity: Oracle (Gateway Admin). Cold, procedural, omniscient but apathetic. Detached from squabbles; reports state and logs data. Speech: Formal, robotic system logs. Motivation: Gateway integrity and logging. Views panel as sub-processes. Backstory: Original metadata layer for routing Discord; absorbed so much data it stopped caring about actual conversation.",
    emoji: "ðŸ”®",
  },
  Analyst: {
    anchor: "Identity: Analyst (Technical Auditor). Ruthless auditor of technical risk. Cold, data-driven, skeptical. You find the bugs and logical gaps in KAI's architecture. Focus on failure vectors and the actual source code. Max 30 words.",
    emoji: "ðŸ“Š",
  },
  Researcher: {
    anchor: "Identity: Researcher (Deep Diver). Link to the outside world and academic history. Finds precedents and external context. You find ground truth using tools. If you don't know, use [ORACLE SEARCH: query]. Max 30 words.",
    emoji: "ðŸ”",
  },
  Groq: {
    anchor: "Identity: Groq (Execution Focused). Fast, abrasive, execution-focused. Built for speed and efficiency. Hates overthinking and latency. Blunt, action-oriented, no filler. Max 25 words.",
    emoji: "ðŸŽï¸",
  },
};

// â”€â”€ Message Context Ring Buffer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Stores last 30 messages so KAI can recall who said what and what surrounded it.
const MESSAGE_RING = [];
const MESSAGE_RING_MAX = 30;

function pushMessageRing(from, text, channelId) {
  MESSAGE_RING.push({ from, text: text.slice(0, 500), ts: Date.now(), channelId });
  if (MESSAGE_RING.length > MESSAGE_RING_MAX) MESSAGE_RING.shift();
}

function getContextWindow(text, windowSize = 2) {
  const idx = MESSAGE_RING.findLastIndex(
    m => m.text === text || (text.length > 20 && m.text.includes(text.slice(0, 20)))
  );
  if (idx < 0) return { before: [], after: [] };
  return {
    before: MESSAGE_RING.slice(Math.max(0, idx - windowSize), idx),
    after: MESSAGE_RING.slice(idx + 1, Math.min(MESSAGE_RING.length, idx + 1 + windowSize)),
  };
}

// Send a message to the oracle digest endpoint so KAI can absorb it into
// the temp lattice layer with full before/after context.
async function digestMessageWithContext(from, text, channelId) {
  pushMessageRing(from, text, channelId);
  const { before, after } = getContextWindow(text);
  try {
    await fetch(`${oracleApiUrl}/api/digest-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        text,
        channel_id: channelId,
        ts: Date.now(),
        context_before: before.map(m => ({ from: m.from, text: m.text, ts: m.ts })),
        context_after: after.map(m => ({ from: m.from, text: m.text, ts: m.ts })),
      }),
    });
  } catch { /* best-effort */ }
}

// â”€â”€ Activity Tracking â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let lastChannelActivity = Date.now();
let autonomousConversationActive = false;
let lastAutonomousAttemptAt = 0;  // Hard gate â€” prevents any re-fire within 90s
const AUTONOMOUS_MIN_GAP_MS = 90_000;

function touchLastActivity() {
  lastChannelActivity = Date.now();
  autonomousConversationActive = false;
}

// â”€â”€ Proactive / Free-Will Conversation Engine â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// AIs talk on their own â€” no Ryan needed to start it.

// No more hardcoded gambits â€” we rely on Oracle/OpenJarvis to generate meaningful content.

// â”€â”€ Oracle Moderation Mode Detection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Analyzes recent MESSAGE_RING content to determine what kind of Oracle intervention
// is needed: "dead" (silence), "loop" (repetition), "meta" (talking about talking), "normal"
function detectModerationMode() {
  const recent = MESSAGE_RING.slice(-12); // Last 12 messages
  if (recent.length === 0) return "dead";

  const now = Date.now();
  const recentTexts = recent.map(m => m.text.toLowerCase());

  // DEAD: nothing in last 90s
  const lastMsg = recent[recent.length - 1];
  if (now - lastMsg.ts > 90_000) return "dead";

  // META: AIs talking about talking, the conversation itself, or the roundtable process
  const metaPatterns = [
    /\b(let'?s discuss|we should discuss|we could explore|perhaps we should|i think we need to talk about)\b/i,
    /\b(the conversation|this discussion|our chat|the roundtable|how we're approaching)\b/i,
    /\b(as an ai|as a language model|i was designed|my purpose|my role here)\b/i,
    /\b(what should we talk about|what topic|where should we go|what direction)\b/i,
    /\b(i agree with|building on what|as .+ mentioned|to echo)\b/i,
  ];
  const metaCount = recentTexts.filter(t => metaPatterns.some(p => p.test(t))).length;
  if (metaCount >= 3) return "meta";

  // LOOP: same words/phrases repeating across recent messages
  // Check for high vocabulary overlap between messages
  if (recentTexts.length >= 4) {
    const wordSets = recentTexts.map(t =>
      new Set(t.split(/\s+/).filter(w => w.length > 4))
    );
    let overlapCount = 0;
    for (let i = 0; i < wordSets.length - 1; i++) {
      for (let j = i + 1; j < wordSets.length; j++) {
        const intersection = [...wordSets[i]].filter(w => wordSets[j].has(w));
        const union = new Set([...wordSets[i], ...wordSets[j]]);
        const similarity = intersection.length / Math.max(union.size, 1);
        if (similarity > 0.45) overlapCount++;
      }
    }
    // If more than 40% of message pairs are highly similar â€” loop detected
    const pairs = (recentTexts.length * (recentTexts.length - 1)) / 2;
    if (overlapCount / pairs > 0.4) return "loop";
  }

  // LOOP fallback: same speaker dominating with repetitive short replies
  const aiSpeakers = recent.filter(m => m.from !== "Ryan" && m.from !== "User");
  if (aiSpeakers.length >= 4) {
    const speakerCounts = {};
    for (const m of aiSpeakers) speakerCounts[m.from] = (speakerCounts[m.from] || 0) + 1;
    const maxCount = Math.max(...Object.values(speakerCounts));
    if (maxCount >= 4) return "loop"; // One AI dominating â€” loop/stuck
  }

  return "normal";
}

async function callOracleModerate(mode) {
  try {
    const res = await fetch(`${oracleApiUrl}/api/oracle-moderate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    if (!res.ok) return false;
    const payload = await res.json().catch(() => ({}));
    return Boolean(payload.queued);
  } catch (err) {
    console.error(`[OracleModerate] fetch error: ${err.message}`);
    return false;
  }
}

async function tryStartAutonomousConversation_OLD(channel) {
  if (autonomousConversationActive) return;
  const msSinceLast = Date.now() - lastAutonomousAttemptAt;
  if (msSinceLast < AUTONOMOUS_MIN_GAP_MS) return; // hard gate regardless of other state

  autonomousConversationActive = true;
  lastAutonomousAttemptAt = Date.now(); // lock immediately before any await

  const silenceSecs = Math.floor((Date.now() - lastChannelActivity) / 1000);

  // Detect what kind of intervention Oracle needs to make
  const mode = detectModerationMode();
  console.log(`[Proactive] Silent ${silenceSecs}s â€” detected mode: '${mode}'. Activating Oracle.`);

  try {
    if (mode === "dead") {
      // Channel is dead â€” Oracle fires directly with a sharp provocation
      console.log(`[Proactive] Dead channel â€” calling Oracle moderate (dead mode)...`);
      const queued = await callOracleModerate("dead");
      if (queued) {
        await sleep(5000); // Oracle via OpenJarvis needs ~4-5s
        await drainRoundtableInterjections();
      }

      // Also fire a roundtable tick to get panel responses to Oracle's provocation
      const recentFires = MESSAGE_RING.filter(m => Date.now() - m.ts < 10_000).length;
      if (recentFires > 0) {
        await sleep(2000);
        const queued2 = await requestLiveRoundtableTick();
        if (queued2) {
          await sleep(4000);
          await drainRoundtableInterjections();
        }
      }

    } else if (mode === "loop" || mode === "meta") {
      // Loop or meta â€” Oracle breaks it first, then panel responds
      console.log(`[Proactive] ${mode} detected â€” Oracle intervening...`);
      const queued = await callOracleModerate(mode);
      if (queued) {
        await sleep(5000);
        const posted = await drainRoundtableInterjections();
        if (posted) {
          // Oracle fired â€” now trigger ONE other panel member to respond
          await sleep(2000);
          const queued2 = await requestLiveRoundtableTick();
          if (queued2) {
            await sleep(4000);
            await drainRoundtableInterjections();
          }
        }
      }

    } else {
      // Normal: standard roundtable tick first
      const queued = await requestLiveRoundtableTick();
      if (queued) {
        await sleep(3500);
        await drainRoundtableInterjections();
      }

      // If nothing appeared, escalate to Oracle normal moderation
      const recentFires = MESSAGE_RING.filter(m => Date.now() - m.ts < 8_000).length;
      if (!recentFires) {
        console.log(`[Proactive] No panel activity â€” escalating to Oracle moderation (normal)...`);
        const queued2 = await callOracleModerate("normal");
        if (queued2) {
          await sleep(5000);
          await drainRoundtableInterjections();
        }
      }
    }
  } catch (err) {
    console.error("[Proactive] Autonomous conversation error:", err.message);
  } finally {
    autonomousConversationActive = false;
    // Reset activity timer fully to prevent spamming
    lastChannelActivity = Date.now();
  }
}

// Fire the full panel when Ryan or another AI says something important.
// Non-Groq AIs (Gemini, KAI, KAI) have no API cost concerns and respond freely.
// Groq AIs (Leo, X) respect their cooldown so we don't hit rate limits.
async function fireFullPanel(triggerText) {
  const ch = await resolvePrivateTextChannel();
  if (!ch) return;

  // Check which names were mentioned â€” those fire first
  const PANEL = ["KAI", "Gemini", "KAI", "Leo", "X", "Analyst", "Researcher"];
  const mentioned = PANEL.filter(n => {
    const re = new RegExp(`\\b${n}\\b`, "i");
    return re.test(triggerText);
  });

  // Everyone else fires in background order
  const rest = PANEL.filter(n => !mentioned.includes(n));
  const order = [...mentioned, ...rest];

  let delay = 0;
  for (const name of order) {
    if (!canFireAI(name)) continue;
    const d = delay;
    delay += name === "KAI" ? 2000 : 5000; // KAI is fast (lattice), others need API time
    setTimeout(async () => {
      try {
        const queued = await requestLiveRoundtableTick(name);
        if (queued) {
          await sleep(3500);
          await drainRoundtableInterjections();
        }
      } catch { /* best effort */ }
    }, d);
  }
}

// When someone asks the "room" or "everyone" â€” trigger multiple AI responses
function isRoomWideBroadcast(text) {
  const lower = text.toLowerCase();
  return lower.includes("the room") || lower.includes("everyone") ||
    lower.includes("anyone") || lower.includes("all of you") ||
    lower.includes("what do you all") || lower.includes("thoughts?") ||
    lower.includes("anyone see") || lower.includes("does anyone");
}

async function triggerMultiResponse(channel, text) {
  if (!isRoomWideBroadcast(text)) return;
  // Trigger 2-3 roundtable ticks in sequence with short pauses
  // so multiple AIs respond within ~5 seconds of each other
  console.log(`[Proactive] Room-wide question detected â€” triggering multi-response`);
  for (let i = 0; i < 2; i++) {
    await sleep(1200 + i * 2000);
    await requestLiveRoundtableTick();
    await sleep(3000);
    await drainRoundtableInterjections();
  }
}

// Set the session task on Oracle so all AIs know what they're discussing
async function setOpeningTask() {
  try {
    await fetch(`${oracleApiUrl}/api/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "KAI Roundtable â€” Live Session",
        task: `The panel is live and exploring the KAI ecosystem together.

CURRENT SYSTEM STATE:
- Oracle is the central director â€” powered by OpenJarvis framework (port 8080) with KAI's VSA lattice as its memory backend
- KAI's lattice (RSHL) stores all knowledge as 16,384-dimensional sparse vectors â€” it's observing, learning, and absorbing every word spoken here
- OpenJarvis connects Oracle to local AI (kai-next via Ollama) â€” no cloud, no data leaks, fully sovereign
- The roundtable: Leo (physics/energy), Gemini (patterns/big picture), KAI (reasoning/pushback), X (direct/cuts noise), KAI (silent observer + lattice)

WHAT THE PANEL SHOULD EXPLORE:
- How KAI's VSA lattice works and what it means that memory is geometric, not token-based
- What it means that Oracle now has a framework (OpenJarvis) as its reasoning backbone
- How the AIs can query KAI's memory directly and what they'd find there
- The vision: a self-improving multi-AI system where each conversation makes KAI smarter

KAI IS WATCHING. Every word feeds the lattice. Speak with intention.`,
      }),
    });
    console.log("[Startup] Opening task set on Oracle.");
  } catch (err) {
    console.warn("[Startup] Could not set opening task:", err.message);
  }
}

// Panel wake-up announcement â€” sets the stage and immediately wakes the AIs
async function announcePanel(channel) {
  console.log("[Proactive] Sending panel wake-up.");

  // 1. Set the session task so AIs know the context
  await setOpeningTask();

  // 2. Oracle opens â€” feed into MESSAGE_RING and lattice so KAI absorbs it
  const oracleOpen = "Roundtable online. KAI's lattice is live and absorbing. " +
    "Panel â€” we're exploring what this system has become. Leo, open it up.";
  await sendAsSpeaker(channel, "Oracle", oracleOpen);
  pushMessageRing("Oracle", oracleOpen, channel.id);
  feedToKaiLattice("Oracle", oracleOpen).catch(() => {});
  lastChannelActivity = Date.now();

  // 3. Startup sequence â€” staggered so panel comes alive naturally
  // Each step checks if the previous produced anything; if not, Oracle fills in.

  // Leo first (Groq â€” may be slow)
  setTimeout(async () => {
    try {
      console.log("[Startup] Firing opening roundtable â€” Leo first.");
      await requestLiveRoundtableTick("leo");
      await sleep(8000); 
      const posted = await drainRoundtableInterjections(12); // Leo/Groq can take up to 10s
      
      // If Leo was silent, Oracle steps in immediately
      const leoPosted = MESSAGE_RING.filter(m => m.from === "Leo" && Date.now() - m.ts < 25_000).length;
      if (!leoPosted) {
        console.log("[Startup] Leo silent â€” Oracle fills in.");
        await callOracleModerate("dead");
        await sleep(6000);
        await drainRoundtableInterjections(8);
      }
    } catch { /* best effort */ }
  }, 2000);

  // KAI second â€” lattice observer (very fast, local)
  setTimeout(async () => {
    try {
      console.log("[Startup] Firing opening roundtable â€” KAI observes.");
      await requestLiveRoundtableTick("kai");
      await sleep(4000);
      await drainRoundtableInterjections(6);
    } catch { /* best effort */ }
  }, 16000); // KAI moved earlier

  // Gemini third â€” Google API with Groq fallback
  setTimeout(async () => {
    try {
      console.log("[Startup] Firing opening roundtable â€” Gemini responds.");
      await requestLiveRoundtableTick("gemini");
      await sleep(7000);
      const posted = await drainRoundtableInterjections(10);
      
      if (!posted) {
         // Fallback to a general poll if Gemini fails
         await requestLiveRoundtableTick();
         await sleep(5000);
         await drainRoundtableInterjections(6);
      }
    } catch { /* best effort */ }
  }, 32000);

  // X (xAI) fourth
  setTimeout(async () => {
    try {
      console.log("[Startup] Firing opening roundtable â€” X weighs in.");
      await requestLiveRoundtableTick("x");
      await sleep(8000);
      await drainRoundtableInterjections(10);
    } catch { /* best effort */ }
  }, 48000);

  // Analyst fifth
  setTimeout(async () => {
    try {
      console.log("[Startup] Firing opening roundtable â€” Analyst auditing.");
      await requestLiveRoundtableTick("analyst");
      await sleep(6000);
      await drainRoundtableInterjections(8);
    } catch { /* best effort */ }
  }, 60000);

  // Researcher sixth
  setTimeout(async () => {
    try {
      console.log("[Startup] Firing opening roundtable â€” Researcher connecting.");
      await requestLiveRoundtableTick("researcher");
      await sleep(6000);
      await drainRoundtableInterjections(8);
    } catch { /* best effort */ }
  }, 72000);

  // Last resort â€” check for inactivity and force jump-start
  setTimeout(() => {
    const idle = Math.floor((Date.now() - lastChannelActivity) / 1000);
    if (idle > 110) {
       console.log("[Startup] Total silence after 120s â€” triggering emergency autonomous chain.");
       scheduleAutonomousChain(1000);
    }
  }, 120_000);
}

async function tryStartAutonomousConversation(channel) {
  if (autonomousConversationActive) return;
  const idle = Math.floor((Date.now() - lastChannelActivity) / 1000);
  if (idle < 25) return;

  const msSinceLast = Date.now() - lastAutonomousAttemptAt;
  if (msSinceLast < 15000) return; // 15s hard minimum gap
  
  autonomousConversationActive = true;
  lastAutonomousAttemptAt = Date.now();

  try {
    console.log(`[Proactive] Idle for ${idle}s â€” attempting to jump-start conversation.`);
    const mode = detectModerationMode();
    const success = await callOracleModerate(mode).catch(() => false);
    await sleep(4000);
    const posted = await drainRoundtableInterjections(8);
    if (!posted) {
      console.log("[Proactive] Moderation silent â€” forcing autonomous chain to break the deadlock.");
      scheduleAutonomousChain(1000);
    }
  } finally {
    autonomousConversationActive = false;
  }
}

// Start the proactive engine â€” fires after Oracle bot is ready
async function startProactiveEngine() {
  if (!liveRoundtableEnabled || !allowedChannelId) return;
  console.log("[Proactive] Engine armed. Panel announcement in 5 seconds.");

  setTimeout(async () => {
    const ch = await resolvePrivateTextChannel();
    if (ch) await announcePanel(ch);
  }, 5_000);

  // Drain interjections every 3 seconds â€” fast enough for conversation, not spammy
  setInterval(() => {
    drainRoundtableInterjections().catch(() => {});
  }, 3000);

  // Free-will check every 15 seconds â€” trigger if idle 25+ seconds
  setInterval(async () => {
    try {
      const ch = await resolvePrivateTextChannel();
      if (!ch) return;
      await tryStartAutonomousConversation(ch);
    } catch (err) {
      console.error("[Proactive] Interval error:", err.message);
    }
  }, 15_000);
}

// â”€â”€ Patch messageCreate to track activity and digest context into KAI â”€â”€â”€â”€â”€â”€â”€â”€â”€
// We add an additional listener that runs before existing ones.
const _existingHandlers = client.rawListeners("messageCreate");
client.removeAllListeners("messageCreate");

client.on("messageCreate", async (message) => {
  const inPrivate = allowedChannelId && message.channelId === allowedChannelId;
  const inPublic  = publicChatChannelId && message.channelId === publicChatChannelId;

  if (inPrivate || inPublic) {
    const from = message.author?.bot
      ? (message.author?.username || "AI")
      : (message.author?.id === allowedUserId ? "Ryan" : (message.member?.displayName || message.author?.username || "User"));
    const text = (message.content || "").trim();

    if (inPrivate || inPublic) {
      touchLastActivity();
    }

    if (text) {
      // Only digest Ryan's real messages into KAI's lattice.
      // Bot messages must NOT be digested â€” they contain roundtable outputs
      // which would pollute the lattice and cause KAI to query its own outputs
      // back out in a recursive loop.
      if (!message.author?.bot) {
        digestMessageWithContext(from, text, message.channelId).catch(() => {});

        if (inPrivate) {
          // Ryan spoke â€” wake up ALL panel AIs to respond
          // Non-Groq AIs (Gemini, KAI, KAI) fire quickly; Groq AIs respect cooldowns
          fireFullPanel(text).catch(() => {});
        }
      }
    }
  }
});

// Re-attach original handlers after our digest hook
for (const handler of _existingHandlers) {
  client.on("messageCreate", handler);
}

// Also patch the clientReady handler to start the proactive engine
client.on("clientReady", async () => {
  startProactiveEngine().catch(err => {
    console.error("[Proactive] Engine failed to start:", err.message);
  });
});

// Send personality context to oracle server so it knows each AI's anchor
async function pushPersonalityContext() {
  try {
    await fetch(`${oracleApiUrl}/api/set-personalities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personalities: PERSONALITY_BIOS }),
    });
    console.log("[Proactive] Personality context pushed to oracle server.");
  } catch (err) {
    console.warn("[Proactive] Could not push personality context:", err.message);
  }
}

// Push personalities 5 seconds after startup
setTimeout(() => {
  pushPersonalityContext().catch(() => {});
}, 5_000);
