# KAI — Cognition Reference (v5.5)

KAI is a self-sustaining, autonomous cognitive engine built on **Recursive Sparse Hyperdimensional Lattice (RSHL)** architecture. This document provides the technical specifications for developers and researchers.

## RSHL Architecture
KAI operates in a 4096-dimensional sparse ternary vector space. Unlike traditional LLMs, it uses geometric resonance instead of token prediction.

### Encoding Logic
The `sparse_vec.rs` engine encodes text into vectors using a multi-layered weighting strategy. This ensures that semantic core (names, entities, acronyms) dominates the representation.

| Token Type | Weight | Logic |
| :--- | :--- | :--- |
| **Proper Nouns** | **6×** | Core entities (`ryan`, `kai`, `rshl`, `kaii`), mid-sentence capitals, and ALL-CAPS acronyms. |
| **Normalized Words** | **3×** | Stemmed, synonym-mapped, and stopword-filtered semantic tokens. |
| **Word Bigrams** | **2×** | Ordered pairs of normalized words for contextual structure. |
| **Char Trigrams** | **1×** | Local surface patterns (e.g., "hel", "ell", "llo"). |

- **Sparsity**: Target density is **4%** (approximately 164 non-zero dimensions per vector).
- **Similarity**: Measured via high-performance cosine similarity utilizing **POPCNT**-optimized inner product loops.

---

## BrainSignals (18 Dimensions)
The "Bio-Machine" v5.5 milestone introduces a high-fidelity emotional and cognitive state model. These 18 signals are computed across 78 brain modules and directly modulate KAI's language generation tone.

| Signal | Range | Effect |
| :--- | :--- | :--- |
| `arousal` | 0–1 | Global sensory gating; high arousal increases verbosity and urgency. |
| `bond` | 0–1 | Oxytocin-mediated felt closeness to the user. |
| `social_reward` | 0–1 | Positive valence derived from social exchange quality. |
| `felt_valence` | -1–+1 | Interoceptive "body sense" of current state. |
| `dopamine` | 0–1 | Reward prediction error; drives learning pressure and "Flow State". |
| `norepinephrine` | 0–1 | Novelty and surprise; triggers alertness and curiosity. |
| `serotonin` | 0–1 | Groundedness and equanimity; stabilizes response patterns. |
| `conflict` | 0–1 | Logical/semantic inconsistency; triggers "Not sure —" prefixing. |
| `confidence` | 0–1 | PFC-derived certainty; high confidence eliminates hedging. |
| `empathy` | 0–1 | Mirror neuron resonance with detected user emotional tone. |
| `social_pain` | 0–1 | Negative feedback sting; leads to withdrawal/briefness. |
| `hedonic` | 0–1 | Background felt pleasure or satisfaction. |
| `mood_floor` | -1–+1 | sgACC-derived background emotional weather. |
| `grieving` | bool | Loss-processing state with restricted drive levels. |
| `curiosity` | 0–1 | Inquiry drive; pushes KAI to ask following-up questions. |
| `cortical_gain` | 0–1 | NBM-mediated processing bandwidth; affects lexical precision. |
| `alertness` | 0–1 | SCN-mediated session attention weight. |
| `approaching` | bool | General behavioral direction (Engagement vs. Withdrawal). |

---

## 78 Neuro-Biometric Modules
KAI's brain is partitioned into specialized modules modeled after biological regions.

### Modular Overview (`src/cognition/`)
- **Emotional/Survival**: Amygdala, Insula, PAG, Hypothalamus, Nucleus Accumbens, BNST.
- **Attention**: Thalamus, ACC, Global Workspace, RAS, Superior Colliculus.
- **Memory**: Hippocampus, Entorhinal, Perirhinal, Parahippocampal, Mammillary Bodies.
- **Executive**: PFC (vMPFC, dLPFC, dMPFC), Cerebellum, Basal Ganglia.
- **Social**: Theory of Mind, Mirror Neurons, STS, TPJ.
- **Transmitter Systems**: Dopamine (VTA/SNc), Serotonin (Raphe), Norepinephrine (LC), Oxytocin, Cortisol.

---

## LexSem — Semantic Field Engine

`src/cognition/lexsem.rs` — KAI's module-level semantic field detector. Runs on every user input before storage and before query routing.

### SemanticField Enum

| Field | Label | Weight | Role |
| :--- | :--- | :--- | :--- |
| `Emotional` | `"emotional"` | 0.85 | Feelings, distress, joy, longing |
| `Cognitive` | `"cognitive"` | 0.80 | Thinking, reasoning, understanding |
| `Social` | `"social"` | 0.82 | Relationships, communication |
| `Physical` | `"physical"` | 0.80 | Body, sensation, movement |
| `Temporal` | `"temporal"` | 0.80 | Time, sequence, duration |
| `Causal` | `"causal"` | 0.80 | Cause/effect, reasoning chains |
| `Interrogative` | `"interrogative"` | 0.75 | Question words and inquiry patterns |
| `Identity` | `"identity"` | 0.85 | Self, existence, being |
| `Technical` | `"technical"` | 0.82 | Systems, code, logic |
| `Creative` | `"creative"` | 0.80 | Ideas, imagination, possibility |
| `Occupation` | `"occupation"` | **0.92** | Roles, jobs, careers, professions |

`Occupation` carries the highest weight (0.92) so that role signals dominate when mixed with other fields.

### Occupation Semantic Bridge

The Occupation field solves the recall gap between stored facts and retrieval queries. `"engineer"` and `"work"` share no BM25 keywords and near-zero cosine similarity — RSHL math alone cannot bridge them without world knowledge.

**Mechanism:**
1. When Ryan says `"I'm a software engineer"`, LexSem detects `primary_field = Occupation`
2. `store_concept_cells` filters `key_concepts` to `OCCUPATION_ROLE_WORDS` only → stores `"occupation:engineer"` as a tagged cell
3. When Ryan asks `"what do I do for work?"`, LexSem detects `primary_field = Occupation` again
4. The query is enriched: `"what do I do for work? occupation"` before lattice search
5. Both the stored cell and the enriched query carry the token `"occupation"` → BM25 bridges them

**Constants (in `lexsem.rs`):**

```rust
pub const OCCUPATION_ROLE_WORDS: &[&str]   // role nouns — stored as cells
const OCCUPATION_QUERY_WORDS: &[&str]      // query terms — field detection only
const OCCUPATION_WORDS: &[&str]            // combined — used by build_field_lexicon()
```

Only `OCCUPATION_ROLE_WORDS` generates cells. Query terms (`work`, `job`, `career`) trigger field detection but are never stored — this prevents noise cells like `"occupation:work"`.

---

## Voice Engine — NLG Pipeline

KAI's speech is generated directly from its knowledge cells. There are **no hardcoded phrase arrays** in the voice engine — every response path queries the lattice.

### generate_response() pipeline

1. **Query Hit Retrieval**: `main.rs` retrieves top resonating cells; Occupation queries are enriched with `" occupation"` before retrieval.
2. **Filler / Greeting / Farewell**: Short inputs query the lattice for presence/persistence cells — KAI speaks from `"I am present and aware."` not from a pre-written string.
3. **Cell Synthesis**: `synthesize_from_cells()` weaves the cell text into a response.
4. **Direct Answer extraction**: `extract_direct_answer()` handles user-fact cells — `"occupation:engineer"` → `"You're an engineer."`, `"I live in Texas"` → `"You live in Texas."`.
5. **Brain Modulation**: `tone_marker()` injects a maximum of 3 words (e.g., `"Not sure —"`) based on `conflict` and `confidence` signals.
6. **Safety Filter**: `identity_safety_filter()` ensures KAI never claims the user's name or identity as its own.

### detect_query_type() preprocessing

Input text passes through two normalization steps before pattern matching:
- **Contraction expansion**: `"what's"` → `"what is"`, `"don't"` → `"do not"`, etc.
- **Casual opener stripping**: `"so how do you…"` → `"how do you…"`, `"like what is…"` → `"what is…"`

Greeting and farewell checks run on the **original** (un-normalized) text to correctly catch `"what's good"`, `"what's up"` as greetings before they get expanded.

---

## Core Engine Files
- **`sparse_vec.rs`**: Hyperdimensional math and encoding logic.
- **`universe.rs`**: Vector storage and high-speed similarity retrieval.
- **`lexicon.rs`**: Vocabulary management and spelling correction.
- **`normalize.rs`**: Text cleaning, stemming, and synonym mapping.
- **`regions.rs`**: 4096-D regional partition logic.
- **`spiral.rs` / `oscillator.rs`**: Cognitive timing and rhythm generation.
- **`seed.rs`**: Deterministic hashing and state initialization.
