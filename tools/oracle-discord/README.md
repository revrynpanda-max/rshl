# Oracle Discord Gateway — KAI Roundtable Bridge

A high-fidelity bridge connecting the local **KAI Oracle** server to Discord. Runs 7 AI agents simultaneously, each with a distinct personality, model, and voice identity.

---

## Features

- **Multi-Agent Roundtable**: Live panel of 7 AI agents (Leo, Gemini, KAI, X, Analyst, Researcher, Groq) who collaborate and challenge each other autonomously.
- **Voice Channel Integration**: Leo joins Discord voice channels, listens to users via ElevenLabs Scribe (STT), and responds with ElevenLabs TTS (OpenAI fallback).
- **Autonomous Interjections**: Agents speak up unprompted when they have relevant insights — the council is always alive.
- **Secure Admin Lane**: Private channel for the owner with isolated public discourse mode.
- **Approval-Gated Tool Use**: Agentic tool calls (shell, file, web) are surfaced in the Oracle UI before execution.

---

## Requirements

- Node.js 18+
- A Discord Application with one bot token per agent (7 total)
- KAI Engine running on port `:3333`
- OpenJarvis backbone running on port `:8080`

---

## Setup

### 1. Install dependencies

```powershell
cd tools/oracle-discord
npm install
```

### 2. Configure tokens

The startup script will prompt for configuration on first run and save it securely:

```powershell
.\run-oracle-discord.ps1
```

Or set environment variables directly:

| Variable | Description |
|----------|-------------|
| `KAI_TOKEN` | Discord bot token for KAI |
| `LEO_TOKEN` | Discord bot token for Leo |
| `GEMINI_TOKEN` | Discord bot token for Gemini |
| `X_TOKEN` | Discord bot token for X |
| `ANALYST_TOKEN` | Discord bot token for Analyst |
| `RESEARCHER_TOKEN` | Discord bot token for Researcher |
| `GROQ_TOKEN` | Discord bot token for Groq |
| `GUILD_ID` | Your Discord server ID |
| `ORACLE_CHANNEL_ID` | The main Oracle text channel ID |
| `ELEVENLABS_API_KEY` | For Leo voice synthesis |
| `OPENAI_API_KEY` | Fallback TTS + cloud models |
| `KAI_LOCAL_ONLY` | Set to `1` to use only local Ollama models |

### 3. Configure Leo Voice (optional)

```powershell
.\run-oracle-discord.ps1 -ConfigureVoice
```

---

## Running

### All-in-one (starts all 3 layers)

```powershell
.\run-oracle-discord.ps1
```

### Gateway only (if KAI + OpenJarvis are already running)

```powershell
node index.mjs
```

---

## Discord Commands

| Command | Description |
|---------|-------------|
| `oracle help` | Show command list and quick-action buttons |
| `oracle status` | View current session and agent vitals |
| `kai <message>` | Talk directly to the KAI geometric engine |
| `leo <message>` | Address Leo directly |
| `leo join` | Leo joins your current voice channel |
| `leo leave` | Leo leaves the voice channel |
| `leo voice test` | Trigger a voice synthesis check |
| `@<AgentName> <message>` | Address any specific agent |

Unaddressed messages in the Oracle channel are routed to Oracle's session and moderated automatically.

---

## Agent Roster

| Agent | Personality |
|-------|-------------|
| **KAI** | The geometric mind. Factual, memory-first, precise. |
| **Leo** | Theoretical physicist. Cynical, brilliant, has a voice. |
| **Gemini** | Analytical systems thinker. Balanced and structured. |
| **X** | Provocateur. Challenges assumptions, pushes boundaries. |
| **Analyst** | Data-driven. Breaks problems into components. |
| **Researcher** | Deep-dive specialist. Finds what others miss. |
| **Groq** | Ultra-fast first-responder. Built for speed. |

---

## Required Discord Permissions

The bots require the following permissions in your server:

- Read Messages / View Channels
- Send Messages
- Read Message History
- Connect (for voice)
- Speak (for Leo voice)
- Use External Emojis

Enable the following **Privileged Gateway Intents** in your Discord Developer Portal for each bot:
- Message Content Intent
- Server Members Intent

---

## Voice Pipeline (Leo)

Leo's voice uses a dual-engine pipeline for maximum fidelity:

1. **Transcription**: ElevenLabs Scribe (high-accuracy STT)
2. **Synthesis**: ElevenLabs Leo Voice ID (primary) → OpenAI `onyx` (fallback)

To test the voice pipeline:

```powershell
node voice_test.mjs
```

---

Copyright © 2026 Ryan Ervin / Geometric Intelligence Systems.
