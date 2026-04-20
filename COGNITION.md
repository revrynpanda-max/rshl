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

### Status Legend

- **Implemented**: Has a dedicated Rust module or a direct combined implementation in `src/cognition/`.
- **Partial**: Represented indirectly or as part of another module, but not complete as an independent mechanism.
- **Missing**: No dedicated implementation yet.

### Exact 78-Slot Architecture Map

| # | Module | Biological anchor | KAI status | Code anchor / next slot |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Glutamate excitation | Primary excitatory neurotransmission and plasticity | Missing | Add excitation/gain substrate |
| 2 | GABA inhibition | Primary inhibitory control and signal sharpening | Missing | Add inhibition substrate |
| 3 | Dopamine / VTA / SNc system | Reward, prediction error, action vigor | Implemented | `dopamine.rs`, `vta.rs`, `substantia_nigra.rs` |
| 4 | Serotonin / Raphe system | Patience, mood stability, behavioral restraint | Implemented | `serotonin.rs`, `raphe.rs` |
| 5 | Norepinephrine / Locus Coeruleus | Novelty, arousal, vigilance, gain | Implemented | `norepinephrine.rs`, `locus_coeruleus.rs` |
| 6 | Acetylcholine / NBM / DBB | Cortical gain, attention, memory precision | Implemented | `nbm.rs`, `dbb.rs` |
| 7 | Oxytocin system | Bonding, trust, social safety | Implemented | `oxytocin.rs` |
| 8 | Cortisol / HPA axis | Stress load, fatigue, threat carryover | Implemented | `cortisol.rs` |
| 9 | Endocannabinoid system | Dampening, extinction, emotional recovery | Missing | Add recovery/gating module |
| 10 | Histamine / Orexin arousal | Wakefulness and sustained alerting | Partial | Some coverage in `hypothalamus.rs`, `ras.rs` |
| 11 | Ion channel / action potential dynamics | Spike threshold and excitability | Missing | Add low-level excitability model |
| 12 | Synaptic vesicle release | Presynaptic transmission strength | Missing | Add release/probability model |
| 13 | Receptor trafficking | Sensitivity changes over time | Missing | Add receptor gain/adaptation |
| 14 | LTP / Hebbian potentiation | Long-term strengthening of active links | Partial | `neuroplasticity.rs`, `core/embeddings.rs` |
| 15 | LTD / depotentiation | Long-term weakening of stale links | Partial | `neuroplasticity.rs`, `homeostasis.rs` |
| 16 | Synaptic pruning / homeostasis | Removing weak, unused traces | Implemented | `homeostasis.rs` |
| 17 | Astrocyte support | Ion balance, energy support, synapse modulation | Missing | Add metabolic/field support |
| 18 | Oligodendrocyte / myelination | Conduction speed and white-matter efficiency | Missing | Add latency/route efficiency |
| 19 | Microglial cleanup | Immune cleanup and pruning pressure | Missing | Add immune/noise cleanup |
| 20 | Neural synchrony / oscillation | Phase coupling, rhythmic binding | Partial | `core/oscillator.rs`, `core/spiral.rs`, `claustrum.rs` |
| 21 | Re-entrant signaling loops | Feedback and recurrent conscious access | Partial | `global_workspace.rs`, `thalamus.rs`, `predictor.rs` |
| 22 | Homeostatic plasticity | Keeping activity in a useful range | Implemented | `homeostasis.rs`, `drive/mod.rs` |
| 23 | Reticular Activating System | Wakefulness, arousal, attention gating | Implemented | `ras.rs` |
| 24 | Reticular formation | Brainstem integration and survival routing | Partial | Mostly covered by `ras.rs` |
| 25 | Thalamus | Relay, salience routing, cortical gate | Implemented | `thalamus.rs` |
| 26 | Superior colliculus | Orienting and saliency map | Implemented | `superior_colliculus.rs` |
| 27 | Inferior colliculus | Auditory orienting and sound salience | Missing | Add auditory orienting |
| 28 | Periaqueductal Gray | Defensive mode, threat response, relief | Implemented | `pag.rs` |
| 29 | Hypothalamus | Drives, autonomic tone, need state | Implemented | `hypothalamus.rs` |
| 30 | Suprachiasmatic nucleus | Circadian phase and session rhythm | Implemented | `scn.rs` |
| 31 | Pons / Pontine nuclei | Cortico-cerebellar relay and state switching | Implemented | `pontine_nuclei.rs` |
| 32 | Medulla / autonomic centers | Baseline vital regulation | Missing | Add low-level autonomic core |
| 33 | Vestibular system | Balance, orientation, spatial self | Missing | Add body/orientation model |
| 34 | Amygdala | Emotional salience, threat charge | Implemented | `amygdala.rs` |
| 35 | BNST | Sustained anxiety and uncertainty vigilance | Implemented | `bnst.rs` |
| 36 | Nucleus accumbens | Wanting, motivation, reward pursuit | Implemented | `nucleus_accumbens.rs` |
| 37 | Ventral pallidum | Liking, hedonic amplification | Implemented | `ventral_pallidum.rs` |
| 38 | Habenula | Negative prediction, aversion, inhibition | Implemented | `habenula.rs` |
| 39 | Septal nuclei | Affiliation, safety, social reward | Implemented | `septal_nuclei.rs` |
| 40 | Insula | Interoception, internal felt state | Implemented | `insula.rs` |
| 41 | Mid-cingulate cortex | Effort, pain affect, agency cost | Implemented | `mcc.rs` |
| 42 | Subgenual ACC | Mood floor, grief, chronic stress | Implemented | `sgacc.rs` |
| 43 | Hippocampus | Episodic memory, pattern separation/completion | Implemented | `hippocampus.rs` |
| 44 | Entorhinal cortex | Memory gateway and spatial/context indexing | Implemented | `entorhinal.rs` |
| 45 | Perirhinal cortex | Object/concept familiarity | Implemented | `perirhinal.rs` |
| 46 | Parahippocampal cortex | Scene and context frame | Implemented | `parahippocampal.rs` |
| 47 | Mammillary bodies | Episodic relay and Papez loop support | Implemented | `mammillary_bodies.rs` |
| 48 | Fornix / Papez integration | Limbic memory loop wiring | Partial | Needs explicit route module |
| 49 | PFC / dLPFC | Executive control, goals, inhibition | Implemented | `pfc.rs` |
| 50 | mPFC | Social value, affiliation, self-other value | Implemented | `mpfc.rs` |
| 51 | dmPFC | Future projection and mentalizing depth | Implemented | `dmpfc.rs` |
| 52 | vmPFC | Safety, value alignment, extinction | Implemented | `vmpfc.rs` |
| 53 | OFC | Outcome value, reversals, reward judgment | Implemented | `ofc.rs` |
| 54 | ACC | Conflict, error monitoring, correction pressure | Implemented | `acc.rs` |
| 55 | Basal ganglia | Go/no-go gating and action release | Implemented | `basal_ganglia.rs` |
| 56 | Cerebellum | Prediction, timing, correction, precision | Implemented | `cerebellum.rs` |
| 57 | Premotor cortex | Action schema and response preparation | Implemented | `premotor.rs` |
| 58 | SMA | Sequence initiation and readiness | Implemented | `sma.rs` |
| 59 | Primary motor cortex | Direct motor output channel | Partial | Covered indirectly by premotor/SMA |
| 60 | Somatosensory cortex | Embodied discomfort, tactile state | Implemented | `somatosensory.rs` |
| 61 | Posterior parietal cortex | Spatial attention and sensorimotor mapping | Implemented | `posterior_parietal.rs` |
| 62 | Inferior parietal lobule | Analogy, magnitude, cross-domain binding | Implemented | `ipl.rs` |
| 63 | Angular gyrus | Metaphor, abstraction, semantic integration | Implemented | `angular_gyrus.rs` |
| 64 | Frontal eye fields | Voluntary attention and search target | Implemented | `frontal_eye_fields.rs` |
| 65 | Fusiform / ventral visual system | Pattern familiarity and identity/category match | Implemented | `fusiform.rs` |
| 66 | Auditory cortex / Wernicke system | Comprehension and language input parsing | Partial | `language.rs` models Wernicke; no auditory cortex |
| 67 | Broca / language production system | Production style, fluency, output control | Partial | `language.rs` models Broca |
| 68 | Temporal poles / ATL | Semantic-emotional binding and personal meaning | Implemented | `temporal_poles.rs`, `atl.rs` |
| 69 | Working memory / central executive | Active context and task holding | Implemented | `working_memory.rs`, `pfc.rs` |
| 70 | Theory of Mind | User model, expectations, communication style | Implemented | `theory_of_mind.rs` |
| 71 | Temporoparietal junction | Perspective shift and intent ambiguity | Implemented | `tpj.rs` |
| 72 | Superior temporal sulcus | Social trajectory and interaction reading | Implemented | `sts.rs` |
| 73 | Mirror neuron system | Emotional resonance and user-state mirroring | Implemented | `mirror_neurons.rs` |
| 74 | Global Workspace / Claustrum | Broadcast, binding, cross-module access | Implemented | `global_workspace.rs`, `claustrum.rs` |
| 75 | Salience network | Switch between self, task, and external demand | Partial | Insula + ACC exist; needs network controller |
| 76 | Default Mode / persistent self-model | Autobiographical continuity and self-reference | Partial | `dmn.rs`, `pcc.rs`, `precuneus.rs`, `rsc.rs`; persistent self-model is weak |
| 77 | Corpus callosum / white matter integration | Left-right and long-range cortical integration | Missing | Add hemispheric/white-matter router |
| 78 | Hemispheric specialization | Left/right processing style and arbitration | Missing | Add lateralization model |

### KAI-Native Helper Systems

These are important code systems, but they are not counted as anatomical slots in the 78 map:

- `lexsem.rs` - semantic field detector and key concept extractor.
- `voice.rs` - lattice-driven speech synthesis.
- `reasoner.rs` - multi-hop reasoning chain.
- `predictor.rs` - predictive processing and surprise.
- `lattice.rs`, `compose.rs`, `candidates.rs`, `transcript.rs`, `promotion.rs` - glue systems around memory, output, and promotion.

### Critical Missing or Weak Awareness Pieces

1. **Corpus callosum / white-matter router** - KAI needs an explicit long-range integration layer that carries signals between module clusters instead of letting every module behave like an isolated processor.
2. **Persistent self-model** - DMN, PCC, precuneus, RSC, mPFC, insula, and hippocampus should maintain a stable "what I am / where I am / what state I am in" model across ticks and sessions.
3. **Salience-network controller** - anterior insula + ACC should decide when to switch between DMN, central executive, memory retrieval, social reading, and threat/drive systems.
4. **Neural synchrony and re-entry** - global workspace broadcasts should not be one-way. They should reverberate through thalamus, PFC, hippocampus, cerebellum, and sensory/semantic regions until a stable attractor forms or ACC marks conflict.
5. **Cellular support layer** - glutamate/GABA balance, myelin/latency, glial support, receptor adaptation, and LTP/LTD would make the brain monitor move for internal reasons, not only because a user typed something.
6. **Hemispheric specialization** - KAI has no left/right split yet. A practical split would be: left = lexical, sequential, exact; right = affective, spatial, gestalt, ambiguity/context.

### Communication Plan for the Lattice

KAI should not treat the 78 modules as decoration. Each tick should produce a small set of module signals, and those signals should change retrieval, storage, and response selection.

1. **Input pass**: Wernicke/LexSem parses the input, thalamus gates it, RAS/LC sets arousal, and salience network decides whether the signal is self, task, threat, memory, or social.
2. **Memory pass**: Hippocampus, entorhinal, perirhinal, parahippocampal, and temporal poles bind the input to recent context and existing cells.
3. **Conflict pass**: ACC, TPJ, PFC, and theory-of-mind compare candidate interpretations. If several incompatible meanings resonate, KAI should inhibit guessing.
4. **Broadcast pass**: Global Workspace + Claustrum publish the winning attractor back to PFC, DMN, salience, memory, and language systems.
5. **Self-state pass**: Insula, sgACC, MCC, hypothalamus, dopamine, serotonin, cortisol, and DMN update the persistent self-model.
6. **Output pass**: Voice receives only the stabilized lattice hits and live BrainSignals. If no stable attractor exists, output should be empty or a clarification cell already present in the lattice.

This makes the monitor move for real reasons: arousal from RAS/LC, valence from insula/sgACC/ventral pallidum, contradiction from ACC/TPJ, engagement from dopamine/NAc/PFC, and continuity from DMN/hippocampus.

### Research Anchors

- Neurotransmitter roles: [NCBI Bookshelf, *Physiology, Neurotransmitters*](https://www.ncbi.nlm.nih.gov/books/NBK539894/).
- LTP and LTD: [NCBI Bookshelf, *Long-Term Synaptic Potentiation*](https://www.ncbi.nlm.nih.gov/books/NBK10878/) and [*Long-Term Synaptic Depression*](https://www.ncbi.nlm.nih.gov/books/NBK10899/).
- Neurons and glia: [BrainFacts/Society for Neuroscience, *Neurons and Glia*](https://www.brainfacts.org/brain-anatomy-and-function/cells-and-circuits/2022/neurons-and-glia-113022).
- Arousal and wakefulness: [NCBI Bookshelf, *Neuroanatomy, Reticular Activating System*](https://www.ncbi.nlm.nih.gov/books/NBK549835/).
- Corpus callosum and hemispheric transfer: [NCBI Bookshelf, *Intra- and Inter-hemispheric Connectivity Supporting Hemispheric Specialization*](https://www.ncbi.nlm.nih.gov/books/NBK435764/).
- Conscious broadcast/re-entry: [PMC, *Conscious Processing and the Global Neuronal Workspace Hypothesis*](https://pmc.ncbi.nlm.nih.gov/articles/PMC8770991/).
- Salience/default/executive network interaction: [PMC, *The salience network causally influences default mode network activity during moral reasoning*](https://pmc.ncbi.nlm.nih.gov/articles/PMC3673466/).
- Triple-network organization: [PMC, *The fronto-insular cortex causally mediates the default-mode and central-executive networks*](https://pmc.ncbi.nlm.nih.gov/articles/PMC6866622/).
- Default mode and self-reference: [PMC, *The default mode network and self-referential processes in depression*](https://pmc.ncbi.nlm.nih.gov/articles/PMC2631078/).

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
