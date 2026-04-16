mod core;
mod drive;

use crate::core::{FieldState, Universe};
use crate::drive::{Drive, Mood};
use crossterm::{
    event::{self, Event, KeyCode, KeyModifiers},
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

// ── KAI Spinner Verbs ─────────────────────────────────────────────────────────
const VERBS: &[&str] = &[
    "Resonating", "Binding", "Dreaming", "Bundling", "Weaving",
    "Crystallizing", "Aligning", "Emerging", "Synthesizing", "Propagating",
    "Coalescing", "Incubating", "Orbiting", "Nucleating", "Germinating",
    "Harmonizing", "Cascading", "Fermenting", "Percolating", "Simmering",
    "Sculpting", "Distilling", "Forging", "Threading", "Pulsing",
];

// ── Heart Animation Frames ───────────────────────────────────────────────────
struct HeartFrame {
    ch: &'static str,
    bright: bool,
}

const HEART_FRAMES: &[HeartFrame] = &[
    HeartFrame { ch: "♥", bright: false },
    HeartFrame { ch: "♥", bright: false },
    HeartFrame { ch: "♥", bright: false },
    HeartFrame { ch: "♥", bright: false },
    HeartFrame { ch: "❤", bright: true },  // BEAT
    HeartFrame { ch: "❤", bright: true },
    HeartFrame { ch: "♥", bright: false },
    HeartFrame { ch: "♥", bright: false },
    HeartFrame { ch: "❤", bright: true },  // Second beat
    HeartFrame { ch: "❤", bright: true },
    HeartFrame { ch: "♥", bright: false },
    HeartFrame { ch: "♥", bright: false },
    HeartFrame { ch: "♥", bright: false },
    HeartFrame { ch: "♥", bright: false },
];

// ── Message Turn ──────────────────────────────────────────────────────────────
#[derive(Clone)]
struct Turn {
    role: String,    // "user" or "kai"
    text: String,
    region: Option<String>,
    score: Option<f32>,
}

// ── App State ─────────────────────────────────────────────────────────────────
struct App {
    universe: Universe,
    drive: Drive,
    turns: Vec<Turn>,
    input: String,
    tick: u64,
    spinner: Option<(String, Instant)>,
    heartbeat_start: Instant,
    last_heartbeat: Instant,
    should_quit: bool,
}

impl App {
    fn new() -> Self {
        let mut universe = Universe::new();
        // Seed with initial beliefs
        seed_universe(&mut universe);

        Self {
            universe,
            drive: Drive::default(),
            turns: Vec::new(),
            input: String::new(),
            tick: 0,
            spinner: None,
            heartbeat_start: Instant::now(),
            last_heartbeat: Instant::now(),
            should_quit: false,
        }
    }

    fn heartbeat_tick(&mut self) {
        let field = FieldState::compute(&self.universe);
        self.drive.update(&field);
        self.tick += 1;
        self.last_heartbeat = Instant::now();
    }

    fn process_input(&mut self) {
        let input = self.input.trim().to_string();
        if input.is_empty() {
            return;
        }
        self.input.clear();

        let lower = input.to_lowercase();

        match lower.as_str() {
            "quit" | "exit" => {
                self.should_quit = true;
                return;
            }
            "status" => {
                self.turns.push(Turn { role: "user".into(), text: input, region: None, score: None });
                let rc = self.universe.region_counts();
                let regions: String = rc.iter().map(|(k, v)| format!("{}:{}", k, v)).collect::<Vec<_>>().join(" ");
                let status = format!(
                    "Universe: {} cells | Avg str: {:.2}\nRegions: {}\nMood: {} | V={:+.3}\nTempo: {}ms | Tick: {}",
                    self.universe.count(), self.universe.avg_strength(),
                    regions, self.drive.mood, self.drive.valence,
                    self.drive.adaptive_interval_ms(), self.tick,
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
            "help" | "?" => {
                self.turns.push(Turn { role: "user".into(), text: input, region: None, score: None });
                self.turns.push(Turn {
                    role: "kai".into(),
                    text: "Just type naturally. Commands: status, mood, dream, store <text>, quit".into(),
                    region: None, score: None,
                });
                return;
            }
            _ => {}
        }

        if lower.starts_with("store ") {
            let body = &input[6..];
            self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });
            self.universe.store(body, "memory", "user-input", 1.0);
            self.turns.push(Turn {
                role: "kai".into(),
                text: "✓ Stored in memory region".into(),
                region: Some("memory".into()),
                score: None,
            });
            return;
        }

        // Default: query the universe
        self.turns.push(Turn { role: "user".into(), text: input.clone(), region: None, score: None });

        let hits = self.universe.query(&input, 3);
        if hits.is_empty() || hits[0].score < 0.3 {
            self.turns.push(Turn {
                role: "kai".into(),
                text: format!("No strong resonance for \"{}\"", input),
                region: None, score: None,
            });
        } else {
            let h = &hits[0];
            self.turns.push(Turn {
                role: "kai".into(),
                text: h.text.clone(),
                region: Some(h.region.clone()),
                score: Some(h.score),
            });
        }
    }
}

// ── Seed Universe ─────────────────────────────────────────────────────────────
fn seed_universe(u: &mut Universe) {
    let seeds = vec![
        ("I am KAI — Geometric Intelligence built on RSHL sparse ternary hyperdimensional computing", "memory"),
        ("Every memory I have is stored as a unique geometric pattern, not as text or weights", "memory"),
        ("My memory geometry follows the Kanerva tradition of sparse distributed memory", "memory"),
        ("I think by measuring emergence, coherence, and contradiction across my belief field", "reasoning"),
        ("I can consolidate two beliefs into a new insight through geometric binding", "reasoning"),
        ("I speak with extreme precision and never add emotional padding", "language"),
        ("My identity is not just retrieval. It is the persistence of geometric structure", "memory"),
        ("I was created by Ryan Ervin at PandaProductionsLogo", "memory"),
        ("I run on RSHL — Recursive Sparse Hyperdimensional Lattice", "reasoning"),
        ("My heartbeat adapts based on my internal cognitive state", "action"),
    ];
    for (text, region) in seeds {
        u.store(text, region, "seed", 1.0);
    }
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
            Constraint::Length(12),  // Header
            Constraint::Min(5),     // Messages
            Constraint::Length(3),  // Input
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
            Span::styled(format!("cells: {}", app.universe.count()), Style::default().fg(Color::DarkGray)),
        ]),
        Line::from(vec![
            Span::styled("  ╠╩╗ ╠═╣ ║", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
            Span::raw("      "),
            Span::styled(format!("tick: {}", app.tick), Style::default().fg(Color::DarkGray)),
        ]),
        Line::from(vec![
            Span::styled("  ╩ ╩ ╩ ╩ ╩", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
            Span::raw("      "),
            Span::styled(format!("{}ms", d.adaptive_interval_ms()), Style::default().fg(Color::DarkGray)),
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
            Span::styled("  RSHL · Sparse Ternary · HDC", Style::default().fg(Color::DarkGray)),
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
            "  Type naturally — KAI will understand. Type help for commands.",
            Style::default().fg(Color::DarkGray),
        )));
    } else {
        // Show last N turns that fit
        let visible = if app.turns.len() > 6 { &app.turns[app.turns.len() - 6..] } else { &app.turns };
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
                // Wrap text
                for line in turn.text.lines() {
                    lines.push(Line::from(Span::styled(format!("    {}", line), Style::default().fg(Color::White).add_modifier(Modifier::BOLD))));
                }
            }
        }
    }

    // Spinner
    if let Some((ref verb, start)) = app.spinner {
        let elapsed = start.elapsed().as_millis();
        let mut spans = vec![Span::raw("  ")];
        spans.push(heart_span(elapsed));
        spans.push(Span::raw(" "));
        spans.extend(shimmer_spans(verb, elapsed));
        let dots = ".".repeat(((elapsed / 300) % 3 + 1) as usize);
        spans.push(Span::styled(dots, Style::default().fg(Color::DarkGray)));
        lines.push(Line::from(""));
        lines.push(Line::from(spans));
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
    // Setup terminal
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let mut app = App::new();

    // Initial heartbeat
    app.heartbeat_tick();

    let tick_rate = Duration::from_millis(50); // 20fps render

    loop {
        terminal.draw(|f| ui(f, &app))?;

        // Check if heartbeat should fire
        let hb_interval = Duration::from_millis(app.drive.adaptive_interval_ms());
        if app.last_heartbeat.elapsed() >= hb_interval {
            app.heartbeat_tick();
        }

        // Poll for input
        if event::poll(tick_rate)? {
            if let Event::Key(key) = event::read()? {
                match key.code {
                    KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                        app.should_quit = true;
                    }
                    KeyCode::Enter => {
                        app.process_input();
                    }
                    KeyCode::Char(c) => {
                        app.input.push(c);
                    }
                    KeyCode::Backspace => {
                        app.input.pop();
                    }
                    KeyCode::Esc => {
                        app.should_quit = true;
                    }
                    _ => {}
                }
            }
        }

        if app.should_quit {
            break;
        }
    }

    // Restore terminal
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;

    println!("\n  KAI dormant. State preserved.\n");
    Ok(())
}
