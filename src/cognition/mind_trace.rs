//! # Mind Trace — the glass window into KAI's head.
//!
//! For ONE input, record every layer, every branch taken *and not taken*, every
//! score with its components broken out, and everything he considered but did
//! not say. The goal is line-for-line: not "retrieval returned 4 hits" but
//! "cell #18422 scored cosine 0.31 × 0.3 + keyword 0.86 × 0.7 = 0.695, boosted
//! ×2.14 by confidence 3.6 → 1.487, ranked #2, TRUNCATED before speaking".
//!
//! ## Why this shape
//!
//! KAI's reply path is a long chain of gates, most of which `return` early. When
//! he answers badly the question is almost never "what did the model output" —
//! it is **which gate fired, and what did the pipeline never even reach**. So a
//! trace that only records what happened is half useless. Every branch event
//! records the condition's actual value and whether it was taken, and every early
//! return is marked, so the trace shows the road not travelled.
//!
//! This is the RSHL analogue of what the J-space work did for transformers —
//! except KAI's intermediate states are already verbalizable. His cells carry
//! literal text, so a trace can show the *actual words* he considered rather than
//! a projection of a residual stream. That is a genuine architectural advantage
//! and this module exists to cash it in.
//!
//! ## Cost when disabled
//!
//! One thread-local `Option` check per event, and `record()` returns immediately
//! if no trace is active. Nothing is allocated, no strings are formatted — every
//! call site passes a closure so the payload is only built when tracing is on.
//! Tracing is per-turn and opt-in (`"trace": true` on the request), never global.

use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::time::Instant;

/// One recorded moment in a turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceEvent {
    /// Stable snake_case name, e.g. `retrieval_scored`, `bypass_direct_recall`.
    pub event: String,
    /// Pipeline stage this belongs to — groups the timeline in the viewer.
    pub stage: String,
    /// Milliseconds since the turn began.
    pub at_ms: f32,
    /// Human-readable one-liner.
    pub detail: String,
    /// Structured payload. Free-form so each stage can carry what it needs.
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub data: serde_json::Value,
    /// For branch events: did the condition hold?
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub taken: Option<bool>,
    /// `true` when the pipeline STOPPED here and returned a reply.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub early_return: bool,
}

/// A single cell considered during retrieval, with every score component kept
/// separate. Collapsing these into one number is what makes retrieval bugs
/// invisible — the whole point is to see which term dominated.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoredCell {
    pub rank: usize,
    pub label: String,
    pub region: String,
    pub source: String,
    pub confidence: f32,
    /// Geometric similarity term (cosine, or the phasor variant when enabled).
    pub cosine: f32,
    /// Keyword overlap, IDF-weighted when `KAI_IDF_KEYWORDS` is on.
    pub keyword: f32,
    /// `w_cos * cosine + w_kw * keyword`, before any boost.
    pub blend: f32,
    /// Multiplier applied by the confidence boost gate (1.0 = not boosted).
    pub boost: f32,
    /// What retrieval actually ranked on.
    pub final_score: f32,
    /// `true` when this cell was returned to the caller; `false` when it fired
    /// and was Hebbian-wired but got truncated before speaking — a silent thought.
    pub survived: bool,
}

/// The full record of one input → output.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MindTrace {
    pub input: String,
    pub speaker: String,
    pub started_at: String,
    pub total_ms: f32,
    pub events: Vec<TraceEvent>,
    /// Everything retrieval scored, survivors and silent alike.
    pub considered: Vec<ScoredCell>,
    /// The reply that actually left the building.
    pub output: String,
    /// Which code path produced `output` — the single most useful field here.
    pub spoke_via: String,
}

/// Local timestamp helper — `persistence::chrono_now` is private to that module
/// and this crate deliberately avoids a hard chrono dependency here.
fn now_iso() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f").to_string()
}

struct ActiveTrace {
    t0: Instant,
    started_at: String,
    input: String,
    speaker: String,
    events: Vec<TraceEvent>,
    considered: Vec<ScoredCell>,
    spoke_via: String,
}

thread_local! {
    /// Per-request, because the Oracle server handles each turn on its own
    /// thread. A global would interleave concurrent turns into nonsense.
    static ACTIVE: RefCell<Option<ActiveTrace>> = const { RefCell::new(None) };
}

/// Begin tracing on THIS thread. Any previous trace is discarded.
pub fn begin(input: &str, speaker: &str) {
    ACTIVE.with(|a| {
        *a.borrow_mut() = Some(ActiveTrace {
            t0: Instant::now(),
            started_at: now_iso(),
            input: input.to_string(),
            speaker: speaker.to_string(),
            events: Vec::with_capacity(64),
            considered: Vec::new(),
            spoke_via: "unknown".to_string(),
        });
    });
}

/// Is a trace active on this thread? Call sites use this to skip expensive
/// payload construction entirely.
#[inline]
pub fn is_active() -> bool {
    ACTIVE.with(|a| a.borrow().is_some())
}

/// Finish and take the trace. Returns `None` when tracing was never started.
pub fn finish(output: &str) -> Option<MindTrace> {
    ACTIVE.with(|a| {
        a.borrow_mut().take().map(|t| MindTrace {
            input: t.input,
            speaker: t.speaker,
            started_at: t.started_at,
            total_ms: t.t0.elapsed().as_secs_f32() * 1000.0,
            events: t.events,
            considered: t.considered,
            output: output.to_string(),
            spoke_via: t.spoke_via,
        })
    })
}

/// Abandon any active trace without producing a result.
pub fn abort() {
    ACTIVE.with(|a| *a.borrow_mut() = None);
}

fn push(ev: TraceEvent) {
    ACTIVE.with(|a| {
        if let Some(t) = a.borrow_mut().as_mut() {
            t.events.push(ev);
        }
    });
}

fn elapsed_ms() -> f32 {
    ACTIVE.with(|a| {
        a.borrow()
            .as_ref()
            .map(|t| t.t0.elapsed().as_secs_f32() * 1000.0)
            .unwrap_or(0.0)
    })
}

/// Record a plain step. `detail` is only built when tracing is on.
pub fn step<F: FnOnce() -> String>(stage: &str, event: &str, detail: F) {
    if !is_active() {
        return;
    }
    push(TraceEvent {
        event: event.to_string(),
        stage: stage.to_string(),
        at_ms: elapsed_ms(),
        detail: detail(),
        data: serde_json::Value::Null,
        taken: None,
        early_return: false,
    });
}

/// Record a step carrying structured data.
pub fn data<F: FnOnce() -> serde_json::Value>(stage: &str, event: &str, detail: &str, d: F) {
    if !is_active() {
        return;
    }
    push(TraceEvent {
        event: event.to_string(),
        stage: stage.to_string(),
        at_ms: elapsed_ms(),
        detail: detail.to_string(),
        data: d(),
        taken: None,
        early_return: false,
    });
}

/// Record a BRANCH — the condition and whether it held. Recording branches that
/// did NOT fire is the entire value proposition: it shows the path not taken.
pub fn branch<F: FnOnce() -> String>(stage: &str, event: &str, taken: bool, detail: F) {
    if !is_active() {
        return;
    }
    push(TraceEvent {
        event: event.to_string(),
        stage: stage.to_string(),
        at_ms: elapsed_ms(),
        detail: detail(),
        data: serde_json::Value::Null,
        taken: Some(taken),
        early_return: false,
    });
}

/// Record the point where the pipeline STOPPED and produced the reply.
/// `via` names the path, and becomes `MindTrace::spoke_via`.
pub fn spoke<F: FnOnce() -> String>(stage: &str, event: &str, via: &str, detail: F) {
    if !is_active() {
        return;
    }
    let d = detail();
    ACTIVE.with(|a| {
        if let Some(t) = a.borrow_mut().as_mut() {
            t.spoke_via = via.to_string();
        }
    });
    push(TraceEvent {
        event: event.to_string(),
        stage: stage.to_string(),
        at_ms: elapsed_ms(),
        detail: d,
        data: serde_json::json!({ "via": via }),
        taken: Some(true),
        early_return: true,
    });
}

/// Record the full scored candidate set from retrieval, survivors and silent.
pub fn scored(cells: Vec<ScoredCell>) {
    if !is_active() {
        return;
    }
    let (survived, silent) = cells.iter().fold((0, 0), |(s, q), c| {
        if c.survived { (s + 1, q) } else { (s, q + 1) }
    });
    ACTIVE.with(|a| {
        if let Some(t) = a.borrow_mut().as_mut() {
            t.considered = cells;
        }
    });
    push(TraceEvent {
        event: "retrieval_scored".to_string(),
        stage: "retrieval".to_string(),
        at_ms: elapsed_ms(),
        detail: format!("{} spoken-eligible, {} silent (fired but truncated)", survived, silent),
        data: serde_json::json!({ "survived": survived, "silent": silent }),
        taken: None,
        early_return: false,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inactive_by_default_and_costs_nothing() {
        abort();
        assert!(!is_active());
        step("retrieval", "noop", || panic!("detail must NOT be built when off"));
        assert!(finish("x").is_none());
    }

    #[test]
    fn records_ordered_events_and_speak_path() {
        begin("who are you?", "Ryan");
        assert!(is_active());
        step("encode", "encoded", || "nnz=655".into());
        branch("voice", "phi_c_gate", false, || "phi_c=0.11 <= 0.20".into());
        spoke("voice", "identity_bypass", "identity_bypass", || "51 identity cells".into());
        let t = finish("I am KAI.").expect("trace must exist");

        assert_eq!(t.events.len(), 3);
        assert_eq!(t.output, "I am KAI.");
        assert_eq!(t.spoke_via, "identity_bypass");
        assert_eq!(t.events[1].taken, Some(false), "untaken branch must be recorded");
        assert!(t.events[2].early_return, "speak point must mark the stop");
        assert!(!is_active(), "finish must clear the slot");
    }

    #[test]
    fn silent_thoughts_are_counted_separately() {
        begin("q", "Ryan");
        scored(vec![
            ScoredCell { rank: 0, label: "a".into(), region: "concept".into(), source: "s".into(),
                confidence: 3.0, cosine: 0.4, keyword: 0.9, blend: 0.75, boost: 2.0,
                final_score: 1.5, survived: true },
            ScoredCell { rank: 1, label: "b".into(), region: "concept".into(), source: "s".into(),
                confidence: 1.0, cosine: 0.2, keyword: 0.1, blend: 0.13, boost: 1.0,
                final_score: 0.13, survived: false },
        ]);
        let t = finish("out").unwrap();
        assert_eq!(t.considered.len(), 2);
        assert_eq!(t.considered.iter().filter(|c| !c.survived).count(), 1);
        let ev = t.events.iter().find(|e| e.event == "retrieval_scored").unwrap();
        assert_eq!(ev.data["silent"], 1);
    }
}
