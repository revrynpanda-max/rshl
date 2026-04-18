/// IPC Server — Rust RSHL as the reasoning backend for TypeScript src.
///
/// When started with `kai --server`, this module runs a JSON line-protocol
/// server on stdin/stdout. The TypeScript src calls this instead of using
/// the slow JavaScript universe.js.
///
/// Protocol: one JSON object per line in, one JSON object per line out.
///
/// Commands from TypeScript → Rust:
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

use crate::core::Universe;
use crate::cognition;
use crate::cognition::CandidateBuffer;
use crate::drive::Drive;
use crate::core::FieldState;
use std::io::{BufRead, Write};

/// Run the IPC server loop. Blocks until stdin is closed.
/// Call this from main() when `--server` flag is present.
pub fn run_server(
    universe: &mut Universe,
    candidates: &mut CandidateBuffer,
    drive: &mut Drive,
) {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());

    // Send ready signal
    let _ = writeln!(out, "{{\"ok\":true,\"ready\":true,\"cells\":{},\"version\":\"5.4\"}}", universe.count());
    let _ = out.flush();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }

        let response = handle_command(trimmed, universe, candidates, drive);
        let _ = writeln!(out, "{}", response);
        let _ = out.flush();
    }
}

fn handle_command(
    json_line: &str,
    universe: &mut Universe,
    candidates: &mut CandidateBuffer,
    drive: &mut Drive,
) -> String {
    let val: serde_json::Value = match serde_json::from_str(json_line) {
        Ok(v)  => v,
        Err(e) => return err_json(&format!("JSON parse error: {}", e)),
    };

    let cmd = val["cmd"].as_str().unwrap_or("");

    match cmd {
        // ── query — geometric resonance search ────────────────────────────────
        "query" => {
            let text = match val["text"].as_str() {
                Some(t) => t,
                None    => return err_json("'text' required for query"),
            };
            let n = val["n"].as_u64().unwrap_or(5) as usize;
            let region_filter = val["region"].as_str();

            let hits = universe.query(text, n.min(20));
            let filtered: Vec<serde_json::Value> = hits.iter()
                .filter(|h| region_filter.map(|r| h.region == r).unwrap_or(true))
                .map(|h| serde_json::json!({
                    "text":     h.text,
                    "region":   h.region,
                    "score":    h.score,
                    "strength": h.strength,
                }))
                .collect();

            serde_json::json!({
                "ok": true,
                "hits": filtered,
                "count": filtered.len(),
            }).to_string()
        }

        // ── store — add a cell to the universe ───────────────────────────────
        "store" => {
            let text = match val["text"].as_str() {
                Some(t) => t,
                None    => return err_json("'text' required for store"),
            };
            let region   = val["region"].as_str().unwrap_or("reasoning");
            let source   = val["source"].as_str().unwrap_or("ts-src");
            let strength = val["strength"].as_f64().unwrap_or(1.0) as f32;

            let is_new = universe.store_or_reinforce(text, region, source, strength);
            serde_json::json!({
                "ok":      true,
                "stored":  is_new,
                "cells":   universe.count(),
            }).to_string()
        }

        // ── reinforce — bump strength of an existing cell ────────────────────
        "reinforce" => {
            let text  = match val["text"].as_str() {
                Some(t) => t,
                None    => return err_json("'text' required for reinforce"),
            };
            let delta = val["delta"].as_f64().unwrap_or(0.05) as f32;
            universe.reinforce_by_text(text, delta);
            serde_json::json!({"ok": true}).to_string()
        }

        // ── dream — run one dream consolidation cycle ────────────────────────
        "dream" => {
            match cognition::consolidate(universe) {
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
                    }).to_string()
                }
                None => serde_json::json!({"ok": true, "dream": null}).to_string(),
            }
        }

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
            }).to_string()
        }

        // ── cells — return top N cells by strength ────────────────────────────
        "cells" => {
            let n = val["n"].as_u64().unwrap_or(20) as usize;
            let region_filter = val["region"].as_str();

            let mut cells: Vec<&crate::core::Cell> = universe.cells().iter()
                .filter(|c| region_filter.map(|r| c.region == r).unwrap_or(true))
                .collect();
            cells.sort_by(|a, b| b.strength.partial_cmp(&a.strength).unwrap_or(std::cmp::Ordering::Equal));

            let result: Vec<serde_json::Value> = cells.iter().take(n)
                .map(|c| serde_json::json!({
                    "text":     c.text,
                    "region":   c.region,
                    "strength": c.strength,
                    "source":   c.source,
                }))
                .collect();

            serde_json::json!({
                "ok":    true,
                "cells": result,
                "total": universe.count(),
            }).to_string()
        }

        // ── ping — connectivity check ─────────────────────────────────────────
        "ping" => {
            serde_json::json!({
                "ok":      true,
                "pong":    true,
                "cells":   universe.count(),
                "version": "5.4",
            }).to_string()
        }

        // ── region_counts ──────────────────────────────────────────────────────
        "region_counts" => {
            let rc = universe.region_counts();
            serde_json::json!({"ok": true, "counts": rc}).to_string()
        }

        _ => err_json(&format!("Unknown command: '{}'", cmd)),
    }
}

fn err_json(msg: &str) -> String {
    serde_json::json!({"ok": false, "error": msg}).to_string()
}
