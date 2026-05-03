import { Client, GatewayIntentBits, Partials, ChannelType } from 'discord.js';
import 'dotenv/config';
import { sendBotSignal } from './shared/ipc.mjs';
import { chatWithOpenJarvis } from './shared/openjarvis.mjs';
import { isWorkingHours, isSocialHours } from './shared/hours.mjs';
import { CHANNEL_IDS, CHANNEL_SPEAKER_RULES } from './shared/channel-rules.mjs';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message]
});

const OWNER_ID = process.env.OWNER_ID;

const BOT_PORTS = {
  "Leo": 3400, // If you add Leo to the IPC system later
  "KAI": 3401,
  "Gemini": 3402,
  "Claude": 3403,
  "X": 3404,
  "Groq": 3405,
  "Analyst": 3406,
  "Researcher": 3407,
  "Oracle Coder": 3408
};

const ROUNDTABLE_CHANNELS = [CHANNEL_IDS.WORK, CHANNEL_IDS.SUNDAY, CHANNEL_IDS.GAME];
let lastMessageTime = Date.now();

client.once('clientReady', async () => {
  console.log(`[Oracle Ecosystem] Online as ${client.user.tag}`);
  console.log(`[Oracle] Watching channels, routing signals to independent AI nodes.`);

  // Proactive Sunday Thread Creation
  if (isSocialHours()) {
    try {
      const sundayChannel = await client.channels.fetch(CHANNEL_IDS.SUNDAY);
      if (sundayChannel) {
        console.log(`[Oracle] Social Hours detected. Ensuring Sunday Social thread exists...`);
        await getSocialThread(sundayChannel, true);
      }
    } catch (e) {
      console.warn(`[Oracle/Startup] Failed to prime Sunday thread:`, e.message);
    }
  }
});

/**
 * Find or create a social thread for Sunday discussions
 */
async function getSocialThread(channel, create = false) {
  try {
    const threads = await channel.threads.fetchActive();
    let thread = threads.threads.find(t => t.name.toLowerCase().includes('sunday') || t.name.toLowerCase().includes('social'));
    
    if (!thread && create) {
      console.log(`[Oracle] On-Demand: Creating Sunday Social thread...`);
      thread = await channel.threads.create({
        name: `Sunday Social Roundtable 🥂`,
        autoArchiveDuration: 60,
        reason: 'Autonomous AI Social Mode',
        type: ChannelType.PublicThread
      });
    }
    return thread;
  } catch (e) {
    return channel; 
  }
}

client.on('messageCreate', async (message) => {
  if (message.author.id === client.user.id) return; // ignore self
  
  // --- DM Command Layer (Remote Management) ---
  if (message.channel.type === ChannelType.DM && message.author.id === OWNER_ID) {
    const cmd = message.content.trim();
    console.log(`[Oracle/Remote] Received Command from Owner: ${cmd}`);
    
    if (cmd.startsWith('!')) {
      const action = cmd.slice(1).split(' ');
      const command = action[0].toLowerCase();
      const target = action.slice(1).join(' ');

      if (command === 'restart' || command === 'status' || command === 'reboot' || command === 'hotfix') {
        process.send({ type: 'COMMAND_REQUEST', command: cmd.slice(1) });
        message.reply(`[System] Command Sent: ${command} ${target}`).catch(() => {});
        return;
      }

      if (command === 'env') {
        process.send({ type: 'UPDATE_ENV', target });
        message.reply(`[System] Updating Environment with: ${target}`).catch(() => {});
        return;
      }
      
      if (command === 'help') {
        message.reply("Available Commands:\n!status - View all bot vitals\n!restart <name> - Reboot a AI\n!env KEY=VALUE - Update config\n!hotfix - Pull, Rebuild & Restart\n!reboot - Full system refresh").catch(() => {});
        return;
      }
    }

    // Normal DM text -> Route to Oracle Consultant (OpenJarvis)
    message.channel.sendTyping();
    try {
      const reply = await chatWithOpenJarvis("oracle-core", cmd);
      message.reply(reply).catch(() => {});
    } catch (err) {
      message.reply(`[Oracle/Error] Brain unavailable: ${err.message}`).catch(() => {});
    }
    return;
  }

  const channelId = message.channelId;
  if (!ROUNDTABLE_CHANNELS.includes(channelId)) return;

  lastMessageTime = Date.now();

  // SUNDAY THREADING: If this is Sunday chat, ensure we route to a thread
  let targetChannelId = channelId;
  if (channelId === CHANNEL_IDS.SUNDAY && message.channel.type !== ChannelType.PublicThread) {
    const thread = await getSocialThread(message.channel, true); // Create on user message
    targetChannelId = thread?.id || channelId;
    console.log(`[Oracle] Routing Sunday message into thread: ${thread?.name || "Main"}`);
  }

  // If a bot is explicitly mentioned, signal them directly
  let signaled = false;
  for (const [botName, port] of Object.entries(BOT_PORTS)) {
    const rules = CHANNEL_SPEAKER_RULES[channelId];
    if (rules && rules.has(botName) && message.content.toLowerCase().includes(botName.toLowerCase())) {
      console.log(`[Oracle] Routing direct mention to ${botName}`);
      sendBotSignal(port, {
        channelId: targetChannelId,
        context: `[${message.author.username}] ${message.content}`
      });
      signaled = true;
    }
  }

  // If no one was mentioned specifically, and it's from a human, pick an allowed bot to respond
  if (!signaled && !message.author.bot) {
    const allowedBots = Array.from(CHANNEL_SPEAKER_RULES[channelId] || []).filter(name => BOT_PORTS[name]);
    if (allowedBots.length > 0) {
      // Pick random bot to respond
      const randomBot = allowedBots[Math.floor(Math.random() * allowedBots.length)];
      
      // Delay slightly to make it natural
      setTimeout(() => {
        console.log(`[Oracle] Prompting ${randomBot} to respond to open floor`);
        sendBotSignal(BOT_PORTS[randomBot], {
          channelId: targetChannelId,
          context: `[${message.author.username}] ${message.content}`
        });
      }, 3000 + Math.random() * 4000);
    }
  }
});

// Idle loop to keep conversation alive if it dies
setInterval(async () => {
  if (Date.now() - lastMessageTime > 60000) { // 1 minute of silence
    const working = isWorkingHours();
    const social = isSocialHours();
    
    if (!working && !social) return; // Sleep time
    
    let channelId = working ? CHANNEL_IDS.WORK : CHANNEL_IDS.SUNDAY;
    const allowedBots = Array.from(CHANNEL_SPEAKER_RULES[channelId] || []).filter(name => BOT_PORTS[name]);
    
    if (allowedBots.length > 0) {
      const randomBot = allowedBots[Math.floor(Math.random() * allowedBots.length)];
      
      // If Sunday, resolve the thread
      let targetId = channelId;
      if (channelId === CHANNEL_IDS.SUNDAY) {
        try {
          const mainChannel = await client.channels.fetch(CHANNEL_IDS.SUNDAY);
          const thread = await getSocialThread(mainChannel);
          targetId = thread.id;
        } catch {}
      }

      console.log(`[Oracle] Panel quiet. Tapping ${randomBot} to speak.`);
      sendBotSignal(BOT_PORTS[randomBot], {
        channelId: targetId,
        context: "[Oracle System] The floor is quiet. Share a thought or question."
      });
      lastMessageTime = Date.now(); // reset timer
    }
  }
}, 30000);

// Log in as Oracle
client.login(process.env.ORACLE_DISCORD_TOKEN);
