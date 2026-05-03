import { Client, GatewayIntentBits, PermissionsBitField } from 'discord.js';
import 'dotenv/config';
import { CHANNEL_IDS } from '../shared/channel-rules.mjs';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

client.once('ready', async () => {
  console.log(`[Diagnostic] Logged in as ${client.user.tag}`);
  
  try {
    const channel = await client.channels.fetch(CHANNEL_IDS.SUNDAY);
    if (!channel) {
      console.error("[Error] Could not find Sunday Chat channel.");
      process.exit(1);
    }

    console.log(`\n--- Raw Overwrites for #${channel.name} ---`);
    channel.permissionOverwrites.cache.forEach(overwrite => {
      console.log(`Overwrite ID: ${overwrite.id} (Type: ${overwrite.type === 0 ? 'Role' : 'Member'})`);
      console.log(`  Allowed: ${overwrite.allow.toArray().join(', ') || 'None'}`);
      console.log(`  Denied:  ${overwrite.deny.toArray().join(', ') || 'None'}`);
    });

    console.log("\n--- Audit Complete ---");
    process.exit(0);
  } catch (e) {
    console.error("[Error]", e.message);
    process.exit(1);
  }
});

client.login(process.env.ORACLE_DISCORD_TOKEN_KAI);
