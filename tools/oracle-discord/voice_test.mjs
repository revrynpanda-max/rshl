import { Client, GatewayIntentBits } from "discord.js";
import { joinVoiceChannel, createAudioPlayer, createAudioResource, VoiceConnectionStatus, entersState } from "@discordjs/voice";
import * as fs from "fs";

// Load from .env or manual config
const token = process.env.ORACLE_DISCORD_TOKEN_LEO;
const voiceChannelId = process.env.ORACLE_DISCORD_LEO_VOICE_CHANNEL_ID || "1489796367466500129";

if (!token) {
    console.error("Missing ORACLE_DISCORD_TOKEN_LEO");
    process.exit(1);
}

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

client.once("ready", async () => {
    console.log(`Test bot online as ${client.user.tag}`);
    try {
        const channel = await client.channels.fetch(voiceChannelId);
        if (!channel) throw new Error("Channel not found");
        
        console.log(`Joining channel: ${channel.name} (${channel.id})`);
        
        const connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator,
        });

        connection.on(VoiceConnectionStatus.Ready, () => {
            console.log("Voice connection READY!");
            // Try to play a short silence or sound if we have ffmpeg
            console.log("Test successful. Connection established.");
            process.exit(0);
        });

        await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
    } catch (err) {
        console.error("Test failed:", err);
        process.exit(1);
    }
});

client.login(token);
