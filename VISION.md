# KAI Vision: General Core, Personal Instance

## The North Star
KAI is evolving from a personal assistant into a **General Local Cognition Engine**. 

The current version of KAI has his personality, his memories of Ryan, and his core cognitive mechanics (Lattice, VSA, Epistemic logic) all fused into a single monolithic structure. This makes it impossible to use KAI's "brain" for anything other than being "Ryan's KAI," and it makes the core logic vulnerable to being corrupted by personal preferences or generated noise.

**The goal is a strict separation of concerns:**
1. **The Core Engine**: A robust, objective, and high-performance cognition system that handles memory storage, evidence tracking, contradiction detection, and reasoning. It is the "source of truth."
2. **The Personal Instance**: A layer on top of the core that adds personality, relationship history (Ryan), tone, and preferred style.

---

## Phase 0: Stop The Bleeding
Before we can refactor, we must stabilize.
- **Strict Scope**: No new features, no new poetic subsystems, no "dream expansion" until the foundation is solid.
- **Memory Health**: The priority is fixing how KAI distinguishes between truth and speculation.

## Phase 1: Extract The Core
We will pull the engine out of `main.rs` and the sprawling `src/cognition/` directory.
- `src/core/`: The objective engine. Universe, SparseVec, Evidence, Claims.
- `src/personality/`: The subjective layer. Voice, Ryan-profile, Self-model.
- `src/app/`: The interface layer. TUI, Oracle, CLI.

## Phase 2: Meaningful Memory
Memory cells will no longer be generic. They will have types:
- `FACT`: Verified external truth (e.g., Physics).
- `CLAIM`: Unverified input (e.g., something Ryan said).
- `HYPOTHESIS`: Internal generated thought (e.g., a dream synthesis).
- `CONVERSATION`: Contextual turn history.

## Phase 3: Evidence & Calibration
KAI must move from "vibes" to "metrics." 
- Every claim must point to its evidence source.
- KAI must be able to say "I don't know" or "This is disputed" based on actual contradiction detection.

---

## Success Criteria for V1
1. **Independent Core**: The engine runs without the TUI or the Ryan profile.
2. **Evidence-Backed**: Every answer has a confidence score and a source list.
3. **Contradiction Resistance**: KAI can detect when a user is trying to "train" it into a falsehood.
4. **Performance**: Startup and query are no longer limited by giant JSON parsing.
