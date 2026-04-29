import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  Partials,
} from "discord.js";

const token = process.env.ORACLE_DISCORD_TOKEN || "";
const allowedUserId = process.env.ORACLE_DISCORD_ALLOWED_USER_ID || "";
const allowedChannelId = process.env.ORACLE_DISCORD_ALLOWED_CHANNEL_ID || "";
const oracleApiUrl = (process.env.ORACLE_API_URL || "http://127.0.0.1:3333").replace(/\/+$/, "");

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
  ],
  partials: [Partials.Channel],
});

client.once("ready", () => {
  console.log(`Oracle Discord gateway online as ${client.user.tag}`);
  console.log(`Oracle API: ${oracleApiUrl}`);
  console.log(`Allowed user: ${allowedUserId}`);
  if (allowedChannelId) console.log(`Allowed channel: ${allowedChannelId}`);
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author?.bot) return;
    if (message.author?.id !== allowedUserId) {
      console.log(`Ignored message from unauthorized user ${message.author?.id || "unknown"}.`);
      return;
    }
    if (allowedChannelId && message.channelId !== allowedChannelId) {
      console.log(`Ignored message from channel ${message.channelId}; allowed channel is ${allowedChannelId}.`);
      return;
    }

    const text = message.content.trim();
    if (!text) {
      console.log("Ignored empty message content. Check Message Content Intent if this happens for normal text.");
      return;
    }

    console.log(`Forwarding Discord message from ${message.author.id} in channel ${message.channelId}.`);
    await message.channel.sendTyping();
    const kaiReply = await sendDiscordTurn(text);
    const replyText = kaiReply || "Oracle received it, but KAI did not answer.";
    await replyInChunks(message, replyText, true);
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
    const oracleReply = await sendDiscordTurn(text);
    const replyText = oracleReply || "Oracle received it, but nobody answered.";
    await interaction.editReply({
      content: chunkForDiscord(replyText)[0],
      components: controlRowsV2(),
      allowedMentions: { parse: [] },
    });

    const overflow = chunkForDiscord(replyText).slice(1);
    for (const chunk of overflow) {
      await interaction.followUp({
        content: chunk,
        allowedMentions: { parse: [] },
      });
    }
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

async function sendDiscordTurn(text) {
  const response = await fetch(`${oracleApiUrl}/api/discord-turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: "Ryan@Discord", text }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Oracle HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const payload = await response.json();
  if (typeof payload.reply === "string" && payload.reply.trim()) {
    return payload.reply.trim();
  }
  return typeof payload.kai_reply === "string" ? payload.kai_reply.trim() : "";
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
  } catch {
    await message.channel.send({
      content,
      components,
      allowedMentions: { parse: [] },
    });
  }
}

function controlRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("oracle:help")
        .setEmoji("❔")
        .setLabel("Help")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("oracle:status")
        .setEmoji("📍")
        .setLabel("Table")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("oracle:kai")
        .setEmoji("🧠")
        .setLabel("KAI")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("oracle:analyst")
        .setEmoji("🔎")
        .setLabel("Analyst")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("oracle:researcher")
        .setEmoji("📚")
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
        .setCustomId("oracle:models")
        .setEmoji("\uD83E\uDDEE")
        .setLabel("Models")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("oracle:kai")
        .setEmoji("\uD83E\uDDE0")
        .setLabel("KAI")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("oracle:analyst")
        .setEmoji("\uD83D\uDD0E")
        .setLabel("Analyst")
        .setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("oracle:researcher")
        .setEmoji("\uD83D\uDCDA")
        .setLabel("Researcher")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("oracle:leo")
        .setEmoji("\uD83D\uDD0A")
        .setLabel("Leo")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("oracle:guide")
        .setEmoji("\u2139\uFE0F")
        .setLabel("Guide")
        .setStyle(ButtonStyle.Secondary),
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
