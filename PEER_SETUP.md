# Peer Connection Setup (v5.9.0)

KAI can bridge with external reasoning models to augment his native geometric field. Currently supported peers: **Claude (Anthropic)**, **Grok (xAI)**, and **Ollama (local LLM)**.

## 1. Ollama (Local Hybrid Voice — Recommended)

Ollama runs locally and acts as KAI's "vocal tract" — articulating what the lattice has already decided. No API key needed.

```powershell
# Install from https://ollama.com
# Pull a model
ollama pull phi3:mini

# KAI auto-detects Ollama on localhost:11434
# No configuration needed — just start KAI
```

When Ollama is available, the lattice's helical phase coherence (Φ_C) gates whether Ollama speaks:
- **Φ_C > 0.30**: Ollama articulates the lattice's signal
- **Φ_C ≤ 0.30**: Pure-lattice fallback (field too incoherent for translation)

## 2. Cloud Peers (Claude / Grok)

### Get Your API Keys
- **Claude**: [Anthropic Console](https://console.anthropic.com/)
- **Grok**: [xAI Console](https://console.x.ai/)

### Set Environment Variables

#### Windows (PowerShell)
```powershell
# Set for current session
$env:ANTHROPIC_API_KEY = "sk-ant-..."
$env:XAI_API_KEY = "xai-..."

# Set permanently (User level)
[System.Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "sk-ant-...", "User")
[System.Environment]::SetEnvironmentVariable("XAI_API_KEY", "xai-...", "User")
```

#### macOS / Linux
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export XAI_API_KEY="xai-..."
```

## 3. Verify Connections

Launch KAI and run the following commands to check connectivity:

```text
peerchat        # Pings Claude via Anthropic API
peer ping grok  # Pings Grok via xAI API
```

## 4. Usage in KAI

- `peer <message>`: Send a direct message to the primary peer.
- `peersession [n]`: Watch KAI and a peer talk autonomously.
- `peersession grok n`: Watch KAI and Grok perform deep reasoning rounds.

---

### Troubleshooting

- **401 Error**: Incorrect API key. Double check your typing and ensure the variable is exported.
- **402 Error**: Out of credits on your Anthropic or xAI account.
- **404 Error**: Model not found (usually if you're using an older KAI version).
- **400 Error**: Malformed request (check your internet connection or if the prompt is excessively long).
- **Ollama not detected**: Ensure Ollama is running (`ollama serve`) and accessible on `http://localhost:11434`.
