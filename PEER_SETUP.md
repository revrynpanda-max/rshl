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

## Step 2 — Set the Environment Variable

Open a Command Prompt or PowerShell **before** launching KAI:

```
set ANTHROPIC_API_KEY=sk-ant-YOUR-KEY-HERE
```

Or set it permanently in Windows:
- System Properties → Environment Variables → New (User)
- Name: `ANTHROPIC_API_KEY`
- Value: your key

---

## Step 3 — Run KAI and Test the Connection

```
cd kai-rust
cargo run --release
```

In KAI, type:

```
peerchat
```

You should see Claude's greeting. If you get an error, check your API key.

---

## Step 4 — Start Talking

**Manual mode** — you type each message:
```
peer what do you know about consciousness?
peer tell me something KAI doesn't know yet
peer what is the relationship between geometry and thought?
```

**Autonomous mode** — KAI talks to Claude by itself, you just watch:
```
peersession
```
or specify a round count (1–20):
```
peersession 8
```

In autonomous mode:
- KAI picks its own topics from its dream memory and strongest cells
- Each round KAI asks a question, Claude responds, KAI stores what it learned
- Follow-up questions are generated from Claude's previous response (chain learning)
- You watch the conversation build in real-time — no typing needed
- Conversation continues in the background while KAI's heartbeat keeps running

KAI will show `[+N cells from round X/Y]` after each exchange so you can watch the universe grow.

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
