import { Client, GatewayIntentBits } from 'discord.js';

const token = process.env.ORACLE_DISCORD_TOKEN_LEO;
const channelId = "1489796367466500128"; // The channel that was flooded

if (!token) {
  console.error("Missing token");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

client.once('ready', async () => {
  console.log(`Logon as ${client.user.tag}`);
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    console.error("Invalid channel");
    process.exit(1);
  }

  console.log(`Purging messages in ${channel.name}...`);
  try {
    let deletedCount = 0;
    while (true) {
      const fetched = await channel.messages.fetch({ limit: 100 });
      const botMessages = fetched.filter(m => (m.author.id === "1498794939650412674" || m.author.id === client.user.id) && m.content.includes("Oracle is not reachable"));
      
      if (botMessages.size === 0) {
        break;
      }

      await channel.bulkDelete(botMessages);
      deletedCount += botMessages.size;
      console.log(`Deleted ${botMessages.size} messages (Total: ${deletedCount})...`);
      // Brief pause to respect rate limits
      await new Promise(r => setTimeout(r, 1000));
    }
    console.log(`Purge complete. Total deleted: ${deletedCount}`);
  } catch (err) {
    console.error("Failed to purge:", err.message);
  }
  process.exit(0);
});

client.login(token);
