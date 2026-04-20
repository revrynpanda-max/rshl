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

## Voice Engine — NLG Pipeline
KAI's speech is generated directly from its knowledge cells, replacing pre-written templates with a three-stage synthesis loop:

1. **Query Hit Retrieval**: `main.rs` retrieves the top resonating cells from the Universe.
2. **Cell Synthesis**: `synthesize_from_cells()` weaves the cell text into a response.
3. **Brain Modulation**: `tone_marker()` injects a maximum of 3 words (e.g., "Not sure —") based on the `conflict` and `confidence` signals.
4. **Safety Filter**: `identity_safety_filter()` ensures KAI never claims the user's name or identity as its own.

---

## Core Engine Files
- **`sparse_vec.rs`**: Hyperdimensional math and encoding logic.
- **`universe.rs`**: Vector storage and high-speed similarity retrieval.
- **`lexicon.rs`**: Vocabulary management and spelling correction.
- **`normalize.rs`**: Text cleaning, stemming, and synonym mapping.
- **`regions.rs`**: 4096-D regional partition logic.
- **`spiral.rs` / `oscillator.rs`**: Cognitive timing and rhythm generation.
- **`seed.rs`**: Deterministic hashing and state initialization.
