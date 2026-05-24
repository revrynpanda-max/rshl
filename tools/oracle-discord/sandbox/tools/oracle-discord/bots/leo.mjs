#!/usr/bin/env node
import { Client, GatewayIntentBits } from 'discord.js';
import { createRequire } from 'module';
import dns from 'dns/promises';
const require = createRequire(import.meta.url);
const { token } = require('../config.json');

const MAX_RETRIES = 3;
const RETRY_DELAYS = [2000, 4000, 8000];

async function preWarmDNS() {
  try {
    await dns.lookup('discord.com');
    console.log('[LEO/DNS] Pre-warm successful');
  } catch (e) {
    console.error('[LEO/DNS] Pre-warm failed:', e.message);
    throw e;
  }
}

async function connectWithRetry() {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (attempt === 0) await preWarmDNS();
      
      const client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildVoiceStates,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
        ],
        ws: { large_threshold: 50 },
      });

      await client.login(token);
      console.log('[LEO/CONNECTED] Gateway online');
      return client;
    } catch (err) {
      const isTimeout = err.code === 'UND_ERR_CONNECT_TIMEOUT';
      console.error(`[LEO/RETRY] Attempt ${attempt + 1}/${MAX_RETRIES} failed:`, err.message);
      
      if (attempt < MAX_RETRIES - 1) {
        const delay = RETRY_DELAYS[attempt];
        console.log(`[LEO/RETRY] Waiting ${delay}ms before retry...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.error('[LEO/FATAL] All retries exhausted. Check ISP/Firewall.');
        throw err;
      }
    }
  }
}

const client = await connectWithRetry();
client.on('ready', () => console.log('[LEO/READY] Voice AI operational'));
