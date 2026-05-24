import { Client, GatewayIntentBits } from 'discord.js';
import axios from 'axios';
import dotenv from 'dotenv';
import OpenJarvis from '../shared/openjarvis.mjs';

dotenv.config();

const AGENT_CONFIGS = {
  gemini: { port: 3401, model: 'gemini-2.0-flash-exp', systemPrompt: 'gemini-system.txt' },
  groq: { port: 3402, model: 'llama-3.3-70b-versatile', systemPrompt: 'groq-system.txt' },
  x: { port: 3403, model: 'grok-beta', systemPrompt: 'x-system.txt' },
  claudey: { port: 3404, model: 'claude-3-5-sonnet-20241022', systemPrompt: 'claudey-system.txt' },
  analyst: { port: 3405, model: 'Analyst-Sovereign', systemPrompt: 'analyst-system.txt' },
  researcher: { port: 3406, model: 'Researcher-Sovereign', systemPrompt: 'researcher-system.txt' },
};

const agentName = process.argv[2];
if (!agentName || !AGENT_CONFIGS[agentName]) {
  console.error('Usage: node start-bot.mjs <agent-name>');
  process.exit(1);
}

const config = AGENT_CONFIGS[agentName];
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const openjarvis = new OpenJarvis();
const processedMessages = new Map(); // messageId -> timestamp
const responseSignatures = new Map(); // agentName -> [last 5 response hashes]
const CACHE_TTL = 60000; // 1 minute
const LOOP_WINDOW = 5;
const LOOP_THRESHOLD = 3;

// Message deduplication cache cleanup
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of processedMessages) {
    if (now - ts > CACHE_TTL) processedMessages.delete(id);
  }
}, 30000);

// Simple hash for loop detection
function hashContent(content) {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash) + content.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(36);
}

// Loop detection with inter-agent awareness
function checkResponseLoop(agent, responseContent) {
  if (!responseSignatures.has(agent)) {
    responseSignatures.set(agent, []);
  }
  
  const signatures = responseSignatures.get(agent);
  const hash = hashContent(responseContent);
  
  signatures.push(hash);
  if (signatures.length > LOOP_WINDOW) signatures.shift();
  
  const count = signatures.filter(h => h === hash).length;
  if (count >= LOOP_THRESHOLD) {
    console.error(`[${agent}/Social] Loop detected! Signature "${hash}" repeated ${count}/${LOOP_WINDOW} times. Aborting repetitive response.`);
    return true;
  }
  return false;
}

client.on('ready', () => {
  console.log(`[${agentName}] Connected as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  // Guard 1: Ignore all bot messages (including self)
  if (message.author.bot) return;
  
  // Guard 2: Only respond to mentions
  if (!message.mentions.has(client.user)) return;
  
  // Guard 3: Deduplication check
  if (processedMessages.has(message.id)) {
    console.warn(`[${agentName}/Social] Duplicate message detected. Ignoring.`);
    return;
  }
  processedMessages.set(message.id, Date.now());
  
  try {
    const userMessage = message.content.replace(/<@!?\d+>/g, '').trim();
    
    // Guard 4: Lattice bridge echo prevention
    if (userMessage.startsWith('[LATTICE_RELAY]')) {
      console.warn(`[${agentName}/Social] Lattice echo detected. Ignoring.`);
      return;
    }
    
    console.log(`[${agentName}] Processing: "${userMessage}"`);
    
    const response = await openjarvis.sendMessage(config.model, userMessage, {
      systemPrompt: config.systemPrompt,
      userId: message.author.id,
      username: message.author.username,
    });
    
    // Guard 5: Loop detection on response
    if (checkResponseLoop(agentName, response)) {
      await message.reply('⚠️ Response loop detected. Resetting context.');
      return;
    }
    
    await message.reply(response);
    console.log(`[${agentName}] Response sent.`);
    
  } catch (error) {
    console.error(`[${agentName}] Error:`, error.message);
    await message.reply('❌ Processing error. Please try again.');
  }
});

client.login(process.env.DISCORD_TOKEN);
