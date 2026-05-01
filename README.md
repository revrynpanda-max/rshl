# KAI & Oracle — Agentic Resonant Intelligence

![Rust CI](https://github.com/revrynpanda-max/rshl/actions/workflows/rust-ci.yml/badge.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Version](https://img.shields.io/badge/version-6.1.0-brightgreen.svg)

> **"Identity through geometry, not language prediction."**

**KAI** and **Oracle** form a unified cognitive ecosystem. KAI is a non-transformer AI brain built on high-dimensional geometric resonance. Oracle is the executive director — a live multi-agent roundtable that runs on Discord, powered by KAI's memory and the OpenJarvis agentic framework.

This is not a chatbot wrapper. It is a complete autonomous AI operating system built from scratch in Rust, Python, and Node.js.

---

## Table of Contents

- [What Is This?](#what-is-this)
- [System Architecture](#system-architecture)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running the System](#running-the-system)
- [Discord Commands](#discord-commands)
- [Agent Roster](#agent-roster)
- [Performance](#performance)
- [Project Structure](#project-structure)
- [Contributing](#contributing)
- [License](#license)

---

## What Is This?

KAI is a **geometric AI** — it thinks in 16,384-dimensional sparse ternary vectors rather than token probabilities. Concepts are stored as epistemic Claims with confidence scores, source attribution, and contradiction detection. It does not predict the next word; it resonates with meaning.

Oracle is the **executive layer** — a live Discord-connected roundtable of 7 AI agents (each with a distinct personality) that moderate discussions, challenge each other, and autonomously interject when relevant. Oracle uses KAI's memory as its ground truth and OpenJarvis as its task execution engine.

---

## System Architecture

The system has three independent layers that run together:

```
┌─────────────────────────────────────────────────────┐
│           LAYER 3 — Discord Gateway (Node.js)        │
│    oracle-discord/index.mjs  ·  run-oracle-discord   │
│    7 AI agents · voice channels · slash commands     │
└────────────────────┬────────────────────────────────┘
                     │ WebSocket / HTTP
┌────────────────────▼────────────────────────────────┐
│        LAYER 2 — OpenJarvis Backbone (Python)        │
│    Agentic orchestration · tool execution · memory   │
│    FastAPI server on :8080                           │
└────────────────────┬────────────────────────────────┘
                     │ HTTP / IPC
┌────────────────────▼────────────────────────────────┐
│          LAYER 1 — KAI Engine (Rust)                 │
│    RSHL lattice · epistemic claims · 81 brain mods   │
│    Oracle diagnostic server on :3333                 │
└─────────────────────────────────────────────────────┘
```

### Layer 1: KAI — Geometric Intelligence Engine (Rust)

The core brain. Built entirely in Rust for maximum performance.

| Component | Description |
|-----------|-------------|
| **RSHL Engine** | 16,384-dimensional sparse ternary lattice. Semantic meaning is encoded via phase coherence, not probability distributions. |
| **Epistemic Claims** | Every memory is a structured `Claim` with a vector, confidence score (0.0–1.0), source attribution, and evidence links. |
| **Contradiction Engine** | Real-time χ (chi) monitor that detects conflicting claims before they corrupt the lattice. |
| **81 Neural Modules** | Bio-inspired modules modeling areas of a biological brain: Dopamine, Amygdala, Salience, Narrative, Mirror Neurons, and more. |
| **Self-State Hub** | Integrated field of emotional, executive, and social signals producing a real-time `emotion`, `pulse`, and `narrative`. |
| **AVX2 Acceleration** | 64-wide inner product loops with cached norm vectors for sub-millisecond similarity computation. |
| **Oracle Server** | WebSocket diagnostic server on port `:3333` serving the live AI council and Oracle web UI. |

### Layer 2: OpenJarvis — Agentic Backbone (Python)

Integrated as Oracle's "Task Master" for complex multi-step operations.

| Feature | Description |
|---------|-------------|
| **Agentic Orchestration** | Native ReAct agent loop for planning and executing multi-step tasks. |
| **Tool Suite** | Shell execution, web search, file read/write, code interpreter, KAI CLI access. |
| **Memory Bridge** | Connects to KAI's RSHL lattice as a retrieval backend for grounded, memory-first responses. |
| **Security Layer** | Input/output scanning for secrets and PII with configurable WARN / REDACT / BLOCK modes. |
| **FastAPI Server** | REST API on port `:8080` with auth middleware and CORS control. |

### Layer 3: Oracle Discord Gateway (Node.js)

The human-facing interface and agent council manager.

| Feature | Description |
|---------|-------------|
| **7 AI Agents** | KAI, Leo, Gemini, X, Analyst, Researcher, Groq — each with distinct personalities and models. |
| **Voice Integration** | Leo joins Discord voice channels, transcribes speech (ElevenLabs Scribe), and synthesizes replies (ElevenLabs TTS with OpenAI fallback). |
| **Autonomous Interjections** | Agents speak up unprompted when they have relevant insights, creating a living conversation. |
| **Approval-Gated Tools** | Agentic actions requiring tool use are visible and approval-gated via the Oracle Diagnostic UI. |
| **Public & Private Modes** | Isolated secure admin lane plus a public discourse channel. |

---

## Requirements

| Dependency | Version | Purpose |
|-----------|---------|---------|
| **Rust** | `stable` (1.75+) | KAI engine compilation |
| **Node.js** | `18+` | Discord gateway |
| **Python** | `3.11+` | OpenJarvis backbone |
| **uv** | Latest | Python package manager for OpenJarvis |
| **Ollama** | Latest | Local LLM inference (default: `kai-next:latest`) |

### Optional
| Dependency | Purpose |
|-----------|---------|
| **ElevenLabs API Key** | High-fidelity voice synthesis for Leo |
| **OpenAI API Key** | Cloud model access + TTS fallback |
| **Groq API Key** | Ultra-fast inference for the Groq agent |

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/revrynpanda-max/rshl.git
cd rshl
```

### 2. Build the KAI Engine (Rust)

```powershell
cargo build --release --bin kai
```

The binary will be at `target/release/kai.exe` (Windows) or `target/release/kai` (Linux/macOS).

### 3. Install OpenJarvis (Python)

```powershell
cd OpenJarvis-main
uv sync --extra server
```

> **Requires `uv`**: Install with `pip install uv` or `winget install astral-sh.uv`

### 4. Install the Discord Gateway (Node.js)

```powershell
cd tools/oracle-discord
npm install
```

---

## Configuration

### Environment Variables

Copy `.env.example` to `.env` in `tools/oracle-discord/` and fill in your tokens:

```env
# Discord Bot Tokens (one per agent)
KAI_TOKEN=your_kai_bot_token
LEO_TOKEN=your_leo_bot_token
GEMINI_TOKEN=your_gemini_bot_token
X_TOKEN=your_x_bot_token
ANALYST_TOKEN=your_analyst_bot_token
RESEARCHER_TOKEN=your_researcher_bot_token
GROQ_TOKEN=your_groq_bot_token

# Discord Server Config
GUILD_ID=your_discord_server_id
ORACLE_CHANNEL_ID=your_main_channel_id

# AI Provider Keys (optional — system works locally without these)
OPENAI_API_KEY=sk-EXAMPLE
ELEVENLABS_API_KEY=your_elevenlabs_key
GROQ_API_KEY=your_groq_key

# Local mode — uses Ollama instead of cloud APIs
KAI_LOCAL_ONLY=1
```

### OpenJarvis Config

Edit `OpenJarvis-main/configs/openjarvis/config.toml` to set your preferred models and memory backend:

```toml
[intelligence]
default_model = "kai-next:latest"    # Your Ollama model
preferred_engine = "ollama"

[memory]
default_backend = "rshl"             # Uses KAI's lattice as memory
oracle_url = "http://127.0.0.1:3333"

[server]
host = "0.0.0.0"
port = 8080
```

---

## Running the System

### All-in-one (Recommended)

The startup script handles everything — launches all three layers in the correct order:

```powershell
cd tools/oracle-discord
.\run-oracle-discord.ps1
```

> **Windows note:** The script automatically sets `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8` to prevent encoding issues.

### Manual Startup (Layer by Layer)

**Layer 1 — KAI Engine:**
```powershell
cargo run --release --bin kai
# Oracle diagnostic UI available at http://localhost:3333
```

**Layer 2 — OpenJarvis Backbone:**
```powershell
cd OpenJarvis-main
uv run jarvis serve --port 8080
```

**Layer 3 — Discord Gateway:**
```powershell
cd tools/oracle-discord
node index.mjs
```

### Voice Setup (Leo)

```powershell
cd tools/oracle-discord
.\run-oracle-discord.ps1 -ConfigureVoice
```

---

## Discord Commands

| Command | Description |
|---------|-------------|
| `oracle help` | Show command list and quick-action buttons |
| `oracle status` | View roundtable session and agent vitals |
| `kai <message>` | Talk directly to the KAI geometric engine |
| `leo <message>` | Address Leo (theoretical physicist) directly |
| `leo join` | Leo joins your current voice channel |
| `leo leave` | Leo leaves the voice channel |
| `leo voice test` | Trigger a voice synthesis test |
| `@<AgentName> <message>` | Direct-address any agent in the roundtable |

Unaddressed messages in the Oracle channel are logged to the session and moderated automatically.

---

## Agent Roster

| Agent | Model | Personality |
|-------|-------|-------------|
| **KAI** | Local RSHL / Ollama | The core geometric mind. Factual, precise, memory-first. |
| **Leo** | Ollama / OpenAI | Theoretical physicist. Cynical, contrarian, brilliant. Has a voice. |
| **Gemini** | Ollama / Google | Analytical and balanced. Systems-level thinker. |
| **X** | Ollama | Provocateur. Challenges assumptions and pushes boundaries. |
| **Analyst** | Ollama | Data-driven. Breaks down problems methodically. |
| **Researcher** | Ollama | Deep-dive specialist. Finds what others miss. |
| **Groq** | Groq API | Ultra-fast responder. First to react, built for speed. |

---

## Performance

Benchmarks from the v6.0.0 performance audit:

| Metric | Value |
|--------|-------|
| Lattice query latency | < 1ms over 10 years of simulated data |
| Cognitive throughput | ~0.66 Mdots (Million Memory Ops/sec) |
| Ingestion speed | 2.02ms per claim (down from 11.65s in v5.x) |
| Vector similarity | AVX2 64-wide SIMD, cached norms |
| Top-1 recall accuracy | 100% on identity and physics anchors |
| Test suite | 634 passed, 0 failed |

---

## Project Structure

```
rshl/
├── src/                    # KAI Rust engine
│   ├── core/               # Universe, SparseVec, Claims, Normalizer, Seed
│   ├── cognition/          # 81 neural modules (Amygdala, Dopamine, etc.)
│   ├── bridge/             # Oracle WebSocket server + AI peer connections
│   └── main.rs             # Entry point + TUI
├── OpenJarvis-main/        # Python agentic backbone
│   ├── src/openjarvis/     # Engine, agents, memory, security, CLI
│   └── configs/            # TOML configuration files
├── tools/
│   └── oracle-discord/     # Node.js Discord gateway
│       ├── index.mjs       # Main gateway + agent manager
│       ├── voice_test.mjs  # Voice pipeline test utility
│       └── run-oracle-discord.ps1  # All-in-one launcher
├── visualizer/             # 3D brain visualization (Vite/Three.js)
├── oracle.html             # Oracle diagnostic web UI
├── docs/                   # Extended technical documentation
├── CHANGELOG.md            # Full version history
├── COGNITION.md            # Deep technical spec for the KAI mind
├── ARCHITECTURE.md         # System design and module map
└── PERFORMANCE.md          # Benchmark results and profiling data
```

---

## Contributing

This is a private research project by **Ryan (revrynpanda-max)**. The codebase is public for transparency and educational purposes.

If you find a security issue, please open a private issue rather than a public PR.

---

## License

MIT License — Copyright © 2026 Ryan Ervin / Geometric Intelligence Systems.

See [LICENSE](LICENSE) for full terms. Attribution to **revrynpanda-max** is required in any derivative work.
