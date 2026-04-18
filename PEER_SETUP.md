# Peer Connection Setup (v5.4)

KAI can bridge with high-tier external reasoning models to augment his native geometric field. Currently supported peers: **Claude (Anthropic)** and **Grok (xAI)**.

## 1. Get Your API Keys

- **Claude**: [Anthropic Console](https://console.anthropic.com/)
- **Grok**: [xAI Console](https://console.x.ai/)

## 2. Set Environment Variables

KAI looks for these specific environment variables in your shell.

### Windows (PowerShell)
```powershell
# Set for current session
$env:ANTHROPIC_API_KEY = "sk-ant-..."
$env:XAI_API_KEY = "xai-..."

# Set permanently (User level)
[System.Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "sk-ant-...", "User")
[System.Environment]::SetEnvironmentVariable("XAI_API_KEY", "xai-...", "User")
```

### macOS / Linux
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

- **401 Error**: Incorrect API key. Double check your typing and ensured the variable is exported.
- **402 Error**: Out of credits on your Anthropic or xAI account.
- **404 Error**: Model not found (usually if you're using an older KAI version).
- **400 Error**: Malformed request (check your internet connection or if the prompt is excessively long).
