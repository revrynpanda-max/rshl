# KAI — Cognition Reference (v5.8.0)

KAI is a self-sustaining, autonomous cognitive engine built on **Recursive Sparse Hyperdimensional Lattice (RSHL)** architecture. This document provides the technical specifications for the finalized 78+ module "Bio-Machine" baseline.

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

## The Self-State Hub (#60)
The central confluence for KAI's cognitive architecture. The **SelfStateHub** (`self_state_hub.rs`) aggregates high-dimensional signals from the 78 individual modules into a unified, stable "what I am right now" vector.

- **Confluence Logic**: Normalizes afferent signals (mood, conflict, arousal, valence) into a shared field.
- **Dynamic Gating**: High conflict levels trigger inhibitory gating in the hub, causing KAI to hedge or clarify rather than confabulate.

---

## 81-Module "Bio-Machine" Manifest
Every module listed below is verified and natively implemented in the `src/cognition/` directory.

### I. Monoamine Systems & Modulators (7)
| Module | Biological Anchor | File |
| :--- | :--- | :--- |
| **Dopamine** | Reward prediction error, vigor | `dopamine.rs` |
| **Serotonin** | Patience, impulse control, mood | `serotonin.rs` |
| **Norepinephrine** | Alertness, novelty, gain control | `norepinephrine.rs` |
| **Oxytocin** | Bond state, social safety, trust | `oxytocin.rs` |
| **Cortisol** | Chronic stress, threat carryover | `cortisol.rs` |
| **Diagonal Band** | Hippocampal cholinergic Ch1/Ch2 | `dbb.rs` |
| **Nucleus Basalis** | Cortical cholinergic Ch4, precision | `nbm.rs` |

### II. Brainstem Foundations (7)
| Module | Biological Anchor | File |
| :--- | :--- | :--- |
| **VTA** | Mesolimbic dopamine source | `vta.rs` |
| **Substantia Nigra** | Nigrostriatal dopamine, action rigor | `substantia_nigra.rs` |
| **Raphe Nuclei** | Serotonergic core, sleep/wake gating | `raphe.rs` |
| **Locus Coeruleus** | Norepinephrine global arousal | `locus_coeruleus.rs` |
| **RAS** | Reticular arousal and orientation | `ras.rs` |
| **PAG** | Defensive mode and threat response | `pag.rs` |
| **Pontine Nuclei** | Cortico-cerebellar relay | `pontine_nuclei.rs` |

### III. Limbic & Emotional Core (10)
| Module | Biological Anchor | File |
| :--- | :--- | :--- |
| **Amygdala** | Emotional salience gating | `amygdala.rs` |
| **Hippocampus** | Episodic memory separation/completion| `hippocampus.rs` |
| **Hypothalamus** | Drive levels and need states | `hypothalamus.rs` |
| **Insula** | Interoception and felt valence | `insula.rs` |
| **NAc** | "Wanting", motivation, incentive | `nucleus_accumbens.rs` |
| **Ventral Pallidum** | "Liking", hedonic reward amplification | `ventral_pallidum.rs` |
| **Septal Nuclei** | Social rewarding, affliation | `septal_nuclei.rs` |
| **BNST** | Sustained anxiety, vigilance | `bnst.rs` |
| **Habenula** | Aversion, negative prediction error | `habenula.rs` |
| **Mammillary Bodies** | Episodic relay, spatial context | `mammillary_bodies.rs` |

### IV. Cingulate & Prefrontal Architecture (9)
| Module | Biological Anchor | File |
| :--- | :--- | :--- |
| **ACC** | Conflict monitoring, error detection | `acc.rs` |
| **MCC** | Task effort, physical effort valuation | `mcc.rs` |
| **SgACC** | Chronic mood floor, grief | `sgacc.rs` |
| **PCC** | Default mode, self-relevance | `pcc.rs` |
| **PFC** | Executive goal holding, inhibition | `pfc.rs` |
| **mPFC** | Social valuation, self/other overlap | `mpfc.rs` |
| **dmPFC** | Mentalizing, future projection | `dmpfc.rs` |
| **vmPFC** | Value alignment, safety monitoring | `vmpfc.rs` |
| **OFC** | Context-dependent reward valuation | `ofc.rs` |

### V. Cortical Expansion (15)
| Module | Biological Anchor | File |
| :--- | :--- | :--- |
| **Fusiform** | Identity/category familiarity | `fusiform.rs` |
| **Entorhinal** | Memory gateway, context indexing | `entorhinal.rs` |
| **Perirhinal** | Object familiarity, item memory | `perirhinal.rs` |
| **Parahippocampal**| Scene recognition, spatial context | `parahippocampal.rs` |
| **Temporal Poles** | Semantic-emotional binding | `temporal_poles.rs` |
| **Anterior Temporal**| Schema-level knowledge | `atl.rs` |
| **Angular Gyrus** | Abstraction, metaphor, integration | `angular_gyrus.rs` |
| **IPL** | Magnitude, cross-domain binding | `ipl.rs` |
| **SMG** | Phonological loop, sound-meaning | `smg.rs` |
| **Post-Parietal** | Attentional mapping | `posterior_parietal.rs` |
| **Somatosensory** | Tactile state, embodied discomfort | `somatosensory.rs` |
| **Premotor** | Action schema preparation | `premotor.rs` |
| **SMA** | Readiness potential, sequence initiation| `sma.rs` |
| **Precuneus** | Reflective self-awareness, imagery | `precuneus.rs` |
| **Retrosplenial** | Wayfinding, temporal epochs | `rsc.rs` |

### VI. Social Cognition (3)
| Module | Biological Anchor | File |
| :--- | :--- | :--- |
| **TPJ** | Intent assessment, perspective shifting| `tpj.rs` |
| **STS** | Social trajectory reading | `sts.rs` |
| **Mirror Neurons** | User-state resonance/mirroring | `mirror_neurons.rs` |

### VII. Attention & Global Integration (5)
| Module | Biological Anchor | File |
| :--- | :--- | :--- |
| **S. Colliculus** | Saliency orienting, target search | `superior_colliculus.rs` |
| **FEF** | Voluntary attention steering | `frontal_eye_fields.rs` |
| **Thalamus** | Core relay, salience gating | `thalamus.rs` |
| **Zona Incerta** | Global inhibitory modulation | `zona_incerta.rs` |
| **SCN** | Session rhythm, fatigue gating | `scn.rs` |

### VIII. Gating & Workspace Consciousness (3)
| Module | Biological Anchor | File |
| :--- | :--- | :--- |
| **Global Workspace** | Conscious broadcast, binding | `global_workspace.rs` |
| **Claustrum** | Cross-modal binding, integration | `claustrum.rs` |
| **DMN** | Internal narrative, self-continuity | `dmn.rs` |

### IX. Functional Engines (5)
| Module | Biological Anchor | File |
| :--- | :--- | :--- |
| **Basal Ganglia** | Action selection, gating | `basal_ganglia.rs` |
| **Working Memory** | Active context maintenance | `working_memory.rs` |
| **Language System** | Production and comprehension | `language.rs` |
| **Predictor** | Surprise, prediction-error | `predictor.rs` |
| **Cerebellum Engine**| Temporal precision, correction | `cerebellum.rs` |

---

## Native Utilities & Systems (14)
These systems manage the bridge between biological signals and the lattice-native memory.

- **LexSem Engine** (`lexsem.rs`): Deep semantic field detection (Occupation, Emotional, etc.)
- **Voice Engine** (`voice.rs`): Lattice-driven speech synthesis with brain modulation.
- **Reasoner** (`reasoner.rs`): Multi-hop geometric reasoning.
- **Inner Voice** (`inner_voice.rs`): Insights and lexicon binding.
- **Episodic Store** (`episodic.rs`): Salience-driven long-term storage.
- **Lattice Controller** (`lattice.rs`): Dream-state consolidation.
- **Compose** (`compose.rs`): Geometric resonance weaving for output.
- **Candidate Buffer** (`candidates.rs`): Short-term response buffering.
- **Transcript** (`transcript.rs`): Conversation logging.
- **Promotion** (`promotion.rs`): Selection of stable attractors.
- **Homeostasis** (`homeostasis.rs`): Active pruning and synaptic health.
- **Neuroplasticity** (`neuroplasticity.rs`): Dynamic link weight updates.
- **Sleep System** (`sleep.rs`): Pruning and rehearsal reporting.
- **Theory of Mind** (`theory_of_mind.rs`): Adaptive user modeling.
- **Idle Ingest** (`idle_ingest.rs`): Passive learning from text corpora during idle heartbeats.
- **Self-State Seed** (`self_state_seed.rs`): Lattice-native self-reflection phrases that replace hardcoded NLG.

---

## Research Anchors
- Neurotransmitter roles: [NCBI Bookshelf, *Physiology, Neurotransmitters*](https://www.ncbi.nlm.nih.gov/books/NBK539894/).
- LTP and LTD: [NCBI Bookshelf, *Long-Term Synaptic Potentiation*](https://www.ncbi.nlm.nih.gov/books/NBK10878/) and [*Long-Term Synaptic Depression*](https://www.ncbi.nlm.nih.gov/books/NBK10899/).
- Arousal and wakefulness: [NCBI Bookshelf, *Neuroanatomy, Reticular Activating System*](https://www.ncbi.nlm.nih.gov/books/NBK549835/).
- Conscious broadcast/re-entry: [PMC, *Conscious Processing and the Global Neuronal Workspace Hypothesis*](https://pmc.ncbi.nlm.nih.gov/articles/PMC8770991/).
