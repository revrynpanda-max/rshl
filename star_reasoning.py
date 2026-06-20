#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
STaR — Self-Taught Reasoner (standalone, flag-gated, NON-LIVE)
==============================================================

A safe, ADDITIVE port of STaR reasoning (Zelikman et al. 2022) into KAI's
training pipeline. STaR =
  1. For each (fact, question) item, ask KAI to produce a RATIONALE + ANSWER.
  2. Grade the ANSWER with the existing cloud teacher (overnight_pipeline's grader).
  3. If correct -> KEEP the (question, rationale, answer) triple.
  4. If wrong   -> RATIONALIZE: re-ask KAI with the golden answer HINTED, so it
     produces a rationale that *justifies the known-correct answer*. Keep that
     rationale (this is STaR's "rationalization" trick that recovers hard items).
  5. Re-ingest the kept rationales back into the lattice via /api/bulk-ingest as
     reinforced "reasoning"-region cells, so KAI's own successful chains of
     thought are reinforced — the self-taught bootstrap.

WHY THIS IS SAFE
----------------
* This file is STANDALONE. It is NOT imported by overnight_pipeline.py and does
  NOT modify the live training loop, the engine, or generation/training code.
* It REUSES overnight_pipeline's existing helpers (ask_kai / ask_teacher /
  bulk_ingest / parse_json_safe / endpoints) by importing them, so it speaks to
  exactly the same /api/oracle-turn and /api/bulk-ingest endpoints with the same
  contract the live pipeline already uses.
* It is OFF unless you run it explicitly. It defaults to --dry-run (no writes)
  unless you pass --commit.

WHAT IT REUSES (real code, all in C:\\KAI\\overnight_pipeline.py)
---------------------------------------------------------------
* ask_kai(question, from_name="Oracle")  -> POSTs to KAI_CHAT_API (/api/oracle-turn),
  returns KAI's reply (or None on infra failure / generator offline). [op.py:475]
* ask_teacher(messages, json_mode=False) -> multi-provider cloud grader
  (Groq -> OpenRouter -> Gemini -> local Ollama) with circuit breakers. [op.py:778]
* bulk_ingest(entries)                   -> POSTs {"entries":[...]} to KAI_INGEST_API
  (/api/bulk-ingest). Each entry = {text, region, source, strength}. [op.py:458]
* parse_json_safe(raw)                    -> tolerant JSON extraction. [op.py:827]
* The grader schema {intent_score, factual_score, syntax_score, golden_answer,
  feedback} and the knowledge-centric combined score
  (factual*0.72 + intent*0.20 + syntax*0.08) mirror quiz_session. [op.py:1356-1398]

HOW IT TOUCHES KAI'S REWARD/PLASTICITY SURFACE
----------------------------------------------
We do NOT call record_co_firing (src/core/synapse.rs:144) directly — that's
engine-internal. Instead we use the SAME indirect path the live pipeline uses:
bulk-ingesting high-strength cells into the lattice causes them to fire and
co-fire during subsequent recall, which is what drives Hebbian wiring + the
phi_g / dopamine-RPE reward signals inside the engine. A kept STaR rationale is
ingested at strength scaled by the grade, so stronger reasoning imprints harder
— the Python-side analog of dopamine-weighted LTP.

USAGE
-----
  # safe preview, writes nothing:
  python star_reasoning.py --dry-run --limit 5

  # actually ingest kept rationales (engine must be up on :3334):
  python star_reasoning.py --commit --limit 20

  # feed your own items file (jsonl of {"fact":..., "question":...}):
  python star_reasoning.py --items my_items.jsonl --commit
"""

import argparse
import json
import os
import sys
import time

# ── Import the live pipeline's helpers WITHOUT running its loop ────────────────
# overnight_pipeline.py guards its main loop under `if __name__ == "__main__"`
# (it is run as a script), so importing it as a module is side-effect-free apart
# from a few module-level constants/flags. We import the functions we need.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

try:
    from overnight_pipeline import (
        ask_kai,
        ask_teacher,
        bulk_ingest,
        parse_json_safe,
        KAI_CHAT_API,
        KAI_INGEST_API,
    )
except Exception as e:  # pragma: no cover - import-time environment guard
    print(f"[star] Could not import helpers from overnight_pipeline.py: {e}")
    print("[star] Run this from the C:\\KAI directory (next to overnight_pipeline.py).")
    sys.exit(2)


# ── Grading (mirrors quiz_session's rubric, self-contained) ───────────────────
GRADE_SYS = (
    "You are a strict exam grader. Output raw JSON ONLY.\n\n"
    "Schema:\n{\n"
    '  "intent_score": 0-100,\n'
    '  "factual_score": 0-100,\n'
    '  "syntax_score": 0-100,\n'
    '  "golden_answer": "the correct answer",\n'
    '  "feedback": "brief note"\n}\n'
    "CRITICAL: If the answer contains error messages, all scores = 0."
)

PASS_THRESHOLD = 70  # same bar the live quiz loop uses (op.py:1408)


def grade_answer(fact_text, question, kai_answer):
    """Grade KAI's answer with the existing cloud teacher. Returns
    (combined_score, golden_answer, grade_dict) or (None, "", None) if the
    teacher is unavailable (round skipped, never scored 0 on infra)."""
    user = (
        f"FACT: {fact_text}\nQUESTION: {question}\nKAI'S ANSWER: {kai_answer}\n"
        f"Grade strictly. Provide golden_answer."
    )
    raw = ask_teacher(
        [{"role": "system", "content": GRADE_SYS},
         {"role": "user", "content": user}],
        json_mode=True,
    )
    grade = parse_json_safe(raw)
    if not grade:
        return None, "", None
    f = float(grade.get("factual_score", 0) or 0)
    i = float(grade.get("intent_score", 0) or 0)
    s = float(grade.get("syntax_score", 0) or 0)
    combined = round(f * 0.72 + i * 0.20 + s * 0.08, 1)
    return combined, grade.get("golden_answer", "") or "", grade


# ── STaR rationale prompts ────────────────────────────────────────────────────
def ask_kai_with_rationale(question):
    """STaR step 1: ask KAI for a rationale THEN an answer.
    Returns (rationale, answer) — both best-effort parsed from KAI's reply.
    KAI is a sparse-lattice, not an LLM, so we parse leniently."""
    prompt = (
        f"{question}\n\n"
        f"First think step by step (your reasoning), then give your final answer. "
        f"Format:\nReasoning: <your reasoning>\nAnswer: <your final answer>"
    )
    reply = ask_kai(prompt)
    if not reply:
        return None, None
    return _split_rationale(reply)


def rationalize_with_hint(question, golden):
    """STaR step 4 (rationalization): the answer is KNOWN. Ask KAI to produce a
    rationale that justifies the correct answer. This recovers hard items that
    KAI couldn't solve forward, while still capturing a KAI-voiced rationale."""
    prompt = (
        f"{question}\n\n"
        f"The correct answer is: {golden}\n"
        f"Explain step by step WHY that answer is correct (your reasoning), "
        f"then restate the answer.\n"
        f"Format:\nReasoning: <your reasoning>\nAnswer: {golden}"
    )
    reply = ask_kai(prompt)
    if not reply:
        return None
    rationale, _ = _split_rationale(reply)
    return rationale


def _split_rationale(reply):
    """Best-effort split of a reply into (rationale, answer)."""
    text = reply.strip()
    rationale, answer = "", text
    low = text.lower()
    if "answer:" in low:
        idx = low.rfind("answer:")
        answer = text[idx + len("answer:"):].strip()
        head = text[:idx]
        if "reasoning:" in head.lower():
            ridx = head.lower().find("reasoning:")
            rationale = head[ridx + len("reasoning:"):].strip()
        else:
            rationale = head.strip()
    elif "reasoning:" in low:
        ridx = low.find("reasoning:")
        rationale = text[ridx + len("reasoning:"):].strip()
        answer = rationale
    return (rationale or None), (answer or None)


# ── Re-ingestion of kept rationales ───────────────────────────────────────────
def build_ingest_entries(question, rationale, answer, combined, rationalized):
    """Turn a KEPT STaR triple into bulk-ingest entries. Strength scales with the
    grade (the Python-side analog of dopamine-weighted plasticity). Rationales go
    to the 'reasoning' region (same region the live loop uses for WHY cells,
    op.py:1446) so they inform recall but are never recited verbatim as answers."""
    # grade in [0,100] -> strength in ~[1.5, 3.5]; rationalized items get a small
    # discount because the answer was hinted, not self-derived.
    base = 1.5 + (max(0.0, min(100.0, combined)) / 100.0) * 2.0
    strength = round(base * (0.8 if rationalized else 1.0), 2)
    entries = []
    if rationale:
        entries.append({
            "text": f"Reasoning for: {question}\n{rationale}",
            "region": "reasoning",
            "source": "star_rationalized" if rationalized else "star_rationale",
            "strength": strength,
        })
    # Reinforce the clean Q:A pair too (so the answer cell wires with the rationale).
    if answer:
        entries.append({
            "text": f"Q: {question}\nA: {answer}",
            "region": "tutoring",
            "source": "star_qa",
            "strength": round(strength * 0.7, 2),
        })
    return entries


# ── Item sourcing ─────────────────────────────────────────────────────────────
def load_items(path, limit):
    """Load items from a JSONL file ({"fact":..., "question":...} per line). If no
    file is given, fall back to a tiny built-in demo set so --dry-run works out
    of the box without touching any curriculum state."""
    items = []
    if path:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                obj = json.loads(line)
                if "question" in obj:
                    items.append(obj)
    else:
        items = [
            {"fact": "Water boils at 100 degrees Celsius at sea level.",
             "question": "At what temperature does water boil at sea level?"},
            {"fact": "The mitochondrion is the powerhouse of the cell.",
             "question": "What is the primary function of the mitochondrion?"},
            {"fact": "Paris is the capital of France.",
             "question": "What is the capital of France?"},
        ]
    if limit and limit > 0:
        items = items[:limit]
    return items


# ── The STaR loop ─────────────────────────────────────────────────────────────
def run_star(items, dry_run=True, pace=1.0):
    kept, rationalized, skipped, failed_unrecoverable = 0, 0, 0, 0
    all_entries = []

    for n, item in enumerate(items, 1):
        fact = item.get("fact", "")
        question = item["question"]
        print(f"\n[{n}/{len(items)}] Q: {question}")

        rationale, answer = ask_kai_with_rationale(question)
        if answer is None:
            print("  [skip] KAI unavailable / generator offline (not counted).")
            skipped += 1
            continue
        print(f"  KAI rationale: {(rationale or '')[:120]}")
        print(f"  KAI answer:    {answer[:120]}")

        combined, golden, _ = grade_answer(fact, question, answer)
        if combined is None:
            print("  [skip] Teacher unavailable (not counted).")
            skipped += 1
            continue
        print(f"  grade: {combined}/100  (pass>= {PASS_THRESHOLD})")

        was_rationalized = False
        if combined >= PASS_THRESHOLD:
            keep_rationale, keep_answer = rationale, answer
        else:
            # STaR rationalization: hint the golden answer, keep the justification.
            if not golden:
                print("  [drop] wrong + no golden answer to rationalize from.")
                failed_unrecoverable += 1
                continue
            print(f"  rationalizing with hint -> {golden[:80]}")
            keep_rationale = rationalize_with_hint(question, golden)
            keep_answer = golden
            was_rationalized = True
            if not keep_rationale:
                print("  [drop] could not obtain a rationalized rationale.")
                failed_unrecoverable += 1
                continue

        entries = build_ingest_entries(
            question, keep_rationale, keep_answer, combined, was_rationalized
        )
        all_entries.extend(entries)
        if was_rationalized:
            rationalized += 1
        else:
            kept += 1
        tag = "RATIONALIZED" if was_rationalized else "KEPT"
        print(f"  [{tag}] +{len(entries)} ingest entries "
              f"(strength {entries[0]['strength'] if entries else 0})")

        if pace:
            time.sleep(pace)

    # ── Commit / dry-run ─────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print(f"STaR summary: kept(correct)={kept}  rationalized={rationalized}  "
          f"skipped(infra)={skipped}  unrecoverable={failed_unrecoverable}")
    print(f"Total ingest entries: {len(all_entries)}")
    if dry_run:
        print("\n[DRY-RUN] Nothing was written. Preview of entries that WOULD be "
              f"sent to {KAI_INGEST_API}:")
        for e in all_entries[:10]:
            print(f"  - [{e['region']}/{e['source']} s={e['strength']}] "
                  f"{e['text'][:90].replace(chr(10), ' / ')}")
        if len(all_entries) > 10:
            print(f"  ... and {len(all_entries) - 10} more")
    else:
        if all_entries:
            ok = bulk_ingest(all_entries)
            print(f"\n[COMMIT] bulk_ingest -> {'OK' if ok else 'FAILED'} "
                  f"({len(all_entries)} entries)")
        else:
            print("\n[COMMIT] No entries to ingest.")
    return all_entries


def main():
    ap = argparse.ArgumentParser(
        description="STaR Self-Taught Reasoner — standalone, additive, flag-gated."
    )
    ap.add_argument("--items", default=None,
                    help="JSONL file of {fact, question} items. "
                         "Omit to use a tiny built-in demo set.")
    ap.add_argument("--limit", type=int, default=0,
                    help="Max items to process (0 = all).")
    ap.add_argument("--pace", type=float, default=1.0,
                    help="Seconds to sleep between items (be kind to the engine).")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--dry-run", dest="dry_run", action="store_true",
                   help="Preview only; write NOTHING. This is the default.")
    g.add_argument("--commit", dest="dry_run", action="store_false",
                   help="Actually bulk-ingest the kept rationales.")
    ap.set_defaults(dry_run=True)
    args = ap.parse_args()

    print("KAI STaR — Self-Taught Reasoner")
    print(f"  chat endpoint:   {KAI_CHAT_API}")
    print(f"  ingest endpoint: {KAI_INGEST_API}")
    print(f"  mode: {'DRY-RUN (no writes)' if args.dry_run else 'COMMIT (will ingest)'}")

    items = load_items(args.items, args.limit)
    print(f"  items: {len(items)}")
    run_star(items, dry_run=args.dry_run, pace=args.pace)


if __name__ == "__main__":
    main()
