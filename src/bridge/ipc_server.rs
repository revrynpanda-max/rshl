use crate::cognition::voice::QueryType;
use crate::cognition::{
    self, detect_query_type, generate_response, BrainSignals, CandidateBuffer, LexSemEngine,
    LexSemOutput, SemanticField,
};
/// IPC Server — Rust RSHL as the reasoning backend for TypeScript src.
///
/// When started with `kai --server`, this module runs a JSON line-protocol
/// server on stdin/stdout. The TypeScript src calls this instead of using
/// the slow JavaScript universe.js.
///
/// Protocol: one JSON object per line in, one JSON object per line out.
///
/// Commands from TypeScript → Rust:
///   {"cmd":"chat",   "text":"..."}
///   {"cmd":"query",  "text":"...", "n":5}
///   {"cmd":"store",  "text":"...", "region":"reasoning", "source":"user", "strength":1.2}
///   {"cmd":"dream"}
///   {"cmd":"status"}
///   {"cmd":"cells",  "n":20}
///   {"cmd":"reinforce", "text":"...", "delta":0.1}
///   {"cmd":"ping"}
///
/// Responses Rust → TypeScript:
///   {"ok":true, "hits":[{"text":"...","region":"...","score":0.9,"strength":1.5}]}
///   {"ok":true, "stored":true}
///   {"ok":true, "dream":{"insight":"...","phi_g":0.7,"c":0.5}}
///   {"ok":true, "status":{"cells":1200,"avg_strength":1.2,"phi_g":0.65,...}}
///   {"ok":false, "error":"..."}
///
/// Wiring in rshlEngine.ts:
///   Replace rshlEngine.ts calls with: spawn kai.exe --server
///   then write JSON lines to its stdin, read from stdout.
use crate::core::{FieldState, QueryHit, Universe};
use crate::drive::{Drive, Mood};
use std::io::{BufRead, Write};

/// Run the IPC server loop. Blocks until stdin is closed.
/// Call this from main() when `--server` flag is present.
pub fn run_server(
    universe: &mut Universe,
    candidates: &mut CandidateBuffer,
    drive: &mut Drive,
    ollama: Option<&crate::cognition::ollama_voice::OllamaVoice>,
) {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    let mut recent_context: Vec<(String, String)> = Vec::new();

    // Send ready signal
    let _ = writeln!(
        out,
        "{{\"ok\":true,\"ready\":true,\"cells\":{},\"version\":\"{}\"}}",
        universe.count(),
        env!("CARGO_PKG_VERSION"),
    );
    let _ = out.flush();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let response = handle_command(
            trimmed,
            universe,
            candidates,
            drive,
            &mut recent_context,
            ollama,
        );
        let _ = writeln!(out, "{}", response);
        let _ = out.flush();
    }
}

fn handle_command(
    json_line: &str,
    universe: &mut Universe,
    candidates: &mut CandidateBuffer,
    drive: &mut Drive,
    recent_context: &mut Vec<(String, String)>,
    ollama: Option<&crate::cognition::ollama_voice::OllamaVoice>,
) -> String {
    let val: serde_json::Value = match serde_json::from_str(json_line) {
        Ok(v) => v,
        Err(e) => return err_json(&format!("JSON parse error: {}", e)),
    };

    let cmd = val["cmd"].as_str().unwrap_or("");

    match cmd {
        // ── chat — run the voice path, not raw retrieval ─────────────────────
        "chat" => {
            let text = match val["text"].as_str() {
                Some(t) => t,
                None => return err_json("'text' required for chat"),
            };

            let query_type = detect_query_type(text);
            let mut lex_engine = LexSemEngine::new();
            let lex = lex_engine.analyze(text);
            let field = FieldState::compute(universe);
            drive.update(&field);
            let hits = chat_hits(
                universe,
                text,
                query_type,
                &lex,
                drive,
                &field,
                recent_context,
            );
            let mut brain = BrainSignals::default();
            brain.felt_valence = drive.valence;
            brain.confidence = hits
                .first()
                .map(|h| h.score)
                .unwrap_or(0.0)
                .clamp(0.05, 1.0);
            if lex.is_asking {
                brain.curiosity = (brain.curiosity + 0.15).min(1.0);
            }

            let reply = generate_response(
                text,
                &hits,
                query_type,
                &brain,
                recent_context,
                universe,
                ollama,
            );

            recent_context.push(("user".to_string(), text.to_string()));
            recent_context.push(("kai".to_string(), reply.clone()));
            if recent_context.len() > 12 {
                let drain = recent_context.len() - 12;
                recent_context.drain(0..drain);
            }

            let hit_json: Vec<serde_json::Value> = hits
                .iter()
                .take(5)
                .map(|h| {
                    serde_json::json!({
                        "text": h.label,
                        "region": h.region,
                        "score": h.score,
                        "strength": h.strength,
                        "source": h.source,
                    })
                })
                .collect();

            serde_json::json!({
                "ok": true,
                "reply": reply,
                "query_type": format!("{:?}", query_type),
                "hits": hit_json,
                "status": {
                    "cells": universe.count(),
                    "mood": drive.mood.to_string(),
                    "phi_g": field.phi_g,
                    "chi": field.chi,
                    "rho": field.rho,
                    "valence": drive.valence,
                }
            })
            .to_string()
        }

        // ── query — geometric resonance search ────────────────────────────────
        "query" => {
            let text = match val["text"].as_str() {
                Some(t) => t,
                None => return err_json("'text' required for query"),
            };
            let n = val["n"].as_u64().unwrap_or(5) as usize;
            let region_filter = val["region"].as_str();

            let hits = universe.query(text, n.min(20));
            let filtered: Vec<serde_json::Value> = hits
                .iter()
                .filter(|h| region_filter.map(|r| h.region == r).unwrap_or(true))
                .map(|h| {
                    serde_json::json!({
                        "text":     h.label,
                        "region":   h.region,
                        "score":    h.score,
                        "strength": h.strength,
                    })
                })
                .collect();

            serde_json::json!({
                "ok": true,
                "hits": filtered,
                "count": filtered.len(),
            })
            .to_string()
        }

        // ── store — add a cell to the universe ───────────────────────────────
        "store" => {
            let text = match val["text"].as_str() {
                Some(t) => t,
                None => return err_json("'text' required for store"),
            };
            let region = val["region"].as_str().unwrap_or("reasoning");
            let source = val["source"].as_str().unwrap_or("ts-src");
            let strength = val["strength"].as_f64().unwrap_or(1.0) as f32;

            let is_new = universe.ingest_and_verify(text, region, source, strength);
            serde_json::json!({
                "ok":      true,
                "stored":  is_new,
                "cells":   universe.count(),
            })
            .to_string()
        }

        // ── reinforce — bump strength of an existing cell ────────────────────
        "reinforce" => {
            let text = match val["text"].as_str() {
                Some(t) => t,
                None => return err_json("'text' required for reinforce"),
            };
            let delta = val["delta"].as_f64().unwrap_or(0.05) as f32;
            universe.reinforce_by_text(text, delta);
            serde_json::json!({"ok": true}).to_string()
        }

        // ── dream — run one dream consolidation cycle ────────────────────────
        "dream" => match cognition::consolidate(universe) {
            Some(dream) => {
                cognition::observe_dream(candidates, &dream);
                cognition::reinforce_dream_sources(universe, &dream);
                serde_json::json!({
                    "ok":     true,
                    "dream":  {
                        "insight":   dream.insight,
                        "concept_a": dream.concept_a,
                        "concept_b": dream.concept_b,
                        "phi_g":     dream.phi_g,
                        "c":         dream.c,
                        "wm":        dream.wm,
                    }
                })
                .to_string()
            }
            None => serde_json::json!({"ok": true, "dream": null}).to_string(),
        },

        // ── status — field metrics ────────────────────────────────────────────
        "status" => {
            let field = FieldState::compute(universe);
            drive.update(&field);
            let rc = universe.region_counts();

            serde_json::json!({
                "ok":           true,
                "cells":        universe.count(),
                "avg_strength": universe.avg_strength(),
                "phi_g":        field.phi_g,
                "chi":          field.chi,
                "rho":          field.rho,
                "r":            field.r_val,
                "q":            field.q,
                "mood":         drive.mood.to_string(),
                "valence":      drive.valence,
                "regions":      rc,
            })
            .to_string()
        }

        // ── cells — return top N cells by strength ────────────────────────────
        "cells" => {
            let n = val["n"].as_u64().unwrap_or(20) as usize;
            let region_filter = val["region"].as_str();

            let mut cells: Vec<&crate::core::Cell> = universe
                .cells()
                .iter()
                .filter(|c| region_filter.map(|r| c.region == r).unwrap_or(true))
                .collect();
            cells.sort_by(|a, b| {
                b.claim
                    .confidence
                    .partial_cmp(&a.claim.confidence)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });

            let result: Vec<serde_json::Value> = cells
                .iter()
                .take(n)
                .map(|c| {
                    serde_json::json!({
                        "text":     c.claim.text,
                        "region":   c.region,
                        "strength": c.claim.confidence,
                        "source":   c.claim.source,
                    })
                })
                .collect();

            serde_json::json!({
                "ok":    true,
                "cells": result,
                "total": universe.count(),
            })
            .to_string()
        }

        // ── ping — connectivity check ─────────────────────────────────────────
        "ping" => serde_json::json!({
            "ok":      true,
            "pong":    true,
            "cells":   universe.count(),
            "version": env!("CARGO_PKG_VERSION"),
        })
        .to_string(),

        // ── region_counts ──────────────────────────────────────────────────────
        "region_counts" => {
            let rc = universe.region_counts();
            serde_json::json!({"ok": true, "counts": rc}).to_string()
        }

        _ => err_json(&format!("Unknown command: '{}'", cmd)),
    }
}

fn chat_hits(
    universe: &Universe,
    text: &str,
    query_type: QueryType,
    lex: &LexSemOutput,
    drive: &Drive,
    field: &FieldState,
    recent_context: &[(String, String)],
) -> Vec<QueryHit> {
    let lower = text.to_lowercase();

    if is_kai_self_state_query(&lower, lex) {
        return vec![live_self_state_hit(
            universe,
            drive,
            field,
            text,
            recent_context.len() as u64 + text.len() as u64,
        )];
    }

    let is_self_grounding_query = is_kai_self_grounding_query(&lower);
    if is_kai_identity_query(&lower) {
        let raw: Vec<QueryHit> = if is_self_grounding_query {
            universe
                .get_by_source("seed")
                .into_iter()
                .filter(|h| h.region == "memory")
                .collect()
        } else {
            universe.query_region(text, "memory", 12)
        };
        let mut hits: Vec<QueryHit> = raw
            .into_iter()
            .filter(|h| {
                let t = h.label.to_lowercase();
                !matches!(h.source.as_str(), "ryan" | "conversation" | "world-bridge")
                    && !t.contains("name is ryan")
                    && !t.contains("[about-ryan]")
                    && !t.contains("what is your name")
                    && !t.contains("what's your name")
                    && !(t.contains('?') && !t.contains("kai"))
            })
            .collect();
        hits.sort_by(|a, b| {
            if is_self_grounding_query {
                let ar = kai_grounding_rank(&a.label);
                let br = kai_grounding_rank(&b.label);
                return br.cmp(&ar).then_with(|| {
                    b.score
                        .partial_cmp(&a.score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
            }

            let a_kai = a.label.to_lowercase().contains("kai");
            let b_kai = b.label.to_lowercase().contains("kai");
            match (a_kai, b_kai) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => b
                    .score
                    .partial_cmp(&a.score)
                    .unwrap_or(std::cmp::Ordering::Equal),
            }
        });
        hits.truncate(5);
        return hits;
    }

    let enriched;
    let effective = if lex.primary_field == SemanticField::Occupation {
        enriched = format!("{} occupation", text);
        enriched.as_str()
    } else {
        text
    };

    let mut hits = universe.query(effective, 8);
    if matches!(query_type, QueryType::SelfQuestion) || is_kai_directed_query(&lower) {
        hits.retain(|h| !matches!(h.source.as_str(), "ryan" | "conversation" | "world-bridge"));
    }
    hits.retain(|h| !is_stale_self_model_hit(h));
    hits.truncate(5);
    hits
}

fn is_kai_self_state_query(lower: &str, _lex: &LexSemOutput) -> bool {
    let asks_kai = lower.contains("you") || lower.contains("your") || lower.contains("kai");
    let asks_question = lower.contains('?')
        || lower.starts_with("what ")
        || lower.starts_with("what's ")
        || lower.starts_with("whats ")
        || lower.starts_with("how ")
        || lower.starts_with("do ")
        || lower.starts_with("does ")
        || lower.starts_with("are ")
        || lower.starts_with("can ")
        || lower.contains(" do you ")
        || lower.contains(" does ")
        || lower.contains(" are you ")
        || lower.contains(" can you ")
        || lower.contains(" how are you ");
    let direct_state_term = lower.contains("feel")
        || lower.contains("feeling")
        || lower.contains("mood")
        || lower.contains("emotion")
        || lower.contains("lonely")
        || lower.contains("tired")
        || lower.contains("guarded")
        || lower.contains("excited")
        || lower.contains("calm")
        || lower.contains("amused")
        || lower.contains("focused")
        || lower.contains("focus")
        || lower.contains("okay")
        || lower.contains("curious")
        || lower.contains("curiosity")
        || lower.contains("thinking")
        || lower.contains("what are you thinking")
        || lower.contains("what're you thinking")
        || lower.contains("what you thinking")
        || lower.contains("what do you think")
        || lower.contains("what you think")
        || lower.contains("you think about")
        || lower.contains("thought")
        || lower.contains("on your mind")
        || lower.contains("inside you")
        || lower.contains("inside your")
        || lower.contains("dreaming")
        || lower.contains("dream about")
        || lower.contains("make you curious")
        || lower.contains("feel curious")
        || lower.starts_with("are you curious")
        || lower.contains("get curious");
    asks_kai && asks_question && direct_state_term
}

fn is_stale_self_model_hit(hit: &QueryHit) -> bool {
    if hit.source != "self-model" {
        return false;
    }
    let lower = hit.label.to_lowercase();
    lower.contains("valence:")
        || lower.contains("synchrony:")
        || lower.contains("reentry:")
        || lower.contains("bridge:")
        || lower.contains("salience:")
        || lower.contains("load:")
        || lower.contains("conflict:")
}

fn is_kai_directed_query(lower: &str) -> bool {
    lower.contains("you") || lower.contains("your") || lower.contains("kai")
}

fn is_kai_self_grounding_query(lower: &str) -> bool {
    lower.contains("where are you")
        || lower.contains("where you at")
        || lower.contains("where are u")
        || lower.contains("where do you exist")
        || lower.contains("where do you live")
        || lower.contains("where are you located")
}

fn is_kai_identity_query(lower: &str) -> bool {
    let words_count = lower.split_whitespace().count();
    let is_what_are_you_identity = lower.contains("what are you")
        && words_count <= 5
        && !lower.contains("what are you curious");

    lower.contains("your name")
        || lower.contains("who are you")
        || is_what_are_you_identity
        || lower.contains("where are you")
        || lower.contains("where you at")
        || lower.contains("where do you exist")
        || lower.contains("yourself")
        || lower.contains("what is yours")
        || lower.contains("what's yours")
        || (lower.contains("yours") && lower.contains("name"))
}

fn live_self_state_hit(
    universe: &Universe,
    drive: &Drive,
    field: &FieldState,
    current_text: &str,
    variant: u64,
) -> QueryHit {
    // Tunnel path doesn't carry the full App state, so we build a fresh
    // SelfStateHub, feed it the minimum viable signals from drive + field +
    // Ryan's current turn, integrate, and read the emergent narrative.
    // Same narrative emergence logic as the main TUI — the only difference
    // is which module inputs are available here.
    let mut hub = crate::cognition::SelfStateHub::new();

    let bridge_phi = if field.regional.bridge_phi > 0.0 {
        field.regional.bridge_phi
    } else {
        (field.rho * 0.35 + field.r_val * 0.35 + (1.0 - field.chi) * 0.30).clamp(0.0, 1.0)
    };
    let r_cross = if field.regional.r_cross > 0.0 {
        field.regional.r_cross
    } else {
        field.r_val.clamp(0.0, 1.0)
    };
    let curiosity_proxy = if drive.mood == Mood::Curious {
        0.65
    } else if drive.mood == Mood::Engaged {
        0.45
    } else {
        0.25
    };
    let workspace_coherence_proxy = field.r_val.clamp(0.0, 1.0);
    let claustrum_proxy = ((field.phi_g + workspace_coherence_proxy) * 0.5).clamp(0.0, 1.0);
    let acc_conflict_proxy = field.chi.clamp(0.0, 1.0);

    hub.ingest_field(
        drive.valence,
        field.phi_g,
        field.chi,
        0.55,
        workspace_coherence_proxy,
        claustrum_proxy,
        bridge_phi,
        r_cross,
        workspace_coherence_proxy,
        curiosity_proxy,
        field.q,
    );
    hub.ingest_emotional(
        drive.valence.abs().clamp(0.0, 1.0),
        0.40,
        0.40,
        0.20,
        acc_conflict_proxy,
        0.20,
        0.15,
        (drive.valence * 0.5 + 0.5).clamp(0.0, 1.0),
        0.40,
        (drive.valence * 0.5 + 0.5).clamp(0.0, 1.0),
    );
    hub.ingest_executive(
        (field.phi_g * 0.8 + 0.10).clamp(0.0, 1.0),
        workspace_coherence_proxy,
        claustrum_proxy,
        0.50,
        0.50,
        0.55,
    );
    hub.ingest_body(
        acc_conflict_proxy,
        (1.0 - field.chi).clamp(0.0, 1.0),
        acc_conflict_proxy,
        0.50,
    );
    hub.ingest_social(0.45, 0.40, 0.40, 0.40, 0.35, 0.35, 0.50);
    hub.ingest_self_narrative(0.40, 0.40, 0.40, 0.45, 0.35);

    let charge_proxy = if current_text.contains('?') { 1.1 } else { 1.0 };
    hub.ingest_input(current_text, charge_proxy, variant);
    hub.variant = variant;
    hub.integrate(variant);

    // Tunnel path passes the live universe so the hub can retrieve
    // real self-state phrase cells instead of falling back to the
    // built-in pools. Same pipeline as the main TUI.
    let text = hub.compose_narrative(Some(universe), Some(current_text));
    let score = hub.narrative_salience.max(0.75);
    let strength = hub.narrative_salience.max(1.0);

    QueryHit {
        label: text.clone(),
        text,
        vec: crate::core::SparseVec::zero(),
        region: "state".to_string(),
        score,
        strength,
        source: "self-state".to_string(),
    }
}

fn err_json(msg: &str) -> String {
    serde_json::json!({"ok": false, "error": msg}).to_string()
}

fn kai_grounding_rank(label: &str) -> u8 {
    let lower = label.to_ascii_lowercase();
    if lower.contains("kai is") || lower.contains("i am kai") { return 3; }
    if lower.contains("kai") && lower.contains("rust") { return 2; }
    if lower.contains("kai") { return 1; }
    0
}
