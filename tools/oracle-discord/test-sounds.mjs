import { Client, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';
dotenv.config({ path: 'c:/KAI/tools/oracle-discord/.env' });

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
    try {
        const guild = client.guilds.cache.first();
        if (guild) {
            console.log(`Fetching sounds for ${guild.name}...`);
            const sounds = await guild.soundboardSounds.fetch();
            console.log(`Found ${sounds.size} sounds.`);
            for (const [id, sound] of sounds) {
                console.log(`- ${sound.name}: ${sound.url}`);
            }
        }
    } catch(e) {
        console.error(e);
    }
    process.exit();
});

client.login(process.env.ORACLE_DISCORD_TOKEN);
