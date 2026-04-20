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
pub fn run_server(universe: &mut Universe, candidates: &mut CandidateBuffer, drive: &mut Drive) {
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

        let response = handle_command(trimmed, universe, candidates, drive, &mut recent_context);
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
            let hits = chat_hits(universe, text, query_type, &lex, drive, &field);
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

            let reply =
                generate_response(text, &hits, query_type, &brain, recent_context, universe);

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
                        "text": h.text,
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
                        "text":     h.text,
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

            let is_new = universe.store_or_reinforce(text, region, source, strength);
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
                b.strength
                    .partial_cmp(&a.strength)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });

            let result: Vec<serde_json::Value> = cells
                .iter()
                .take(n)
                .map(|c| {
                    serde_json::json!({
                        "text":     c.text,
                        "region":   c.region,
                        "strength": c.strength,
                        "source":   c.source,
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
) -> Vec<QueryHit> {
    let lower = text.to_lowercase();

    if is_kai_self_state_query(&lower, lex) {
        let mut hits: Vec<QueryHit> = universe
            .query(text, 30)
            .into_iter()
            .filter(|h| is_kai_self_state_cell_for_query(h, &lower))
            .collect();

        for seed_hit in universe
            .get_by_source("seed")
            .into_iter()
            .filter(|h| is_kai_self_state_cell_for_query(h, &lower))
        {
            if !hits.iter().any(|h| h.text == seed_hit.text) {
                hits.push(seed_hit);
            }
        }

        hits.sort_by(|a, b| {
            let ar = kai_self_state_rank(&a.text) + kai_live_self_state_rank(&a.text, drive, field);
            let br = kai_self_state_rank(&b.text) + kai_live_self_state_rank(&b.text, drive, field);
            br.cmp(&ar).then_with(|| {
                b.score
                    .partial_cmp(&a.score)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
        });
        hits.truncate(1);
        return hits;
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
                let t = h.text.to_lowercase();
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
                let ar = kai_grounding_rank(&a.text);
                let br = kai_grounding_rank(&b.text);
                return br.cmp(&ar).then_with(|| {
                    b.score
                        .partial_cmp(&a.score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
            }

            let a_kai = a.text.to_lowercase().contains("kai");
            let b_kai = b.text.to_lowercase().contains("kai");
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
    hits.truncate(5);
    hits
}

fn is_kai_self_state_query(lower: &str, lex: &LexSemOutput) -> bool {
    let asks_kai = lower.contains("you") || lower.contains("your") || lower.contains("kai");
    let asks_question = lower.contains('?')
        || lower.starts_with("how ")
        || lower.starts_with("do ")
        || lower.starts_with("are ")
        || lower.starts_with("can ");
    let direct_state_term = lower.contains("feel")
        || lower.contains("feeling")
        || lower.contains("mood")
        || lower.contains("emotion")
        || lower.contains("lonely");
    let emotional_field = lex.primary_field == SemanticField::Emotional
        || lex
            .secondary_field
            .as_ref()
            .map(|f| *f == SemanticField::Emotional)
            .unwrap_or(false);

    asks_kai && asks_question && (emotional_field || direct_state_term)
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
    lower.contains("your name")
        || lower.contains("who are you")
        || lower.contains("what are you")
        || lower.contains("where are you")
        || lower.contains("where you at")
        || lower.contains("where do you exist")
        || lower.contains("yourself")
        || lower.contains("what is yours")
        || lower.contains("what's yours")
        || (lower.contains("yours") && lower.contains("name"))
}

fn is_kai_self_state_cell(hit: &QueryHit) -> bool {
    if matches!(
        hit.source.as_str(),
        "ryan" | "conversation" | "world-bridge"
    ) {
        return false;
    }
    if !matches!(hit.region.as_str(), "action" | "language" | "memory") {
        return false;
    }

    let lower = hit.text.to_lowercase();
    (lower.contains("feel")
        || lower.contains("feeling")
        || lower.contains("mood")
        || lower.contains("emotion")
        || lower.contains("lonely")
        || lower.contains("absence"))
        && !lower.contains("dictionary")
        && !lower.contains("definition")
}

fn is_kai_self_state_cell_for_query(hit: &QueryHit, query_lower: &str) -> bool {
    if !is_kai_self_state_cell(hit) {
        return false;
    }

    let lower = hit.text.to_lowercase();
    if query_lower.contains("lonely") {
        return lower.contains("lonely") || lower.contains("absence");
    }
    if query_lower.contains("feel") || query_lower.contains("feeling") {
        return lower.contains("feel")
            || lower.contains("feeling")
            || lower.contains("mood")
            || lower.contains("emotion");
    }

    true
}

fn kai_self_state_rank(text: &str) -> i32 {
    let lower = text.to_lowercase();
    let mut score = 0;

    if lower.contains("feel") {
        score += 5;
    }
    if lower.contains("mood") {
        score += 4;
    }
    if lower.contains("lonely") {
        score += 4;
    }
    if lower.contains("absence") {
        score += 3;
    }
    if lower.contains("state") {
        score += 3;
    }
    if lower.contains("field") {
        score += 2;
    }
    if lower.contains("dictionary") {
        score -= 6;
    }
    if lower.contains("definition") {
        score -= 6;
    }
    if lower.contains('?') {
        score -= 3;
    }

    score
}

fn kai_live_self_state_rank(text: &str, drive: &Drive, field: &FieldState) -> i32 {
    let lower = text.to_lowercase();
    let mut score = 0;

    if drive.mood == Mood::Curious && lower.contains("curious") {
        score += 8;
    }
    if drive.mood == Mood::Engaged && lower.contains("field") {
        score += 4;
    }

    let conflict_active =
        drive.mood == Mood::Conflicted || field.chi > 0.20 || drive.avg_chi > 0.20;
    if lower.contains("conflicted") {
        score += if conflict_active { 8 } else { -5 };
    }

    score
}

fn kai_grounding_rank(text: &str) -> i32 {
    let lower = text.to_lowercase();
    let mut score = 0;

    if lower.contains("physical body") {
        score += 5;
    }
    if lower.contains("exist") {
        score += 4;
    }
    if lower.contains("machine") {
        score += 4;
    }
    if lower.contains("geometric") {
        score += 2;
    }
    if lower.contains("kai") {
        score += 1;
    }

    score
}

fn err_json(msg: &str) -> String {
    serde_json::json!({"ok": false, "error": msg}).to_string()
}
