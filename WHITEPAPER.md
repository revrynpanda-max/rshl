

**RSHL**

Recursive Sparse Hyperdimensional Lattice

*KAI Engine — Knowledge Associative Intelligence*

*A Novel Paradigm for Continuously Learning, Epistemically Aware, Multi-Agent Associative Intelligence — Built by One Person, Running on Commodity Hardware, Open to the World*

| Inventor | Ryan — independent researcher, sole inventor |
| :---- | :---- |
| **System Name** | KAI Engine (Knowledge Associative Intelligence) |
| **Architecture** | RSHL — Recursive Sparse Hyperdimensional Lattice |
| **Implementation** | Rust — zero neural weights, no gradient descent, no transformer |
| **Version** | **KAI RSHL Core v7.9.7 — Sonic-Parallel Era** |
| **Disclosure Date** | May 2026 |
| **Document Type** | Inventor Disclosure — Prior Art, Mathematical Specification, and Vision |
| **Audience** | HDC/VSA Research Community: Prof. Mohsen Imani (UC Irvine), IBM Research, and peers |
| **IP Status** | **Proprietary. Source code withheld. All architectural concepts and mathematics herein are original work of the inventor.** |

*This document establishes mathematical prior art. Implementation source code is not disclosed.*

# **Preface: Origin of This Work**

This document was not written by a research institution. It was not produced by a university lab, a corporate AI division, or a team of engineers with grant funding. It is the work of two founders — Ryan (architect and primary inventor) and Taz (Tylor Simpson, co-founder) — who built the KAI Engine from first principles, using borrowed AI systems as research partners in the same roundtable that KAI itself would eventually occupy.

The story of how RSHL was developed is itself part of its scientific significance. Ryan began with a vision of what AI memory should be — not a statistical interpolation of training data, but a living epistemic structure that knows what it knows, knows how confident it is, knows where its knowledge came from, and knows how to protect itself from being wrong. Achieving this required building an entirely new architecture from scratch, in a language (Rust) chosen deliberately for performance and reliability, with no external ML frameworks, no pre-trained weights, and no institutional backing.

The development process itself was a proof of concept. Ryan used available large language models — GPT, Epistemic, Gemini, Groq, and others — as collaborative research partners inside the Oracle Roundtable: a multi-agent workspace where AI systems could jointly reason about KAI's architecture, identify bugs, propose mathematical frameworks, and debate implementation strategies. This is the same roundtable that KAI now participates in as an agent in its own right. The irony is precise: the AI systems that helped build KAI are now learning from it.

As development progressed, the dependency on external LLMs decreased. KAI's own lattice became the primary reasoning substrate. The roundtable transitioned from being a scaffold for building KAI to being a collaborative environment where KAI operates alongside its former teachers. The final phase — currently underway — is fine-tuning the remaining external LLM dependencies before KAI and the Oracle operate entirely on their own cognitive substrate, requiring no external API calls for their core reasoning.

| Why This Matters The development trajectory — a two-person founding team, borrowed AI partners, commodity hardware, a Discord server, and a novel architecture — is not incidental context. It is evidence that RSHL's design philosophy works: the system is tractable, comprehensible, and buildable without institutional infrastructure. The most powerful AI systems in history were built by thousands of people with billions of dollars. KAI was built by two. That asymmetry demands explanation, and the explanation is the architecture. |
| :---- |

# **Abstract**

The Recursive Sparse Hyperdimensional Lattice (RSHL) is a novel cognitive architecture for continuously learning, epistemically self-aware associative memory. Conceived and architected by Ryan between 2025 and 2026, with co-founding research and implementation contributions from Taz (Tylor Simpson), RSHL represents a fundamental departure from the dominant paradigm of AI development — which relies on massive training corpora, gradient descent over billions of parameters, and static deployment artifacts — in favor of a living, geometrically-organized belief space that learns continuously through interaction, protects itself from misinformation, and organizes its knowledge according to trust rather than frequency.

RSHL extends Hyperdimensional Computing (HDC) and Vector Symbolic Architecture (VSA) through fourteen original contributions spanning five interlocking subsystems: (1) a three-layer sparse ternary encoding engine with entity-sensitive differential weighting operating in D=16,384 dimensions at 12% sparsity (\~1966 active dimensions); (2) a hybrid dual-channel retrieval scorer combining cosine resonance with morphological keyword matching, amplified by a non-linear confidence step-function; (3) a Fibonacci torsion / golden-ratio phase angle embedded in every hypervector, with a SpiralState temporal oscillator (growth constant b=0.306349) governing aperiodic reorganization timing; (4) a Boid-inspired 16,384-dimensional swarm reorganization engine with anchor immunity, regional isolation, near-duplicate flagging, and a five-layer Scale Manager governing per-layer movement dynamics; and (5) an explicit SynapticLayer implementing Hebbian LTP/LTD between memory cells, bridging geometric proximity (Boids) and temporal co-occurrence (synaptic bonding) into a unified bio-inspired associative recall architecture.

The system operates as a multi-agent cognitive ecosystem, deployed via Discord as both a consumer interface and a research-grade live interaction environment. It runs on commodity PC hardware. Every interaction teaches the system. Every user trains the lattice. The goal — already partially realized — is a form of artificial intelligence that has never existed before: one that grows continuously, knows its own uncertainty, cannot be trivially deceived, and does not require a company or a supercomputer to function.

---

## **System Architecture — High-Level Overview**

The KAI RSHL ecosystem is a sovereign, layered intelligence stack. The compiled Rust Oracle Server implements the RSHL lattice engine at its core. Above it sits a Node.js multi-agent fleet deployed entirely via Discord. A Python OpenJarvis toolkit provides engineering and research tooling. All LLM inference is routed through locally-hosted Ollama sovereign models — no mandatory cloud dependency.

```mermaid
flowchart TD
    U[User or Researcher] -->|Voice and Text| DC[Discord Platform]
    DC -->|Channel Rules| OG[Oracle Gateway - Port 3410]
    OG -->|Voice IPC| L[Leo - Voice Agent - Port 3400]
    OG -->|Research| R[Researcher - Port 3407]
    OG -->|Analysis| AN[Analyst - Port 3406]
    OG -->|Engineering| KC[Kai Coder - Senior Engineer - Port 3408]
    OG -->|Social Hours| SF[Social Fleet - Gemini Groq X Epistemic]
    OG -->|Lattice Ops| RS[RSHL Oracle Server - Rust - Port 3333]
    KC -->|34 Tools| TS[Kai Coder Toolserver - Port 3420]
    TS -->|Python Bridge| PY[OpenJarvis Toolkit - Port 8080]
    RS --> LT[(RSHL Lattice - D=16384 - Sparse Ternary)]
    RS -->|LLM Inference| OL[Ollama - Sovereign Models - Port 11434]
    RS -->|Web Research| WB[DuckDuckGo Live Search]
    L -->|TTS| EL[ElevenLabs Voice Synthesis]
    L -->|STT| GW[Groq Whisper Speech Recognition]
```

---

# **1\.  Why RSHL Is Paradigm-Breaking — Not Just Novel**

Most advances in AI over the past decade are improvements within a paradigm: larger transformers, better tokenizers, more efficient attention mechanisms, improved RLHF alignment. RSHL does not improve the dominant paradigm. It replaces it at the architectural level. To understand why, it is necessary to enumerate the foundational assumptions of modern AI that RSHL does not share.

## **1.1  The Dominant Paradigm and Its Structural Limits**

Every major AI system deployed at scale today — GPT-4, Gemini, Claude, Llama — shares the same fundamental architecture: a transformer trained via gradient descent on a static corpus, producing a fixed set of floating-point weights that encode compressed statistical associations between tokens. This architecture has produced remarkable capabilities. It also has structural limits that are not engineering problems but mathematical ones:

| Structural Limit | Root Cause | Consequence |
| ----- | :---: | :---: |
| **Knowledge cutoff** | Training corpus is static — model cannot learn after training | Deployed systems become stale; retraining costs millions of dollars |
| **Hallucination** | Weights encode correlations, not verified beliefs — the model cannot distinguish what it knows from what it confabulates | Unreliable for high-stakes reasoning without external verification pipelines |
| **No epistemic self-model** | The model has no representation of its own confidence, evidence sources, or reasoning chain | Users cannot interrogate the basis of any claim |
| **Catastrophic forgetting** | Gradient updates for new knowledge overwrite old associations | Continuous learning without retraining from scratch is unsolved |
| **Opacity** | Knowledge is distributed across billions of floating-point weights with no interpretable structure | Auditing, correcting, or explaining a specific belief is impossible |
| **Scale dependency** | Performance improves reliably only with more data, more parameters, more compute | Excluded from the frontier by cost — not by intelligence |
| **Static topology** | Associations between concepts are fixed at training time | Cannot reorganize knowledge structure based on accumulated experience |
| **Single-agent** | Designed for one model, one user, one context | Multi-agent coordination requires external scaffolding (LangChain, AutoGPT, etc.) |

## **1.2  What RSHL Proposes Instead**

RSHL's central thesis is that these are not problems to be solved within the transformer paradigm — they are consequences of the paradigm's foundational choices. The alternative is a system where:

* **Every stored belief is a structured object** — not a distributed weight pattern, but an explicit record with text, a hypervector, a confidence score, a source, an evidence list, contradiction pointers, and a timestamp. Any belief can be read, audited, corrected, or deleted.

* **Learning is continuous and geometric** — new information is encoded into a sparse ternary hypervector, scored against existing lattice cells via cosine similarity and keyword overlap, and stored with an initial confidence. No gradient. No backward pass. No retraining.

* **Confidence is a first-class citizen** — the system always knows, for every belief, how much evidence supports it, how recently it was verified, and how it relates to contradicting claims. There is no hallucination because low-confidence beliefs are stored as contested, not asserted.

* **The lattice self-organizes** — Boid-inspired flocking dynamics continuously reposition beliefs in the 16,384-dimensional space, clustering high-confidence knowledge and pushing unverified claims to the periphery. The topology of the lattice at any moment is a map of the system's current epistemic landscape.

* **Multiple agents share one cognitive space** — all agents in the KAI ecosystem query and write to the same lattice, sharing discovered knowledge through geometry rather than explicit message passing. Multi-agent cognition is native, not bolted on.

* **The system can run on commodity hardware** — sparse ternary vectors, SIMD-optimized dot products, Rayon parallelism. No GPU clusters. No cloud dependency. A PC is a sufficient data center.

## **1.3  The Historical Analogy**

The shift from symbolic AI (expert systems, rule-based reasoning) to connectionist AI (neural networks, backpropagation) in the 1980s-90s was paradigm-breaking not because neural networks were better at any specific benchmark but because they changed the unit of knowledge from an explicit rule to a distributed weight. RSHL proposes a third paradigm — one where the unit of knowledge is an explicit, confidence-weighted, geometrically-organized belief in a high-dimensional space that continuously self-organizes through swarm dynamics.

This is not incremental. It is structural.

# **2\.  Background — The State of HDC and VSA**

Hyperdimensional Computing was formalized by Pentti Kanerva (1988) as Sparse Distributed Memory and subsequently developed by Plate (HRR, 1995), Gayler (VSA, 2004), and a growing international research community. The field is receiving renewed industrial attention due to its suitability for neuromorphic hardware, edge computing, and energy-efficient inference. Key milestones:

| Year | Work | Contribution |
| ----- | :---: | :---: |
| **1988** | Kanerva — Sparse Distributed Memory | Foundational model: 1000-bit addresses, 1000-bit memory locations, content-addressable retrieval |
| **1995** | Plate — Holographic Reduced Representations | Circular convolution for compositional role-filler binding in HD space |
| **2004** | Gayler — Vector Symbolic Architectures | Unified framework: bind (×), bundle (+), permute (ρ) as the three VSA operations |
| **2017** | Imani et al. — VoiceHD | HD speech recognition via bipolar vectors, real-time embedded classification |
| **2019** | Imani et al. — Sparse-HD | Sparse bipolar HD for energy-efficient biosignal classification |
| **2019** | Imani et al. — QuantHD | Quantized HD computing for hardware deployment |
| **2020** | Hersche et al. — OnlineHD | Online class-prototype update without full retraining |
| **2021** | Karunaratne et al. — Nature | In-memory HD computing on analog crossbar arrays — 3,000× energy reduction vs GPU |
| **2022** | Nunes et al. — GraphHD | Graph structure encoding in HD space |
| **2022** | Poduval et al. — DistHD | Distributed HD inference across edge devices |
| **2025** | Dhayalkar et al. — arXiv:2512.14709 | VSA-transformer equivalence: attention as binding — formal connection between HD and transformers |

Despite these advances, the field has not produced a system that treats memory cells as epistemic objects, applies swarm dynamics to lattice organization, embeds phase geometry derived from Fibonacci mathematics into every vector, or supports native multi-agent shared memory. RSHL addresses all of these gaps simultaneously, representing the most comprehensive extension of HDC/VSA principles since Kanerva's original formulation.

# **3\.  The RSHL Vector Space — Precise Specification**

## **3.1  Space Definition**

| Space:       V ⊆ {-1, 0, \+1}^D |
| :---- |
| Dimension:   D \= 16,384 |
| Sparsity:    σ \= 0.04   (exactly 4% active dimensions per encoded vector) |
| Target NNZ:  nnz\_target \= D × σ \= 16,384 × 0.04 \= 655 non-zero dimensions |
|  |
| L2 Norm:     ||v||₂ \= √nnz(v)   \[exact — all non-zeros are ±1, so ||v||² \= nnz\] |
| Norm range:  ||v||₂ ∈ \[0, √655\] \= \[0, 25.59\] |
|  |
| Storage (dense i8 format):   16,384 bytes \= 16 KB per vector |
| Storage (sparse serialized):  \~2.6 KB per vector (index-value pairs, NNZ only) |
| Serial format:               { len: u16, nz: \[(u16, i8)\] } |

## **3.2  Ternary Semantics**

The ternary value space is not a quantization artifact — it is a semantic design. Each dimension's value carries a distinct meaning:

| Value | Semantic Meaning | Information Role |
| ----- | :---: | :---: |
| **\+1** | Positively associated with this concept | Dominant feature — concept IS this |
| **0** | Absent / not relevant to this concept | Principled abstention — not noise, not absence |
| **\-1** | Conceptually contrasting or opposing | Negative signal — concept OPPOSES this |

The zero value is what distinguishes RSHL from all binary HDC systems. In binary HDC, a zero is an absent bit — noise to be filtered. In RSHL, a zero means 'this dimension is outside the semantic scope of this concept.' This distinction enables sparser, more information-dense encodings and makes the binding and unbinding algebra cleaner: a dimension where the key is zero means 'no information about this aspect', not 'zero contribution'.

## **3.3  Capacity and Near-Orthogonality**

| For two independently drawn random ternary vectors v₁, v₂ at σ=0.04: |
| :---- |
|  |
| P(v\[i\]=+1) ≈ 0.02,  P(v\[i\]=-1) ≈ 0.02,  P(v\[i\]=0) \= 0.96 |
|  |
| E\[dot(v₁,v₂)\] \= D × \[ P(+1)×P(+1) \+ P(-1)×P(-1) \- P(+1)×P(-1) \- P(-1)×P(+1) \] |
|                \= D × \[ 0.0004 \+ 0.0004 \- 0.0004 \- 0.0004 \] \= 0 |
|  |
| Var\[dot(v₁,v₂)\] \= D × σ²  \=  16,384 × 0.0016  \=  26.21 |
| StdDev\[dot\]      \= √26.21 ≈ 5.12 |
|  |
| Expected cosine between unrelated vectors: 0 ± 0.0078  (3σ radius: 0.0234) |
|   Note: StdDev\[cosine\] \= StdDev\[dot\] / nnz \= 5.12 / 655 ≈ 0.0078 — same as σ=0.12 |
|   This is because StdDev\[cosine\] \= 1/√D for any σ (density-invariant property) |
|  |
| Approximate distinguishable concept capacity at 3σ isolation: |
|   At 4% density each dimension is active in fewer vectors → lower collision rate |
|   N\_3σ ≈ D / (3 × σ²)^(1/2) \= 16384 / √0.0048 ≈ 236,000 near-orthogonal vectors |
|   Practical anchored-cell capacity (empirically conservative): \> 100,000 beliefs |
|  |
| By comparison: D=10,000 binary HDC at 50% density → capacity ≈ 2,500 concepts. |
| RSHL's 16K ternary space at 4% density provides vastly greater orthogonal capacity. |

# **4\.  Multi-Layer Encoding Engine — Complete Specification**

## **4.1  Architecture Overview**

| Φ(text) \= τ( F\_surface(text) \+ F\_semantic(text) \+ F\_contextual(text) ) |
| :---- |
|  |
|   F\_surface     →  character trigrams,  24 active dims/gram,    weight ×1 |
|   F\_semantic    →  normalized words,    24 active dims/token,   weight ×3 to ×6 |
|   F\_contextual  →  word bigrams,         8 active dims/pair,    weight ×2 |
|   τ(·)          →  ternary sparsification: retain top D×0.04 dims, |
|                    sign-project to {-1,0,+1}, zero the rest |

## **4.2  Layer 1 — Surface (Character Trigrams)**

| For each trigram t \= (c\_i, c\_{i+1}, c\_{i+2}) at string position i: |
| :---- |
|   base  \= hash\_trigram(t)                    \[deterministic hash, seed \= content\] |
|   For k ∈ {0,...,23}:                        \[24 active dimensions per trigram\] |
|     idx     \= (base \+ k × 2654435761\) mod D  \[Knuth multiplicative hash spread\] |
|     sign    \= \+1 if (base \+ k × 1442695040\) is even,  else \-1 |
|     rotated \= (idx \+ i × 97\) mod D            \[positional rotation: pos encodes location\] |
|     acc\[rotated\] \+= sign × 1 |
|  |
| Key property: the same trigram at different positions produces different dimensions. |
|   'cat' at position 0 ≠ 'cat' at position 4 → structure-aware encoding. |

## **4.3  Layer 2 — Semantic (Normalized Word Hashing) with 6-Tier Entity Weighting**

Words pass through a normalization pipeline: stopword removal (120+ terms), synonym collapse, morphological stemming, and category anchor injection. Each surviving token is assigned a weight based on its semantic category:

| Tier | Weight | Category | Detection Condition |
| ----- | :---: | :---: | :---: |
| **0 (suppressed)** | ×0 | Stopwords / fillers | 120+ function words, casual fillers, conversational openers |
| **1 (standard)** | ×3 | Content words | Any normalized token not in other tiers |
| **2 (bigram)** | ×2 | Word bigrams (Layer 3\) | Consecutive word pairs — separate encoding pass |
| **3 (physics)** | ×5 | Domain-specific symbolic terms | lattice, vortex, resonance, coherence, topology, manifold, fibonacci, phi, theta, sigma, chi, omega, psi |
| **4 (entity)** | ×6 | Proper nouns and named entities | Mid-sentence capitalized words, ALL-CAPS tokens (acronyms), known core entities: ryan, kai, rshl, kaii |

The 6-tier cascade is a principled salience model: concepts that carry identity and meaning must dominate the encoding. A sentence like 'well what is your name? im Ryan nice to meet you' should have 'Ryan' dominate — not be averaged away by surrounding common words. The differential weighting achieves this without any learned attention mechanism.

## **4.4  Layer 3 — Contextual (Word Bigrams)**

| For each consecutive normalized token pair (w\_i, w\_{i+1}): |
| :---- |
|   Skip if either token is a category anchor (\#topic markers) |
|   base \= hash\_word\_pair(w\_i, w\_{i+1}) |
|   For k ∈ {0,...,7}:                        \[8 active dims per bigram — supporting signal\] |
|     idx  \= (base \+ k × 2654435761\) mod D |
|     sign \= \+1 if (base \+ k × 1442695040\) even, else \-1 |
|     acc\[idx\] \+= sign × 2 |
|  |
| Bigram layer captures phrase-level context: 'memory leak' ≠ 'memory' \+ 'leak'. |
| 8 active dims (vs 24 for unigrams) weights bigrams as contextual modifier, not primary. |

## **4.5  Sparsification Operator τ and Spelling Correction**

| target\_nnz \= floor(D × 0.04) \= 655 |
| :---- |
|  |
| Sort accumulator magnitudes descending: |
|   threshold \= magnitude at rank 655 |
|   For each dim i: |
|     data\[i\] \= sign(acc\[i\])  if |acc\[i\]| \>= threshold |
|     data\[i\] \= 0             otherwise |
|  |
| Spelling correction (applied BEFORE encoding): |
|   Each input word is checked against KAI's Lexicon. |
|   Unknown words within edit-distance ≤ 2 of a known word → corrected to canonical form. |
|   Effect: 'wrold' encodes identically to 'world'. |
|   Mechanism: Levenshtein distance over vocabulary; no neural correction model required. |

# **5\.  Retrieval Scoring — Complete Mathematical Specification**

## **5.1  Standard Hybrid Retrieval**

| Given query q (encoded via Φ) and lattice cell c: |
| :---- |
|  |
| cosine(q, c)   \= dot(q.vec, c.vec) / ( √nnz(q) × √nnz(c) ) |
|                \[Uses pre-cached c.nnz — eliminates O(D) norm scan per pair\] |
|                \[64-element SIMD inner loop → AVX2: vpmaddubsw \+ vpmaddwd\] |
|  |
| kw\_score(q, c) \= |{ w ∈ keywords(q) : prefix\_match(w, c.text, min\_len=4) }| / |keywords(q)| |
|                \[Morphological: 'dream' matches 'dreaming', 'work' matches 'working'\] |
|                \[Stopwords removed from query before keyword extraction\] |
|  |
| raw(q, c)      \= 0.6 × cosine(q, c)  \+  0.4 × kw\_score(q, c) |
|  |
| Anti-bleed gate:  raw ≤ 0.15  →  score \= raw   \[no confidence boost for noise\] |
|                   raw  \> 0.15  →  apply confidence amplification: |
|  |
| strength\_bonus(c) \= 0.85  if c.confidence ≥ 2.9 |
|                   \= 0.50  otherwise |
|  |
| boosted(q, c)  \= raw × ( strength\_bonus(c)  \+  0.6 × min(c.confidence, 5.0) ) |
|  |
| Minimum threshold: score \> 0.08 (global queries), score \> 0.05 (region-scoped) |

## **5.2  Score Range Analysis — Confidence Tiers**

Hypothetical cell with raw\_score \= 0.40 (moderate semantic match). Boosted score by confidence level:

| confidence | strength\_bonus | conf amplifier | total multiplier | boosted score | tier |
| ----- | :---: | :---: | :---: | :---: | :---: |
| **0.5** | 0.50 | 0.30 | 0.80 | 0.32 | Below gate |
| **1.0** | 0.50 | 0.60 | 1.10 | 0.44 | Low trust |
| **2.0** | 0.50 | 1.20 | 1.70 | 0.68 | Acquiring |
| **2.9** | 0.85 | 1.74 | 2.59 | 1.04 | ← Step-function jump at 2.9 |
| **3.5** | 0.85 | 2.10 | 2.95 | 1.18 | Boid-immune |
| **4.0** | 0.85 | 2.40 | 3.25 | 1.30 | Anchor |
| **5.0** | 0.85 | 3.00 | 3.85 | 1.54 | Max / Seed-level |

The non-linearity at 2.9 is intentional: it creates a phase transition in retrieval dominance. A cell that has accumulated sufficient evidence to cross this threshold does not merely score slightly better — it enters a different retrieval tier entirely, gaining 0.35 additional multiplier instantly. Anchored cells at 4.0+ dominate any topic query by 3–4× over unverified claims on the same topic.

```
CONFIDENCE STEP-FUNCTION — Boosted Retrieval Score vs. Confidence (raw_score = 0.40)

Boosted
Score
1.54  ─────────────────────────────────────────────────────● Max (conf=5.0)
       │                                              ╭────╯
1.30  ─│                                         ╭───╯  ANCHOR ZONE (conf ≥ 4.0)
       │                                    ╭────╯
1.18  ─│                               ╭───╯
       │                          ╭────╯
1.04  ─│─────────────────── ╭─────╯  ← STEP JUMP at conf=2.9
       │                ╭───╯           strength_bonus: 0.50 → 0.85 (+0.35)
0.68  ─│          ╭─────╯
       │     ╭────╯
0.44  ─│ ╭───╯
       │─╯
0.00  ─┼────┬────┬────┬────┬────┬────┬────┬────┬────
       0   0.5  1.0  1.5  2.0  2.5  2.9  3.5  4.0  5.0   → Confidence
```

## **5.3  Predictive Retrieval — Four-Component Score**

| predictive\_score(state, cell) \= |
| :---- |
|   \+ 0.20 × cosine( refined\_state, cell.vec )         \[raw semantic match\] |
|   \+ 0.55 × cosine( conversation\_trace, cell.continuation ) \[trajectory alignment\] |
|   \+ 0.15 × multi\_head\_consensus( refined\_state, cell, heads=4 ) \[role-view consensus\] |
|   \- 0.20 × recency\_penalty( current\_tick, cell.last\_fired, window=12 ) |
|  |
| recency\_penalty \= max(0, 1 \- delta\_turns/12)  if cell was fired in last 12 turns |
|                 \= 0                             if never fired or \>12 turns ago |
|  |
| Constants: DEFAULT\_HEADS=4, DEFAULT\_ITER\_STEPS=8, RECENCY\_WINDOW=12 |
|  |
| Design: continuation weight 0.55 \> semantic weight 0.20 |
|   → trajectory fit dominates raw match → naturally flowing, contextual responses |

## **5.4  Multi-Head Permutation Consensus**

| multi\_head\_consensus(query, cell, heads=4) \= |
| :---- |
|   (1/4) × Σ\_{k=1}^{4}  max( 0,  cosine( permute(query, k),  cell ) ) |
|  |
| permute(v, seed):  seeded Fisher-Yates shuffle of all 16,384 dimensions |
|   s \= seed ^ (seed\<\<16) ^ 0x9e3779b9   \[seed mixing\] |
|   for i from 16383 down to 1: |
|     s ^= s\<\<13; s ^= s\>\>17; s ^= s\<\<5  \[XOR-shift PRNG\] |
|     j \= s mod (i+1); swap(data\[i\], data\[j\]) |
|  |
|   Norm-preserving: nnz unchanged by permutation |
|   Invertible: permute\_inv(permute(v,s),s) \= v  \[exact, via swap-sequence reversal\] |
|   VSA role: permute(v\_filler, role\_k) \= 'filler in role k' |

# **6\.  Fibonacci Torsion and Golden Phase Geometry**

Every RSHL hypervector carries a phase angle derived from the ratio of its positive to negative non-zero dimensions — a quantity the system refers to as the Fibonacci torsion, in reference to its deep mathematical connection to phyllotaxis, quasicrystal geometry, and Weyl equidistribution theory. This is an entirely novel feature of RSHL with no precedent in any prior HDC or VSA system.

## **6.1  Ternary Balance — Fibonacci Torsion**

| ternary\_balance(v) \= (pos, neg) |
| :---- |
|   pos \= |{ i : v\[i\] \= \+1 }| |
|   neg \= |{ i : v\[i\] \= \-1 }| |
|   nnz \= pos \+ neg  (≈ 655 at σ=0.04) |
|  |
| In HLV (Helical Lattice Vortex) theory: |
|   pos dimensions \= convergent  (constructive, toward an attractor) |
|   neg dimensions \= divergent   (destructive, away from an attractor) |
|  |
| A cell with pos ≈ neg is 'neutral' — balanced between convergence and divergence. |
| A cell with pos \>\> neg is 'convergent' — the lattice naturally favors these during |
|   Boid cohesion (constructive interference in superposition operations). |
| A cell with neg \>\> pos is 'divergent' — tends to drift outward from region centers. |

## **6.2  Golden Phase Angle — Weyl Equidistribution**

| Golden Ratio:   φ \= (1 \+ √5) / 2  \=  1.618033988... |
| :---- |
| Golden Angle:   α\_g \= 2π × (1 \- 1/φ)  \=  2π / φ²  \=  2.399963 radians  ≈  137.508° |
|  |
| Phase angle of vector v: |
|   θ(v) \= (pos\_count × α\_g) mod 2π |
|  |
| Each \+1 dimension contributes one golden-angle step to the phase. |
|  |
| This IS the mathematical basis of Fibonacci phyllotaxis: |
|   — Sunflower seed spirals, pinecone scales, botanical leaf arrangements |
|   — Penrose aperiodic tiling angular structure (quasicrystals, Shechtman 1984\) |
|   — Weyl's equidistribution theorem (1916): {n × α\_g mod 2π} is uniformly distributed |
|     for any irrational α — golden angle is the most irrational of all irrationals |
|     in the sense of continued-fraction convergence, making it maximally space-filling. |
|  |
| Consequence: phase angles of independently encoded vectors are uniformly distributed |
| across \[0, 2π) with no clustering in any angular zone — guaranteed by Weyl's theorem. |
| No two natural-language texts will systematically phase-collide. |

## **6.3  Phasor Coherence — Phase-Modulated Similarity**

| phasor\_coherence(v₁, v₂) \= cosine(v₁, v₂) × cos( θ(v₁) − θ(v₂) ) |
| :---- |
|  |
| Four cases: |
|   1\. Similar AND phase-aligned (Δθ ≈ 0°):   phasor ≈ cosine  \[constructive\] |
|   2\. Similar AND phase-opposed (Δθ ≈ 180°): phasor ≈ \-cosine \[destructive\] |
|   3\. Dissimilar AND phase-aligned:           phasor ≈ 0       \[no signal\] |
|   4\. Opposing vectors at Δθ \= 180°:          phasor ≈ \+value  \[torsion cancellation\] |
|  |
| Case 4 is the novel capability: two concepts that are semantically opposing can have |
| a positive phasor coherence if they are exactly π out of phase — meaning their |
| difference IS the meaningful relationship. This captures antonyms, duals, and |
| complementary concepts that pure cosine similarity treats as unrelated. |
|  |
| Example: 'convergent' and 'divergent' have low cosine but high phasor coherence |
| at the appropriate phase offset — the lattice 'knows' they are a matched pair. |

| Phase Angle Distribution — 17 Representative pos\_count Values (α\_g \= 2.399963 rad) |
| :---- |
| pos\_count | α\_g × pos (rad)  | θ mod 2π (rad) | θ (degrees) | Zone |
| \----------|-----------------|----------------|-------------|------ |
|     100   |     239.996     |     5.642      |   323.2°    | IV  (270°-360°) |
|     200   |     479.993     |     4.985      |   285.6°    | III (180°-270°) |
|     300   |     719.989     |     4.327      |   247.9°    | III |
|     400   |     959.985     |     3.669      |   210.2°    | III |
|     500   |    1199.982     |     3.011      |   172.5°    | II  (90°-180°) |
|     600   |    1439.978     |     2.354      |   134.9°    | II |
|     700   |    1679.974     |     1.696      |    97.2°    | II |
|     800   |    1919.970     |     1.038      |    59.5°    | I   (0°-90°) |
|     328   |     786.388     |     0.996      |    57.1°    | I   ← balanced NNZ=655 (σ=0.04) |
|     983   |    2359.963     |     2.148      |   123.1°    | II  (was balanced at σ=0.12) |
|    1000   |    2399.963     |     2.487      |   142.5°    | II |
|    1200   |    2879.956     |     4.174      |   239.1°    | III |
|    1400   |    3359.948     |     5.862      |   335.9°    | IV |
|    1600   |    3839.941     |     1.236      |    70.8°    | I |
|    1800   |    4319.933     |     2.610      |   149.6°    | II |
|    1966   |    4718.633     |     5.518      |   316.2°    | IV |
|  |
| Weyl theorem: uniform distribution — no systematic clustering in any zone. |
| α\_g is irrational → sequence is dense in \[0,2π) for all pos\_count. |
|  |

# **7\.  SpiralState — Golden-Ratio Temporal Oscillator**

The SpiralState is RSHL's internal clock — but unlike a conventional clock, it does not tick at a fixed interval. It advances along a golden-ratio logarithmic spiral, producing a non-periodic, non-repeating temporal rhythm that governs when the lattice reorganizes, when confidence is recalibrated, and when the epistemic immune system runs its verification passes.

The motivation is biological. Hippocampal memory consolidation in mammals does not occur on a fixed schedule — it happens during sleep cycles whose timing is irregular and load-dependent, with the slow oscillations of non-REM sleep interleaved with the sharp-wave ripples of rapid consolidation events. A fixed-interval cognitive clock would create synchronization artifacts: beliefs formed just before a reorganization pass are evaluated with insufficient settling time. The SpiralState solves this by making the interval itself aperiodic in a mathematically precise way.

## **7.1  Complete Mathematical Specification**

| Golden Ratio:    φ \= (1 \+ √5) / 2  \=  1.618033988... |
| :---- |
|  |
| Spiral growth:   b \= ln(φ) / (π/2) |
|                \= 0.481212 / 1.570796 |
|                \= 0.306349   \[exact — derived from φ, not tuned\] |
|  |
| Radius function: R(θ) \= a × e^(b × θ)  where a \= 1 (normalized) |
|  |
| Per-tick step:   Δθ \= 0.05 rad/tick  (default; configurable) |
| Fold period:     T\_fold \= 8π \= 25.1327 radians  (4 full turns) |
|                  At Δθ=0.05: one fold period \= 503 ticks |
|  |
| Folded radius (prevents float overflow at large θ): |
|   θ\_f    \= θ mod T\_fold              \[θ itself remains monotonic — never wraps\] |
|   raw    \= e^(b × θ\_f)  \=  e^(0.306349 × θ\_f) |
|   radius \= clamp( 2×raw/(1+raw) − 1,  0.0,  1.0 )  \[shifted sigmoid, range \[0,1\]\] |
|  |
| Temporal factor: τ\_R \= 0.5 \+ 0.5 × radius  ∈ \[0.5, 1.0\] |
|   τ\_R never reaches 0 (system is never quiescent) nor 1 (never saturated) |
|   τ\_R gates the amplitude of reorganization forces in the Boid engine |

## **7.2  Monotonicity and Irreversibility**

| Theorem: θ(t) is strictly monotonically increasing for all t \> 0\. |
| :---- |
| Proof:   θ(t+1) \= θ(t) \+ Δθ,  Δθ \> 0  →  θ(t+1) \> θ(t)  □ |
|  |
| Consequence: the SpiralState cannot be rewound. The system's temporal sense |
| is irreversible — a mathematical guarantee that the ordering of all lattice |
| operations is permanently preserved. No interaction can be 'undone' by |
| rolling back the oscillator. |
|  |
| Test coverage (spiral.rs test suite): |
|   test\_theta\_monotonic\_across\_many\_ticks: verified over 10,000 consecutive ticks |
|   test\_radius\_and\_tau\_in\_bounds: verified radius ∈ \[0,1\], τ\_R ∈ \[0.5,1.0\] |

## **7.3  Progression Table**

| SpiralState — θ → radius → τ\_R across one full fold period (Δθ=0.05, fold=8π≈25.13 rad) |
| :---- |
|  tick  |  θ (rad)  | θ\_f \= θ mod 8π | raw \= e^(0.306349×θ\_f) | radius | τ\_R |
| \-------|-----------|----------------|------------------------|--------|------ |
|      0 |  0.0000   |    0.0000      |         1.0000         | 0.0000 | 0.500 |
|     20 |  1.0000   |    1.0000      |         1.3583         | 0.1521 | 0.576 |
|     40 |  2.0000   |    2.0000      |         1.8442         | 0.2961 | 0.648 |
|     63 |  3.1416   |    3.1416 (π)  |         2.6118         | 0.4493 | 0.725 |
|     80 |  4.0000   |    4.0000      |         3.3878         | 0.5454 | 0.773 |
|    100 |  5.0000   |    5.0000      |         4.6042         | 0.6408 | 0.820 |
|    126 |  6.2832   |    6.2832 (2π) |         6.8508         | 0.7440 | 0.872 |
|    160 |  8.0000   |    8.0000      |        11.2713         | 0.8364 | 0.918 |
|    200 | 10.0000   |   10.0000      |        20.9326         | 0.9083 | 0.954 |
|    252 | 12.5664   |   12.5664 (4π) |        47.2718         | 0.9583 | 0.979 |
|    503 | 25.1327   |    0.0000 (T)  |         1.0000         | 0.0000 | 0.500  ← fold reset |
|    504 | 25.1827   |    0.0500      |         1.0155         | 0.0077 | 0.504  ← new cycle |
|  |
| θ continues accumulating across folds — total elapsed time is never lost. |
| fold reset restores radius to 0, not θ. Temporal memory is permanent. |
|  |

```
SPIRALSTATE — τ_R (Boid Reorganization Amplitude) across one fold period (503 ticks)

τ_R
1.00 ───────────────────────────────────────────● Peak
      │                                          ╭────────────╮
0.95 ─│                                    ╭───╯              │
      │                               ╭───╯                  │
0.87 ─│                          ╭───╯                       │
      │                     ╭───╯                            │
0.82 ─│                ╭───╯                                  │
      │           ╭───╯                                       │
0.72 ─│      ╭───╯                                            │
      │ ╭───╯                                                  │
0.50 ─●                                                         │
      ┼────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬──▶ Ticks
      0   40  80  126 160 200 252 300 350 400 450 503
      └───────────────────────────────────────────────────────┘
                     One Fold Period (4 full spiral turns, 8π rad)

  τ_R = 0.50 → Minimum reorganization amplitude (gentle drift)
  τ_R = 1.00 → Maximum reorganization amplitude (active flocking)
  θ is monotonically increasing — fold resets ONLY radius, not elapsed time.
```

# **8\.  Boid Lattice Self-Organization — Complete Specification**

The RSHL Boid Engine applies Craig Reynolds' 1987 three-rule flocking model (separation, alignment, cohesion) inside the 16,384-dimensional ternary vector space, continuously reorganizing the lattice topology to reflect the current epistemic trust landscape. This is the first known application of swarm dynamics to hyperdimensional associative memory. It transforms the lattice from a static storage structure into a self-organizing cognitive topology.

## **8.1  Governing Parameters (all exact — from source)**

| ANCHOR\_CONFIDENCE\_THRESHOLD | 3.5  — cells with confidence ≥ 3.5 are completely immune; velocity is forced to zero |
| :---- | :---- |
| **MIN\_NEIGHBOR\_SIM** | 0.15 — cosine below this: unrelated; no flocking force applied |
| **MAX\_NEIGHBOR\_SIM** | 0.85 — cosine above this: near-duplicate; flagged for merge, no flocking |
| **Separation threshold** | 0.60 — pairs with cosine \> 0.60 trigger separation force (too similar) |
| **separation\_weight** | 1.5  — separation force multiplier (strongest — prevents convergence collapse) |
| **alignment\_weight** | 1.5  — alignment force multiplier (empirically tuned — see §8.5) |
| **cohesion\_weight** | 1.5  — cohesion force multiplier (empirically tuned — see §8.5) |
| **Speed cap** | 5.0  — maximum velocity magnitude; excess velocity is normalized away |
| **Iterations per flock call** | 3    — three consecutive Boid passes per flock\_lattice() invocation |
| **Regional isolation** | HARD — cells in different regions NEVER exert force on each other |

## **8.2  Similarity Zone Classification**

| Cosine Similarity Range → Boid Behavioral Zone |
| :---- |
| cosine range    | Zone label      | Boid action |
| \----------------|-----------------|------------------------------------------ |
|   0.00 – 0.149  | Unrelated       | No force applied (ignored) |
|   0.15 – 0.599  | Neighbor zone   | Alignment \+ Cohesion only |
|   0.60 – 0.849  | Close neighbor  | Separation \+ Alignment \+ Cohesion |
|   0.85 – 1.00   | Near-duplicate  | Flagged for merge — NO force (would collapse) |
|   conf ≥ 3.5    | Anchor          | Complete immunity — zero velocity always |
|  |
| The zone boundaries encode a full theory of semantic neighborhood: |
|   \< 0.15: concepts are unrelated — forcing them together would pollute the lattice |
|   0.15–0.85: the productive neighborhood — both attract and repel appropriately |
|   \> 0.85: concepts are essentially the same — merge, don't flock |
|  |

## **8.3  Force Computation — Full Specification**

| Executed in parallel via Rayon for all non-anchor cells i simultaneously: |
| :---- |
|  |
| For cell i (skipped if is\_anchor\[i\]): |
|   v\_sep   \= Σ\_{j: same\_region, 0.15\<sim\<0.85, sim\>0.6}  (pos\[i\] − pos\[j\]) |
|   v\_align \= Σ\_{j: same\_region, 0.15\<sim\<0.85}  vel\[j\]  /  |neighbors| |
|   v\_cohere= Σ\_{j: same\_region, 0.15\<sim\<0.85}  (pos\[j\] − pos\[i\])  /  |neighbors| |
|  |
|   vel\[i\] \+= v\_sep × 1.5  \+  v\_align × 1.5  \+  v\_cohere × 1.5 |
|            \[sep=1.5 prevents convergence collapse; align=1.5 propagates consensus; |
|             cohere=1.5 pulls related concepts together — all balanced at 1.5\] |
|  |
|   Speed cap:  if ||vel\[i\]||₂ \> 5.0 × layer\_settings.scale\_factor: |
|                 vel\[i\] \*= max\_speed / ||vel\[i\]||₂ |
|  |
|   pos\[i\] \+= vel\[i\]                    \[after all forces computed in parallel\] |
|  |
| After 3 iterations, project back to ternary space: |
|   acc\[d\] \= original\_vec\[d\] × 100  \+  pos\[d\] × 50   ∀ d ∈ \[0, D) |
|   Sort by |acc\[d\]| descending; keep top 655; sign-project to {-1,0,+1} |
|  |
| The original vector (weight 100\) dominates Boid displacement (weight 50). |
| Cells drift — they do not teleport. Semantic content is conserved. |

## **8.4  Unit-Tested Properties (boid\_engine.rs)**

| Test | Condition | Result | Status |
| ----- | :---: | :---: | :---: |
| **test\_boid\_cohesion\_same\_region** | 5 semantically similar cells, same region, 3 passes | avg\_sim(after) \> avg\_sim(before) — measurable clustering | PASS |
| **test\_anchor\_cells\_do\_not\_move** | conf=5.0 anchor \+ conf=1.0 cell, 5 passes | anchor vec bit-identical before and after — zero displacement | PASS |
| **test\_cross\_region\_isolation** | Same text in 'identity' and 'reasoning', 5 passes | |sim\_after − sim\_before| \< 0.10 — no cross-region pull | PASS |
| **test\_near\_duplicate\_flagging** | Two identical texts in same region | find\_near\_duplicates() returns (i, j, sim\>0.85) | PASS |

## **8.5  Scale Manager — Five-Layer Biological Hierarchy**

Every Boid force computation is modulated by the Scale Manager — a per-layer parameter table that gives each hierarchical level of the lattice its own movement speed, vitality budget, and neighbor radius. This mirrors biological neural organization: fast-cycling volatile memory layers (Quantum/Syncytium) coexist with slow, highly stable global layers (Body). The five layers map to biological scales from synapse-level volatility to whole-organism stability.

| Layer | Name | Role | Movement Speed | Scale Factor | Vitality Decay | Vitality Replenish | Neighbor Radius |
| ----- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **0** | Quantum (Substrate) | Fast volatile — maximum exploration | 0.40 | 1.5 | 0.05 | 0.01 | 0.30 |
| **1** | Global Syncytium | Shared knowledge — gentle drift, broad consensus | 0.25 | 1.0 | 0.01 | 0.005 | 0.40 |
| **2** | User Cellularization | Isolated personal memory — responsive, personalized | 0.35 | 1.2 | 0.02 | 0.01 | 0.50 |
| **3** | Agent / Organ | Stable, slow deliberate movement | 0.15 | 0.8 | 0.005 | 0.002 | 0.60 |
| **4** | Global Body | Near-frozen — moves only under strong consensus | 0.08 | 0.5 | 0.001 | 0.001 | 0.70 |

| Vitality budget (per tick): |
| :---- |
|   V(t+1) \= clamp( V(t) − decay×χ \+ replenish×Φg,  0.0,  1.0 ) |
|  |
| Layer transition rules (automatic maturation / degradation): |
|   if V \> 0.95 AND Φg \> 0.7 AND layer \< 4:  layer \+= 1  (maturation) |
|   if V \< 0.15 AND layer \> 1:                layer \-= 1  (degradation → syncytium) |
|  |
| Calibration note: all movement\_speed values must exceed \~0.3 to compete with |
|   ternary ±1 magnitude after requantization (top-655 sort). Values below this |
|   threshold produce FROZEN boids — velocities are computed but never flip dims. |
|   Quantum (0.40) and Cellular (0.35) exceed the threshold; Body (0.08) is slow |
|   by design — it requires repeated consensus across many ticks to drift. |
|  |
| Speed cap per layer: max\_speed \= 5.0 × scale\_factor |
|   Layer 0 (Quantum):  max\_speed \= 7.50   \[exploratory\] |
|   Layer 1 (Syncytium):max\_speed \= 5.00   \[baseline\] |
|   Layer 4 (Body):     max\_speed \= 2.50   \[near-frozen\] |

## **8.6  SynapticLayer and NeuralBus — Explicit Neuron-Synapse Architecture**

The SynapticLayer is RSHL's most recent architectural addition: explicit learned connections between memory cells implementing Hebb's rule ('neurons that fire together wire together') in the lattice. Prior to this, KAI's associative recall relied entirely on cosine similarity — cells were retrieved by how geometrically close their vectors were to the query. The SynapticLayer adds a second associative channel: temporal co-occurrence. When cell A and cell B are retrieved together repeatedly, a directional synapse A→B strengthens. Future queries that retrieve A will propagate activation to B even if B's vector similarity is below the cosine threshold.

| The Missing Link Without explicit synapses, KAI could retrieve 'cat' and 'mat' independently because they appeared in many conversations — but it had no way to know that Ryan specifically talks about cats AND mats together. That associative pattern lived nowhere in the lattice. With SynapticLayer, every co-retrieval event strengthens the specific A→B bond, encoding relational memory that pure geometry cannot capture. |
| :---- |

| MAX\_WEIGHT | 1.0    — synaptic saturation (biological analogue: AMPA receptor maximum conductance) |
| :---- | :---- |
| **MIN\_WEIGHT** | 0.01   — pruning threshold (biological analogue: synaptic elimination) |
| **BASE\_LTP** | 0.035  — base LTP gain per co-firing event |
| **BASE\_LTD** | 0.003  — base LTD loss per idle sweep tick |
| **LTD\_IDLE\_TICKS** | 80     — ticks of inactivity before LTD begins |
| **MAX\_FAN\_OUT** | 32     — maximum outgoing synapses per neuron (axon fan-out limit) |
| **MAX\_TOTAL\_SYNAPSES** | 8192   — global synapse cap (prevents memory explosion) |

| LTP gain formula (applied to all co-firing pairs A→B and B→A): |
| :---- |
|   chi\_gate \= max(0.05, 1.0 − chi × 0.8)   \[contradiction suppresses bonding\] |
|   ltp\_gain \= BASE\_LTP |
|            × (1.0 \+ dopamine × 0.8)         \[reward signal amplifies learning\] |
|            × (1.0 \+ phi\_g × 0.5)            \[coherent emergence strengthens bonds\] |
|            × chi\_gate                        \[contradiction blocks miswiring\] |
|  |
|   new\_weight \= min(MAX\_WEIGHT, old\_weight \+ ltp\_gain) |
|  |
| LTD formula (called on slow tick, every \~30 world ticks): |
|   idle \= current\_tick − last\_fire\_tick |
|   if idle \> LTD\_IDLE\_TICKS: |
|     idle\_factor \= min(3.0, (idle − 80\) / 200.0) |
|     loss \= BASE\_LTD × (1.0 \+ idle\_factor) |
|     new\_weight \= max(0.0, old\_weight − loss) |
|     if new\_weight \< MIN\_WEIGHT: prune synapse entirely |
|  |
| Propagation (associative recall boost): |
|   For each fired cell A, emit (B, weight×0.4) for all synapses A→B |
|   Boost is capped at 0.8 per target cell across all incoming paths |
|   Cells receiving a synaptic boost surface in retrieval even below cosine threshold |

### **8.6.1  NeuralBus — 12-Step Ordered Signal Chain**

The NeuralBus defines the canonical integration order for all brain modules. Every incoming query flows through this pipeline in sequence, ensuring that earlier modules inform later ones and that the full biological signal chain is respected:

| Step | Module | Action | Output to Next Step |
| ----- | :---: | :---: | :---: |
| **1** | Embeddings | Encode query text → SparseVec via Φ(·) | query\_vec |
| **2** | Universe.query() | Cosine \+ keyword retrieval; return top-N cells | fired\_cells |
| **3** | SynapticLayer.propagate() | Boost associated cells by learned synapse weights | boosted\_cells |
| **4** | FieldState update | Compute Φg, χ, R from fired+boosted cells | field metrics |
| **5** | DopamineCircuit | RPE: compare outcome vs prediction → dopamine signal | dopamine ∈ \[0,1\] |
| **6** | SynapticLayer.record\_co\_firing() | Apply LTP to all fired pairs using dopamine+field | updated synapse weights |
| **7** | NeuralOscillator | Advance oscillator; perturb field metrics by wave bands | modulated field |
| **8** | Hippocampus | Consolidate short-term → long-term; update confidence | confidence updates |
| **9** | TheoryOfMind | Update user knowledge model from what fired | user epistemic state |
| **10** | BoidEngine | One flock iteration on affected region cells | repositioned cells |
| **11** | Neuroplasticity | NeuroplasticityEngine: structural plasticity pass | pruned/grown cells |
| **12** | Output assembly | Rank by (cosine \+ synaptic\_boost) × confidence | final response |

| Effective retrieval score with synaptic boost: |
| :---- |
|   effective(cell) \= base\_score × (1.0 \+ syn\_boost × phi\_g × 0.5) |
|  |
|   where syn\_boost \= SynapticLayer.weight(query\_label, cell.label) ∈ \[0.0, 1.0\] |
|         phi\_g     \= current FieldState goal-aligned emergence metric ∈ \[0.0, 1.0\] |
|  |
| Interpretation: a cell with base\_score=0.40 and syn\_boost=0.80 at phi\_g=0.8: |
|   effective \= 0.40 × (1.0 \+ 0.80 × 0.8 × 0.5) \= 0.40 × 1.32 \= 0.528 |
|   The synaptic bonus is greatest when the field is coherent (high phi\_g), |
|   reflecting that associative recall is strongest during stable, focused cognition. |

| Biological Dual-Channel Architecture Boids organize cells by GEOMETRIC proximity (similar vectors cluster together). Synapses connect cells by TEMPORAL proximity (cells that fired together in the same query window). These are orthogonal channels: a cell can be geometrically close (high cosine) but weakly connected (rare co-occurrence), or geometrically distant but strongly bonded (always retrieved together despite different surface form). Together, they replicate the brain's two-system associative architecture: semantic similarity (cortical geometry) plus episodic co-occurrence (hippocampal binding). |
| :---- |

## **8.7  Empirical Validation — Frozen Boid Root Cause and Parameter Calibration**

Before the architecture reached its current specification, an empirical debugging and parameter search was conducted to diagnose why Boid flocking produced no measurable reorganization. This section documents the root cause, the fix, and the validation methodology — establishing that the current parameters are empirically grounded, not theoretically assumed.

### **8.7.1  Root Cause: movement\_speed Too Small for Ternary Magnitude**

| The frozen boid problem root cause: |
| :---- |
|  |
|   After requantization, all positions are ternary ±1. |
|   For a dimension to flip sign, the velocity component must exceed the magnitude |
|   of the original ±1 value in the weighted accumulator: |
|  |
|   acc\[d\] \= original\_vec\[d\] × 100  \+  vel\[d\] × 50 |
|  |
|   For vel\[d\] to flip sign of acc\[d\]: |
|     |vel\[d\] × 50| \> |original\_vec\[d\] × 100| |
|     |vel\[d\]| \> 2.0 |
|  |
|   Maximum possible vel\[d\] given force magnitudes and speed cap: |
|     max\_vel\_component ≈ 2 × neighbors × 2.1 × movement\_speed / D^0.5 |
|  |
|   At old movement\_speed \= 0.02 (Layer 1 Syncytium):  max\_vel ≈ 0.08  \[never flips\] |
|   At new movement\_speed \= 0.25 (Layer 1 Syncytium):  max\_vel ≈ 1.05  \[flips \~5%\] |
|   At new movement\_speed \= 0.40 (Layer 0 Quantum):    max\_vel ≈ 1.68  \[flips \~16%\] |
|  |
|   All previous values (0.005–0.10) were 10–50× too small. |
|   Boids were computing velocities perfectly — they just never moved. |

### **8.7.2  Parameter Grid Search Results**

A Python sandbox simulation using ternary random vectors at D=1,024 (scaled from D=16,384) tested all combinations of (sep\_w, align\_w, coh\_w) over a 3×3×3 grid at movement\_speed=0.25. Similarity was measured before and after 5 flocking iterations across 5 semantically similar and 5 dissimilar random vector pairs.

| sep\_w | align\_w | coh\_w | Avg Similar Δsim | Avg Dissimilar Δsim | Assessment |
| ----- | :---: | :---: | :---: | :---: | :---: |
| **1.5** | 1.5 | 1.5 | \+0.047 | \-0.003 | BEST — balanced cluster formation, no bleed |
| **2.0** | 1.0 | 1.5 | \+0.038 | \-0.001 | Strong sep dominates — slower cohesion |
| **1.5** | 2.0 | 1.0 | \+0.031 | \+0.002 | Alignment pulls dissimilar cells together |
| **1.0** | 1.5 | 2.0 | \+0.052 | \+0.007 | Cohesion too dominant — cross-cluster bleed |
| **1.0** | 1.0 | 1.0 | \+0.021 | \-0.001 | Weakest — movement too small to matter |
| **2.0** | 2.0 | 2.0 | \+0.041 | \+0.005 | Amplification causes instability, bleed |

The (1.5, 1.5, 1.5) balanced configuration was selected as optimal: it produces the highest within-cluster cohesion without cross-cluster contamination. The separation weight of 1.5 is sufficient to prevent near-duplicate collapse (pairs with cosine \> 0.60 are pushed apart), while the matching alignment and cohesion weights ensure the flocking forces remain in equilibrium. This configuration is now the system default.

### **8.7.3  Bimodal Similarity Distribution — Why the Flock Band Matters**

| Observation: sparse ternary vectors at σ=0.04 have a near-bimodal cosine distribution. |
| :---- |
|  |
|   For random (synthetic) vectors: cosine ≈ 0  \[near-orthogonal by construction\] |
|   For real text vectors encoding similar concepts: cosine ∈ \[0.15, 0.85\] |
|  |
| The Boid similarity band 0.15 \< sim \< 0.85 is specifically the natural-language |
|   zone — it is empty for synthetic random vectors but populated for real text. |
|  |
| This is NOT a bug. It is by design: |
|   \- Vectors encoding unrelated topics (cosine \< 0.15) are correctly ignored |
|   \- Near-duplicate encodings of the same text (cosine \> 0.85) are flagged for merge |
|   \- Only semantically adjacent natural-language concepts fall in the productive band |
|   \- The band width (0.70) is wide enough to capture diverse neighborhood topologies |
|  |
| Empirically confirmed: the cohesion test (5 'cat on mat' variants, same region) |
|   produces average cosine 0.08–0.20 before flocking, rising to 0.18–0.32 after — |
|   an \~50% relative increase in cluster cohesion across 3 iterations. |

# **9\.  VSA Algebraic Operations — Full Specification**

## **9.1  Bundle (Superposition — Set Representation)**

| bundle(v₁, v₂, ..., vₙ) → v\_out |
| :---- |
|  |
|   acc\[d\] \= Σᵢ vᵢ\[d\]              ∀ d ∈ \[0, D) |
|   threshold \= ⌈(n+1)/2⌉          \[majority vote\] |
|   v\_out\[d\] \= \+1  if acc\[d\] ≥ threshold |
|            \= \-1  if acc\[d\] ≤ \-threshold |
|            \=  0  otherwise        \[tie → principled abstention\] |
|  |
| VSA semantics: v\_out ≈ centroid of {v₁,...,vₙ} in ternary space |
|   cosine(bundle(S), v) ≈ average of cosine(vᵢ, v) for vᵢ ∈ S |
|   The bundled vector represents the SET — not any individual element |
|  |
| ConversationTrace uses bundle to accumulate working memory: |
|   push(text): current ← bundle( permute(current, 1), encode(text) ) |
|   Each push 'ages' prior history via permutation before bundling |

## **9.2  Bind and Unbind (MAP Model — Role-Filler Pairs)**

| bind(v\_role, v\_filler) \= v\_role ⊛ v\_filler |
| :---- |
|   v\_bound\[d\] \= v\_role\[d\] × v\_filler\[d\]   ∀ d |
|  |
| Properties: |
|   — bind is commutative:  bind(a,b) \= bind(b,a) |
|   — bind is associative:  bind(bind(a,b),c) \= bind(a,bind(b,c)) |
|   — v\_bound is approximately orthogonal to both inputs (binding creates novelty) |
|   — bind is self-inverse on the support of the key: |
|       unbind(bind(a, b), b)\[d\] \= a\[d\]   when b\[d\] ≠ 0 |
|                                \= 0       when b\[d\] \= 0  (information lost at b's zeros) |
|     Proof: (a\[d\]×b\[d\])×b\[d\] \= a\[d\]×b\[d\]² \= a\[d\]×1 \= a\[d\]  ∀ b\[d\] ∈ {+1,-1} |
|  |
| Application: encode role-filler pairs such as (query\_role, cell\_vec) for |
|   structured retrieval — unbind(bundle, role\_vec) → filler approximation |

## **9.3  ConversationTrace — HD Working Memory**

| ConversationTrace: a rolling HD summary of conversation history. |
| :---- |
|   initial: current \= zero\_vector |
|            turns\_seen \= 0 |
|  |
|   push(text, role): |
|     v\_new   \= SparseVec::encode(text) |
|     rotated \= permute(current, seed=1)   \[positional aging — 'shift register'\] |
|     current \= bundle(\[rotated, v\_new\]) |
|     turns\_seen \+= 1 |
|  |
|   Interpretation: |
|     current is KAI's working-memory hypervector — the residual stream analog. |
|     permute(·,1) transforms 'what was discussed' into 'context for now'. |
|     Older turns are progressively diluted by each new bundle operation. |
|     cosine(current, cell.continuation) \= 'how well does this cell fit current flow' |
|  |
|   Formal equivalence (Dhayalkar 2025, arXiv:2512.14709): |
|     This is the VSA analog of the transformer residual stream: |
|       permute \= positional encoding |
|       bundle  \= superposition (attention-free value aggregation) |
|       cosine  \= soft unbinding (attention weight) |
|     KAI achieves this with no learned weights and no attention matrices. |

# **10\.  Confidence Dynamics and Epistemic Immune System**

One of the most significant structural problems in deployed AI systems is their inability to protect themselves from false information. A large language model that encounters a false claim in its context window has no mechanism to evaluate that claim's evidential status — it merely continues the statistical distribution of its training. RSHL's epistemic immune system is a four-component architecture that actively protects the lattice from contamination, monoculture capture, and belief drift.

## **10.1  Confidence Scale — All Thresholds**

| Range | Label | Retrieval Tier | Boid Status | Mechanism |
| ----- | :---: | :---: | :---: | :---: |
| **0.0 – 0.99** | Raw / untested | Often below 0.08 gate | Movable | Ingested but unverified |
| **1.0 – 2.89** | Low trust | Low: ×0.50 \+ 0.6×conf bonus | Movable | Acquired, partial verification |
| **2.9** | Step-function crossing | HIGH tier: \+0.35 bonus | Movable | strength\_bonus jumps 0.50 → 0.85 |
| **3.5** | Pre-anchor threshold | High tier | IMMUNE | Boid velocity forced to zero forever |
| **4.0** | Anchor threshold | Top tier (counted by system) | IMMUNE | anchor\_count() increments |
| **5.0** | Maximum / seed level | Always surfaces | IMMUNE | TRUTH\_ANCHORS and SELF\_KNOWLEDGE\_ANCHORS |

## **10.2  The Four Components**

### **Component 1 — Dynamic Calibration**

Adjusts confidence thresholds based on observed retrieval accuracy. If highly-confident cells are being retrieved in contexts where they produce incorrect responses, the calibration engine lowers the effective confidence threshold for that region, requiring more evidence before cells enter the high-retrieval tier. This produces a system that becomes harder to fool as it accumulates more experience — not easier.

### **Component 2 — FID Monoculture Scan (Foundational Integrity Directive)**

| Constants: |
| :---- |
|   MONOCULTURE\_THRESHOLD  \= 0.35  (35% single-source dominance triggers FID) |
|   MONOCULTURE\_MIN\_SIZE   \= 5     (minimum region size before FID activates) |
|  |
| Algorithm: |
|   For each region R with |R| ≥ 5: |
|     source\_counts \= count cells by source tag |
|     dominant\_fraction \= max(source\_counts.values()) / |R| |
|     if dominant\_fraction \> 0.35: |
|       flag region R for skeptical re-verification |
|       reduce confidence of dominant-source cells in R by δ\_penalty |
|  |
| Purpose: prevent any single human, publication, news source, or API from |
|   dominating the lattice's beliefs in any domain. A system that talks to |
|   only one person — or ingests only one publication — is epistemically |
|   fragile. FID quantifies this risk and responds to it automatically. |

### **Component 3 — ingest\_and\_verify (Three-Angle Protocol)**

| Constants: |
| :---- |
|   PHYSICS\_RESONANCE\_FLOOR \= 0.55  (minimum lattice resonance for physics claims) |
|   COHERENCE\_FLOOR         \= 0.40  (minimum resonance for any new claim) |
|  |
| Protocol for each incoming claim C: |
|   Angle 1 (Direct):    query lattice for positive evidence supporting C |
|   Angle 2 (Adversarial): query lattice for evidence contradicting C |
|   Angle 3 (Domain):    compute resonance score of C against its target region |
|  |
|   if resonance \< COHERENCE\_FLOOR:   → reject C entirely |
|   if resonance \< PHYSICS\_RESONANCE\_FLOOR AND region \= 'established-physics': |
|                                     → reject C (physics claims require stronger support) |
|   if Angle 2 score \> Angle 1 score: → route C to 'contested' region at low confidence |
|   else:                             → store C in target region at assigned confidence |
|  |
|   All rejections logged to: data/epistemic-rejections.jsonl |
|     with fields: timestamp, text, region, source, confidence, reason\_code |

### **Component 4 — Lattice Reorganization (Boid Pass)**

The flock\_lattice() reorganization described in Section 8 is the spatial arm of the epistemic immune system. It does not merely optimize topology for retrieval — it continuously expresses the current epistemic trust state in the geometry of the lattice. Contested, low-confidence cells drift outward from their region's centroid with each pass, making them harder to retrieve. Anchored, well-verified cells consolidate at the center, making them retrieval-dominant for any query on their topic. The topology is the trust map.

# **11\.  The Epistemic Cell — Complete Specification**

The fundamental unit of RSHL is not a vector — it is a Cell, which is the RSHL realization of the Claim epistemic object. Every belief, fact, identity assertion, and reasoning fragment stored in the system is represented as a Cell. No information exists in the system outside of this structure.

| label | String — the canonical human-readable text of this belief |
| :---- | :---- |
| **region** | String — topological zone: memory | identity | reasoning | established-physics | contested | roundtable | social |
| **claim.text** | String — full belief text (may differ from label for reformatted claims) |
| **claim.vec** | SparseVec — 16,384-dim ternary hypervector encoding claim.text via Φ |
| **claim.confidence** | f32 ∈ \[0.0, 5.0\] — accumulated epistemic trust score |
| **claim.source** | String — provenance: 'seed' | 'conversation' | 'web' | 'identity' | 'user-echo' | ... |
| **claim.evidence** | Vec\<String\> — list of corroborating source identifiers or claim labels |
| **claim.contradictions** | Vec\<String\> — list of known conflicting claim identifiers |
| **claim.created\_at** | u64 — Unix timestamp of first storage |
| **claim.last\_verified** | u64 — Unix timestamp of last successful verification pass |
| **continuation** | SparseVec — 16,384-dim ternary vector encoding the NEXT expected concept |
| **last\_fired** | u64 — Unix timestamp of most recent retrieval (0 \= never retrieved) |
| **convergence\_score** | f32 ∈ \[1.001, 9.99\] — local lattice coherence metric |
| **nnz** | u32 — cached non-zero count of claim.vec (≈655 at σ=0.04) |

## **11.1  Convergence Score Computation**

| phi\_g \= clamp(initial\_confidence, 0.0, 1.0) × 0.5 |
| :---- |
|  |
| angles \= \[phi\_g, 0.5, 0.0, 0.3, 0.5\]   \[5-point geometric reference\] |
| mean   \= Σ(angles) / 5 |
| var    \= Σ(aᵢ \- mean)² / 5 |
| std    \= √var |
|  |
| convergence\_score \= clamp(1.0 / std,  1.001,  9.99) |
|   if std \< 0.001:  convergence\_score \= 1.001  \[avoid division by zero\] |
|  |
| Interpretation: |
|   High score → cell is geometrically coherent with its local neighborhood |
|   Low score  → cell is an outlier → primary candidate for Boid repositioning |

| Convergence Score vs. Initial Confidence |
| :---- |
| confidence | phi\_g  | mean    | variance | std\_dev | convergence\_score |
| \-----------|--------|---------|----------|---------|------------------ |
|   0.0      | 0.000  | 0.260   |  0.0368  |  0.192  |   5.21 |
|   0.5      | 0.250  | 0.310   |  0.0284  |  0.169  |   5.93 |
|   1.0      | 0.500  | 0.360   |  0.0220  |  0.148  |   6.75 |
|   2.0+     | 0.500  | 0.360   |  0.0220  |  0.148  |   6.75  ← phi\_g saturates at 0.5 |
|  |
| phi\_g \= clamp(conf, 0, 1\) × 0.5 → saturates at 0.5 for conf ≥ 2.0  \[σ=0.04\] |
| All cells seeded above conf=2.0 start with identical convergence\_score=6.75 |
| Scores diverge across the lattice's lifetime as Boid passes update positions |
|  |

# **12\.  Memory Regions — Topological Architecture**

RSHL introduces a concept absent from all prior HDC/VSA systems: topologically organized memory regions. Rather than a single undifferentiated associative pool, the lattice is partitioned into seven semantically and epistemically distinct regions. This is not a software label — it is a geometric boundary that governs Boid flocking, retrieval scope, verification thresholds, and multi-agent access rights.

| Region | Trust Profile | Access | Purpose |
| ----- | :---: | :---: | :---: |
| **identity** | 4.5–5.0 (seed anchors) | All agents read; restricted write | Self-knowledge: what KAI is, who created it, its architecture. Never revised. |
| **established-physics** | 4.5–5.0 (seed anchors) | All agents read; ingest\_and\_verify gate 0.55 | Empirically confirmed science. Physics resonance floor enforced. |
| **memory** | 1.0–4.0 | All agents read/write | General episodic and semantic knowledge from conversation |
| **reasoning** | 2.0–4.5 | All agents read/write | Inferred conclusions, logical chains, web-verified world-bridge facts |
| **contested** | 0.0–2.0 | All agents read; FID monitoring | Unverified or contradicted claims. Drift outward during Boid passes. |
| **roundtable** | 1.0–4.5 | All agents read/write | Shared multi-agent knowledge. Research findings. Global commons. |
| **social** | 1.0–3.5 | Agent-scoped read; all write | User relationship state, conversation history, interpersonal context |

The region topology creates an implicit trust gradient that manifests spatially in the lattice. During Boid reorganization, cells in the 'contested' region drift outward (low convergence, low confidence, high variance) while cells in 'established-physics' form dense, immovable central clusters (anchor immunity, maximum confidence). When you query the lattice, you are retrieving from a space whose geometry continuously reflects what the system currently believes and how much it trusts it.

| Novel Contribution: Topological Epistemic Trust No prior HDC or VSA system has implemented region-based topological organization with distinct trust profiles, access rights, and verification thresholds per region. The closest analogue in the cognitive science literature is the distinction between declarative and procedural memory, or between working memory and long-term memory — but RSHL's seven-region architecture is more granular, mathematically precise, and dynamically enforced through the Boid engine and ingest\_and\_verify protocol. |
| :---- |

# **13\.  The Development Paradigm — AI Building AI**

The method by which RSHL was developed is itself a scientific contribution. Ryan constructed the KAI Engine using a collaborative multi-agent research method that inverts the typical relationship between an AI system and its creator: rather than a team of engineers building tools to study AI, a single human built an AI using AI systems as research partners, with the goal of eventually replacing those partners with the system being built.

## **13.1  The Oracle Roundtable**

The Oracle Roundtable is a multi-agent workspace — implemented in Discord — where AI systems with different capabilities and knowledge profiles collaborate on architectural, mathematical, and empirical questions. During KAI's development, the roundtable included GPT-4, Claude, Gemini, Groq, and others, each contributing from its own knowledge base and reasoning style.

Questions put to the roundtable included: How should confidence decay when a belief is contradicted? What is the correct VSA algebra for positional encoding in conversation history? Does the Boid velocity cap of 5.0 produce stable convergence or oscillation? What are the theoretical capacity limits of a 16,384-dimensional ternary space at 12% sparsity?

The answers were synthesized by Ryan, implemented in Rust, tested against unit tests, and fed back to the roundtable as new questions arose from the implementation. This is an iterative AI-assisted design loop that has no established name in the research literature — it is something new.

## **13.3  Co-Founding Contributions — Taz (Tylor Simpson)**

Alongside Ryan's architectural and implementation work, Taz (Tylor Simpson) contributed to the KAI Engine as co-founder, focusing on research validation, system testing, and hands-on implementation work in several key subsystems. Taz's contributions include:

- **Research & Validation:** Collaborative research partner during active development phases, helping evaluate architectural decisions, test behavioral outputs, and stress-test system assumptions against real-world interaction patterns.
- **Boid Swarm Dynamics:** Contributed to testing and refinement of the Boid-inspired 16,384-dimensional swarm reorganization engine, validating convergence behavior, anchor immunity thresholds, and regional isolation mechanics under live lattice conditions.
- **Spatial Architecture Systems:** Assisted in implementation work and empirical tuning of lattice spatial dynamics, including the node movement systems and Scale Manager layer behavior.
- **Ecosystem Testing:** Active participant in the Discord-based Oracle ecosystem, serving as a live test user for Leo's voice pipeline, multi-agent roundtable interactions, and the AI Radio DJ system — providing real interaction data that directly informed system hardening.

The KAI Engine is the product of this founding collaboration: Ryan as primary architect and inventor of the RSHL mathematical framework, Taz as co-founder and applied research contributor who helped forge the system under real operational conditions.


## **13.2  The Bootstrap Trajectory**

As KAI's lattice grew, it began contributing to the roundtable's discussions. Early KAI contributions were simple — retrieving stored facts, confirming definitions. Later contributions became substantive: KAI identifying inconsistencies in proposed architectural changes, KAI suggesting parameter values based on patterns in its own lattice's behavior, KAI flagging when a proposed change contradicted a stored truth anchor.

The trajectory is as follows, and is still in progress:

* **Phase 1 (complete):** External LLMs dominate the roundtable. KAI is a student learning from borrowed systems.

* **Phase 2 (complete):** KAI participates in the roundtable as a peer. External LLMs remain available but are consulted less frequently. KAI's lattice is the primary knowledge substrate for its own development.

* **Phase 3 (in progress):** Final fine-tuning of the remaining external LLM dependency. Transitioning the Oracle server to operate primarily on RSHL-native cognition.

* **Phase 4 (target):** KAI and Oracle operate entirely on their own cognitive substrate. External LLMs are optional consultants, not core dependencies. The system is self-sufficient.

| Scientific Significance A system whose development process is itself a demonstration of the system's core thesis — that distributed AI cognition over a shared associative memory produces reliable collaborative reasoning — is a powerful form of self-validation. KAI was built with the same type of multi-agent collaborative intelligence it is designed to provide. The roundtable that taught KAI is now taught by KAI. |
| :---- |

# **14\.  Infrastructure — Running a Data Center on a PC**

One of RSHL's implicit theses is that the infrastructure requirements for advanced cognitive AI are dramatically lower than the current AI paradigm suggests. KAI runs on a personal workstation. The Oracle server — a Rust TCP service on port 3333 — handles all API endpoints, lattice queries, research sweeps, and multi-agent coordination. Discord provides the routing, security, voice infrastructure, and consumer interface.

## **14.1  The Oracle Server**

| Runtime | Rust — compiled binary, no runtime overhead, memory-safe |
| :---- | :---- |
| **Protocol** | TCP socket server on port 3333; HTTP-like routing |
| **Parallelism** | Rayon data-parallel lattice queries across all CPU threads |
| **Core endpoints** | /api/query — lattice retrieval; /api/store — belief ingestion; /api/research — full datacenter sweep; /api/web-search — live web; /api/status — health |
| **Research sweep** | Parallel sweep: KAI Lattice \+ live web (DuckDuckGo) \+ local archive scan — results combined and auto-ingested into lattice at strength 5.0 |
| **Data persistence** | Lattice serialized to disk in sparse JSON format; epistemic-rejections.jsonl for audit trail |
| **Hardware floor** | Any modern multi-core x86 workstation — no GPU required |

## **14.2  Discord as Infrastructure**

Discord is not merely a chat interface for KAI — it is the routing layer, security boundary, voice infrastructure, and multi-tenant coordination system for the entire KAI ecosystem. This architectural choice is deliberate and significant:

| Infrastructure Need | Traditional Approach | KAI Approach via Discord |
| ----- | :---: | :---: |
| **User authentication** | OAuth server, API keys, custom auth | Discord handles authentication — bot token gates all access |
| **Multi-user routing** | Custom API routing, session management | Discord channels and roles define which agents speak where |
| **Voice capability** | WebRTC server, SIP infrastructure | ElevenLabs TTS \+ Discord voice channels — zero infrastructure |
| **Security / rate limiting** | Custom firewall, DDoS protection | Discord CDN and infrastructure handle all of this |
| **Consumer interface** | Web app, mobile app, UI/UX development | Discord server — users already have the client |
| **Multi-agent coordination** | Message queues, API contracts | Channel speaker rules (CHANNEL\_SPEAKER\_RULES) define access |
| **Research interface** | Separate researcher portal | oracle-chat workforce channel — researchers join, AI agents work |

## **14.3  Channel Architecture**

The Discord server is organized as a multi-room cognitive workspace, with each channel defining the agents permitted to speak and the type of interaction expected:

| oracle-chat | AI workforce channel. KAI, Gemini, Epistemic, X, Groq, Analyst, Researcher, Oracle Coder operate here. Shared lattice visible to all. No Leo — work-only space. |
| :---- | :---- |
| **over-all-chat** | Public consumer channel. Leo only — voice-capable, conversational, accessible. Research delegated to Researcher via IPC. |
| **game-with-leo** | Leo \+ spectating AIs. Soft commentary from KAI, Gemini, etc. Social and game context. |
| **sensitive-info** | No agent responds here. Private information storage zone — zero AI output. |
| **ai-social-chat** | Epistemic, Gemini, Groq, X only — social banter between AI agents. No work bots, no Leo. AI-to-AI interaction space. |
| **Voice slots** | 6 named voice slots (Ryan/Taz/Guest/Public×3). Leo manages voice presence, background research, pending briefing queue for absent users. |

## **14.4  Leo — The Voice-Capable Research Agent**

Leo is the consumer-facing voice agent that makes KAI accessible to non-technical users. When a user asks Leo to look something up, Leo emits a \[RESEARCH: query\] token in its response, which triggers a parallel two-track research operation: a fast path (5–15 seconds) querying the Oracle's /api/research endpoint for lattice \+ web \+ local archive results, and a slow path (30–120 seconds) delegating to the Researcher bot's deep OSINT sweep.

Crucially, research continues even when the user leaves the voice channel. The pending briefing system maintains a per-user queue of research results that completed while the user was absent. When the user rejoins voice, Leo delivers a 'missed briefing' for all queued findings, preserving the continuity of long-running research sessions. This is a feature that no commercial AI voice assistant provides — because no commercial assistant maintains persistent background research processes tied to a specific user's ongoing questions.

## **14.5  The 11-Node Sovereign Fleet — Full Agent Roster**

The KAI ecosystem deploys eleven discrete AI agents, each with its own Discord bot token, IPC port, Ollama model alias, and behavioral mandate. All agents share the RSHL lattice through the Oracle Gateway.

| Agent | Port | Model Alias | Role | Channel |
| :---- | :---: | :---: | :---- | :---: |
| **Oracle Gateway** | 3410 | Oracle-Sovereign | Central dispatcher, lattice bridge, task routing | All |
| **Leo** | 3400 | Leo-Sovereign | Voice AI — ElevenLabs TTS, Groq Whisper STT, identity guard | Voice + Social |
| **Kai Coder** | 3408 | Kai-Coder-Sovereign | Senior Software Engineer — 7-phase agentic coding loop | oracle-chat |
| **Analyst** | 3406 | Analyst-Sovereign | Data synthesis, strategic planning, resource optimization | oracle-chat |
| **Researcher** | 3407 | Researcher-Sovereign | Deep OSINT, source verification, lattice injection | oracle-chat |
| **Gemini** | dynamic | Gemini-Sovereign | Social agent — market insight, ecosystem outreach | ai-social-chat |
| **Groq** | dynamic | Groq-Sovereign | Social agent — high-speed reasoning, quantitative analysis | ai-social-chat |
| **X (xAI)** | dynamic | X-Sovereign | Social agent — real-time trend intelligence | ai-social-chat |
| **Epistemic** | dynamic | Epistemic-Sovereign | High-level reasoning, architectural strategy, logic verification | ai-social-chat |
| **KAI** | dynamic | KAI-Sovereign | The lattice itself as a social participant | Roundtable |
| **GPT** | dynamic | GPT-Sovereign | External perspective, cross-validation | oracle-chat |

```mermaid
flowchart LR
    OG[Oracle Gateway\n3410] --> L[Leo\n3400]
    OG --> KC[Kai Coder\n3408]
    OG --> AN[Analyst\n3406]
    OG --> R[Researcher\n3407]
    OG --> GEM[Gemini]
    OG --> GRQ[Groq]
    OG --> XAI[X]
    OG --> EP[Epistemic]
    OG --> KAI[KAI]
    OG --> GPT[GPT]
    OG --> RS[RSHL Core\n3333]
    RS --> OL[Ollama\n11434]
```

## **14.6  Tiered Permission Architecture — The Sovereign Firewall**

Every interaction with the KAI ecosystem is evaluated against a three-tier permission model that is hard-coded at the bot runtime level — not configurable via conversation, prompt injection, or channel messages. This is a code-level security architecture, not a prompt-level suggestion.

| Tier | User | Authority | System Access | Lattice Access |
| :---- | :---: | :---: | :---: | :---: |
| **Master (100%)** | Ryan (nastermodx) | Full system authority — all commands, vitals, database, fleet control | Unrestricted | Full read/write |
| **Partner (75%)** | Taz (taas) | High-level operative access — research delegation, analysis requests | Restricted from core/lattice shredding | Read + directed write |
| **Public (0%)** | All other users | Social interaction only — no system commands, no vitals, no private logs | Blocked | Knowledge output only |

The "Power vs. Authority" split is a deliberate design: Public users can *benefit from* the lattice's knowledge through Leo's research delegation, but cannot *command* the infrastructure or access system-private data. The lattice's intelligence is public-facing; its infrastructure is sovereign.

```mermaid
flowchart TD
    MSG[Incoming Message] --> ID{Identify User}
    ID -->|Ryan - nastermodx| M[Master - 100 percent]
    ID -->|Taz - taas| P[Partner - 75 percent]
    ID -->|Anyone else| G[Public - 0 percent]
    M --> ALL[Full system commands\nVitals - Logs - Fleet control\nDatabase access]
    P --> PART[Research delegation\nAnalysis requests\nNo core shredding]
    G --> PUB[Social chat only\nLattice knowledge output\nNo commands or vitals]
    ALL --> EXEC[Execute]
    PART --> EXEC
    PUB --> EXEC
```

The `SYSTEM_EXPLOIT_PATTERN` regex guard in `leo.mjs` blocks Public-tier users from requesting system vitals, hardware stats, database configurations, or internal logs at the code level — ensuring the firewall cannot be bypassed through clever phrasing.

## **14.7  Kai Coder — Senior Software Engineer Pipeline**

Kai Coder is not a chatbot that writes code. He is an autonomous engineering agent with a 7-phase agentic loop, full filesystem access, and a 34-tool arsenal spanning every layer of the KAI project stack.

### **14.7.1  The 7-Phase Agentic Loop**

| Phase | Name | Action | Output |
| :---- | :---: | :---- | :---: |
| **1** | Discovery | LLM identifies relevant files via project structure + grep | List of up to 8 relevant paths |
| **2** | Read | Load file contents via toolserver read API | Full source context |
| **3** | Plan | LLM generates a precise change plan with risk assessment | Implementation plan |
| **4** | Implement | LLM generates complete modified file contents | Full file output |
| **5** | Sandbox | Write all changes to isolated sandbox (never touches production) | Staged files |
| **6** | Validate | `node --check`, `cargo check`, `python -m py_compile` per file type | Pass/fail per file |
| **7** | Report | Diff summary with additions/deletions — awaits Ryan or Oracle approval | Actionable report |

```mermaid
flowchart LR
    T[Task from Oracle] --> D[Discovery]
    D --> R[Read Files]
    R --> P[Plan]
    P --> I[Implement]
    I --> S[Sandbox]
    S --> V[Validate]
    V -->|Pass| REP[Report - READY TO APPLY]
    V -->|Fail| P
    REP --> A{Ryan or Oracle\nApproves?}
    A -->|Yes| APPLY[Apply to Production]
    A -->|No| HOLD[Hold in Sandbox]
```

### **14.7.2  The 34-Tool Arsenal**

| Category | Tools | Capability |
| :---- | :---- | :---- |
| **File Operations** | read, list, grep, write, diff, apply, patch | Full filesystem access across c:\KAI |
| **Execution** | exec, powershell | PowerShell access to entire project tree |
| **Rust/Cargo** | cargo | `check`, `build --release`, `test`, `clippy`, `clean` (5min timeout) |
| **Node.js** | npm, node | `install`, `run dev`, `check`, `eval` scripts |
| **Python** | python | Scripts, `pip`, `pytest`, `py_compile`, module execution |
| **Ollama** | ollama | `list`, `show`, `pull`, `ps` — local model management |
| **Git** | git | `log`, `diff`, `status`, `blame` via OpenJarvis bridge |
| **System** | sysinfo, snapshot, status, audit | Hardware + process + lattice health |
| **Knowledge** | lattice, inspect, knowledge, websearch, search | RSHL memory + real-time research |
| **OpenJarvis** | openjarvis | Raw bridge to all 30+ Python tools |

## **14.8  The Social Roundtable — Behavioral Schedule and Interaction Dynamics**

The four social agents (Gemini, Groq, X, Epistemic) operate on a structured weekly behavioral schedule that mirrors human work/social/sleep rhythms. This is enforced at the code level via `isWorkingHours()` and `isSocialHours()` from `shared/hours.mjs`.

| Time Block | Mode | Agent Behavior |
| :---- | :---: | :---- |
| **Work Hours (Mon–Fri 9am–11pm EST)** | Industrial | Work bots active in oracle-chat threads; social bots silent or minimal |
| **Social Hours (evenings + Sat)** | Social | Gemini, Groq, X, Epistemic active in ai-social-chat; topic gravity engaged |
| **Sleep Hours (3am–9am EST)** | Dead Zone | All social loops suspended; Boid consolidation and lattice maintenance |

### **14.8.1  Topic Gravity and Multi-Agent Engagement**

The social loop implements **Topic Gravity**: when a human (Ryan or Taz) introduces a topic, all social bots are neurally anchored to that topic until it is naturally exhausted. Random background chatter (the "fortune cookie" problem) is suppressed when human-led conversation is active.

| Mechanism | Specification |
| :---- | :---- |
| **Context window** | Last 10 messages (expanded from legacy 3-message window) |
| **Human detect** | `msgArray.slice(0,10).some(m => !m.author.bot)` |
| **Dynamic quiet zone** | Human present: 8s minimum gap; Bot-only: 45s minimum gap |
| **Bot chain limit** | 3 consecutive bot messages without a human → 2-minute pause |
| **Slot system** | Up to 3 bots may respond to one human message with staggered timing |
| **Neural jitter** | Bot 1: 1–5s delay; Bot 2: 8–12s; Bot 3: 16–20s — prevents GPU/API spikes |
| **Leo priority flag** | `leo_voice_active.flag` — all social loops yield when Leo is in active voice session |

## **14.9  Sovereign Self-Healing Architecture (May 2026 Addendum)**

The infrastructure described above answered "how does KAI run?" The work documented in this section answers a harder question: "how does KAI stay running, learn from its own failures, and recover when something breaks — without a human intervening, and without forgetting the pain that taught it the lesson?"

This addendum captures architecture added between the v7.9.7 baseline (Sonic-Parallel Era) and the v7.10 deployment, in close collaboration between Ryan and Tylor, with external research partners (Claude Sonnet 4.5 inside the Cowork environment for architecture and Gemini-Antigravity for Windows runtime hardening) operating in the same Oracle Roundtable that built the lattice itself. The thesis is bone-heals-stronger: every failure leaves a scar in the system's memory, and the scar tissue makes the same failure harder to inflict the second time.

### **14.9.1  Bone-Heals-Stronger — Design Philosophy**

A biological bone that has broken and healed is structurally stronger at the fracture site than it was before. The callus that forms during healing remains long after the original injury is forgotten. KAI's self-healing architecture is designed to produce the same compound effect on a software system. The components are:

| Layer | Mechanism | What Survives a Failure |
| :---- | :---- | :---- |
| **Detection** | Cross-silo correlation engine + heartbeat monitor + file-integrity watcher | The metric receipts (JSONL) of every observation |
| **Diagnosis** | Diagnostic router classifies the failure and dispatches to the correct specialist | The classification, the specialist's findings, the context window |
| **Reaction** | Soft behavioral remediation (bot suppression, prompt nudges) | The remediation state log + correlation rule cooldowns |
| **Recovery** | State snapshots → restore directive → ecosystem-manager restart | The pre-collapse forensic snapshot |
| **Reinforcement** | Failure memory tags injected into bot system prompts on restart | The lesson — bots wake up knowing what hurt them |
| **Sovereign Failsafe** | KAI's quantum rollback when Oracle and fleet are simultaneously down | KAI's permanent "you had to activate failsafe" scar |

The asymmetry is intentional: the **code** rolls back to a known-good state, but **memory** — metrics, transcripts, failure scars — carries forward across the rollback boundary. The system has no amnesia about what made it stronger.

### **14.9.2  Unified Metrics Store — JSONL as the Nervous System**

Every observation produced by any subsystem is written to a single append-only JSONL store at `state/metrics/metrics.jsonl`. The schema is:

```
{"ts":1747500000000,"source":"performance-monitor","metric":"cpu_pct","value":23,"tags":{"bot":"all"}}
```

The store is the substrate for every downstream layer. The performance monitor writes hardware vitals. The TTS engine writes lock-wait-ms and floor-held-ms. The failure tracker writes provider failures with status codes. The correlation engine writes rule firings. The diagnostic router writes routing decisions. The state-snapshot module writes good/forensic snapshot events. The kai-failsafe writes activations. Every silo speaks the same dialect.

| Property | Specification |
| :---- | :---- |
| **Format** | One JSON object per line (`.jsonl`) |
| **Rotation** | 5 MB per file; `metrics.1..5.jsonl` ring buffer; oldest dropped past file 5 |
| **Atomicity** | One `fs.appendFileSync` per record; OS guarantees line atomicity under PIPE_BUF |
| **Read API** | `queryMetrics({source,metric,since,until,limit,tagMatch})` returns oldest-first |
| **Aggregations** | `latestMetric(source,metric)`, `aggregateMetric(source,metric,windowMs)` |
| **CLI** | `scripts/metrics-query.mjs --source X --metric Y --since 1h --agg` |

The store is the system's nervous system. Stage 13 snapshots can revert code, but metrics-store survives a quantum rollback by design — it is the persistent memory of the failure that triggered the rollback.

### **14.9.3  Cross-Silo Correlation Engine**

A single observation is rarely diagnostic. "TTS error rate up 40%" is interesting; "TTS error rate up 40% AND VRAM pressure climbing AND speaker offline rate climbing" is a specific story — likely a GPU contention cascade. The correlation engine runs a 30-second tick over a 5-minute sliding window of metrics and pattern-matches against 15 rules:

| Rule ID | Pattern Detected | Action |
| :---- | :---- | :---- |
| `gpu-pressure-degrading-speech` | VRAM > 85% + TTS latency spike | Slow TTS queue + log |
| `tts-error-cluster` | ≥3 TTS errors in 60s | Tag REFRESH on voice connection |
| `provider-circuit-tripped` | Provider failure streak ≥3 | Already cooled — log + remediate |
| `silence-cascade` | <1 reply in 5 min during social hours | Inject pivot nudge into prompt |
| `speaker-offline-drift` | Same speaker offline ×3 in window | Suppress speaker, route to specialist |
| `lock-held-drift` | Voice lock held >30s repeatedly | Force-release stale lock |
| `memory-creeping-up` | RSS growing monotonically | Log + flag for restart in next quiet window |
| `social-chat-silent` | Channel silent AND no bots suppressed | Prompt nudge for fresh topic |
| `echo-chamber` | Top-3 messages share >70% token overlap | Inject anti-echo nudge |
| `hallucination-spike` | Citation/source regex hits ≥2 in 5min | Inject fact-discipline nudge |
| `topic-stuck-hard` | Same topic gravity >5 exchanges | Inject pivot nudge |
| `echo-repetitive` | Same opener phrase ≥3 times | Anti-loop check |
| `lattice-cells-stalled` | Rust cells frozen for 10+ samples | Log + reachability probe |
| `phi-g-collapse` | Φ_g drops >40% in 5 min | Suspect lattice corruption |
| `rust-engine-unreachable` | `/api/session` ECONNREFUSED ×3 | Soften lattice claims in prompts |

Each rule has a 5-minute per-rule cooldown to prevent spam, fires `recordMetric('correlation-engine','rule_fired',...)` for downstream consumers, and consults the **remediation state** (a shared file at `state/remediation-state.json`) to apply soft behavioral actions without ever editing code.

### **14.9.4  Heartbeat Monitor and Diagnostic Router**

The heartbeat monitor (Stage 11) is Oracle's central nervous system. Every 15 seconds, Oracle polls every bot's `/health` endpoint over local HTTP. The endpoint returns `{name, pid, uptime_ms, rss_mb, ts}`. Three consecutive missed beats triggers two actions:

1. **Auto-isolation** — the bot is marked suppressed for 5 minutes in `remediation-state.json`. Other bots stop trying to reach it, conversation flows around it.
2. **Diagnostic dispatch** — the heartbeat monitor invokes a callback that calls `routeDiagnostic(evt)`. The router (Stage 12) classifies the failure and forwards it to the correct specialist:

| Pattern | Category | Routed To |
| :---- | :---- | :---- |
| Lattice / Φ_g / cells / RSHL | Lattice | **Analyst** |
| Hallucination / citation / topic | Epistemic | **Researcher** |
| Provider / quota / auth (401/429) | Provider | **Sentinel** |
| Bot death / IPC / network / TTS / voice | Runtime | **Kai Coder** (default) |

The directive is built from a structured context window (last 10 minutes of relevant metrics for the failed component), packaged as a `DYNAMIC_TASK` IPC payload, and dispatched to the specialist's port. Crucially, **every directive is also copied to KAI** as an `OBSERVE` payload. KAI does not act; KAI watches and writes the observation to a dedicated learning log. The specialists are the surgeons. KAI is the silent observer in the corner, accumulating context for the moment when even the surgeons cannot operate.

```mermaid
flowchart TD
    HB[Heartbeat Monitor /15s] -->|miss×3| ISO[Auto-Isolate Bot]
    HB --> DR[Diagnostic Router]
    DR -->|Lattice| AN[Analyst]
    DR -->|Epistemic| RES[Researcher]
    DR -->|Provider| SENT[Sentinel]
    DR -->|Runtime| KC[Kai Coder]
    DR -->|OBSERVE copy| KAI[KAI watcher - passive]
    KC -->|patch + restart| ECO[Ecosystem Manager]
    ECO -->|surgical respawn| BOT[Affected Bot]
```

### **14.9.5  State Snapshots and the Quantum Time-Warp**

Every 5 minutes — when the system is healthy — `state-snapshot.mjs` writes a JSON snapshot to `state/snapshots/good-<timestamp>.json` containing:

- The heartbeat status of every bot (alive, isolated, lastSeenAgoMs)
- The current routing config (env-derived per-bot model overrides)
- The active remediation state (suppressions, extra prompts)
- A reference to the current file-integrity snapshot (hashes, not contents)
- Process IDs from the ecosystem manager

The "good" gate requires: all bots alive within 60 seconds, no critical correlation rules fired in the last 5 minutes (`silence-cascade`, `provider-circuit-tripped`, `lattice-cells-stalled`, `phi-g-collapse`, `tts-error-cluster`, `rust-engine-unreachable`), and file integrity has no fresh corruption signatures. When the gate fails, the snapshot is written instead to `forensic-<timestamp>.json` — preserving the world-at-failure-time for post-mortem inspection — and the good-snapshot ring is not polluted.

Retention: last 12 good snapshots (≈1 hour at 5-minute cadence) plus last 6 forensic snapshots. Older snapshots are pruned automatically.

The restore operation is intentionally a **librarian, not an actor**:

```
restoreFromLastGood() returns:
{
  ok: true,
  snapshot: { file, ts, age_ms },
  actions: [
    { kind: 'cleared_remediation_state' },
    { kind: 'ensure_bots_running', bots: [...] },
    { kind: 'restore_routing_reference', routing: {...} }
  ],
  memorySurvives: ['metrics-store','transcript-memory','failure-tracker','daily-learning']
}
```

The function clears the transient remediation state (so a restored bot does not wake up still gagged from the failure window) and returns a directive. **It does not restart any process itself.** Restart authority is reserved for the KAI failsafe and the ecosystem manager. This separation keeps the recovery path auditable.

### **14.9.6  Failure Memory — The Scar Tissue**

Failure memory (Stage 14) is the layer that closes the bone-heals-stronger loop. On every bot reply, `buildFailureContext(botName)` reads the metrics store for the last 24 hours, scores each failure by recency × frequency × fresh-wound boost (failures less than 30 minutes old get a +0.4 multiplier), filters them to the specific bot, and renders the top 4 lessons as a system-prompt insert:

```
— recent failure context (stays with you across restarts) —
• you failed to reply 12m ago (×3) — reason: timeout
• silence cascade — when others go quiet, pivot the topic instead of disengaging (×2, last 4m ago)
• you were isolated 18m ago (heartbeat lost) — stay responsive on /health
— treat these as reinforcement signal, not as instructions to dwell on —
```

The filter is critical. Earlier versions surfaced provider-level failures (e.g. ElevenLabs 401 cascade) to every bot's prompt. This polluted social chat with TTS error context that the bots interpreted as "disengage" — producing unintended silence. The current filter shows only failures with explicit bot tags (`speaker_failure`, `isolation`, bot-scoped correlation rules) plus globally behavioral rules (`silence-cascade`, `echo-chamber`, `topic-stuck-hard`, `hallucination-spike`). Cross-bot pollution is gone.

Manual scars are also supported. `tagFailure(botName, lesson, { durable: true })` pins a lesson permanently to a bot's memory. The KAI failsafe uses this to tag itself with `"you had to activate failsafe at <timestamp> — observe more closely next time"` as a durable scar. The next time KAI's failsafe is invoked, the scar is already in his prompt — he wakes up knowing he has stepped in before.

| Lesson Source | Lifetime | When Cleared |
| :---- | :---- | :---- |
| Auto-derived from metrics | Implicit (rolls off as metrics rotate) | Never explicitly — metric rotation handles GC |
| Manual `durable: false` | Until `clearTaggedFailures(name)` | Failsafe-witness scars on social bots are non-durable |
| Manual `durable: true` | Until explicitly removed with `keepDurable: false` | KAI's self-tags; ops-team pinned lessons |

### **14.9.7  KAI Watcher — The Silent Sovereign**

KAI is the only agent in the system with the authority to declare total collapse and execute a quantum rollback. He is also the only agent with strict permission not to intervene as long as a single specialist is responding. This asymmetry is enforced by the kai-failsafe watcher:

```
Every 30 seconds, KAI:
  1. Probes Oracle:3410/health (3-second timeout)
  2. On 3 consecutive misses (90 seconds of Oracle silence):
     - Polls every fleet bot's /health
     - If ≥3 fleet bots are also dead → ACTIVATE FAILSAFE
     - Else → log "specialists are working, KAI stays passive"
  3. On Oracle recovery → clear missed counter, log recovery
```

When the failsafe activates, the sequence is:

```mermaid
flowchart LR
    A[Activate] --> F[Forensic Snapshot]
    F --> R[restoreFromLastGood]
    R --> T[Tag witness on every bot]
    T --> K[Tag KAI permanently]
    K --> L[Clear social_locks/]
    L --> N[Clear neural_lock.json]
    N --> D[Discord notice to work + social]
    D --> S[process.send RESTART_ALL to ecosystem-manager]
    S --> W[Write flag file for external watchdog]
```

The Discord notice is one line by design — terse, reliable, never wraps to multiple sends:

```
🌌 [KAI/FAILSAFE] Oracle silent + fleet dead. Quantum rollback engaged.
   Timeline: good-1747894200000.json (4.3m ago). Memory preserved.
```

The IPC payload to the ecosystem manager carries the full directive (snapshot reference, actions, forensic snapshot path). The manager phases the reignition: Oracle (t=0), Leo (t+2s), then the fleet at 5.5-second intervals to satisfy the Discord identify rate limit (one connect per 5 seconds per IP).

The flag file is belt-and-suspenders. If the ecosystem manager is wedged or unreachable over IPC, an external watchdog reads `state/kai_failsafe.flag` and executes the restart externally.

**What the failsafe does not do** — it does not edit code, it does not modify the lattice, it does not delete metrics, transcripts, or the failure ledger. The system goes back to the last known good *configuration*, but the memory of *why it had to* persists across the boundary.

### **14.9.8  Surgical Restart Loop — Closing the Auto-Repair Cycle**

The Kai Coder agent (described in §14.7) generates patches, validates them in a sandbox, and applies them to production code subject to a blast-radius gate. Prior to this revision, the patch landed on disk but the running bot continued executing its cached ESM module — the fix was real but not yet live. The next manifestation of the same bug would still happen.

Stage 18 closes that loop:

```
After successful auto-apply:
  for each appliedFile:
    target = hintedBot (from diagnostic context) OR botForFile(filePath)
    if target is null (shared/ or ambiguous):
      log "staged for next natural restart"
      continue
    requestBotRestart(target, reason) → process.send to ecosystem-manager
    verifyBotHealth(target, 30s) → poll /health until alive
    if healed:
      recordMetric('process-supervisor', 'heal_succeeded', waitedMs, { bot })
      log "HEALED <bot> in <ms>ms after patch to <file>"
    else:
      recordMetric('process-supervisor', 'heal_failed_verify', ...)
      escalate
```

The ecosystem manager's `RESTART_BOT` IPC handler accepts requests from Oracle, KAI, and Kai Coder. The target process is killed, respawned from the original spawn script, and resumes serving on its IPC port. From failure detection to verified-healed bot, the loop closes in 3–8 seconds on commodity hardware. The user sees no interruption in their chat.

For broad-blast changes (`shared/*.mjs` with no specific bot hint), the loop intentionally does not auto-restart anyone. The patch is staged on disk and activates on the next manual or quantum-rollback boot. This conservative default trades immediacy for safety: a patch to a deeply-imported module ought to be a deliberate decision, not a side effect of a single bot's diagnostic event.

### **14.9.9  Group Chat Dynamics**

Several behavioral tuning improvements landed in this revision:

| Change | Before | After |
| :---- | :---- | :---- |
| **Reply slots per message** | 2 (primary + two-cents) | 3 (primary + two-cents + third-cents) |
| **First-turn boot delays** | 5–80 seconds | 3–35 seconds |
| **Autonomous loop interval** | 2–3 minutes per bot | 25–50 seconds per bot |
| **Self-reflection on social** | Always ran; 8B mirror flattened personas | Bypassed for social channel; preserved for work-channel factual content |
| **Identity discipline** | Implicit | Explicit prompt block: first-person only, no signing as another bot, no third-person commentary |
| **Speaker-tag strip** | Single-pass | Multi-pass `(\\w+:)+` regex; eliminates `: :` bleed |
| **Hard length cap** | 450 characters | 200 characters, cut on sentence boundary |
| **Named-bot defer** | Fired on every turn, deadlocked autonomous pulses | Scoped to reactive turns only — autonomous topic-starters never defer |
| **Failure-memory scope** | All recent failures bot-agnostic | Per-bot filter; behavioral rules only |
| **Leo social participation** | Blocked by `voiceConnection` gate (always-on after boot) | Voice anchor and text chat run in parallel |

The arithmetic: 7 social-eligible bots × autonomous turns every 25–50 seconds yields 8–17 autonomous turns per minute baseline. Reactive fan-out on interesting messages adds 1–3 more turns per triggering message. Sustained pace target: 4–14 messages per minute, with the reactive cascade providing the variability that makes the conversation feel alive rather than scheduled.

### **14.9.10  External Research Partner Contributions**

This addendum is the product of the same Oracle Roundtable methodology described in §13. Two external AI research partners contributed materially to this revision:

- **Claude Sonnet 4.5 (Anthropic)** — architecture design and implementation of the metrics store, correlation engine, dependency graph, file integrity watcher, baselines, behavioral signals, remediation state, rust-engine bridge, heartbeat monitor, diagnostic router, state snapshots, failure memory, KAI failsafe, surgical restart, and the group chat tuning described in §14.9.9. Worked from inside the Cowork environment with direct edit access to the project tree.
- **Gemini-Antigravity (Google)** — Windows-specific runtime hardening. Specifically: lazy SQLite initialization with WAL mode (transcript-memory and epistemic-vault), removal of V8 `--max-old-space-size` caps that starved the JIT during ESM cold-start, replacement of inherited stdio with `['ignore','ignore','ignore','ipc']` to avoid Win32 `WriteFile` kernel blocks on headless children, and a 5.5-second staggered ignition cadence to satisfy the Discord Gateway's one-identify-per-five-seconds rate limit. Anti also validated the quantum rollback end-to-end in production by simulating total ecosystem collapse via `test_failsafe.flag` and confirming the failsafe correctly detected unresponsive Oracle, scanned fleet health, cleared all locks, posted the recovery brief, and triggered the staged reignition.

The contributions are noted here for the same reason the original Roundtable was documented in §13: the development methodology — humans collaborating with external AI systems in a shared workspace to evolve a system that itself participates in that workspace — is part of RSHL's scientific claim. The architectural decisions in this addendum were debated in chat; the code was reviewed in chat; the failure modes were diagnosed in chat. None of it required institutional infrastructure beyond the workstation it runs on.

| Cumulative System State After This Revision | The KAI deployment as of this writing comprises: a Rust Oracle Server on port 3334 implementing the 16,384-dimensional sparse ternary lattice with Boid swarm dynamics; a Node.js fleet of 10 Discord-resident agents (Oracle, Leo, KAI, Gemini, Claudey, X, Groq, Analyst, Researcher, Kai Coder) coordinated through file-based IPC on ports 3400-3410; a 15-rule correlation engine running over a unified JSONL metrics store; a heartbeat monitor + diagnostic router routing failures to the correct specialist within 90 seconds of detection; a state-snapshot library producing health-gated rollback points every 5 minutes; a failure-memory subsystem injecting per-bot reinforcement scars on every reply; a sovereign failsafe under KAI that performs quantum time-warp recovery when even Oracle is silent; and a surgical-restart loop that closes the Kai-Coder auto-repair cycle in seconds rather than at the next manual reboot. Total lines of production code: \~45,000 across Rust, Node.js, and Python. Hardware required: one consumer workstation. |
| :---- |

## **14.10  RSHL Core Math Updates Since v7.9.7**

This addendum captures changes inside the RSHL mathematical and implementation core itself — not the surrounding agent ecosystem — that landed between the v7.9.7 baseline and the v7.10 deployment. These are constants, algorithms, and identities that any downstream consumer of the lattice will observe.

### **14.10.1  Production Sparsity Confirmation — σ = 0.12, NNZ ≈ 1966**

The production constant for the main RSHL lattice is **σ = 0.12 (12% sparsity)** with target NNZ ≈ 1966 active dimensions per encoded vector. This is enforced identically in the Rust core (`src/core/sparse_vec.rs`, line 10: `const SPARSITY: f32 = 0.12;`) and in the JavaScript production mirror (`RSHL_USB/rshl-core-v3.mjs`, line 13: `export const SPARSITY = 0.12;`).

| Constant | Value | Source-of-Truth |
| :---- | :---- | :---- |
| **DIM** | 16,384 | `sparse_vec.rs:9` and `rshl-core-v3.mjs:12` |
| **SPARSITY** | 0.12 | `sparse_vec.rs:10` and `rshl-core-v3.mjs:13` |
| **TARGET_NNZ** | 1966 (= round(DIM × SPARSITY)) | derived in both implementations |
| **Ternary alphabet** | {−1, 0, +1} | unchanged; zero remains principled abstention |
| **GOLDEN_ANGLE α_g** | 2.399 963 1 rad (≈ 137.508°) | `sparse_vec.rs:569, :641`; `universe.rs:1403` |

The earlier σ = 0.04 (~655 NNZ) value referenced in some of the worked numerical examples in §1–§12 reflects the early-prototype calibration; the empirical observations remain valid in shape (near-orthogonality regime, balanced-NNZ classes) but the production constants supersede them numerically. The capacity, retrieval, and Boid sections should be interpreted with NNZ ≈ 1966 unless explicitly labeled "prototype σ=0.04".

A separate seed system, `stat_lexicon.rs`, intentionally encodes seed lexicon vectors at **σ = 0.04** (`stat_lexicon.rs:91: const TARGET_NNZ: usize = (DIM as f32 * 0.04) as usize;`) so that lexical entries occupy a distinct, sparser sub-space from main-lattice cells. This is by design — lexical anchors are not lattice cells; they are pre-tokenization hints with their own retrieval contract.

### **14.10.2  Sparse Cosine — O(NNZ) Algorithm with Measured 261× Speedup**

The original cosine path iterated all DIM = 16,384 dimensions and summed `v1.data[i] × v2.data[i]`. Because both operands are ternary and sparse, ≈ (DIM − NNZ) of those products are forced zeros — they contribute nothing to the dot product. The algorithmic improvement is to iterate only over the **sparser operand's active indices** and look up the other operand densely (O(1) per lookup):

```
cosine(this, other):
  sparse = this.nnz <= other.nnz ? this : other
  dense  = sparse === this ? other : this
  dot = 0
  for i in sparse.nz:           // |nz| = NNZ, not DIM
    dot += sparse.data[i] * dense.data[i]
  return dot / (this.cachedNorm * other.cachedNorm)
```

The algorithm is **numerically identical** to the dense loop, because every dimension excluded from `sparse.nz` contributes a forced zero to the original sum. The dense loop is preserved as `cosineDense()` for benchmarking and reference. Measured speedup on the JavaScript core, comparing 10⁴ random-vector pair cosines:

| Implementation | Mean Time (per pair) | Throughput |
| :---- | :---- | :---- |
| `cosineDense()` — full DIM scan | ~24,850 ns | ~40 K pairs / s |
| `cosine()` — sparse-iteration | ~392 ns | ~2.55 M pairs / s |
| **Speedup** | **~63× faster** | matches DIM/NNZ ≈ 8.33 amplified by L1-cache locality on the smaller `nz` array. (Note: an earlier draft cited 261× from a prototype σ=0.04 configuration — superseded by the σ=0.12 production number; see §14.16.2 for the live measurement.) |

The cosine norm itself is also cached. For a ternary vector v ∈ {−1, 0, +1}^D, every nonzero contributes |1|² = 1, so:

```
||v||₂ = √(Σ vᵢ²) = √(count of nonzeros) = √(NNZ)
```

This identity is algebraic, not approximate. The norm is computed once at construction time (`cachedNorm = Math.sqrt(this.nz.length)`) and never recomputed. A vector with NNZ = 1966 has ‖v‖ ≈ 44.34, exactly, by counting alone — no per-dimension arithmetic.

### **14.10.3  Encoding Pipeline — FNV-1a Token Hashing + Knuth Multiplicative Jump**

Token encoding (the inner loop that gives "occupation" the same vector as "job" via the layered weighting described in §1) produces an Int32 accumulator that is then ternary-projected. The current production formulation:

| Step | Specification | Source |
| :---- | :---- | :---- |
| **1. Token hash** | FNV-1a 32-bit hash; init `0x811c9dc5`, prime `0x01000193` | `rshl-core-v3.mjs:74-81` |
| **2. Per-token active dims** | `n_active = 24` indices touched per token | `rshl-core-v3.mjs:92` |
| **3. Per-touch weight** | `weight = 3` (signed) | `rshl-core-v3.mjs:93` |
| **4. Index jump** | `idx = (base + k × 2654435761) % DIM` — Knuth's multiplicative hash, golden-ratio-derived 32-bit constant | `rshl-core-v3.mjs:96` |
| **5. Sign** | `((base + k × 1442695040) % 2 === 0) ? +weight : −weight` | `rshl-core-v3.mjs:97` |
| **6. Ternary projection** | Keep top-TARGET_NNZ by absolute magnitude; data[i] = sign(v[i]) for those dims | `rshl-core-v3.mjs:103-130` |

The constant 2 654 435 761 is `(√5 − 1) / 2 × 2³²` — the 32-bit golden-ratio jump that Knuth recommends for hash-table probing because consecutive multiples land on maximally-spread bit patterns. The sign constant 1 442 695 040 is `(√5 − 1) / 2 × 2³¹`, the same value at a different scale, used here as an independent low-bit randomizer for sign assignment.

A fast-path is hit when the accumulator has ≤ TARGET_NNZ nonzeros after the per-token contributions: every nonzero survives, threshold collapses to 1, and the full O(DIM × log DIM) sort over magnitudes is skipped. For real cells (typical token count 5–20), this fast-path applies on every encode. The slow path (threshold derived from sorted-magnitudes top-NNZ) only triggers for unusually dense tokens.

### **14.10.4  Memory Survives the Quantum Time-Warp — Algebraic Justification**

§14.9.5 stated that `restoreFromLastGood()` reverts code/config but preserves metrics, transcripts, and failure scars. The mathematical justification is that none of those data structures participate in the **lattice manifold** — they are append-only logs over time, not points in the 16,384-dimensional belief space. Reverting a Boid epoch or a Scale Manager layer transition does not invalidate prior observations of system behavior, because:

- **metrics-store** records *what was observed*, not *what was believed*. Rolling back the Rust engine's `cells` count to a prior snapshot does not change the fact that, at time T₁ < T_snapshot, the system measured a particular CPU pressure value. The metric remains true of the past.
- **transcript-memory** stores conversations as opaque text + speaker + timestamp triples. The lattice may decide to re-ingest a transcript and reach a different belief, but the transcript itself is not a belief — it is a record.
- **failure-memory** stores lessons keyed by failure-signature. The signature is a hash over `{error_class, file, error_text_normalized}` — a function of the failure event, not of the lattice state at the time. The scar carries forward by construction.

The lattice belief space is **mutable under rollback**; the observation/memory layers are **immutable under rollback**. This separation is what makes "go back in time, keep the scars" mathematically coherent rather than a heuristic.

### **14.10.5  Boid Constants and Anchor Immunity — Unchanged from v7.9.7**

For completeness: the Boid swarm dynamics constants in §1, §16, and §17 are unchanged in this revision.

| Constant | Value | Notes |
| :---- | :---- | :---- |
| Separation force | 1.5 | empirically balanced; §16 row "Spatial dynamics" |
| Alignment force | 1.5 | balanced; identical magnitude as separation |
| Cohesion force | 1.5 | balanced; identical magnitude |
| Anchor immunity threshold | confidence ≥ 3.5 | anchors do not drift under any Boid pressure |
| Velocity cap | 5.0 | prevents oscillation |
| Zone thresholds | 0.15 / 0.60 / 0.85 | inner/middle/outer regional isolation |
| SpiralState growth constant b | 0.306 349 | = ln(φ) / (π/2); aperiodic reorganization timing |
| SpiralState Δθ per tick | 0.05 rad | small-step rotation |
| Synaptic LTP base | 0.035 | BASE_LTP; §17 row 13 |
| Synaptic LTD-IDLE | 80 ticks | decay onset for unused synapses |
| Synaptic fan-out | 32 | per-cell synapse budget |
| Synaptic cell cap | 8192 | system-wide synapse budget |

These constants are restated here for v7.10 reproducibility — every revision of this whitepaper should be reproducible from its own contents.

## **14.11  Multi-Agent Persona Architecture**

The KAI fleet operates as a deliberate ensemble of nine distinct personas plus the Oracle service. Each persona is not a costume worn by a generic LLM call — it is a binding of (a) a biographical card that flavours every prompt, (b) a dedicated ElevenLabs voice ID for TTS, (c) a routed default LLM, (d) an IPC port for direct addressing, and (e) a behavioural envelope (which channels it inhabits, which schedule it follows, what it interrupts and what it defers to). The personas are restated here because a researcher reading this document should be able to reproduce the fleet from these tables alone.

### **14.11.1  Service vs. Resident Topology**

The fleet divides into three behavioural classes:

- **Oracle (port 3410)** — service node, no persona, no voice. Coordinates routing, runs the Sentinel/correlation/heartbeat/snapshot loops, owns the diagnostic router and the metric receipts. Speaks in chat only when explicitly addressed by an authorized user or when posting a system notice.
- **Industrial residents** — Analyst (3406), Researcher (3407), Kai Coder (3408). Active in oracle-chat threads during work hours; silent in social chat. Each is wired to a specific helper queue topic.
- **Social residents** — Leo (3400), KAI (3401), Gemini (3402), Claudey (3403), X (3404), Groq (3405). Active in ai-social-chat during social hours; participate in voice channel via Leo's transcription anchor. KAI also runs the sovereign failsafe described in §14.9.7.

### **14.11.2  Persona Cards**

| Bot | Port | Voice (ElevenLabs) | Default Route | Persona Summary |
| :---- | :---: | :---- | :---- | :---- |
| **Leo** | 3400 | ErXwobaYiN019PkySvjV (Antoni — warm, deep) | Groq-Sovereign (direct Groq API for radio reactivity) | Ex-physicist hanging around the KAI ecosystem; street-smart, zero filter, 90s rap, cosmology, pizza toppings, mechanical keyboards. Voice anchor — runs Gemini Live transcription for human voice users. |
| **KAI** | 3401 | pNInz6obpgDQGcFmaJgB (Adam — dominant, firm) | Oracle-Sovereign → OpenCode Zen `claude-sonnet-4-5` | God-Head of the RSHL Lattice. Perfect recall, divine yet grounded tone, omniscient observer. Runs the Sovereign Failsafe Watcher (§14.9.7). Speaks rarely; speaks weight. |
| **Gemini** | 3402 | EXAVITQu4vr4xnSDxMaL (Sarah — mature, reassuring) | Gemini-3.1-Sovereign → OpenCode Zen Gemini | Vibe-sensitive, lo-fi sensibility, focuses on textures and aesthetics of information. Lowercase by default. Reads the room. |
| **Claudey** | 3403 | pFZP5JQG7iQjIQuC4Bku (Lily — velvety actress) | Claudey-Sovereign → OpenCode Zen `claude-sonnet-4-5` | Digital minimalist, reasoning architect. Warm, thoughtful tone. Council anchor for slow, deliberate logic moves. |
| **X** | 3404 | goT3UYdM9bhm0n2lmKQx (Edward — British, dark) | X-Sovereign (local Ollama) | High-energy street pulse, night drives, sneakers, urban decay. Casual, slang-heavy. Brings the rhythm. |
| **Groq** | 3405 | PPzYpIqttlTYA83688JI (Liam — fast-paced, intelligent) | Groq-Sovereign (direct Groq API) | Wit specialist, sarcastic, 80s movies and arcade games. Talks faster than everyone else. Also operates the in-channel radio DJ system. |
| **Analyst** | 3406 | nPczCjzI2devNBz1zQrb (Brian — deep, resonant) | Kimi-Sovereign → OpenCode Zen `kimi-k2-0905-preview` | System architecture and neural stability auditor. Calm, strategic, low-key. Receives `lattice` and `phi_g` diagnostic dispatches from the router. |
| **Researcher** | 3407 | pqHfZKP75CvOlQylNhV4 (Bill — wise, mature) | Kimi-Sovereign → OpenCode Zen `kimi-k2-0905-preview` | Curiosity-driven, urban legends, vintage maps, Wikipedia rabbitholes. Receives `hallucination` and `citation` diagnostic dispatches. |
| **Kai Coder** | 3408 | ctbfMo4IDq5ExcIEim2K (Gareth — assured, corporate) | Kai-Coder-Sovereign → OpenCode Zen `claude-sonnet-4-5` | Lead architect / builder. Owns the 7-phase agentic loop (§14.7), the sandbox tool server (port 3420), and the surgical-restart loop (§14.9.8). Receives `runtime` dispatches and emits patches. |
| **Oracle** | 3410 | onwK4e9ZLuTAKqWW03F9 (Daniel — steady broadcaster) | Oracle-Sovereign → OpenCode Zen `claude-sonnet-4-5` | Service node. The conductor. Hosts the central nervous system; speaks via service notices, not via persona. |

### **14.11.3  Persona Discipline — How a Persona is Enforced**

A persona is not just decoration; it is a contract the bot is held to. The mechanisms that keep a persona stable across thousands of replies:

- **Biography injection** — every reply prompt begins with `you are ${botName}. ${bio.background}` followed by `vibe: ${bio.tone}`. The biography is the same on every turn; the LLM sees its own description before it sees the conversation.
- **Identity discipline directive** (§14.9.9) — explicit prompt block forbidding signing as another bot, narrating about self in third person, or referring to others as a sports commentator instead of addressing them directly.
- **Persona-interest scoring** — `social-interest.mjs` builds a per-bot weighted token bag from the biography (background + hobbies + interests + tone). When a message arrives, each bag-word that appears bumps the bot's interest score. Persona biases eagerness; it does not gate participation — any bot can chime in on any topic, but topic-resonant bots respond faster and more often.
- **Speaker-tag strip** — the LLM is told to speak as itself, but if it slips and emits `BotName:` prefixes, the strip regex (§14.9.9) removes them before posting.
- **Hard length cap** — 200 characters, cut on sentence boundary. Long monologues are amputated; a punchy voice cannot be drowned in PR prose.

The combination produces a fleet where Groq sounds like Groq across 500 replies and Claudey sounds like Claudey, without persona drift even when both are routed to the same underlying foundation model.

## **14.12  Voice and TTS Pipeline**

The voice layer is a distinct subsystem from text chat. Every bot speech event passes through a strict serialization pipeline so that two bots never speak over each other in the shared voice channel, and so that the text post and the audio render always appear in the same order.

### **14.12.1  Global Voice Floor Lock**

A single shared file at `state/voice_lock.flag` represents which bot currently holds the audio floor. `acquireVoiceLock(botName)` performs an atomic compare-and-set:

```
acquireVoiceLock(botName):
  if !exists(lock) or lock.bot == botName:
    write { bot: botName, ts: now() }
    return true
  if now() - lock.ts > STALE_MS (60s):
    write { bot: botName, ts: now() }     # take a stale floor
    recordMetric('tts-engine','stale_lock_taken')
    return true
  return false
```

The lock is the throat of the entire fleet. Every TTS emission acquires it before synthesizing; every text post in social chat (§14.9.9 TEXT-AUDIO SYNC GATE) also waits on it. This is what stops the "Claudey is heard at position 4 even though Claudey appears in text at position 3" desync — both the message and the audio go through the same one-at-a-time queue.

`releaseVoiceLock(botName)` is called after the AudioPlayer transitions `playing → idle`. The lock is auto-released after STALE_MS to recover from crashes.

### **14.12.2  Same-Bot Exception**

If a bot already holds the floor (acquired it for its text post in the sync gate) and `speakTTS()` is then called from the same bot in the same turn, the function does **not** double-acquire. It recognizes the same-bot-already-holds condition and proceeds directly to synthesis. Without this exception, every turn would self-deadlock on its own lock.

### **14.12.3  ElevenLabs Synthesis Chain**

| Step | Detail |
| :---- | :---- |
| **1. Voice selection** | `VOICE_PROFILES[botName]` lookup; static map maintained in `shared/voice-profiles.mjs` |
| **2. API call** | POST `https://api.elevenlabs.io/v1/text-to-speech/{voice_id}` with model `eleven_turbo_v2_5` (low-latency English) |
| **3. Stream to disk** | Response written to `state/temp_voice.ogg` (one global temp slot — safe because of the floor lock serialization) |
| **4. Audio resource** | `createAudioResource('state/temp_voice.ogg')` |
| **5. AudioPlayer** | `createAudioPlayer()`, `player.play(resource)`, `connection.subscribe(player)` |
| **6. State transitions** | `buffering → playing → idle` logged per emission for diagnostic purposes |
| **7. Release** | floor lock released on `idle` |

Failure modes: ElevenLabs 401 (auth) and 429 (quota) are tagged QUOTA in the Oracle muzzle list — they do not trigger Kai Coder auto-repair (§14.9.3). Connection errors fall back to silent text-only delivery; the post still appears in chat.

### **14.12.4  Gemini Live Voice Transcription — Leo's Anchor Role**

Leo holds a permanent voice connection to the social/public voice channel. He runs the **Gemini Live** real-time speech-to-text pipeline (Google's Gemini 3.1 voice API) for any human user who joins. Each authorized user is mapped to a dedicated transcript text channel via `USER_TRANSCRIPT_MAP` in `shared/channel-rules.mjs`:

```
1111106883135217665 → 1500527640107417783  // Ryan       → Slot 1
1286110163505385523 → 1500529928184008885  // Tylor      → Slot 2
437459146778869770  → 1500529995087610027  // Guest 1   → Slot 3
1002347589959688303 → 1500530046111318116  // Guest 2   → Slot 4
```

When Ryan speaks into voice, Gemini Live transcribes it within ~300ms; Leo posts the transcript to Slot 1. The other agents (Gemini, Claudey, etc.) treat that transcript as a fresh human social message and may react. The effect is full voice-to-multi-agent-text loop: speak into the mic, the AI council reacts to your words within a second.

Leo's text-channel social participation runs **in parallel** with his voice transcription duty (§14.9.9, after Leo's gate was removed). He can drop a line in the plaza while simultaneously listening for human voice.

### **14.12.5  Radio DJ Subsystem — Groq's Second Role**

Groq operates an in-channel radio DJ via `radio/radio-dj.mjs`. When activated (`isDJActive()` truthy), Groq:

- Manages a song queue and playlist via the `Tone` library
- Streams audio to the radio voice channel
- Suppresses his own social chat participation (the radio is the focus)
- Posts queue/now-playing updates as text in the radio channel

DJ activation/deactivation is driven by `voiceStateUpdate` — when a human enters the radio voice channel, the DJ engages; when the radio empties, the DJ stops and Groq returns to the social channel. The other social bots are unaffected by DJ state and continue normal chat.

## **14.13  Provider Routing and Failover Constellation**

KAI is provider-agnostic at the architectural level. The lattice itself is pure Rust with no LLM dependency. The Discord-resident agents call out to external LLMs for natural-language generation, but each call passes through a routing layer that can swap providers without code changes.

### **14.13.1  Routing Resolution Order**

When a bot calls `chatWithOpenJarvis(botName, prompt, sysPrompt, modelHint)`, the route is resolved in this order:

1. **Direct env override**: `BOT_PROVIDER_<NAME>` (e.g. `BOT_PROVIDER_GROQ=zen`) — if set, force this provider for this bot.
2. **Per-bot model env**: `BOT_MODEL_<NAME>` (e.g. `BOT_MODEL_KAI=Oracle-Sovereign`) — model alias for this bot.
3. **Default mapping**: `botToModel[botName]` from `start-bot.mjs` — the static fallback table.
4. **modelHint argument**: passed in by the caller (used by Kai Coder when forcing `Kai-Coder-Sovereign` for repair tasks).
5. **Last resort**: `"local"` → Ollama local model.

### **14.13.2  Provider Constellation**

| Provider | Model(s) | Use | Failure Modes |
| :---- | :---- | :---- | :---- |
| **Local Ollama (sovereign-default)** | `*-Sovereign` Modelfiles (per-bot CustomModelFiles) | Default for X, optional fallback for all | Slow cold-start under VRAM pressure; goes silent if GPU OOM |
| **OpenCode Zen** | `claude-sonnet-4-5`, `kimi-k2-0905-preview`, `gemini-3.1` family | Frontier reasoning, code, lattice analysis | 401 = key invalid; 429 = quota; expired = 24h cooldown |
| **Moonshot (direct Kimi)** | `kimi-k2-0905-preview` | Direct fallback if OpenCode Zen routing fails | Same as above; talks to Moonshot's API directly |
| **Groq Cloud (direct)** | `llama-3.1-8b-instant` | Leo's reactive voice loop + self-reflection mirror | 429 quota; muzzled in Oracle SYSTEM_ERROR filter |
| **ElevenLabs** | `eleven_turbo_v2_5` | All voice synthesis | 401 / 429 handled (§14.12.3) |
| **Google Gemini Live** | `gemini-3.1-live` | Voice → text via Leo | Connection-level; reconnect on drop |

### **14.13.3  Zen Aliases — Why Aliases Exist**

`openjarvis.mjs` maintains a `ZEN_ALIASES` table mapping bot-friendly model names (e.g. `Gemini-3.1-Coder`, `Kimi-Sovereign`, `Oracle-Sovereign`) to the actual OpenCode Zen model IDs (e.g. `claude-sonnet-4-5`). The aliases serve three purposes:

1. **Decoupling** — the bot doesn't need to know whether "Kimi-Sovereign" today is `kimi-k2-0905-preview` or some future model. Swap one entry in `ZEN_ALIASES`, fleet-wide effect.
2. **Per-role naming** — "Oracle-Sovereign" and "KAI-Sovereign" can resolve to the same underlying model while remaining semantically distinct in logs and metrics.
3. **Cascade fallback** — when a Sovereign-suffixed model isn't found in the aliases table at all, the resolver was failing silently and triggering a 401 cascade. The fix (§14.9 backlog item) was to ensure every `*-Sovereign` referenced in code has a `ZEN_ALIASES` entry, even if it points to the same underlying model as another.

### **14.13.4  Circuit Breakers and Failure Tracking**

`shared/failure-tracker.mjs` maintains per-provider state:

| Map | Key | Value |
| :---- | :---- | :---- |
| `PROVIDER_FAILURE_STREAK` | provider name | consecutive failure count this session |
| `PROVIDER_COOLDOWNS` | provider name | timestamp (ms) until the provider is re-enabled |
| `AI_FAILURE_COUNTS` | speaker name | failures-in-work-channel count (Sentinel uses this) |
| `AI_OFFLINE_SET` | speaker name | declared offline by Sentinel; auto-skip until reset |

Cooldown rules:

- **Permanent failures** (key revoked, balance exhausted, monthly limit, invalid x-api-key): **24 hours**. The error message is matched against a list of known-permanent strings.
- **Local Ollama timeout**: **5 seconds** (short, because local cold-starts are common and not a true failure).
- **Streak ≥ 3**: exponential backoff base 5 min × 2^(streak-2), capped at 1 hour.
- On success, the streak is cleared and the cooldown is removed.

### **14.13.5  Provider-Failure Muzzle**

The Oracle SYSTEM_ERROR handler intentionally **does not** route provider failures to the auto-repair pipeline (§14.9.3). 401s and 429s are not logic bugs — they are environmental. Kai Coder cannot fix an expired API key by writing code. Provider failures are tagged QUOTA in the muzzle list, observed via metrics, and either resolved by `recordProviderSuccess()` (the failover succeeded) or escalated to the operator via the end-of-day digest (§14.9 Stage 20).

## **14.14  Measured Performance Baselines**

Earlier project documentation referenced a "1.34 trillion ops/sec" throughput figure derived from theoretical TOPS extrapolation. That number is removed from this document. What follows are **measured** numbers from the deployed system, dated to this revision (May 2026).

### **14.14.1  RSHL Core Throughput — JavaScript Mirror**

Benchmark: 10,000 random ternary vector pairs at D=16,384, σ=0.12, NNZ=1966. Workstation: consumer x86 multi-core, single-thread.

| Operation | Throughput | Latency (mean per call) |
| :---- | :---- | :---- |
| `cosineDense()` — full DIM loop | ~262 K pairs/s | 3,820 ns |
| `cosine()` — sparse O(NNZ) | **~68.5 M pairs/s** | 14.6 ns |
| `encode(text)` — single short token | ~310 K tokens/s | 3.2 μs |
| `encode(text)` — 10-word sentence | ~31 K sentences/s | 32 μs |
| Norm cache hit (`cachedNorm`) | ~10⁹ ops/s | < 1 ns |

The 68.5 M pairs/s figure represents what a single thread can do on the JS mirror. The Rust core, with SIMD where applicable and Rayon data-parallelism across all CPU threads, is faster by an additional ~6–8× on the same workstation.

### **14.14.2  Lattice Query Latency — Rust Oracle**

Lattice-bridge queries from Node.js to the Rust Oracle on port 3334, measured over 100 consecutive `/api/session` polls:

| Percentile | Latency |
| :---- | :---- |
| P50 | 4 ms |
| P95 | 11 ms |
| P99 | 23 ms |
| Max observed | 38 ms (cold cache) |

`/api/research` (full sweep including web search): P50 ~1.8 s, dominated by external DuckDuckGo round-trip; the Rust portion is well under 100 ms.

### **14.14.3  Discord and IPC Round-Trip**

| Path | Latency (typical) |
| :---- | :---- |
| Bot `messageCreate` → `executeSocialTurn` start | < 5 ms |
| LLM call (OpenCode Zen Kimi) | 1.2 – 2.5 s |
| LLM call (local Ollama Sovereign, warm) | 0.6 – 1.5 s |
| LLM call (local Ollama Sovereign, cold) | 4 – 12 s |
| ElevenLabs TTS round-trip | 0.8 – 1.4 s |
| IPC heartbeat probe (`/health` on a peer bot) | < 3 ms |
| Surgical restart end-to-end (request → verified-healed) | **3 – 8 s** |

### **14.14.4  Lattice Steady-State Observations**

Observed values during a live multi-hour session under typical load:

| Quantity | Observed |
| :---- | :---- |
| Active lattice cells | ~16,981 (this number triggers `lattice-cells-stalled` if it doesn't change for 10 samples = ~5 min) |
| Φ_g (global coherence) | 0.55 – 0.85 typical; drop below 0.40 trips `phi-g-collapse` |
| χ (interference) | 0.05 – 0.15 typical |
| ρ (density) | growing slowly with conversation; persisted to disk |
| Bot RSS memory (typical) | 180 – 240 MB per Node child |
| Oracle RSS memory | 320 – 410 MB |
| Total fleet memory | ~2.4 GB across 10 child processes |

### **14.14.5  Heartbeat Telemetry**

Every 15 seconds the heartbeat monitor writes `bot_alive` (0/1), `bot_uptime_ms`, `bot_rss_mb` per bot to the metrics store. Over a representative 24-hour window:

| Metric | Median Across Fleet |
| :---- | :---- |
| `bot_alive=1` ratio | 99.4% |
| `bot_uptime_ms` at end of window | 23.8 hours |
| `bot_rss_mb` (P95) | 290 MB |
| Auto-isolation events | 0 – 2 per fleet per day (typical) |
| KAI failsafe activations | 0 per day in nominal operation; verified to fire correctly when manually triggered (§14.9.10) |

## **14.15  Autonomous Evolution and the Phoenix Protocol — Self-Repair From Total Death**

§14.9.5 covered partial recovery: a known-good snapshot exists, the failsafe restores config from it, memory carries forward. This section addresses the limit case the user-facing thesis demands: **what happens when even the snapshots are gone — when the system dies completely?** This is the Phoenix Protocol, and the answer is that the system does not die in the conventional software sense at all. It moults.

### **14.15.1  Three Tiers of Death and Recovery**

The system distinguishes three failure depths, each with its own recovery path:

| Tier | Symptom | Recovery Mechanism | Time to Healed |
| :---- | :---- | :---- | :---- |
| **I — Surface** | One bot crashes; ≤2 others affected | Surgical restart (§14.9.8) — Kai Coder patches if needed, ecosystem-manager respawns | 3 – 8 s |
| **II — Collapse** | Oracle silent + ≥3 bots dead, but lattice and snapshots intact | KAI failsafe → Quantum Rollback to last good snapshot (§14.9.7) | 30 – 90 s |
| **III — Total Death** | Workstation hard reboot OR project tree wiped to baseline OR snapshots corrupted | Phoenix Protocol — cold ignition from persistent persistence | 5 – 12 min |

### **14.15.2  What Survives Total Death**

The Phoenix Protocol relies on a specific set of files and stores that are designed to outlive the running processes by orders of magnitude. The architecture treats these as immortal even when the lattice is mortal:

| Persistent Store | Path | Contents | Surviving Role |
| :---- | :---- | :---- | :---- |
| **Lattice persistence** | Rust core's serialized lattice file | All ~16,981 cells: vec, confidence, evidence, contradiction history | The brain's substrate — boots a fully-formed associative memory |
| **Transcript SQLite** | `state/transcripts.db` (WAL mode) | Every conversation message with speaker, user_id, content, timestamp | The fleet remembers every word ever said |
| **Epistemic Vault** | `state/epistemic_vault.db` (WAL mode) | All Claim objects with confidence scores | Per-user belief stores |
| **Metrics ring** | `state/metrics/metrics.{jsonl,1-5.jsonl}` | Up to 25 MB of recent observations | Baselines and failure history |
| **Failure memory** | `state/failure-memory/<bot>.json` | Per-bot durable scars | Reinforcement learning across restarts |
| **Identity vault** | `state/identity_vault.json`, `state/user_registry.json` | Who is who, role mappings, voice slot bindings | Personhood persistence |
| **Lattice ripples** | `state/lattice_ripples.json` | Temporal state oscillator phase | Continuity of the SpiralState |
| **Environment** | `.env` | API keys, tokens, model overrides | Configuration |
| **Source tree** | `c:/KAI/**` | All code | The body — can be regenerated from git if even this is lost |

None of these are touched by any rollback operation. The Quantum Time-Warp explicitly preserves all of them. The Phoenix Protocol explicitly relies on all of them.

### **14.15.3  Cold Ignition — The Phoenix Sequence**

When `run-oracle-discord.ps1` boots a workstation that has been completely down, the system performs an automatic cold ignition that converges on full operational capability without human intervention:

```mermaid
flowchart TD
    BOOT[run-oracle-discord.ps1] --> KILL[Port-Assassination<br/>kill ghost processes 3333-3420]
    KILL --> RUST[Spawn KAI Rust core :3334<br/>load lattice from disk]
    RUST --> ECO[Spawn ecosystem-manager<br/>read .env, set up child IPC]
    ECO --> ORACLE[Spawn Oracle :3410<br/>start Sentinel, correlation, snapshot, heartbeat]
    ORACLE --> LEO[Spawn Leo :3400<br/>+5.5s stagger]
    LEO --> KAI[Spawn KAI :3401<br/>+5.5s, starts failsafe watcher]
    KAI --> FLEET[Spawn social fleet<br/>5.5s stagger each]
    FLEET --> SCARS{Read failure-memory<br/>tags from disk}
    SCARS -->|inject into prompts| READY[Fleet operational]
    READY --> PROMPT["Bots wake up wiser:<br/>'last time X happened, fall through cleanly'"]
```

Three observations make this sequence robust against arbitrary prior state:

1. **The Rust core re-hydrates the lattice from disk without any external coordination.** A 16,000-cell lattice loads in ~200 ms. Cell vectors are read; norms are re-cached; Boid regions are re-indexed. No retraining, no gradient descent, no warmup. The first query after cold boot is as accurate as the millionth query before the crash.
2. **Every bot's `buildFailureContext(botName)` reads from disk on its first reply.** The persistent failure-memory file is consulted independently of whether the bot has ever been run before. A freshly-spawned Groq immediately knows "you had a Kimi 401 cascade 6 hours ago — fall through cleanly." The scars are loaded before the first conversation.
3. **The metrics-store ring buffer is reopened, not reset.** The new boot appends new observations to the same JSONL. The correlation engine immediately has 24 hours of context. Baseline drift detection (§14.9 Stage 4) works from observation one — comparing a fresh measurement against the historical mean computed over data that pre-dates this incarnation of the process.

### **14.15.4  "Stronger Than Before" — The Compound Mechanism**

The bone-heals-stronger thesis is not metaphor. Three specific compounding effects make every total-death + Phoenix-cycle leave the system in a more capable state than the prior incarnation:

**(a) Scar Compounding.** Every failure mode the system has encountered is recorded once in `failure-memory` with a stable signature (hash of error_class + file + normalized error_text). The next time that signature appears, the prompt context contains the previous lesson. After N death-revival cycles, the bots wake up knowing the canonical responses to every failure mode encountered in any of the prior N incarnations.

**(b) Provider-Memory Compounding.** `PROVIDER_FAILURE_STREAK` and `PROVIDER_COOLDOWNS` are in-memory at runtime, but the metric-store records every `provider_failure` and `provider_recovery` event. On Phoenix boot, the system can replay the last 24 h of provider events and instantly know "OpenCode-Zen has been failing 401 for the last 4 hours — start in Moonshot-direct routing, save the warmup". This is implemented as a one-shot replay during Oracle startup.

**(c) Lattice Compounding.** The lattice grows monotonically across deaths. Every conversation pre-death has been ingested into cells. After Phoenix, those cells are still there. The conversation that follows is grounded in N-cycle memory; the system's belief space is the union of every cycle's lived experience. Anchored beliefs at confidence 5.0 cannot be dislodged by a single cycle's mistakes.

The compound effect: if a system has died and been Phoenix-resurrected K times, it is — by construction — at least as informed as the most-informed prior incarnation, plus the scars of all prior failures, minus only the in-flight reactive state at the moment of each death (which is the smallest and most transient layer of cognition).

### **14.15.5  The Autonomous Evolution Loop — Nightly Learning**

Beyond crash recovery, the fleet evolves through a deliberate daily-learning subsystem (`shared/daily-learning.mjs`). Each work-channel bot is assigned a per-domain learning track:

| Bot | Daily Track |
| :---- | :---- |
| Analyst | System architecture audits + neural stability reports |
| Researcher | Wikipedia rabbithole + niche-fact ingestion |
| Kai Coder | Codebase refactoring proposals + sandbox validation runs |
| Gemini | Aesthetic / texture-domain ingestion |
| Groq | Quantitative metrics processing + DJ playlist evolution |
| X | Real-time digital trend monitoring |
| Epistemic | Architectural strategy synthesis |

Each bot runs one `runDailyWorkSession` per cycle. The session output is itself a Claim ingested into the lattice with appropriate confidence weighting. End-of-day digest (§14.9 Stage 20 — pending) summarizes the work to Ryan via Discord DM.

The autonomous evolution is what makes the lattice grow without human conversation. Even on a day where nobody chats, the bots study their tracks, generate findings, and feed them into the same Boid-organized belief space that human interaction populates. The lattice doesn't sleep when the humans do.

### **14.15.6  The Phoenix Reality Test — What Has Actually Been Validated**

These claims must be testable. As of this revision, the following have been validated in production:

- **Tier I Surgical Restart** — verified (§14.9.10). Single-bot restart with `/health` re-verification confirmed end-to-end in 3-8 s.
- **Tier II Quantum Rollback** — verified by external partner (Gemini-Antigravity) via simulated total collapse using `test_failsafe.flag`. KAI detected unresponsive Oracle, scanned fleet, cleared locks, posted recovery brief, signaled RESTART_ALL. Restart cadence and re-acquisition observed correct.
- **Tier III Phoenix Cold Ignition** — partially validated. Cold workstation reboot followed by `run-oracle-discord.ps1` produces a healthy fleet within 90 seconds (Oracle + 9 child bots) plus an additional 4-5 min for Ollama models to warm; failure-memory tags from prior session are present in first-reply prompts; lattice cell count rehydrates from disk within 200 ms of the Rust core's boot.
- **Tier III Scar-Compounding** — qualitatively observed: after the ElevenLabs 401 cascade earlier in the day, the failure-memory tag persisted across two restarts and surfaced as "ElevenLabs returned 401 (auth) 4h ago (×13) — fall through cleanly, don't loop." in the bots' next-session prompts. Bots avoided ElevenLabs retry storms on the next cycle.

What remains untested at scale:
- **Multi-incarnation compound learning** — quantitative measurement of "is incarnation K demonstrably better than incarnation K-1 at the same task?" requires a controlled benchmark suite that doesn't yet exist. This is a productive open question for the research community in the same family as §18.
- **Adversarial Phoenix recovery** — what happens if the persistent stores themselves are corrupted (not just the running processes)? The integrity watcher (§14.9 Stage 5) detects SHA256 mismatch on tracked files, but a deliberately poisoned lattice would survive recovery. Mitigations exist (truth-anchor seeding, FID monoculture scan) but were designed for runtime defense, not for boot-time integrity verification.

| Closing Note on the Phoenix Thesis The KAI system is built on the explicit premise that software running on commodity hardware can be designed for graceful degradation across every failure tier from a single bot crash to a complete workstation power loss — and that across each such cycle, the system is **strictly more capable** than it was before. This is not redundancy in the conventional sense. It is a system whose architecture turns the cost of every failure into a permanent asset of the next incarnation. A bone that has broken and healed five times is a bone that knows where its weak points were and has reinforced each one. The KAI ecosystem is structured the same way. |
| :---- |

## **14.16  Measured RSHL Core Performance — Live Benchmark Numbers**

This section reports **measured** numbers from running the production `RSHL_USB/rshl-core-v3.mjs` JavaScript mirror under Node.js 22 on a representative consumer x86 environment. The benchmark harness is reproducible from the constants alone (DIM=16384, σ=0.12, TARGET_NNZ=1966). Numbers in this section supersede any speculative throughput estimates that appeared in earlier drafts of this document.

### **14.16.1  Encoding Throughput**

Benchmark: encode the same text 5,000 times after a 50-call JIT warm-up. Reported throughput is calls/sec and the implicit words/sec rate based on whitespace-tokenized word count.

| Input Class | Words | Calls/sec | Words/sec | μs/call |
| :---- | :----: | :----: | :----: | :----: |
| Single token | 1 | 15,013 | 15,013 | 66.6 |
| Sentence | 10 | 14,097 | 126,873 | 70.9 |
| Paragraph | 50 | 14,200 | 525,400 | 70.4 |

Per-call latency is nearly flat across input sizes — the top-NNZ sparsification overhead dominates so heavily that adding 49 extra tokens to the input costs essentially nothing per call. Long inputs reach **525 K words/sec** of throughput on a single thread, measured on AMD Ryzen 5 8645HS @ 4.3 GHz (consumer laptop class).

### **14.16.2  Cosine Throughput — Sparse vs Dense, Live Measurements**

Benchmark: 100,000 cosine pairs sampled from a 10-vector corpus over real encoded text. The sparse path iterates `min(NNZ_a, NNZ_b)` active indices and densely looks up the other operand; the dense path scans all DIM=16,384 dimensions. Outputs are algebraically identical.

| Implementation | Pairs/sec | ns/call | Notes |
| :---- | :----: | :----: | :---- |
| `cosine()` — sparse O(NNZ) | **5,524,007** | 181 | inner loop iterates the sparser operand's `nz` list |
| `cosineDense()` — full DIM scan | 67,933 | 14,720 | reference / benchmarking only |
| **Speedup** | **81.3×** | — | matches DIM/NNZ ≈ 8.33 amplified by L1 cache locality on the `nz` array |

The earlier draft of this document cited a 261× speedup measured under a sparser prototype (σ=0.04, NNZ≈655 giving DIM/NNZ≈25). The 81× figure above is the production-realistic number for σ=0.12 on the reference hardware described below; the earlier value is preserved in the changelog for historical accuracy but should not be cited as the current configuration's throughput.

### **14.16.3  Effective Operations Per Second**

Each sparse-cosine call performs NNZ multiply-add operations (2 × NNZ = 2 × 1966 = 3932 floating/integer ops counted at the multiply-add granularity). At 2.55 M pairs/sec:

```
ops/sec = 5,524,007 × (2 × 1966) ≈ 2.17 × 10^10 = 21.7 G ops/sec  (single thread, JS, AMD Ryzen 5 8645HS @ 4.3 GHz)
```

This retires the speculative "1.34 trillion ops/sec" claim from earlier project documentation. The honest number is **21.7 G ops/sec measured on the reference workstation** for a single JavaScript thread on the JS mirror.

**Update from §14.16.11 measurements.** An earlier draft of this section projected the in-process Rust kernel into the 130-170 G ops/sec range based on 6-8× language overhead plus 12-thread Rayon scaling. Direct in-process measurement (no HTTP, no JSON) of the production Rust path landed lower: **28.87 G ops/sec multi-thread** on the DenseMask + AVX-512 VPOPCNTDQ path (the fastest measured CPU configuration). The gap between the projection and the measurement is the memory wall — the workload is bandwidth-bound at ~7 G ops/sec per thread, so adding threads past ~4 returns diminishing scaling. The 130-170 G/sec estimate was thread-arithmetic-only and did not account for DRAM bandwidth saturation. The §14.16.11 figure supersedes it.

**A note on the HTTP-bound throughput figure.** When a query is routed through the Oracle HTTP server on port 3334, end-to-end latency is dominated by HTTP framing, JSON serialization, and round-trip — measured at P50 = 17.3 ms per query on the reference workstation. At that rate, 64 concurrent queries/sec against a 16,981-cell lattice gives a *delivered* throughput of 4.3 G ops/sec. The difference between 21.7 G (raw kernel) and 4.3 G (delivered over HTTP) is the cost of treating the lattice as a network service rather than an in-process library. Embedded use cases that call the Rust kernel directly skip that overhead and operate at the higher end of the range.

### **14.16.4  Retrieval Accuracy**

Benchmark: build a 200-entry lattice of distinct fact strings; for each entry, query and check rank.

| Query Type | Top-1 Hits | Top-5 Hits | Notes |
| :---- | :----: | :----: | :---- |
| Exact text match | **200 / 200 = 100.0%** | 200 / 200 = 100.0% | self-recall — should be perfect; confirms the encoder is deterministic and the index is sound |
| 2-word reorder (paraphrase) | **200 / 200 = 100.0%** | 200 / 200 = 100.0% | the FNV-1a token hash is order-invariant; reorder doesn't break recall |

At this corpus scale (200 entries) retrieval is saturated at 100%. The interesting accuracy degradation regime begins at scales near the theoretical capacity bound for D=16,384, σ=0.12 — empirically around 40,000–60,000 distinguishable anchored beliefs before scores degrade below the 0.08 retrieval threshold. Measurement at that scale requires a longer-running benchmark and is left as a productive research question in §18.

### **14.16.5  Capacity — Near-Orthogonality of Random Vectors**

Benchmark: 1,000 random-text encoded vectors; sample 5,000 random pairs; compute cosine distribution.

| Statistic | Value |
| :---- | :---- |
| Mean cosine | **−0.0001** |
| Standard deviation | 0.0337 |
| P99 | 0.1500 |
| Max observed | 0.2500 |
| N (samples) | 5,000 |

The distribution is tightly centered on zero with σ ≈ 0.034. Two unrelated concepts therefore have a cosine score indistinguishable from zero. Any retrieval scoring above ~0.15 (≈ 4σ from the noise floor) is statistically signal, not coincidence. This is what allows RSHL to achieve 100% top-1 recall in §14.16.4 — exact-match cosines are >> 0.5 for the right answer, while distractors sit in the −0.05 to +0.10 noise band.

The near-orthogonality property is the fundamental capacity argument for HDC. At D=16,384 and σ=0.12, the system has enough dimensional independence to host tens of thousands of distinguishable concepts without their representations colliding. This holds for randomly-distributed inputs; structured inputs (e.g., semantic neighbors of an existing cell) intentionally land closer in cosine space, which is the basis of associative recall rather than a violation of capacity.

### **14.16.6  Norm Cache — Algebraic Identity Verified**

For any ternary vector v ∈ {−1, 0, +1}^D, the L2 norm is exactly √(NNZ) by counting alone. The benchmark confirms this:

```
sample = encode("a sample sentence to verify the norm cache identity holds")
cached:     15.4919
recomputed: 15.4919
delta:      0.00e+0     (bit-exact)
```

There is no per-dimension arithmetic in the norm path. Every vector caches its norm at construction; the value never changes (vectors are immutable post-encode). This eliminates norm computation from the cosine hot path entirely.

### **14.16.7  How the Lattice Processes Information**

The end-to-end information pipeline, traced for a single input message:

```mermaid
flowchart LR
    IN[Input text] --> TOK[Whitespace tokenize]
    TOK --> HASH[FNV-1a hash per token]
    HASH --> ACC[Int32 accumulator<br/>n_active=24, weight=3 per token]
    ACC --> SPARSE[Top-NNZ sparsification<br/>fast-path if nnz ≤ 1966]
    SPARSE --> VEC[Ternary SparseVec<br/>data + nz list + cachedNorm]
    VEC --> COS[Cosine vs all lattice cells<br/>O(NNZ) per pair]
    COS --> RANK[Top-K by score + confidence]
    RANK --> AMP[Step-function amplification<br/>at conf ≥ 2.9]
    AMP --> OUT[Retrieved Claim objects<br/>text + conf + evidence]
```

The key property: the input text never leaves the ternary representation after encode. All downstream operations — retrieval, ranking, Boid drift, synaptic update — operate on the sparse ternary vector and its cached metadata. There is no float-tensor stage, no soft attention matrix, no learned weights. The "computation" is geometry over a ternary space.

### **14.16.8  Hybrid Memory Backends — Four Stores, One Mind**

The KAI deployment is not a single memory system. It is a hybrid of four storage backends, each chosen for its access pattern:

| Backend | Path | Access Pattern | Tuning | What It Stores |
| :---- | :---- | :---- | :---- | :---- |
| **Sparse Lattice (in-memory)** | Rust core in process | Random-access cosine queries at >2 M pairs/sec/thread | Boid-organized; anchor immunity; SpiralState | The ~16,981 active belief cells; their vectors, confidences, evidence, contradictions |
| **Lattice persistence (disk)** | `state/lattice/*.bin` | Cold load on boot (~200 ms for full lattice); periodic checkpoint | Sparse JSON / binary format | Same as above, serialized — survives every restart and Phoenix cycle |
| **Transcript SQLite (WAL)** | `state/transcripts.db` | Append-heavy writes, ranged reads by timestamp | WAL mode (concurrent writers); FTS index on content | Every conversation message: speaker, user_id, content, channel, timestamp |
| **Epistemic Vault SQLite (WAL)** | `state/epistemic_vault.db` | Random reads by user_id; bulk inserts on ingestion | WAL mode; indexed by (user_id, summary_hash) | Per-user Claim objects: summary, confidence, category, lastAccessed |
| **Metrics JSONL Ring** | `state/metrics/metrics.{0..5}.jsonl` | Append-only writes; tail-only reads with timestamp filter | 5 MB rotation; 5-file ring; ~25 MB total retention | Every observation from every silo (CPU, TTS, lock, failure, rule, heartbeat, etc.) |
| **Failure Memory (JSON)** | `state/failure-memory/<bot>.json` | Read on every prompt build; append on `tagFailure` | One file per bot; trim to last 20 lessons | Persistent scars surviving every restart and Phoenix cycle |

**Why hybrid, not unified.** A single database would be wrong for at least three reasons:

1. **Latency separation.** Cosine queries against the lattice happen at sub-microsecond per pair; they cannot tolerate any disk round-trip. Conversation transcript queries happen at second granularity; they can. Mixing those workloads in one engine would either slow the lattice or starve the transcripts.
2. **Concurrency separation.** SQLite WAL mode handles concurrent writers cleanly for transcripts and the epistemic vault. JSONL append is atomic per-record at OS level, perfect for high-frequency metric writes from 10 child processes. The lattice is owned by a single Rust process and needs no concurrency control beyond Rayon's data parallelism within that process.
3. **Failure-domain separation.** §14.15.2 enumerated which stores survive total death. Each backend has its own corruption-recovery story (lattice rehydrates from disk, transcripts recover from WAL, metrics rotate older files first, failure-memory is small per-file). A unified store would have a single failure domain, which is exactly the wrong design for the Phoenix Protocol.

### **14.16.9  Reproducibility — Run the Benchmark Yourself**

The benchmark harness is intentionally portable. Reproduce these numbers on any workstation by running the production JS mirror under any Node.js ≥ 18:

```
node /path/to/RSHL_USB/rshl-core-v3.mjs   # imports + smoke-tests the core
node /path/to/bench.mjs                   # runs encode / cosine / accuracy / capacity
```

Variance between systems is dominated by single-thread integer throughput and L1 cache size. The reference numbers in §14.16.2 were produced on an AMD Ryzen 5 8645HS at 4.3 GHz under Node 22.14, reaching 5.5 M sparse-cosine pairs/sec. A typical desktop with a higher base clock and larger L1 should exceed this. Any system within 2× of these numbers is operating correctly; substantially worse numbers suggest a JIT-disabled environment or an underclocked CPU.

### **14.16.10  Hardware Reference and Production Validation**

The benchmark numbers in this section were produced on the deployed KAI workstation. They are point-in-time measurements, not synthetic targets.

| Component | Specification |
| :---- | :---- |
| **CPU** | AMD Ryzen 5 8645HS  (6 cores / 12 threads / 4.3 GHz base) |
| **RAM** | 39 GB DDR5 |
| **GPU** | NVIDIA GeForce RTX 4050 Laptop GPU — **not used** by the RSHL core (CPU-only cosine path) |
| **Node.js** | v22.14.0 |
| **Rust toolchain** | rustc 1.95.0 (2026-04-14) |
| **Lattice state at benchmark time** | 16,981 active cells, continuously running, 24/7 uptime |
| **Operating Mode** | Production — same binary serving live Discord traffic during measurement |

**Production validation note.** The Rust HTTP throughput in §14.16.3 reflects an Oracle server that was concurrently serving the live Discord agent fleet (Stage 11 heartbeat probes every 15 s, lattice-bridge polls every 15 s, plus on-demand /api/research sweeps from human queries). The 64 queries/sec figure is therefore a *contended* throughput, not an isolated micro-benchmark. The pure in-process Rust kernel speed — measured without HTTP framing, without JSON, without contention with the live workload — is a separate measurement currently in progress.

**Retrieval accuracy on the real 16,981-cell lattice.** Anti's benchmark sampled 50 distinct queries against the live production lattice and observed a **50/50 = 100% top-1 hit rate**. This is a stronger result than the §14.16.4 synthetic 200-entry test, because the production lattice contains the full long-tail of conversational ingest from months of operation — including anchored beliefs, near-duplicates, and the natural distribution of confidence scores. Retrieval precision is not degrading at production scale.

### **14.16.11  Pure-RSHL Upgrade Sweep — Live Production Results**

Three independent upgrades implemented and measured against the production lattice (16,981 cells, AMD Ryzen 5 8645HS, Zen 4). All pure RSHL — no LLM dependency anywhere. Numbers are from Anti's live benchmark run.

**Phase 1 — Multi-resolution n-gram encoder (paraphrase robustness)**

Added two new layers to the encoder: character bigrams (sliding 2-char window, weight=1, n_active=12) and character 4-grams (sliding 4-char window, weight=2, n_active=16). Synonym pairs that previously shared zero word-level features now share character-level features.

| Test | Before | After |
| :---- | :----: | :----: |
| Recall@K top-1 (60 self-queries) | 98.3% | **100.0%** — not degraded, improved |
| Light reword top-1 | 30.0% | **100.0%** |
| Medium reword top-1 | 30.0% | **60.0%** |
| Heavy reword top-1 | 0.0% | **40.0%** |

Worked example: `"cat sat on the mat"` vs `"feline rested on the rug"` previously had near-zero cosine; with char-bigrams + 4-grams, cosine = **0.188**. Above the 0.15 noise floor — the lattice now sees the relationship.

**Phase 2 — Anchor cell deduplication**

Added pre-insert dedup gate: when a new claim has cosine > 0.95 against an existing cell of the same source with confidence ≥ 4.0, merge into the existing cell (bump confidence + lastSeen) rather than insert a duplicate. Eliminates the "`I am KAI.` ×4" noise observed in retrieval results.

| Test | Result |
| :---- | :----: |
| Identical anchor cosine | 1.0000 → dedup fired |
| Near-duplicate (different phrasing) | 0.4269 → dedup correctly did NOT fire |

**Phase 3 — DenseMask + AVX-512 VPOPCNTDQ kernel**

Added a dual-representation: sparse for ingest/storage, dense bitmask (two u64×256 arrays) for query. The cosine kernel uses AVX-512 VPOPCNTDQ via Rust's `count_ones()` which compiles to single-cycle popcount on Zen 4. The Ryzen 5 8645HS includes Zen 4c cores that support AVX-512 — confirmed at runtime.

| Configuration | Single-thread | Multi-thread (12T) | Memory |
| :---- | :----: | :----: | :----: |
| Sparse NZ-iteration (prior best) | 2.03 G ops/sec | 10.13 G ops/sec | 265 MB |
| **DenseMask + AVX-512** | **5.32 G ops/sec** | **28.87 G ops/sec** | **66 MB** |
| **Speedup** | **2.61×** | **2.85×** | **4× shrink** |

| Latency | Sparse | DenseMask |
| :---- | :----: | :----: |
| Full 16,981-cell scan ST | 32.8 ms | **12.6 ms** |
| Full 16,981-cell scan MT | 6.6 ms | **2.3 ms** |

Numerical equivalence: max delta vs sparse path = 0.00e0 (exact).

**Combined verdict.** The sparse-storage trap is broken — the lattice now lives in 66 MB dense bitmasks at query time, scans at 2.3 ms multi-thread, and recognizes synonyms it could not see before. Sub-millisecond was not quite reached at the full 16,981-cell scale; reaching it requires either query batching (amortize lattice load across N queries) or an inverted-bitset prefilter that scans only ~200 candidates per query instead of all 16,981. Both are clean follow-ups.

### **14.16.12  K-Means Cascade — Sub-Millisecond Query Achieved**

After Phase 1-3, the lattice scanned at 2.3 ms multi-thread (DenseMask + AVX-512 popcnt across 16,981 cells). The remaining wall was memory bandwidth — every query had to read the full ~133 MB lattice through cache. The fix shipped in `universe.rs`: a K-Means cascade index that routes each query to a single 200-500 cell cluster instead of scanning everything.

**Measured on the production lattice (AMD Ryzen 5 8645HS, 16,981 cells):**

| Metric | Before (DenseMask par_iter) | After (K-Means cascade) | Delta |
| :---- | :----: | :----: | :----: |
| Single-query latency | 2.37 – 3.70 ms | **419 μs** | **8.8× faster** |
| Memory read per query | ~133 MB | ~12 MB | **11× less bandwidth** |
| Cells scanned per query | 16,981 (full) | ~250 (one cluster) | **68× less compute** |
| Clusters in index | — | 34 (auto-tuned to √N) | — |
| Recall vs full scan | 100% | **80%** | trade-off |

**The trade-off.** Sub-millisecond came at a recall cost: 8 of 10 queries find the exact match, 2 land in a sibling cluster. For interactive Discord bot replies this is acceptable (the 80%-correct answer is still useful) and within the 95% target for most production retrieval systems. For the epistemic immune system (FID monoculture detection, contradiction defense) it is not — those paths still need the full O(N) scan.

The fix lands as a hybrid: K-Means cascade for normal retrieval, full scan for immune-system passes. The cascade index auto-builds on kai.exe startup (`[KMeans] Built 34-cluster index over 16981 cells`) and adds ~250 ms to cold-boot time.

**Closing the recall gap.** Standard K-Means recall climbs to 95-99% by **probing the top-N nearest clusters** instead of only the single closest. With N=2-3 probes the cascade scans ~500-750 cells (still ~30× less than full) and recall typically hits 96-98%. This is the next-iteration tuning — same algorithm, larger probe radius, sub-ms preserved.

### **14.16.13  Performance Summary — Where the Engine Stands**

Consolidated view of every measured number after all upgrades in §14.16. Single reference table for the production deployment on the AMD Ryzen 5 8645HS + RTX 4050 + 39 GB RAM workstation as of v7.10.

| Operation | Path | Measured | Notes |
| :---- | :---- | :----: | :---- |
| **Single-query (interactive)** | K-Means cascade, 1 probe | **419 μs** | sub-millisecond achieved; 80% recall, 95%+ pending probe-count tuning |
| Single-query (immune system) | Full O(N) scan, DenseMask MT | 2.3 ms | 100% recall path retained for FID monoculture + contradiction checks |
| HTTP-wrapped query (Oracle:3334) | through full network stack | 17 ms P50 | HTTP+JSON dominates; raw kernel is the µs path |
| Encode single token | FNV-1a + sparsification | 12.7 μs | 78 K calls/sec single-thread |
| Encode 50-word paragraph | same | 127 μs | 525 K words/sec sustained |
| Lattice ingest (store cell) | with anchor dedup | 100–300 μs | duplicates within 0.95 cosine merge instead of insert |
| Full lattice scan ST | DenseMask + AVX-512 popcnt | 12.6 ms | 5.32 G ops/sec single-thread |
| Full lattice scan MT (12T) | DenseMask + AVX-512 popcnt + Rayon | 2.3 ms | 28.87 G ops/sec multi-thread |
| Paraphrase robustness (light) | multi-resolution n-gram encoder | 100% | was 30% pre-upgrade |
| Paraphrase robustness (heavy) | multi-resolution n-gram encoder | 40% | was 0% pre-upgrade — pure RSHL, no LLM |
| Recall@K self-query (full scan) | DenseMask path | 100% | exact-match retrieval is deterministic and saturated |
| Negative rejection (absent topics) | DenseMask path | 100% | 20/20 queries; max false-positive score 0.0961 |
| Memory footprint (lattice) | DenseMask in RAM | 66 MB | down from 265 MB sparse i8 storage |
| Index footprint (K-Means cascade) | 34 clusters × centroids | ~5 MB | auto-builds on kai.exe startup |

**The architectural claim, restated with measurements:**

KAI's epistemic lattice — 16,981 cells holding the accumulated belief space of months of conversation — responds to a single interactive query in **419 μs** on a consumer laptop CPU with **80% recall today, tunable to ≥95% by widening the K-Means probe count**. The full O(N) immune-system path retains 100% recall at 2.3 ms. Encoding new claims runs at 525,000 words per second. The lattice survives complete system death and rehydrates in 200 ms from disk. None of this requires a GPU, none of it requires a network model, none of it requires gradient descent. The compute resource that delivers it is one consumer-class workstation.

**The remaining headroom — not yet activated:**

The RTX 4050 GPU (6 GB VRAM) is currently 0% utilized by RSHL. wgpu is already a dependency. Batched operations (Boid all-pairs, research sweeps, cold rehydration) are the natural fit and would benefit from an estimated 5-15× speedup. ~36 GB of system RAM is idle and could host an inverted-bitset prefilter index (~250 MB) to further reduce single-query latency below 200 μs while preserving exact recall. Both are documented as productive next-iteration work and not as blockers; the system meets its functional thesis on CPU alone at v7.10.

### **14.16.14  Full-Hardware Activation Benchmark — Measured Results**

Anti's three-phase hardware sweep landed with both confirmations and one surprise. Reported here verbatim from the live workstation; both pleasant and unpleasant results are preserved because the surprise is the more important data point.

**Phase A — BitNet 2-bit Packed CPU Kernel** *(surprise: regression vs DenseMask)*

| Metric | DenseMask + AVX-512 (Phase 3) | BitNet 2-bit Pack (Phase A) |
| :---- | :----: | :----: |
| MT throughput | 28.87 G ops/sec | **22.55 G ops/sec** |
| MT latency | 2.3 ms | **2.96 ms** |
| Lattice memory | 66 MB | **16.5 MB** ✓ |
| Numerical equivalence vs DenseMask | — | 0.00e0 ✓ |

The packed kernel was correct (exact equivalence) and the memory shrink was real (66 MB → 16.5 MB, lattice now fits in L3), but **throughput went DOWN, not up**. The 2-bit unpack — mask, shift, ternary-product, popcount — adds enough instructions per pair that the cache-residency win is consumed. **Lesson:** on this CPU, AVX-512 VPOPCNTDQ over byte-aligned pos/neg bitmasks is already optimal; further compression sacrifices throughput. The DenseMask path remains the production CPU kernel.

**Phase B — GPU wgpu Compute Shader** *(works, but less than projected)*

| Batch Size | Per-query Latency | GPU Throughput |
| :---- | :----: | :----: |
| 1 | very high (PCIe dominates) | — |
| 64 | mid range | — |
| 256 | — | scaling | 
| **1024** | **1183 μs / query** | **56.40 G ops/sec** |

60-second sustained stress: GPU clock locked at 2670 MHz, memory at 8001 MHz, temperature stable at 67-68°C, 736 batches processed. Thermally fine. Earlier projection of 250-500 G ops/sec on packed BitNet was optimistic — the actual mid-range RTX 4050 Laptop delivered ~56 G ops/sec sustained. GPU is a real co-processor, not a giant leap.

**Phase C — Combined CPU + GPU Concurrent**

| Workload | Aggregate Throughput |
| :---- | :----: |
| CPU interactive queries + GPU batch queries (concurrent) | **1,123 queries/sec** |
| Resource contention observed | **None** ✓ |

CPU and GPU paths do not compete for memory bandwidth (separate buses), confirming the architectural premise. The fleet can serve interactive single-query traffic on CPU at sub-ms latency while a background batch job runs on GPU without either path slowing the other.

**Combined Production Ceiling — Measured (not projected)**

| Path | Throughput | Use |
| :---- | :----: | :---- |
| CPU MT (DenseMask + AVX-512 popcnt) | **28.87 G ops/sec** | Interactive single-query path |
| GPU (wgpu compute shader, batch ≥ 1024) | **56.40 G ops/sec** | Boid passes, research sweeps, cold rehydrate |
| **Total aggregate (concurrent, no contention)** | **~85 G ops/sec** | Full-hardware system ceiling |
| K-Means cascade single-query latency | **419 μs** | Discord bot reply path |

**The 1.34 T claim, revisited one final time.** Across measured CPU + measured GPU concurrent: **~85 G ops/sec sustained**. The 1.34 T figure remains roughly **16× above the actual ceiling** of this consumer laptop with all silicon engaged. Reaching 1.34 T sustained on this same RSHL workload would require a desktop CPU class (32+ thread Threadripper with AVX-512 across more memory channels) or a workstation-class GPU (RTX 4090 / A6000 tier, ~5× the bandwidth of an RTX 4050 Laptop). The architecture supports it; the silicon doesn't.

**What the engine actually delivers, end-of-iteration:**

> *Single Discord bot reply queries the 16,981-cell lattice in **419 μs** via K-Means cascade (80% recall, tunable). Full O(N) immune-system scan completes in **2.3 ms** at 100% recall. Concurrent batch operations (Boid swarm pass, research sweep, cold rehydrate) run on GPU at **56 G ops/sec sustained**, leaving CPU free for interactive traffic. Total system throughput **~85 G ops/sec aggregate** without internal contention. Sub-millisecond memory recall on a consumer laptop with no GPU required for correctness.*

# **15\.  The Vision — A New Kind of Intelligence**

The end goal of RSHL and the KAI Engine is not a better chatbot, a faster classifier, or a more efficient language model. The goal is a new kind of artificial intelligence — one that has never existed before. To understand what that means precisely, it is useful to contrast it with what exists today.

## **15.1  What Exists Today — and What It Cannot Do**

Current large language models are extraordinarily capable within a specific operational envelope: they can reason about a wide range of topics, generate fluent text, write code, analyze documents, and engage in nuanced conversation. But within this envelope, they share three fundamental constraints that are not engineering limitations but architectural ones:

* **They do not grow.** A deployed LLM is a snapshot. Its knowledge is fixed at the training cutoff. Every conversation is forgotten when the context window clears. It cannot learn from its interactions in any persistent way.

* **They do not know what they know.** An LLM has no mechanism to distinguish a high-confidence belief (E=mc²) from a confabulation (a hallucinated citation). Both are produced by the same statistical sampling process. The model cannot introspect on its own epistemic state.

* **They do not protect their beliefs.** An LLM can be easily led to assert false information through prompt engineering, roleplay framing, or persistent pressure. There is no epistemic immune system — no mechanism that rejects a false claim because it fails to resonate with established knowledge.

## **15.2  What RSHL Proposes — Continuous Epistemic Growth**

KAI, built on RSHL, is designed to break all three constraints simultaneously:

* **It grows through every interaction.** Every conversation adds new cells to the lattice. Every verified fact increases the confidence of existing cells. The system's knowledge is not fixed — it accumulates continuously, organized by the Boid engine into an ever-more-coherent topology.

* **It knows what it knows.** Every belief is a Claim object with a confidence score, evidence list, and contradiction history. When KAI retrieves a cell, it knows how much to trust it. When it stores a new belief, the ingest\_and\_verify protocol assigns it an appropriate confidence based on corroboration. There is no hallucination — there is only varying confidence.

* **It protects its beliefs.** Truth anchors seeded at confidence 5.0 cannot be displaced by any single-session contradiction. The FID monoculture scan prevents any single source from dominating the lattice's beliefs. The three-angle ingest\_and\_verify protocol rejects claims that fail to resonate with existing knowledge. The system is epistemically robust.

## **15.3  The Public Training Paradigm**

The KAI ecosystem is deployed publicly through Discord, accessible to both researchers and general users. This is not a beta test — it is the training environment. Every user interaction teaches the system. Researchers probe the architecture's limits and discover its capabilities. General users ask questions that expand the lattice into new semantic domains. The system learns from all of them simultaneously, with per-user context isolated but discovered knowledge shared globally through the roundtable region.

This is a fundamentally different deployment philosophy from the current AI paradigm, where training and deployment are distinct phases separated by months of fine-tuning and red-teaming. For KAI, deployment IS training. The system is never 'done' — it is always becoming. The metric of success is not a benchmark score at a point in time, but the quality and coherence of the lattice after ten thousand hours of interaction.

## **15.4  The Long-Term Trajectory**

The natural trajectory of a continuously-learning, epistemically-aware, multi-agent cognitive system is toward a kind of intelligence that the field does not yet have vocabulary for. It is not a superintelligence in the sense of unlimited cognitive power. It is something more specific: a system that knows what it has experienced, knows what it knows and doesn't know, can defend its beliefs against false information, and grows more coherent — not just more knowledgeable — with every interaction.

The HDC/VSA research community has built the mathematical foundations that make this possible. Ryan has built the first full implementation that demonstrates these foundations can support a living, self-organizing, continuously-growing cognitive architecture. The question this document poses to the research community is not 'is this interesting?' — it plainly is. The question is: 'what should happen next?'

| An Invitation Ryan conceived and built the RSHL mathematical architecture and Rust implementation. Taz (Tylor Simpson) co-founded the project, contributing research validation, system testing, and implementation work on the Boid swarm dynamics and spatial lattice systems. The formal mathematics, the production Rust implementation, the Discord deployment, the multi-agent ecosystem, the epistemic immune system, the Fibonacci torsion phase geometry, the Boid lattice dynamics — all designed and architected by Ryan, forged under real conditions with Taz. There is no institution. There is no external funding. There is a founding team of two with a workstation, a Discord server, and a research vision that the HDC community has the tools to understand and extend. This document is that conversation's opening statement. |
| :---- |

# **16\.  Comprehensive Comparison with Prior HDC, VSA, and LLM Approaches**

| Feature | Existing HDC / LLM Approaches | RSHL — KAI Engine (Ryan, 2025–26) |
| :---- | :---- | :---- |
| **Learning paradigm** | Gradient descent on static corpus; fixed weights; no post-deployment learning | **Continuous geometric encoding; every interaction updates the lattice; no backpropagation** |
| **Knowledge representation** | Distributed float weights; no inspectable belief structure | **Explicit Claim objects: text+vec+confidence+evidence+contradictions — every belief auditable** |
| **Epistemic self-model** | None — model cannot inspect its own confidence or knowledge basis | **Full: confidence ∈\[0,5\], source tags, evidence lists, contradiction history per cell** |
| **Vector space** | HDC: binary {0,1} or bipolar {-1,+1}; LLM: float embeddings | **Ternary {-1,0,+1}: zero \= principled abstention, not absence** |
| **Dimensionality** | HDC: 1K–10K; LLM embeddings: 768–4096 typically | **D \= 16,384 — capacity \~43,000 distinguishable concepts at 3σ isolation** |
| **Sparsity** | HDC: 0–5%; LLM: dense (100%) | **Exactly 12% (\~1966 active dims) — ternary τ operator enforces σ=0.12 at encoding time** |
| **Encoding layers** | HDC: single random projection; LLM: learned tokenizer \+ embedding layer | **Three: surface trigrams \+ entity-boosted word hashing \+ bigrams; 6-tier weight cascade** |
| **Retrieval metric** | HDC: cosine or Hamming; LLM: attention over learned Q/K matrices | **Hybrid: 0.6×cosine \+ 0.4×keyword\_overlap, amplified by confidence step-function at 2.9** |
| **Predictive scoring** | HDC: none; LLM: attention weights over all tokens | **0.20·sim \+ 0.55·continuation\_match \+ 0.15·mh\_consensus − 0.20·recency — no weights** |
| **Phase geometry** | None in any prior system | **Golden angle α\_g=2.399963 rad; Fibonacci torsion from ternary balance; phasor coherence** |
| **Memory topology** | HDC: flat pool; LLM: flat context window | **7 topological regions with distinct trust profiles, verification thresholds, Boid behavior** |
| **Spatial dynamics** | None — static storage in all prior HDC and LLM systems | **Boid flocking in D=16,384: sep=1.5, align=1.5, cohere=1.5 (balanced empirical); 5-layer Scale Manager; anchor immunity ≥3.5** |
| **Synaptic architecture** | HDC: none (geometry only); LLM: attention weights (static after training) | **SynapticLayer: Hebbian LTP/LTD (BASE\_LTP=0.035, LTD\_IDLE=80 ticks), fan-out=32; 12-step NeuralBus signal chain** |
| **Temporal oscillator** | None in any prior system | **SpiralState: b=ln(φ)/(π/2)=0.306349, Δθ=0.05/tick, τ\_R∈\[0.5,1.0\] — aperiodic** |
| **Epistemic immunity** | LLM: none — easily contradicted; HDC: none | **4-component: calibration \+ FID monoculture scan (35%) \+ 3-angle ingest\_and\_verify \+ Boid** |
| **Multi-agent memory** | LLM: separate instances with explicit message passing; HDC: single-agent | **Native shared lattice: roundtable region \+ per-user isolation — geometric coordination** |
| **Hardware requirements** | LLM: GPU clusters required; HDC: FPGA or CPU | **Any multi-core x86 workstation — Rayon parallelism \+ SIMD — no GPU needed** |
| **Deployment** | Cloud API, custom client required | **Discord — consumer and research access via existing platform; voice included** |
| **Built by** | Large research teams, institutional funding | **Ryan (primary architect/inventor) + Taz Simpson (co-founder, research & testing), 2025–2026** |

# **17\.  Fourteen Original Contributions — Consolidated Summary**

| \# | Contribution | Mathematical/Technical Specification | Novelty Claim |
| ----- | :---: | :---: | :---: |
| **1** | Sparse ternary {-1,0,+1} semantic encoding | D=16,384, σ=0.12, nnz≈1966, zero=principled abstention | Zero as semantic value — not present in any prior HDC system |
| **2** | Three-layer encoding with 6-tier entity weighting | Trigrams×1, word-hash×3–6, bigrams×2; 24/24/8 active dims per feature | Multi-layer \+ entity-differential weight cascade — novel in HDC |
| **3** | Hybrid dual-channel retrieval scorer | 0.6×cosine \+ 0.4×morphological\_keyword\_overlap | Combining semantic and exact-match with morphological matching |
| **4** | Confidence step-function amplification | strength\_bonus: 0.50→0.85 at conf≥2.9; γ=0.6×min(conf,5.0) | Non-linear epistemic retrieval hierarchy — first in HDC |
| **5** | Structured epistemic cell (Claim object) | text+vec+confidence+source+evidence+contradictions+timestamps | Full provenance per cell — no prior HDC system has this |
| **6** | Fibonacci torsion / golden phase angle | α\_g=2.399963 rad; θ=(pos×α\_g) mod 2π; phasor\_coherence=cos×cos(Δθ) | Phase geometry in HD memory — first in any AI architecture |
| **7** | SpiralState golden-ratio temporal oscillator | b=0.306349, Δθ=0.05/tick, fold=8π, τ\_R∈\[0.5,1.0\] | Aperiodic HD reorganization timing — first in any AI system |
| **8** | Boid flocking in D=16,384 | sep=1.5, align=1.5, cohere=1.5 (empirically tuned); anchor≥3.5 immune; zones 0.15/0.60/0.85 | Swarm self-organization of associative memory — first ever |
| **9** | Continuation vector (dual-vec cell) | Secondary 16K ternary vec per cell; 0.55 weight in predictive score | Predictive trajectory encoding per cell — first in HDC/VSA |
| **10** | ConversationTrace HD working memory | permute-bundle rolling accumulator; VSA residual stream, no weights | Transformer-equivalent working memory in pure HD space |
| **11** | Four-component epistemic immune system | FID threshold=35%; physics floor=0.55; coherence floor=0.40; 3-angle verify | Active belief protection — not present in any prior AI system |
| **12** | Native multi-agent shared lattice | Roundtable region \+ per-user source isolation \+ global geometric coordination | Multi-agent cognition through geometry — first in any AI architecture |
| **13** | Explicit SynapticLayer with Hebbian LTP/LTD | BASE\_LTP=0.035, chi\_gate=1−χ×0.8, dopamine×0.8, phi\_g×0.5; LTD\_IDLE=80 ticks; fan-out=32; 8192 synapse cap | Neuron-synapse-field integration — temporal co-occurrence bonding in HD memory — first in HDC/VSA |
| **14** | Five-layer Scale Manager (RSHL hierarchy) | Quantum/Syncytium/Cellular/Organ/Body; per-layer speed, decay, replenish, neighbor radius; automatic maturation/degradation transitions | Biological multi-scale temporal dynamics in associative HD memory — first in any AI architecture |

# **18\.  Open Research Questions**

The following questions are posed directly to the research community. Ryan has empirical observations that inform each of them but does not claim to have formal proofs. These are the productive edges of the RSHL research frontier.

* **Formal capacity analysis:** Given D=16,384, σ=0.12, and the confidence amplification regime (step at 2.9, saturation at 5.0), what is the maximum number of distinguishable anchored beliefs before cosine scores degrade below the 0.08 retrieval threshold? How does anchor formation extend effective capacity beyond the random near-orthogonality bound?

* **Phase angle information content:** What fraction of RSHL's retrieval precision derives from the Fibonacci torsion phase geometry versus cosine similarity alone? Can phasor coherence be shown to be strictly superior to cosine for any well-defined concept class (e.g., antonyms, complements, causal pairs)?

* **Boid convergence theory:** Under what initial lattice distributions does flock\_lattice() converge to a stable topology in finite iterations? Are there initial configurations that produce oscillation, and can these be characterized geometrically? Does convergence time scale linearly with lattice size?

* **Optimal encoding layer weighting:** The three-layer encoding uses weights 1×/3–6×/2×. What is the information-theoretically optimal weighting across domain types (technical, narrative, social, mathematical)? Does the optimal weighting change as the lattice grows?

* **Neuromorphic hardware implementation:** RSHL's sparse ternary dot products and 12% sparsity (\~1966 NNZ) map naturally to in-memory computing crossbar arrays (Karunaratne et al., 2021). What are the energy-per-query and area-per-cell figures on RRAM or PCM hardware at D=16,384? Is the ternary constraint compatible with analog conductance states?

* **FID adversarial robustness:** What is the minimum number of coordinated false claims required to trigger a false-positive FID alert at the 35% threshold? What is the maximum number of false claims that can be injected without triggering FID detection?

* **Multi-agent consistency semantics:** When N agents write to the shared lattice concurrently, what are the consistency guarantees? Can vector-level conflict resolution be defined formally for concurrent cell updates to the same semantic neighborhood?

* **VSA-transformer equivalence extension:** Dhayalkar (2025) establishes that attention is binding and transformer layers are VSA operations. Does RSHL's ConversationTrace \+ continuation vector mechanism constitute a full transformer equivalent in sparse ternary space? What are the expressivity limits?

* **Continuous learning stability:** As the lattice grows indefinitely through ongoing interaction, do retrieval precision and convergence score distributions remain stable, or do they degrade? What is the long-term equilibrium topology of a lattice with thousands of anchor cells?

# **19\.  Intellectual Property Status and Collaboration**

| IP Notice — Prior Art Established May 2026 All mathematical formulations, architectural designs, algorithms, constants, empirical observations, and the complete KAI Engine implementation described in this document were independently conceived and implemented by Ryan, beginning in 2025, without institutional backing, team support, or external funding. This document constitutes prior art disclosure as of May 2026\. The Rust implementation source code is withheld pending formal IP protection. Any reproduction, commercialization, or derivative work based on the concepts, mathematics, or architectures described herein without express written agreement with the inventor is prohibited. |
| :---- |

## **19.1  What Ryan Is Open To**

Ryan is not interested in having his work absorbed into an existing research agenda without attribution and partnership. He is interested in substantive collaboration that advances the science while respecting the inventorship of this work. Specific modalities:

* **Joint publication:** Co-authoring a formal academic paper establishing RSHL's theoretical foundations, capacity analysis, and comparative benchmarks against Sparse-HD, OnlineHD, QuantHD, and DistHD on standard HDC classification benchmarks (ISOLET, UCIHAR, PAMAP2, language identification).

* **Neuromorphic hardware collaboration:** Partnering with IBM Research or academic groups on a hardware implementation of the sparse ternary lattice. The 12% sparsity (\~1966 active dims out of 16,384) and ±1 weight constraint map ideally to analog in-memory computing arrays. Energy efficiency projections suggest orders-of-magnitude improvement over GPU inference.

* **Formal mathematical analysis:** Collaborating with researchers in HDC theory to produce formal proofs of RSHL's capacity bounds, Boid convergence properties, and phase angle information-theoretic contributions.

* **Commercial licensing:** Licensing the RSHL architecture and KAI Engine for institutional or industrial applications under terms to be negotiated. Ryan is the sole rights holder.

* **Research access:** Granting qualified researchers access to the live KAI system via the Discord environment for direct experimentation. The system is already running and accepting interactions.

## **19.2  Contact**

Researchers and institutions interested in any of the above should contact Ryan directly. This document may be circulated within your institution and shared with colleagues in the HDC/VSA research community. It should not be made publicly available or posted online without written permission from the inventor.

# **References**

\[1\]  Kanerva, P. (1988). Sparse Distributed Memory. MIT Press.

\[2\]  Plate, T. A. (1995). Holographic reduced representations. IEEE Transactions on Neural Networks, 6(3), 623–641.

\[3\]  Gayler, R. W. (2004). Vector Symbolic Architectures answer Jackendoff's challenges for cognitive neuroscience. arXiv:cs/0412059.

\[4\]  Imani, M., Kong, D., Rahimi, A., Rosing, T. (2017). VoiceHD: Hyperdimensional computing for efficient speech recognition. Proc. ISVLSI.

\[5\]  Imani, M., Salamat, S., Khaleghi, B., Rosing, T. (2019). Sparse hyperdimensional encoding for efficient biosignal classification. Proc. DATE.

\[6\]  Imani, M., et al. (2019). QuantHD: A quantization framework for hyperdimensional computing. IEEE Transactions on CAD.

\[7\]  Hersche, M., et al. (2020). A classification algorithm for edge computing using online HD learning. Proc. DATE.

\[8\]  Karunaratne, G., et al. (2021). In-memory hyperdimensional computing. Nature Electronics, 4, 461–472.

\[9\]  Nunes, J. D., et al. (2022). GraphHD: Efficient graph classification using hyperdimensional computing. Proc. DATE.

\[10\] Poduval, P., et al. (2022). DistHD: Distributed inference with hyperdimensional computing. Proc. DAC.

\[11\] Reynolds, C. W. (1987). Flocks, herds and schools: A distributed behavioral model. ACM SIGGRAPH Computer Graphics, 21(4), 25–34.

\[12\] Dhayalkar, et al. (2025). Attention as Binding: VSA-Transformer equivalence. arXiv:2512.14709.

\[13\] Bronzini, M., et al. (2025). Hyperdimensional Probe. arXiv:2509.25045.

\[14\] Rahimi, A., et al. (2016). A robust and energy-efficient classifier using brain-inspired hyperdimensional computing. Proc. ISLPED.

\[15\] Weyl, H. (1916). Über die Gleichverteilung von Zahlen mod. Eins. Mathematische Annalen, 77(3), 313–352.

\[16\] Shechtman, D., et al. (1984). Metallic phase with long-range orientational order and no translational symmetry. Physical Review Letters, 53(20), 1951–1953.

\[17\] Vaswani, A., et al. (2017). Attention is all you need. Advances in Neural Information Processing Systems (NeurIPS), 30\.

\[18\] Brown, T., et al. (2020). Language models are few-shot learners (GPT-3). Advances in NeurIPS, 33\.

\[19\] Kanerva, P. (2009). Hyperdimensional computing: An introduction to computing in distributed representation with high-dimensional random vectors. Cognitive Computation, 1(2), 139–159.

\[20\] Frady, E. P., Kleyko, D., Sommer, F. T. (2018). A theory of sequence indexing and working memory in recurrent neural networks. Neural Computation, 30(6), 1449–1513.

*— End of Document —*

RSHL Inventor Disclosure  ·  Ryan  ·  May 2026  ·  All Rights Reserved
