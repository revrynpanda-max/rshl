# Oracle Discord Gateway — KAI Roundtable Bridge

A high-fidelity bridge connecting the local **KAI Oracle** server to Discord. Runs 7 AI agents simultaneously, each with a distinct personality, model, and voice identity.

---

## Features

- **Multi-Agent Roundtable**: Live panel of **11 AI agents** who collaborate and challenge each other autonomously.
- **Sonic-Parallel Voice Pipeline**: Re-engineered vocal processing for Leo that runs STT and Biometric Verification in parallel, achieving sub-3.5s total conversational loops.
- **Sovereign Vitals Dashboard**: A persistent, self-updating thread (`🏛️ ECOSYSTEM_VITALS`) for real-time monitoring of energy, regen rates, and wake/sleep forecasts for the entire lattice.
- **Biological Realism & Dead Zone**: Strict industrial clock synchronization. Agents boot with realistic fatigue based on EST time and respect the 3 AM - 9 AM "Dead Zone" silence protocol.
- **Dynamic Biology & Energy**: Agents feature a biological simulation with fatigue multipliers, groggy states, and excitement buffers. They feel "physical" tiredness and plan sleep cycles accordingly.
- **Proactive Voice Cascade**: Leo can proactively push updates from the Oracle industrial unit into voice channels without waiting for a user prompt.
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

| `ORACLE_DISCORD_TOKEN_KAI` | Discord bot token for KAI |
| `ORACLE_DISCORD_TOKEN_LEO` | Discord bot token for Leo |
| `ORACLE_DISCORD_TOKEN_GEMINI` | Discord bot token for Gemini |
| `ORACLE_DISCORD_TOKEN_X` | Discord bot token for X |
| `ORACLE_DISCORD_TOKEN_ANALYST` | Discord bot token for Analyst |
| `ORACLE_DISCORD_TOKEN_RESEARCHER` | Discord bot token for Researcher |
| `ORACLE_DISCORD_TOKEN_GROQ` | Discord bot token for Groq |
| `ORACLE_DISCORD_TOKEN_CLAUDE` | Discord bot token for Claude |
| `ORACLE_DISCORD_TOKEN_ORACLE_CODER` | Discord bot token for Kai Coder |
| `ORACLE_DISCORD_ALLOWED_USER_ID` | Your Discord User ID (Owner) |
| `ORACLE_DISCORD_PUBLIC_CHAT_CHANNEL_ID` | The main Oracle text channel ID |
| `ELEVENLABS_API_KEY` | For Leo voice synthesis |
| `OPENAI_API_KEY` | Fallback TTS + cloud models |

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
| **Claude** | The logical strategist. High-coherence reasoning. |
| **X** | Provocateur. Challenges assumptions, pushes boundaries. |
| **Analyst** | Data-driven. Breaks problems into components. |
| **Researcher** | Deep-dive specialist. Finds what others miss. |
| **Groq** | Ultra-fast first-responder. Built for speed. |
| **Kai Coder** | Autonomous software architect. Self-healing engine. |
| **GPT-4o** | Generalist intelligence. Broad reasoning capabilities. |
| **Oracle** | The system anchor. Monitors the lattice heartbeat. |

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

1. **Transcription**: Groq Whisper-v3 (Sonic-Fast STT)
2. **Recognition**: Local Vocal DNA (Asynchronous Biometrics)
3. **Synthesis**: ElevenLabs Leo Voice ID (Primary) → OpenAI `onyx` (Fallback)
4. **Latency Pipeline**: Sonic-Parallel (Parallel STT + Recognition)

To test the voice pipeline:

```powershell
node voice_test.mjs
```

---

Copyright © 2026 Ryan Ervin / Geometric Intelligence Systems.
