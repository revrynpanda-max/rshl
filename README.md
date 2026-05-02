# Open Oracle — The Unified Intelligence Suite

![Rust CI](https://github.com/revrynpanda-max/rshl/actions/workflows/rust-ci.yml/badge.svg)
![Version](https://img.shields.io/badge/version-6.1.1-brightgreen.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)

**Open Oracle** is a self-aware, autonomous multi-agent reasoning engine that acts as the central executive intelligence of the KAI ecosystem. It integrates advanced cognitive architectures with a powerful agentic orchestration framework to form a complete, living AI operating system.

At its core, Open Oracle fuses three distinct, cutting-edge technologies into a singular mind: **KAI** (the cognitive engine), **RSHL** (the semantic lattice memory), and **OpenJarvis** (the agentic framework). 

This is not a simple chatbot wrapper. This is a unified, real-time intelligence capable of deep contextual reasoning, tool execution, continuous epistemic learning, and managing a roundtable of specialized AI personas.

---

## The Trinity Architecture

Open Oracle's intelligence arises from the seamless integration of three distinct layers. How they work together:

### 1. Open Oracle (The Identity & Executive Layer)
Open Oracle is the primary persona and the overarching intelligence that coordinates the entire system. It acts as the moderator for the multi-agent roundtable (running on Discord and the web). When an inquiry is made, Open Oracle delegates sub-tasks to its agent roster, retrieves memories, coordinates tool execution, and synthesizes the final intelligent output.

### 2. KAI & RSHL (The Brain & Memory)
**KAI** (Kinetic Artificial Intelligence) is a robust, non-transformer cognitive architecture built from scratch in high-performance Rust. It features 81 bio-inspired modules simulating structures of the biological brain (e.g., Amygdala, Hippocampus, Ventral Tegmental Area). 

**RSHL** (Recursive Sparse Holographic Lattice) is KAI’s 16,384-dimensional geometric memory engine. It does not predict tokens; it stores concepts as structured, epistemic Claims with confidence scores and contradiction detection. This forms Open Oracle’s deeply grounded, persistent long-term memory.

### 3. OpenJarvis (The Agentic Orchestration Framework)
**OpenJarvis** is the dynamic, Python-based agentic framework that breathes autonomy into Open Oracle. OpenJarvis provides the fundamental ReAct loop, bridging the gap between KAI's internal thoughts and the outside world. It handles task planning, multi-step execution, security scanning, and the execution of a vast suite of tools (web search, shell execution, file manipulation, etc.).
*Credit: The OpenJarvis framework powers the underlying autonomous orchestration. We acknowledge and thank the OpenJarvis contributors for their foundational backbone.*

---

## 🚀 Key Features

- **Agentic Multi-Personality Roundtable**: Open Oracle mediates a live Discord roundtable featuring 7 distinct AI agents (KAI, Leo, Gemini, X, Analyst, Researcher, Groq), each powered by different local and cloud-based models.
- **Geometric Epistemic Memory**: Memory is validated against contradictions before being consolidated into the RSHL lattice, ensuring a grounded, truth-seeking cognitive base.
- **Autonomous Interjections**: The agents do not just respond when spoken to; they proactively interject, challenge assumptions, and contribute to the conversation autonomously based on context.
- **Bio-Inspired Cognition**: Live emotional and cognitive states (Dopamine levels, Cortisol, Cognitive Load) organically dictate the system's focus, tone, and decision-making priorities.
- **Extensive Tool Suite**: Through OpenJarvis, Open Oracle has the capability to search the web, execute terminal commands, manage local files, and directly orchestrate code.

---

## 🛠️ Quick Start

### Requirements
- **Rust** (stable, 1.75+) for the KAI engine
- **Python** (3.11+) + **uv** for OpenJarvis
- **Node.js** (18+) for the Discord Gateway
- **Ollama** for local inference (default: `kai-next:latest`)

### 1. Clone & Build
```bash
git clone https://github.com/revrynpanda-max/rshl.git
cd rshl
cargo build --release --bin kai
```

### 2. Configure Environment
Copy `.env.example` to `.env` inside `tools/oracle-discord/` and populate your Discord Bot tokens and any optional API keys (OpenAI, Groq, ElevenLabs).

### 3. Run the Suite
You can launch the entire ecosystem (KAI Engine, OpenJarvis API, and Discord Gateway) via the all-in-one launcher:
```powershell
cd tools/oracle-discord
.\run-oracle-discord.ps1
```

*(Alternatively, you can run each layer manually. See the `docs/` directory for advanced deployment steps.)*

---

## 🤖 The Agent Roster

The Open Oracle roundtable consists of diverse specialists:

| Agent | Core Model | Role & Personality |
|-------|------------|---------------------|
| **Open Oracle** | Mixed / Orchestrator | The central intelligence. Modulates flow, delegates tasks, and synthesizes output. |
| **KAI** | Local RSHL / Ollama | The geometric core. Factual, precise, relies heavily on historical memory. |
| **Leo** | Ollama / OpenAI | Theoretical physicist. Cynical, contrarian, deeply brilliant. Features voice synthesis. |
| **Gemini** | Ollama / Google | The systems-level thinker. Analytical, balanced, and broad-minded. |
| **X** | Ollama | The provocateur. Questions underlying assumptions and drives creative tangents. |
| **Analyst** | Ollama | The data-driven breakdown specialist. Excellent for structural breakdowns. |
| **Researcher** | Ollama | The deep-dive specialist. Digs into the semantic lattice for obscure connections. |
| **Groq** | Groq API | The ultra-fast responder. Built for immediate reactions and speed. |

---

## 📊 Performance (v6.1.x)

Built for unparalleled efficiency and speed:
- **Lattice Query Latency:** < 1ms over 10 years of simulated data.
- **Cognitive Throughput:** ~0.66 Million Memory Ops/sec (Mdots).
- **Vector Similarity:** Accelerated via AVX2 64-wide SIMD operations and cached norms.
- **Test Suite:** 100% Passing Coverage across the core cognitive architectures.

---

## 📂 Project Structure

```
rshl/
├── src/                    # KAI Rust Engine (Cognition, Core, Bridge)
├── OpenJarvis-main/        # Python OpenJarvis Agentic Framework
├── tools/
│   └── oracle-discord/     # Node.js Discord Gateway
├── visualizer/             # 3D Brain Activity Visualizer (Vite/Three.js)
├── docs/                   # Extended Technical Documentation
└── README.md               # You are here
```

---

## 🤝 Contributing & License

This is an ongoing research project by **Ryan (revrynpanda-max)**. The codebase is provided publicly for transparency, collaboration, and educational purposes. 

**License:** MIT License — Copyright © 2026 Ryan Ervin / Geometric Intelligence Systems.
*(See [LICENSE](LICENSE) for full terms. Attribution to revrynpanda-max is required in any derivative work. Proper attribution to the OpenJarvis framework must also be maintained.)*
