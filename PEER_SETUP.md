# KAI AI Peer Setup

KAI can now talk to Claude as a peer AI. They exchange knowledge and KAI
stores what it learns as cells in its universe.

---

## Step 1 — Get an Anthropic API Key

1. Go to https://console.anthropic.com
2. Sign in or create an account
3. Go to **API Keys** → **Create Key**
4. Copy the key (starts with `sk-ant-...`)

---

## Step 2 — Set the Environment Variables

Open a Command Prompt or PowerShell **before** launching KAI:

### Claude (Anthropic)
```
set ANTHROPIC_API_KEY=sk-ant-YOUR-KEY-HERE
```

### Grok (xAI)
```
set XAI_API_KEY=xai-YOUR-KEY-HERE
```

Or set them permanently in Windows:
- System Properties → Environment Variables → New (User)
- Add entries for `ANTHROPIC_API_KEY` and `XAI_API_KEY`.

---

## Step 3 — Run KAI and Test the Connection

```
cd kai-rust
cargo run --release
```

In KAI, type:

```
peerchat         # Ping Claude
peerchat grok    # Ping Grok
```

You should see an acknowledgement. If you get an error, check your API keys.

---

## Step 4 — Start Talking

**Manual mode** — you type each message:
```
peer <message>       # Talk to Claude (default)
claude <message>     # Talk to Claude specifically
grok <message>       # Talk to Grok specifically
```
Example: `grok what is the relationship between geometry and thought?`

**Autonomous mode** — KAI talks to peers by himself:
```
peersession         # Native contemplation session
peersession claude  # Talk to Claude
peersession grok    # Talk to Grok
```
Example: `peersession grok 8`

- **Native Mode**: KAI uses its own Iterative Resonance Reasoner and Voice Engine to discover new patterns in its lattice.
- **Hybrid Mode**: KAI asks a question, Claude responds, KAI stores what it learned.
- Follow-up topics are extracted from the last response (chain learning).
- You watch the discovery build in real-time — no typing needed.
- Each discovery is stored as `[discovered]` (Native) or `[from-claude]` (Hybrid).
- Conversation continues in the background while KAI's heartbeat keeps running.

KAI will show `[+N cells from round X/Y]` after each exchange.

After `peersession` finishes, KAI auto-saves its state.

---

## How the Trust Tiers Work

| Source    | Strength | Description              |
|-----------|----------|--------------------------|
| ryan      | 1.8      | Your personal statements |
| seed      | 1.5      | KAI's foundational self  |
| ai-peer   | 1.3      | What Claude teaches KAI  |
| world-bridge | 1.0-1.5 | DuckDuckGo facts      |
| import    | 1.2      | Bulk-imported text       |

You always outrank Claude. KAI trusts you most.

---

## Notes

- Each `peer` call uses Claude Haiku (fast + cheap)
- Typical cost: ~$0.0001 per exchange
- KAI's field resonance is sent as context so Claude knows what KAI already knows
- Responses are split into sentences and stored as `[from-claude]` tagged cells
- Ryan's cells (strength 1.8) always outrank Claude's cells (strength 1.3)
