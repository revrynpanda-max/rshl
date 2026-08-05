pub mod algebra;
pub mod audio_model;
pub mod bone_heal;
pub mod candle_voice;
pub mod word_calculus;  // Ryan's "word calculus": carry-weight operators + hierarchical consolidation (flag-gated, off by default)
pub mod rshl_feedback;  // RSHL feedback binding: bind(wrong ⊕ correct) for instant retrain-free correction recall (flag-gated, off by default)

pub mod semantic_dict;
pub mod math_engine;
pub mod ternary_math;

pub use candle_voice::CandleVoice;
pub mod acc;
pub mod amygdala;
pub mod angular_gyrus;
pub mod basal_ganglia;
pub mod bnst;
pub mod candidates;
pub mod cerebellum;
pub mod claustrum;
pub mod coherence;
pub mod compose;
pub mod corpus_trainer;
pub mod cortisol;
pub mod dmn;
pub mod dopamine;
pub mod entorhinal;
pub mod episodic;
pub mod fusiform;
pub mod generative;
pub mod agent_core;      // v9.10.557 — RSHL-native agentic loop (KAI-AGENT-CORE-GOAL.md)
pub mod global_workspace;
pub mod habenula;
pub mod hippocampus;
pub mod hlv_training;
pub mod homeostasis;
pub mod idle_ingest;
pub mod ingest_filter;
pub mod mind_trace;
pub mod inner_voice;
pub mod insula;
pub mod ipl;
pub mod language;
pub mod lattice;
pub mod lattice_attention;
pub mod lexsem;
pub mod locus_coeruleus;
pub mod mcc;
pub mod mirror_neurons;
pub mod mpfc;
pub mod nbm;
pub mod neural_mapper;
pub mod neuroplasticity;
pub mod norepinephrine;
pub mod nucleus_accumbens;
pub mod ofc;
pub mod ollama_voice;
pub mod oxytocin;
pub mod bitnet_inference;
pub mod bitnet_llama;
pub mod bitnet_brain;
pub mod pag;
pub mod pcc;
pub mod persona;
pub mod native_nlg;
pub mod training_bridge;
pub mod sequence_chain;
pub mod pfc;
pub mod precuneus;
pub mod predictor;
pub mod world_model;  // VSA-native state→action→next-state world model (flag-gated KAI_WORLDMODEL, off by default)
pub mod promotion;
pub mod raphe;
pub mod ras;
pub mod scn;
pub mod self_state_hub;
pub mod septal_nuclei;
pub mod serotonin;
pub mod sgacc;
pub mod sleep;
pub mod sma;
pub mod somatosensory;
pub mod sts;
pub mod substantia_nigra;
pub mod superior_colliculus;
pub mod thalamus;
pub mod theory_of_mind;
pub mod figurative;
pub use figurative::{interpret as interpret_figurative, FigurativeClass, InterpretResult, should_store as figurative_should_store};

pub mod tpj;
pub mod training;
pub mod transcript;
pub mod ventral_pallidum;
pub mod vmpfc;
pub mod voice;
pub mod polychora;  // 600-cell 4D geometry: projects 16384-dim vectors to 120
                     // structural vertices for query routing + coherence scoring.
pub mod self_reflection;
pub mod vta;
pub mod working_memory;
pub mod experience;
pub mod engram;
pub mod language_warehouse;

pub use experience::{ExperienceRecord, store_experience, build_experiential_vector};
pub use engram::{Engram, EngramSystem, store_sparse_experience, retrieve_linked_memories, pattern_completion, ENGRAM_SPARSITY, TEMPORAL_LINK_WINDOW_SECS};
pub use language_warehouse::{
    LanguageWarehouse, SparseTernaryVec, init_language_warehouse, query_language_warehouse,
    suggest_words, warehouse_status, has_word, has_native_transformer, has_dense_expert,
    has_kai_native, global_native_decode, hybrid_brain_status, native_decode_count,
    dense_decode_count, kai_native_decode_count,
};

pub use acc::AccMonitor;
pub use amygdala::{score_emotional_charge, AmygdalaGate};
pub use angular_gyrus::{AGOutput, AngularGyrus};
pub use basal_ganglia::{ActionDecision, BasalGanglia};
pub use bnst::{BNSTInput, BNSTOutput, BNST};
pub use candidates::CandidateBuffer;
pub use cerebellum::{CerebellumEngine, PrecisionReport};
pub use claustrum::{BoundStream, Claustrum, ClaustrumOutput};
pub use cortisol::{CortisolEvent, CortisolState, CortisolSystem};
pub use dmn::DefaultModeNetwork;
pub use dopamine::DopamineCircuit;
pub use entorhinal::{ECOutput, EntorhinalCortex};
pub use episodic::{compute_salience, EpisodicEvent, EpisodicStore};
pub use fusiform::{FusiformGyrus, FusiformOutput};
pub use generative::build_generative_state;
pub use global_workspace::{GlobalWorkspace, WorkspaceEntry};
pub use habenula::{Habenula, HabenulaOutput, HabenulaSignal};
pub use hippocampus::{CompletionResult, Hippocampus, SeparationResult};
pub use homeostasis::{run_homeostasis, HomeostasisConfig};
pub use idle_ingest::{IdleIngest, IngestBatch, IngestReport, IngestedCell};
pub use inner_voice::{explore_lexicon_binding, validate_insight, InsightVerdict};
pub use insula::{FeltCondition, InsulaMonitor};
pub use ipl::{AnalogyMapping, CrossDomainLink, IPLOutput, InferiorParietalLobule};
pub use language::{
    BrocaAnalysis, LanguageSystem, ProductionStyle, SentenceType, WernickeAnalysis,
};
pub use lattice::{
    consolidate, consolidate_pair, gate_stats, observe_dream, reinforce_dream_sources,
    store_synthesis, DreamSynthesis, GateStats,
};
pub use lexsem::{LexSemEngine, LexSemOutput, ResponseRegister, SemanticField};
pub use locus_coeruleus::{LCMode, LCOutput, LocusCoeruleus};
pub use mcc::{MCCOutput, MidCingulateCortex};
pub use mirror_neurons::{EmotionalTone, IntentSignal, MirrorNeuronSystem};
pub use mpfc::{MPFCOutput, SocialOutcome, MPFC};
pub use nbm::{NBMOutput, NucleusBasalis};
pub use neural_mapper::{blend_mapper_with_state, NeuralVsaMapper};
pub use neuroplasticity::NeuroplasticityEngine;
pub use norepinephrine::{NeEvent, NorepinephrineSystem};
pub use nucleus_accumbens::{NucleusAccumbens, WantingSignal};
pub use ofc::{OFCJudgment, OrbitofrontalCortex};
pub use ollama_voice::{OllamaVoice, SrhtState};
pub use oxytocin::{BondState, OxytocinEvent, OxytocinSystem};
pub use pag::{DefensiveMode, PAGEvent, PAGOutput, PeriaqueductalGray};
pub use pcc::{NarrativeThread, SelfRelevance, PCC};
pub use pfc::{Goal, PfcVerdict, PrefrontalCortex};
pub use precuneus::{Precuneus, PrecuneusOutput, ReflectionLevel};
pub use predictor::PredictiveEngine;
pub use world_model::{predict_next as world_predict_next, observe_transition as world_observe_transition, link_continuation as world_link_continuation, blend_continuation as world_blend_continuation, WorldModelConfig};
pub use promotion::{run_promotion, PromotionThresholds};
pub use raphe::{RapheEvent, RapheMode, RapheNuclei, RapheOutput};
pub use ras::{RASEvent, RASOutput, ReticuloActivatingSystem};
pub use scn::{SCNOutput, SuprachiasmaticNucleus};
pub use self_state_hub::{
    classify_question, HubFrame, QuestionKind, SelfStateHub, TrajectoryShape,
};
pub use septal_nuclei::{SeptalEvent, SeptalNuclei, SeptalOutput};
pub use serotonin::{SerotoninEvent, SerotoninSystem};
pub use sgacc::{SgACCOutput, SubgenualACC};
pub use sleep::{SleepReport, SleepSystem};
pub use sma::{SMAOutput, SequenceStage, SMA};
pub use somatosensory::{S1Output, SomatosensoryCortex};
pub use sts::{STSReading, SocialGoal, SocialTrajectory, STS};
pub use substantia_nigra::{SNcEvent, SNcOutput, SubstantiaNigra};
pub use superior_colliculus::{SCOutput, SaliencyItem, SuperiorColliculus};
pub use thalamus::{RoutedSignal, SignalType, ThalamicRelay, ThalamicSignal};
pub use theory_of_mind::{CommunicationStyle, Familiarity, TheoryOfMind};
pub use tpj::{IntentAssessment, TPJOutput, TPJ};
pub use ventral_pallidum::{VPOutput, VentralPallidum};
pub use vmpfc::{VentromedialPFC, VmPFCEvent, VmPFCOutput};
pub use vta::VTA;
pub use working_memory::WorkingMemory;
pub use corpus_trainer::{ingest_corpus_dir, corpus_stats, run_ingest_corpus_cli, run_train_response_mlp_cli, CorpusReport, ResponseMlp};
pub use voice::{detect_query_type, generate_response, generate_response_predictive, generate_inner_thought, MoodState, BrainSignals, QueryType};
pub use lattice_attention::{generate_attentive_response, multi_hop_attend, softmax, format_hop_chain};
pub use persona::{PersonaMatrix, MbtiDichotomy};
pub mod pathfinder;
pub use pathfinder::find_semantic_path;
pub use native_nlg::{NativeGenerator, IntentSkeleton, TernaryWord};
pub use sequence_chain::{SequenceChain, TernaryDictionary, HDC_DIM};
pub use bone_heal::{bone_heal_pass, anti_hebbian_fire, hebbian_fire, BoneHealReport};
