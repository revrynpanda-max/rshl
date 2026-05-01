# Oracle Discord Gateway — KAI Roundtable Bridge

A high-fidelity bridge connecting the local **KAI Oracle** server to Discord.

## 🔮 Features

- **Multi-AI Roundtable**: Communicate with Leo, Gemini, KAI, X, Analyst, Researcher, and Groq.
- **Voice Channel Integration**: Speak directly to **Leo** in voice channels using ElevenLabs/OpenAI TTS/STT.
- **Autonomous Interjections**: Agents speak up when relevant, creating a living council.
- **Public & Private Modes**: Secure administrative lane for Ryan, with a isolated public discourse channel.

## 🕹️ Discord Message Routing

- `oracle help` — Show the command list and quick buttons.
- `oracle status` — View the current roundtable session and agent vitals.
- `kai hello` — Talk directly to the KAI Geometric engine.
- `leo join` / `leo leave` — Manage voice channel presence.
- `leo voice test` — Trigger a high-fidelity voice check.

Unaddressed messages in the private channel are logged to the Oracle session and moderated by Oracle.

## 🎙️ Leo Voice Setup

Leo uses a dual-engine pipeline for maximum fidelity:
1. **Transcription**: ElevenLabs Scribe (High accuracy).
2. **Synthesis**: ElevenLabs Leo Voice (Primary) or OpenAI `onyx` (Fallback).

### Configuration
```powershell
cd C:\KAI\tools\oracle-discord
.\run-oracle-discord.ps1 -ConfigureVoice
```

## 🚀 Quick Start

1. Start the **Oracle Engine** (Rust) first.
2. In PowerShell, run the gateway:
   ```powershell
   cd C:\KAI\tools\oracle-discord
   .\run-oracle-discord.ps1
   ```
3. Use the `oracle help` command in Discord to verify connectivity.

## 📜 Permissions Required
The bot needs the following in your target server:
- View Channel / Read Message History
- Send Messages
- Connect / Speak (for Leo Voice)
- Use External Emojis

---
Copyright © 2026 Geometric Intelligence Systems.
