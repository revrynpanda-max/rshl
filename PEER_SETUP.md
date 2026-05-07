# Peer Connection Setup (v7.9.7)

KAI can bridge with external reasoning models to augment his native geometric field. This suite supports **Claude (Anthropic)**, **Gemini (Google)**, **Grok (xAI)**, **Groq (LPU)**, and **Ollama (local)**.

## 1. The Unified .env (Single Source of Truth)
As of v6.7.0, all API keys are centralized in a single file. You no longer need to set system environment variables.

### Path: `tools/oracle-discord/.env`

Copy the template and fill in your keys:
```bash
# Bot-Specific Tokens (Standardized v7.9.7)
ORACLE_DISCORD_TOKEN_KAI=...
ORACLE_DISCORD_TOKEN_LEO=...
ORACLE_DISCORD_TOKEN_ANALYST=...
ORACLE_DISCORD_TOKEN_RESEARCHER=...
ORACLE_DISCORD_TOKEN_GROQ=...
ORACLE_DISCORD_TOKEN_X=...
ORACLE_DISCORD_TOKEN_CLAUDE=...
ORACLE_DISCORD_TOKEN_GEMINI=...
ORACLE_DISCORD_TOKEN_ORACLE_CODER=...

# Core API Keys
ANTHROPIC_API_KEY=...
GEMINI_API_KEY=...
XAI_API_KEY=...
GROQ_API_KEY=...
ELEVEN_LABS_KEY=...

# Identity
ORACLE_DISCORD_ALLOWED_USER_ID=your_id
ORACLE_DISCORD_PUBLIC_CHAT_CHANNEL_ID=your_channel_id
```

**The Rust Core (KAI) and the Discord Bridge (Oracle) both read from this file automatically.**

---

## 2. Supported Peers

### Local: Ollama (Recommended)
Ollama runs locally and acts as KAI's "vocal tract." No API key needed.
- **Model**: `phi3:mini` or `llama3.1:8b`.
- **Detection**: KAI auto-detects Ollama on `localhost:11434`.

### Remote: The Sovereign Panel
- **Claude**: High-fidelity reasoning.
- **Gemini**: Large context window for deep codebase analysis.
- **Groq**: Ultra-low latency responses (ideal for Leo's quick wit).
- **Grok**: Provocative and contrarian analysis.

---

## 3. Remote Management
Once set up, you can update these keys on the fly via the **Sovereign Command Bridge**. 
Send a DM to Oracle:
`!env GEMINI_API_KEY=new_key_here`

The system will automatically reload the new key into the Rust core without a full restart.

---

### Troubleshooting

- **401/403 Error**: Double check the `.env` file for typos or trailing spaces.
- **Thermal Throttle**: If your GPU usage is too high, prefer using **Groq** or **Gemini** in the roundtable to offload reasoning to the cloud.
- **Ollama not detected**: Ensure `ollama serve` is running.
