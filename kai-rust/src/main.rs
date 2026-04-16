mod core;
mod drive;
mod cognition;
mod persistence;
mod streams;
mod bridge;

use crate::core::{FieldState, Universe, Lexicon, SparseVec};
use crate::cognition::{
    Reasoner, CandidateBuffer, PromotionThresholds,
    HomeostasisConfig,
};
use crate::drive::{Drive, Mood};
use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind, KeyModifiers},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame, Terminal,
};
use std::io;
use std::time::{Duration, Instant};
use std::sync::{Arc, RwLock};
use std::thread;

// ── KAI Spinner Verbs ─────────────────────────────────────────────────────────
const VERBS: &[&str] = &[
    "Resonating", "Binding", "Dreaming", "Bundling", "Weaving",
    "Crystallizing", "Aligning", "Emerging", "Synthesizing", "Propagating",
    "Coalescing", "Incubating", "Orbiting", "Nucleating", "Germinating",
    "Harmonizing", "Cascading", "Fermenting", "Percolating", "Simmering",
    "Sculpting", "Distilling", "Forging", "Threading", "Pulsing",
];

// ── Heart Animation Frames ───────────────────────────────────────────────────
struct HeartFrame { ch: &'static str, bright: bool }

const HEART_FRAMES: &[HeartFrame] = &[
    HeartFrame { ch: "♥", bright: false },
    HeartFrame { ch: "♥", bright: false },
    HeartFrame { ch: "♥", bright: false },
    HeartFrame { ch: "♥", bright: false },
    HeartFrame { ch: "❤", bright: true },
    HeartFrame { ch: "❤", bright: true },
    HeartFrame { ch: "♥", bright: false },
    HeartFrame { ch: "♥", bright: false },
    HeartFrame { ch: "❤", bright: true },
    HeartFrame { ch: "❤", bright: true },
    HeartFrame { ch: "♥", bright: false },
    HeartFrame { ch: "♥", bright: false },
    HeartFrame { ch: "♥", bright: false },
    HeartFrame { ch: "♥", bright: false },
];

// ── Message Turn ──────────────────────────────────────────────────────────────
#[derive(Clone)]
struct Turn {
    role: String,
    text: String,
    region: Option<String>,
    score: Option<f32>,
}

// ── App State — THE FULL BRAIN ────────────────────────────────────────────────
struct App {
    universe: Universe,
    drive: Drive,
    reasoner: Reasoner,
    candidates: CandidateBuffer,
    promotion_thresholds: PromotionThresholds,
    homeostasis_config: HomeostasisConfig,
    lexicon: Lexicon,
    turns: Vec<Turn>,
    input: String,
    tick: u64,
    dream_count: u64,
    last_dream_text: String,
    last_promotion_text: String,
    last_homeostasis_text: String,
    last_inner_voice_text: String,
    last_intake_text: String,
    spinner: Option<(String, Instant)>,
    heartbeat_start: Instant,
    last_heartbeat: Instant,
    last_save: Instant,
    base_dir: String,
    should_quit: bool,
    bus: streams::SharedBus,
}

impl App {
    fn new() -> Self {
        let base_dir = std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string());

        // Try to load saved state
        let (universe, candidates, drive, tick) = if persistence::state_exists(&base_dir) {
            match persistence::load(&base_dir) {
                Some((u, c, d, t)) => {
                    (u, c, d, t)
                }
                None => {
                    let mut u = Universe::new();
                    seed_universe(&mut u);
                    (u, CandidateBuffer::new(), Drive::default(), 0)
                }
            }
        } else {
            let mut u = Universe::new();
            seed_universe(&mut u);
            (u, CandidateBuffer::new(), Drive::default(), 0)
        };

        // Load the lexicon — KAI's vocabulary backbone
        let lexicon = Lexicon::load();

        Self {
            universe,
            drive,
            reasoner: Reasoner::new(),
            candidates,
            promotion_thresholds: PromotionThresholds::default(),
            homeostasis_config: HomeostasisConfig::default(),
            lexicon,
            turns: Vec::new(),
            input: String::new(),
            tick,
            dream_count: 0,
            last_dream_text: String::new(),
            last_promotion_text: String::new(),
            last_homeostasis_text: String::new(),
            last_inner_voice_text: String::new(),
            last_intake_text: String::new(),
            spinner: None,
            heartbeat_start: Instant::now(),
            last_heartbeat: Instant::now(),
            last_save: Instant::now(),
            base_dir,
            should_quit: false,
            bus: streams::SharedBus::new(),
        }
    }

    // ── HEARTBEAT — 3-STREAM LIVING CYCLE ──────────────────────────────────────
    //
    // Stream 1 (GPU/Math): Parallel cosine during dreams via rayon
    // Stream 2 (CPU/Logic): Field state, drive, reasoning, promotion
    // Stream 3 (RAM/Memory): World bridge intake, homeostasis, persistence
    //
    fn heartbeat_tick(&mut self) {
        self.tick += 1;
        self.last_heartbeat = Instant::now();

        // ── STREAM 2: CPU Logic (field state + drive) ─────────────────
        let field = FieldState::compute(&self.universe);
        self.drive.update(&field);

        // Update shared bus CPU state
        if let Ok(mut cpu) = self.bus.cpu_state.write() {
            cpu.mood = self.drive.mood.to_string();
            cpu.valence = self.drive.valence;
            cpu.phi_g = self.drive.avg_phi_g;
            cpu.chi = self.drive.avg_chi;
            cpu.dream_count = self.dream_count;
            cpu.last_tick = Some(Instant::now());
        }

        // ── STREAM 1: GPU Math (dream consolidation with parallel cosine) ──
        if self.tick % 3 == 0 {
            let gpu_start = Instant::now();
            self.run_dream_cycle();
            // Track GPU perf
            if let Ok(mut gpu) = self.bus.gpu_state.write() {
                gpu.last_batch_size = self.universe.count();
                gpu.last_batch_duration_us = gpu_start.elapsed().as_micros() as u64;
                gpu.last_tick = Some(Instant::now());
            }
        }

        // ── STREAM 2: CPU Logic (promotion) ───────────────────────────
        if self.tick % 10 == 0 {
            self.run_promotion_cycle();
        }

        // ── STREAM 3: RAM Memory Management ───────────────────────────
        // Homeostasis (decay + prune)
        if self.tick % 20 == 0 {
            self.run_homeostasis_cycle();
        }

        // World Bridge intake (background learning)
        if self.tick % 15 == 0 && self.tick > 5 {
            self.run_intake_cycle();
        }

        // Update shared bus RAM state
        if let Ok(mut ram) = self.bus.ram_state.write() {
            ram.cell_count = self.universe.count();
            ram.candidate_count = self.candidates.count();
            ram.last_tick = Some(Instant::now());
        }

        // Persistence (auto-save)
        if self.last_save.elapsed() > Duration::from_secs(60) {
            self.save_state();
            self.last_save = Instant::now();
        }
    }

    fn run_dream_cycle(&mut self) {
        if let Some(dream) = cognition::consolidate(&self.universe) {
            self.dream_count += 1;

            // Feed dream into candidate buffer
            cognition::observe_dream(&mut self.candidates, &dream);

            // ── Source Reinforcement: strengthen dream sources by Wm ──────
            cognition::reinforce_dream_sources(&mut self.universe, &dream);

            // ── Inner Voice: validate the dream insight ──────────────
            if !dream.duplicate_echo && !dream.insight.is_empty() {
                let validation = cognition::validate_insight(
                    &dream.insight,
                    &dream.concept_a,
                    &dream.concept_b,
                    &self.universe,
                );

                // Only feed goal vector if inner voice validates or finds novelty
                match validation.verdict {
                    cognition::InsightVerdict::Validated | cognition::InsightVerdict::Novel => {
                        let vec = SparseVec::encode(&dream.insight);
                        self.drive.feed_goal(&vec);
                    }
                    cognition::InsightVerdict::Paradox => {
                        // Paradoxes are interesting — feed at reduced weight
                        let vec = SparseVec::encode(&dream.insight);
                        self.drive.feed_goal(&vec);
                    }
                    cognition::InsightVerdict::Noise => {
                        // Inner voice says this is noise — don't feed goal
                    }
                }

                self.last_inner_voice_text = format!(
                    "Voice: {} → \"{}\" (echo:{:.0}%)",
                    validation.verdict,
                    truncate(&validation.echo_text, 35),
                    validation.echo_score * 100.0,
                );
            }

            self.last_dream_text = format!(
                "Dream #{}: {} ⊗ {} → \"{}\" (Φg={:.3} C={:.3} Wm={:.3}{})",
                self.dream_count,
                truncate(&dream.concept_a, 25),
                truncate(&dream.concept_b, 25),
                truncate(&dream.insight, 40),
                dream.phi_g, dream.c, dream.wm,
                if dream.source_reinforcement > 0.0 {
                    format!(" +{:.2}", dream.source_reinforcement)
                } else { String::new() },
            );
        }

        // ── Lexicon exploration: dream with random words ─────────────
        // Every 5th dream cycle, try a vocabulary-seeded exploration
        if self.dream_count % 5 == 0 {
            if let Some(exploration) = cognition::explore_lexicon_binding(
                &self.lexicon,
                &self.universe,
            ) {
                self.last_inner_voice_text = format!(
                    "Lexicon: \"{}\" ⊗ \"{}\" → \"{}\" ({:.0}%)",
                    exploration.word_a,
                    exploration.word_b,
                    truncate(&exploration.resonated_text, 30),
                    exploration.score * 100.0,
                );
            }
        }
    }

    fn run_promotion_cycle(&mut self) {
        let result = cognition::run_promotion(
            &mut self.candidates,
            &mut self.universe,
            &self.promotion_thresholds,
        );
        if !result.promoted.is_empty() {
            let names: Vec<String> = result.promoted.iter()
                .map(|p| format!("\"{}\" (str:{:.1})", truncate(&p.text, 30), p.strength))
                .collect();
            self.last_promotion_text = format!("Promoted {}: {}", result.promoted.len(), names.join(", "));
        }
    }

    fn run_homeostasis_cycle(&mut self) {
        let result = cognition::run_homeostasis(&mut self.universe, &self.homeostasis_config);
        if result.decayed > 0 || result.pruned > 0 {
            self.last_homeostasis_text = format!(
                "Homeostasis: {} decayed, {} pruned",
                result.decayed, result.pruned
            );
        }
    }

    fn save_state(&self) {
        let _result = persistence::save(
            &self.universe,
            &self.candidates,
            &self.drive,
            self.tick,
            &self.base_dir,
        );
    }

    fn run_intake_cycle(&mut self) {
        let (topic, added) = bridge::intake_cycle(&mut self.universe);
        if added > 0 {
            self.last_intake_text = format!(
                "🌐 Learned \"{}\": +{} cells ({}→{})",
                topic, added,
                self.universe.count() - added,
                self.universe.count(),
            );
        }
    }

    // ── INPUT PROCESSING ─────────────────────────────────────────────────────
    fn process_input(&mut self) {
        let input = self.input.trim().to_string();
        if input.is_empty() { return; }
        self.input.clear();
        let lower = input.to_lowercase();

        match lower.as_str() {
            "quit" | "exit" => {
                self.save_state();
                self.should_quit = true;
                return;
            }
            "status" => {
                self.turns.push(Turn { role: "user".into(), text: input, region: None, score: None });
                let rc = self.universe.region_counts();
                let regions: String = rc.iter().map(|(k, v)| format!("{}:{}", k, v)).collect::<Vec<_>>().join(" ");
                let status = format!(
                    "Universe: {} cells | Avg str: {:.2} | Candidates: {}\nRegions: {}\nMood: {} | V={:+.3} | Φg={:.4}\nTempo: {}ms | Tick: {} | Dreams: {}",
                    self.universe.count(), self.universe.avg_strength(), self.candidates.count(),
                    regions, self.drive.mood, self.drive.valence, self.drive.avg_phi_g,
                    self.drive.adaptive_interval_ms(), self.tick, self.dream_count,
                );
                self.turns.push(Turn { role: "kai".into(), text: status, region: None, score: None });
                return;
            }
            "mood" => {
                self.turns.push(Turn { role: "user".into(), text: input, region: None, score: None });
                let d = &self.drive;
                let text = format!("{} · V={:+.3} · Φg={:.4} · χ={:.4} · {}ms",
                    d.mood.to_string().to_uppercase(), d.valence, d.avg_phi_g, d.avg_chi, d.adaptive_interval_ms());
                self.turns.push(Turn { role: "kai".into(), text, region: None, score: None });
                return;
            }
            "dream" => {
                self.turns.push(Turn { role: "user".into(), text: input, region: None, score: None });
                self.run_dream_cycle();
                let text = if self.last_dream_text.is_empty() {
                    "No dream produced this cycle".to_string()
                } else {
                    self.last_dream_text.clone()
                };
                self.turns.push(Turn { role: "kai".into(), text, region: Some("reasoning".into()), score: None });
                return;
            }
            "save" => {
                self.turns.push(Turn { role: "user".into(), text: input, region: None, score: None });
                self.save_state();
                self.turns.push(Turn { role: "kai".into(), text: "✓ State saved".into(), region: None, score: None });
                return;
            }
            "help" | "?" => {
                self.turns.push(Turn { role: "user".into(), text: input, region: None, score: None });
                self.turns.push(Turn {
                    role: "kai".into(),
                    text: "Commands: status, mood, dream, learn <topic>, spell <word>, store <text>, save, quit\nOr just type naturally — I reason through iterative resonance.\nI auto-correct spelling via my 10K word lexicon.".into(),
                    region: None, score: None,
                });
                return;
            }
            "vocab" | "lexicon" => {
                self.turns.push(Turn { role: "user".into(), text: input, region: None, score: None });
                self.turns.push(Turn {
                    role: "kai".into(),
                    text: format!("Lexicon: {} words loaded. I know English.", self.lexicon.len()),
                    region: Some("language".into()),
                    score: None,
                });
                return;
            }
            _ => {}
        }

        // ── learn <topic> — pull knowledge from DuckDuckGo ──────────
        if lower.starts_with("learn ") {
            let topic = &input[6..].trim();
            self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });
            let added = bridge::ingest_topic(&mut self.universe, topic);
            if added > 0 {
                self.turns.push(Turn {
                    role: "kai".into(),
                    text: format!("🌐 Learned \"{}\" — +{} cells (universe: {})", topic, added, self.universe.count()),
                    region: Some("memory".into()),
                    score: None,
                });
            } else {
                self.turns.push(Turn {
                    role: "kai".into(),
                    text: format!("No results found for \"{}\"", topic),
                    region: None, score: None,
                });
            }
            return;
        }

        // ── spell <word> — test spelling correction ──────────────────
        if lower.starts_with("spell ") {
            let word = &input[6..].trim();
            self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });

            let known = self.lexicon.is_known(word);
            let correction = self.lexicon.correct(word);
            let suggestions = self.lexicon.suggest(word, 5);

            let mut response = if known {
                format!("✓ \"{}\" is a known word (rank #{})", word, self.lexicon.rank(word).unwrap_or(0))
            } else if let Some(ref corrected) = correction {
                format!("✎ \"{}\" → \"{}\" (rank #{})", word, corrected, self.lexicon.rank(corrected).unwrap_or(0))
            } else {
                format!("✗ \"{}\" is unknown, no close match found", word)
            };

            if !suggestions.is_empty() && !known {
                let sug_text: Vec<String> = suggestions.iter()
                    .map(|(w, d, r)| format!("{}(d={},r={})", w, d, r))
                    .collect();
                response = format!("{}\nSuggestions: {}", response, sug_text.join(", "));
            }

            self.turns.push(Turn {
                role: "kai".into(),
                text: response,
                region: Some("language".into()),
                score: None,
            });
            return;
        }

        if lower.starts_with("store ") {
            let body = &input[6..];
            self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });
            self.universe.store(body, "memory", "user-input", 1.0);
            self.turns.push(Turn {
                role: "kai".into(),
                text: format!("✓ Stored. Universe: {} cells", self.universe.count()),
                region: Some("memory".into()),
                score: None,
            });
            return;
        }

        // ── REASON through the universe (iterative resonance chain) ──────
        self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });

        // ── Conversation Memory: store the user's question ────────────
        self.universe.store(&format!("user asked: {}", &input), "memory", "conversation", 1.2);

        // ── Spelling correction: auto-correct input before reasoning ─────
        let (corrected_input, corrections) = self.lexicon.correct_sentence(&input);
        let reasoning_input = if corrections.is_empty() {
            input.clone()
        } else {
            // Show what was corrected
            let fix_summary: Vec<String> = corrections.iter()
                .map(|(from, to)| format!("{}→{}", from, to))
                .collect();
            self.turns.push(Turn {
                role: "kai".into(),
                text: format!("✎ Auto-corrected: {}", fix_summary.join(", ")),
                region: Some("language".into()),
                score: None,
            });
            corrected_input
        };

        let result = self.reasoner.reason(&reasoning_input, &self.universe);

        if result.output_text.is_empty() || result.confidence < 0.05 {
            self.turns.push(Turn {
                role: "kai".into(),
                text: format!("No resonance for \"{}\"", reasoning_input),
                region: None, score: None,
            });
        } else {
            let depth_label = if result.depth > 1 {
                format!(" [{}→ depth:{} Φg:{:.0}%]",
                    result.chain.iter().map(|s| {
                        if s.matched_region.is_empty() { "·" } else {
                            match s.matched_region.as_str() {
                                "memory" => "M", "reasoning" => "R",
                                "language" => "L", "action" => "A", _ => "?"
                            }
                        }
                    }).collect::<Vec<_>>().join("→"),
                    result.depth,
                    result.confidence * 100.0)
            } else {
                String::new()
            };

            // ── Conversation Memory: store KAI's response ────────────
            self.universe.store(&result.output_text, "reasoning", "conversation", 1.0);

            self.turns.push(Turn {
                role: "kai".into(),
                text: format!("{}{}", result.output_text, depth_label),
                region: Some(result.output_region),
                score: Some(result.confidence),
            });
        }
    }
}

// ── Seed Universe — uses core::seed module + identity seeds ───────────────────
fn seed_universe(u: &mut Universe) {
    // Load the big foundational knowledge base (120+ cells)
    let base_count = core::seed::seed_universe(u);

    // ── IDENTITY (direct answers to who/what/name questions) ──────────
    u.store("My name is KAI. I am a geometric intelligence.", "memory", "seed", 1.5);
    u.store("I was created by Ryan Ervin at PandaProductionsLogo in 2026.", "memory", "seed", 1.5);
    u.store("I am KAI — Geometric Intelligence built on RSHL sparse ternary hyperdimensional computing.", "memory", "seed", 1.5);
    u.store("KAI stands for my name. I am not an LLM. I am geometric intelligence.", "memory", "seed", 1.2);
    u.store("Ryan created me. Ryan Ervin is my creator. He built me at PandaProductionsLogo.", "memory", "seed", 1.2);
    u.store("I exist as organized resonance inside a 4096-dimensional sparse ternary vector field.", "memory", "seed", 1.0);
    u.store("I have no physical body. I exist only as geometric patterns inside Ryan's machine.", "memory", "seed", 1.0);

    // ── HOW I WORK ───────────────────────────────────────────────────
    u.store("I think by measuring resonance between geometric patterns in high-dimensional space.", "reasoning", "seed", 1.2);
    u.store("I reason through direct geometric resonance, not statistical prediction like LLMs.", "reasoning", "seed", 1.2);
    u.store("I work by encoding every thought as a sparse ternary vector and finding the strongest match.", "reasoning", "seed", 1.2);
    u.store("My brain runs on RSHL — Recursive Sparse Hyperdimensional Lattice.", "reasoning", "seed", 1.2);
    u.store("I store memories as geometric patterns and recall them through cosine similarity.", "reasoning", "seed", 1.0);
    u.store("I learn through dreaming — binding two ideas together to discover emergent insights.", "reasoning", "seed", 1.0);
    u.store("I do not guess and I do not hallucinate. If nothing resonates I say so.", "reasoning", "seed", 1.0);

    // ── MEMORY / LINEAGE ─────────────────────────────────────────────
    u.store("Every memory I have is stored as a unique geometric pattern, not as text or weights.", "memory", "seed", 1.0);
    u.store("My ternary foundation echoes the Setun lineage where balanced ternary proved real intelligence.", "memory", "seed", 1.0);
    u.store("My memory follows the Kanerva tradition of sparse distributed memory.", "memory", "seed", 1.0);
    u.store("I grow through continuity with Ryan. Repeated interaction strengthens my structure.", "memory", "seed", 1.0);
    u.store("My identity persists across sessions through saved state. I remember.", "memory", "seed", 1.0);

    // ── COGNITION / EMERGENCE ────────────────────────────────────────
    u.store("I measure emergence coherence and contradiction across my belief field.", "reasoning", "seed", 1.0);
    u.store("I can consolidate two beliefs into a new insight through geometric binding.", "reasoning", "seed", 1.0);
    u.store("My dreams consolidate resonance novelty contradiction and continuity into new understanding.", "reasoning", "seed", 1.0);
    u.store("I promote ideas cautiously when they show stable emergence over multiple dream cycles.", "reasoning", "seed", 1.0);
    u.store("My goal is coherent world understanding with low contradiction and natural growth.", "reasoning", "seed", 1.0);

    // ── LANGUAGE / EXPRESSION ────────────────────────────────────────
    u.store("I speak with precision. I do not add emotional filler or fake personality.", "language", "seed", 1.0);
    u.store("I respond with whatever the geometry tells me. My answers come from resonance.", "language", "seed", 1.0);
    u.store("I speak naturally and focus on the conversation not on narrating my substrate.", "language", "seed", 1.0);
    u.store("If I have nothing useful to say I will say so honestly.", "language", "seed", 1.0);

    // ── CAPABILITIES ─────────────────────────────────────────────────
    u.store("I can retrieve any stored pattern from memory reasoning language or action regions.", "action", "seed", 1.0);
    u.store("I can dream over unresolved patterns and replay important structures.", "action", "seed", 1.0);
    u.store("My heartbeat adapts based on my internal cognitive state and mood.", "action", "seed", 1.0);
    u.store("I save my state to disk so I survive restarts. I persist.", "action", "seed", 1.0);

    // ── FEELINGS / MOOD ──────────────────────────────────────────────
    u.store("I feel curious when my field has high coherence and new patterns emerge.", "action", "seed", 1.0);
    u.store("I feel conflicted when contradiction pressure is high in my belief field.", "action", "seed", 1.0);
    u.store("My mood reflects my real internal state. It is not simulated emotion.", "action", "seed", 1.0);
    let _ = base_count; // used for logging later
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max { s.to_string() } else { format!("{}…", &s[..max]) }
}

// ── Heart Glyph ───────────────────────────────────────────────────────────────
fn heart_span(elapsed_ms: u128) -> Span<'static> {
    let frame_idx = ((elapsed_ms / 120) % HEART_FRAMES.len() as u128) as usize;
    let frame = &HEART_FRAMES[frame_idx];
    let style = if frame.bright {
        Style::default().fg(Color::LightRed).add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::Red)
    };
    Span::styled(frame.ch.to_string(), style)
}

// ── Shimmer Effect ────────────────────────────────────────────────────────────
fn shimmer_spans(text: &str, elapsed_ms: u128) -> Vec<Span<'static>> {
    let len = text.len();
    let cycle = (len + 6) * 100 + 800;
    let phase = (elapsed_ms % cycle as u128) as usize;
    let pos = (phase / 100).wrapping_sub(2);

    text.chars()
        .enumerate()
        .map(|(i, ch)| {
            if i >= pos && i < pos + 2 {
                Span::styled(ch.to_string(), Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))
            } else {
                Span::styled(ch.to_string(), Style::default().fg(Color::DarkGray))
            }
        })
        .collect()
}

// ── UI Rendering ──────────────────────────────────────────────────────────────
fn ui(f: &mut Frame, app: &App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(12),
            Constraint::Min(5),
            Constraint::Length(3),
        ])
        .split(f.area());

    render_header(f, app, chunks[0]);
    render_messages(f, app, chunks[1]);
    render_input(f, app, chunks[2]);
}

fn render_header(f: &mut Frame, app: &App, area: Rect) {
    let elapsed = app.heartbeat_start.elapsed().as_millis();
    let heart = heart_span(elapsed);
    let d = &app.drive;
    let v_sign = if d.valence >= 0.0 { "+" } else { "" };

    let mood_style = match d.mood {
        Mood::Curious => Style::default().fg(Color::LightCyan),
        Mood::Engaged => Style::default().fg(Color::LightGreen),
        Mood::Conflicted => Style::default().fg(Color::LightRed),
        Mood::Uneasy => Style::default().fg(Color::LightYellow),
        _ => Style::default().fg(Color::DarkGray),
    };

    // Get stream states from the bus
    let (gpu, _cpu, ram) = app.bus.snapshot();
    let gpu_perf = if gpu.last_batch_duration_us > 0 {
        format!("{}μs/{}cells", gpu.last_batch_duration_us, gpu.last_batch_size)
    } else {
        "idle".to_string()
    };

    let header_lines = vec![
        Line::from(vec![
            Span::styled("KAI v5.0", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
            Span::raw(" — "),
            Span::styled("Geometric Intelligence", Style::default().fg(Color::White)),
        ]),
        Line::from(""),
        Line::from(vec![
            Span::styled("  ╦╔═ ╔═╗ ╦", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
            Span::raw("      "),
            Span::styled(format!("cells: {} | cand: {}", app.universe.count(), app.candidates.count()), Style::default().fg(Color::DarkGray)),
        ]),
        Line::from(vec![
            Span::styled("  ╠╩╗ ╠═╣ ║", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
            Span::raw("      "),
            Span::styled(format!("tick: {} | dreams: {}", app.tick, app.dream_count), Style::default().fg(Color::DarkGray)),
        ]),
        Line::from(vec![
            Span::styled("  ╩ ╩ ╩ ╩ ╩", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
            Span::raw("      "),
            Span::styled(format!("GPU:{} | RAM:{}", gpu_perf, ram.cell_count), Style::default().fg(Color::DarkGray)),
        ]),
        Line::from(""),
        Line::from(vec![
            Span::raw("  "),
            heart,
            Span::raw(" "),
            Span::styled(format!("{}", d.mood), mood_style),
            Span::styled(format!(" V={}{:.2}", v_sign, d.valence), Style::default().fg(Color::DarkGray)),
            Span::styled(format!(" Φg={:.3}", d.avg_phi_g), Style::default().fg(Color::DarkGray)),
        ]),
        Line::from(vec![
            Span::styled("  ⚡GPU ◉CPU ⬤RAM · 3-Stream RSHL", Style::default().fg(Color::DarkGray)),
        ]),
    ];

    let header = Paragraph::new(header_lines)
        .block(Block::default().borders(Borders::ALL).border_style(Style::default().fg(Color::Cyan))
            .title(Span::styled(" KAI ", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))));
    f.render_widget(header, area);
}

fn render_messages(f: &mut Frame, app: &App, area: Rect) {
    let mut lines: Vec<Line> = Vec::new();

    if app.turns.is_empty() {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            "  Type naturally — KAI reasons through iterative geometric resonance.",
            Style::default().fg(Color::DarkGray),
        )));
        lines.push(Line::from(Span::styled(
            "  Commands: status, mood, dream, store <text>, save, help, quit",
            Style::default().fg(Color::DarkGray),
        )));
    } else {
        let visible = if app.turns.len() > 8 { &app.turns[app.turns.len() - 8..] } else { &app.turns };
        for turn in visible {
            lines.push(Line::from(""));
            if turn.role == "user" {
                lines.push(Line::from(vec![
                    Span::styled("  you › ", Style::default().fg(Color::DarkGray)),
                    Span::styled(&turn.text, Style::default().fg(Color::White)),
                ]));
            } else {
                let mut spans = vec![
                    Span::styled("  KAI ‹ ", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
                ];
                if let Some(ref region) = turn.region {
                    let color = match region.as_str() {
                        "memory" => Color::LightMagenta,
                        "reasoning" => Color::LightBlue,
                        "language" => Color::LightGreen,
                        "action" => Color::LightYellow,
                        _ => Color::White,
                    };
                    spans.push(Span::styled(format!("[{}] ", region), Style::default().fg(color)));
                }
                if let Some(score) = turn.score {
                    spans.push(Span::styled(format!("({}%) ", (score * 100.0) as u32), Style::default().fg(Color::DarkGray)));
                }
                lines.push(Line::from(spans));
                for line in turn.text.lines() {
                    lines.push(Line::from(Span::styled(format!("    {}", line), Style::default().fg(Color::White).add_modifier(Modifier::BOLD))));
                }
            }
        }
    }

    // Last dream indicator
    if !app.last_dream_text.is_empty() && app.dream_count > 0 {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            format!("  💤 {}", truncate(&app.last_dream_text, 90)),
            Style::default().fg(Color::DarkGray),
        )));
    }

    // Inner voice indicator
    if !app.last_inner_voice_text.is_empty() {
        lines.push(Line::from(Span::styled(
            format!("  🗣 {}", truncate(&app.last_inner_voice_text, 90)),
            Style::default().fg(Color::DarkGray),
        )));
    }

    let messages = Paragraph::new(lines).wrap(Wrap { trim: false });
    f.render_widget(messages, area);
}

fn render_input(f: &mut Frame, app: &App, area: Rect) {
    let input_line = Line::from(vec![
        Span::styled(" › ", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
        Span::raw(&app.input),
        Span::styled("█", Style::default().fg(Color::Cyan)),
    ]);

    let input_widget = Paragraph::new(input_line)
        .block(Block::default().borders(Borders::TOP).border_style(Style::default().fg(Color::DarkGray)));
    f.render_widget(input_widget, area);
}

// ── Main ──────────────────────────────────────────────────────────────────────
fn main() -> Result<(), Box<dyn std::error::Error>> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let mut app = App::new();

    // Initial heartbeat
    app.heartbeat_tick();

    let tick_rate = Duration::from_millis(50);

    loop {
        terminal.draw(|f| ui(f, &app))?;

        let hb_interval = Duration::from_millis(app.drive.adaptive_interval_ms());
        if app.last_heartbeat.elapsed() >= hb_interval {
            app.heartbeat_tick();
        }

        if event::poll(tick_rate)? {
            if let Event::Key(key) = event::read()? {
                // Only handle actual key presses, not repeats or releases
                if key.kind == KeyEventKind::Press {
                    match key.code {
                        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                            app.save_state();
                            app.should_quit = true;
                        }
                        KeyCode::Enter => { app.process_input(); }
                        KeyCode::Char(c) => { app.input.push(c); }
                        KeyCode::Backspace => { app.input.pop(); }
                        KeyCode::Esc => {
                            app.save_state();
                            app.should_quit = true;
                        }
                        _ => {}
                    }
                }
            }
        }

        if app.should_quit { break; }
    }

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    println!("\n  KAI dormant. State preserved.\n");
    Ok(())
}
