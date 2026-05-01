# Oracle Discord Gateway

Minimal Ryan-only Discord bridge for the local KAI Oracle server.

The bot is intentionally dumb:

- it accepts messages only from `ORACLE_DISCORD_ALLOWED_USER_ID`
- it calls one Oracle endpoint: `POST /api/discord-turn`
- Oracle records the Discord turn and routes it to the platform or named participant
- the bot sends Oracle's returned reply back to Discord

## Discord Message Routing

- `oracle help` shows the phone commands.
- `oracle status` shows the current Oracle session status.
- `kai hello` talks directly to KAI.
- `kai ...`, `gemini ...`, `gpt ...`, `groq ...`, `researcher ...`, `analyst ...`, and `leo ...` route to those Oracle participants when their backend is configured.
- A normal unaddressed message is logged into the Oracle session and answered by Oracle as the platform.

## Quick Buttons

Every Oracle reply includes quick buttons:

- â” **Help** -> `oracle help`
- ðŸ“ **Table** -> `oracle status`
- ðŸ§  **KAI** -> ask KAI what he is holding right now
- ðŸ”Ž **Analyst** -> ask the analyst for the biggest current issue
- ðŸ“š **Researcher** -> ask what context is needed next

Discord does not allow bots to add a permanent custom toolbar at the bottom of chat. If you want a persistent control panel, send `oracle help` and manually pin that bot message in the channel.

## Setup

1. Create a Discord application and bot in the Discord Developer Portal.
2. Enable **Message Content Intent** for the bot:
   - Discord Developer Portal -> your application -> **Bot**
   - Scroll to **Privileged Gateway Intents**
   - Turn on **Message Content Intent**
   - Save changes
3. Invite the bot to your private server or DM it.
4. In Discord, enable **User Settings > Advanced > Developer Mode**.
5. Right-click your own profile and choose **Copy User ID**. This is the value for `ORACLE_DISCORD_ALLOWED_USER_ID`.
6. Optional: right-click `#general` or another channel and choose **Copy Channel ID**. This is the value for `ORACLE_DISCORD_ALLOWED_CHANNEL_ID`.
7. Start KAI so Oracle is listening on `http://127.0.0.1:3333`.
8. In PowerShell, run the guided starter:

```powershell
cd C:\KAI\tools\oracle-discord
.\run-oracle-discord.ps1
```

The script will ask for the bot token, your numeric user ID, and optionally a channel ID. It does not save the token.

Manual startup is also supported:

```powershell
cd C:\KAI\tools\oracle-discord
npm install
$env:ORACLE_DISCORD_TOKEN="your_bot_token"
$env:ORACLE_DISCORD_ALLOWED_USER_ID="your_discord_user_id"
# Optional: lock to one Discord channel
# $env:ORACLE_DISCORD_ALLOWED_CHANNEL_ID="your_channel_id"
npm start
```

## Config Check

```powershell
node index.mjs --check-config
```

## Notes

This gateway does not expose shell commands, file reads, test approval, or an Oracle command dashboard. Those should be added only after the simple phone loop works.
