// claude-bot.mjs — talk to Claude (Anthropic API) through Discord, on the go.
//
// A "Claude" persona in your fleet, backed by the Anthropic Messages API and gated
// to YOU. DM it or @mention it; it confirms it's you, holds short conversation
// context, and chunks long replies under Discord's 2000-char limit.
//
// ── Setup (one time) ────────────────────────────────────────────────────────
//   1. Anthropic API key:  https://console.anthropic.com  ->  put in .env as
//        ANTHROPIC_API_KEY=sk-ant-...
//   2. A Discord bot token (create an app + bot, invite it, enable the
//      MESSAGE CONTENT intent in the Developer Portal) -> .env:
//        ORACLE_DISCORD_TOKEN_CLAUDE=...
//   3. Your Discord user id is already ORACLE_DISCORD_ALLOWED_USER_ID.
//   4. Run:  node tools/oracle-discord/bots/claude-bot.mjs
//      (or add "Claude" to the ecosystem-manager process map to boot it with the fleet)
//
// NOTE: this bot has ONLY the Anthropic API behind it — it can think/answer/architect,
// but it does NOT have file/shell tools unless you wire your fleet's tool system in
// (the same `executeToolCall` pattern your other bots use). That's the upgrade path
// to "do everything it can do" on the desktop.

import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import 'dotenv/config';

const TOKEN   = process.env.ORACLE_DISCORD_TOKEN_CLAUDE;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const OWNER   = process.env.ORACLE_DISCORD_ALLOWED_USER_ID || '1111106883135217665';
const MODEL   = process.env.CLAUDE_MODEL || 'claude-opus-4-8';

if (!TOKEN)   { console.error('[Claude] Missing ORACLE_DISCORD_TOKEN_CLAUDE in .env — set the Discord bot token.'); process.exit(1); }
if (!API_KEY) { console.error('[Claude] Missing ANTHROPIC_API_KEY in .env — get one at console.anthropic.com.'); process.exit(1); }

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const history = new Map(); // userId -> [{role, content}]
const MAX_TURNS = 12;

const SYSTEM = `You are Claude, talking to Ryan (Owner/Creator of the KAI ecosystem) through his Discord, so he can work with you on the go. Be direct, technical, and warm — his coding/architecture partner for the KAI project (a ternary RSHL AI: Rust engine on 127.0.0.1:3334, a Node.js Discord fleet, Python training in overnight_pipeline.py). Keep replies concise for chat unless he asks you to go deep. You do not have file/shell access from here — if a task needs that, say so and suggest he run it in the desktop app.`;

async function askClaude(userId, text) {
  const turns = history.get(userId) || [];
  turns.push({ role: 'user', content: text });
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      messages: turns.slice(-MAX_TURNS),
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const reply = (data?.content || []).map(b => b.text || '').join('').trim() || '(empty reply)';
  turns.push({ role: 'assistant', content: reply });
  history.set(userId, turns.slice(-MAX_TURNS));
  return reply;
}

client.once(Events.ClientReady, c =>
  console.log(`[Claude] Online as ${c.user.tag}. DM me or @mention me (owner-gated). Model: ${MODEL}.`));

client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author.bot) return;
    const isDM = !msg.guild;
    const mentioned = msg.mentions?.users?.has(client.user.id);
    if (!isDM && !mentioned) return;

    // OWNER GATE — confirm it's you before doing anything.
    if (msg.author.id !== OWNER) {
      if (isDM) msg.reply("This Claude line is private to the owner.").catch(() => {});
      return;
    }

    const text = msg.content.replace(/<@!?\d+>/g, '').trim();
    if (!text) return;
    if (text.toLowerCase() === '/reset') { history.delete(msg.author.id); msg.reply('Context cleared.').catch(() => {}); return; }

    await msg.channel.sendTyping().catch(() => {});
    const reply = await askClaude(msg.author.id, text);
    for (let i = 0; i < reply.length; i += 1900) {
      const chunk = reply.slice(i, i + 1900);
      await msg.reply(chunk).catch(() => msg.channel.send(chunk).catch(() => {}));
    }
  } catch (e) {
    console.error('[Claude] error:', e.message);
    msg.reply(`(error: ${e.message})`).catch(() => {});
  }
});

client.login(TOKEN);
