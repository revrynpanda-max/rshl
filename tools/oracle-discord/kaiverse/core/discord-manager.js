import { Client, GatewayIntentBits, Partials, ChannelType } from "discord.js";
import 'dotenv/config'; // Make sure env vars are loaded

const ORACLE_CHAT_ID = process.env.ORACLE_DISCORD_ALLOWED_CHANNEL_ID || "1489796367466500128";
const PUBLIC_CHAT_ID = "1499108697631232090"; // over-all-chat

const THREAD_NAMES = [
    "kai-lattice",
    "oracle-command",
    "leo-work",
    "claude-work",
    "gemini-work",
    "x-work",
    "groq-work"
];

const THREAD_MAP = new Map(); // Name -> ThreadChannel ID

export class DiscordManager {
    constructor() {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildVoiceStates,
                GatewayIntentBits.DirectMessages,
            ],
            partials: [Partials.Channel, Partials.Message],
        });

        this.messageHandler = null;
    }

    onMessage(handler) {
        this.messageHandler = handler;
    }

    async start(token) {
        this.client.on("ready", async () => {
            console.log(`[DiscordManager] Logged in as ${this.client.user.tag}`);
            await this.ensureThreadsExist();
            console.log(`[DiscordManager] Thread mapping complete:`, Array.from(THREAD_MAP.entries()));
        });

        this.client.on("messageCreate", async (message) => {
            if (this.messageHandler) {
                await this.messageHandler(message, THREAD_MAP);
            }
        });

        await this.client.login(token);
    }

    async ensureThreadsExist() {
        try {
            const channel = await this.client.channels.fetch(ORACLE_CHAT_ID);
            if (!channel || channel.type !== ChannelType.GuildText) {
                console.error(`[DiscordManager] Could not find text channel ${ORACLE_CHAT_ID} to create threads.`);
                return;
            }

            const { threads } = await channel.threads.fetchActive();
            
            for (const name of THREAD_NAMES) {
                let existingThread = threads.find(t => t.name === name);
                
                if (!existingThread) {
                    console.log(`[DiscordManager] Thread '${name}' not found. Creating it...`);
                    existingThread = await channel.threads.create({
                        name: name,
                        autoArchiveDuration: 10080, // 1 week
                        reason: `Dedicated work thread for ${name}`
                    });
                }
                THREAD_MAP.set(name, existingThread.id);
                THREAD_MAP.set(existingThread.id, name); // Bi-directional lookup
            }
        } catch (error) {
            console.error(`[DiscordManager] Error ensuring threads:`, error);
        }
    }

    getThreadId(name) {
        return THREAD_MAP.get(name);
    }
}

export const discordManager = new DiscordManager();
