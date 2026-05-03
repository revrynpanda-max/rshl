import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { isAllowed } from '../shared/channel-rules.mjs';
import { recordAIFailure, isSpeakerOffline } from '../shared/failure-tracker.mjs';
import { isLoopingResponse } from '../shared/utils.mjs';
import { startBotServer } from '../shared/ipc.mjs';

export function createBot(config) {
  const { name, token, port, generateResponse, onTick } = config;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message]
  });

  client.once('clientReady', () => {
    console.log(`[${name} Bot] Online as ${client.user.tag}`);
  });

  // Handle Heartbeat from Ecosystem Manager
  process.on('message', async (msg) => {
    if (msg.type === 'WORLD_TICK' && onTick) {
      await onTick(client, msg.worldState);
    }
  });

  // IPC server for Oracle to trigger this bot
  startBotServer(port, name, async (payload) => {
    if (isSpeakerOffline(name)) return;
    const { channelId, context } = payload;
    
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel) return;
      
      channel.sendTyping().catch(() => {});
      
      const reply = await generateResponse("System", context, channelId);
      
      if (reply) {
        if (isLoopingResponse(reply)) {
          recordAIFailure(name, `looping response: ${reply.slice(0, 80)}`, channelId);
          return;
        }
        await channel.send(reply);
      } else {
        recordAIFailure(name, "empty response generated", channelId);
      }
    } catch (e) {
      console.warn(`[${name}] IPC trigger failed:`, e.message);
    }
  });

  // Direct mentions from users
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const channelId = message.channelId;

    if (!isAllowed(name, channelId)) return;
    if (isSpeakerOffline(name)) return;

    // Only respond to direct mentions in discord
    if (message.mentions.has(client.user.id)) {
      message.channel.sendTyping().catch(() => {});
      const userName = message.author.username;
      const text = message.content.trim();
      
      const reply = await generateResponse(userName, text, channelId);
      
      if (reply) {
        if (isLoopingResponse(reply)) {
          recordAIFailure(name, `looping response: ${reply.slice(0, 80)}`, channelId);
          return;
        }
        await message.reply(reply).catch(console.error);
      } else {
        recordAIFailure(name, "empty response generated", channelId);
      }
    }
  });

  client.login(token).catch(e => console.error(`[${name}] Login failed:`, e.message));
  
  return client;
}

