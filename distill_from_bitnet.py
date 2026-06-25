#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
distill_from_bitnet.py — Stage-2 distillation driver (BitNet teacher -> KAI lattice)
====================================================================================

GOAL
----
DISTILL BitNet (teacher) INTO KAI's lattice (student) so that, over time, KAI
reproduces BitNet's behaviour from its OWN lattice — without running the BitNet
transformer live. We do this the data way:

    prompt --> BitNet (offline teacher) --> answer
    bulk_ingest( prompt -> BitNet-answer )  into KAI's lattice

Run it over many nights and KAI's recall converges toward BitNet's outputs.

WHY THIS IS SAFE / ADDITIVE
---------------------------
* BitNet runs ONLY as a SEPARATE OFFLINE process — the already-compiled
  bitnet.cpp `llama-cli.exe`. It does NOT touch the live serving engine and does
  NOT set KAI_NATIVE_BRAIN (the live engine stays transformer-OFF: a RAM fix).
* This file is STANDALONE. It REUSES overnight_pipeline.py's helpers
  (ask_teacher_bitnet, ask_kai, bulk_ingest, parse_json_safe) by importing them,
  speaking to exactly the same /api/oracle-turn and /api/bulk-ingest endpoints
  the live pipeline already uses.
* It DEFAULTS TO --dry-run: nothing is ingested unless you pass --commit.

WHAT IT DOES EACH ITEM
----------------------
1. Take a prompt (from --corpus file, the built-in seed list, or KAI's weak spots).
2. Ask the OFFLINE BitNet teacher for its answer (ask_teacher_bitnet).
3. (Optional, default ON) STaR-style reinforcement: have KAI explain WHY BitNet's
   answer is correct, and keep that rationale — so KAI learns the reasoning bridge,
   not just the verbatim string (reuses the star_reasoning pattern).
4. bulk_ingest the (prompt -> BitNet-answer) pair (+ rationale) into the lattice.

CONVERGENCE CHECK
-----------------
Every --eval-every items (and at the end) we hold out a few prompts, ask BOTH
BitNet and KAI, and print a token-overlap AGREEMENT score (0-100). A rising score
across runs = KAI is moving toward BitNet. Held-out prompts are NEVER ingested.

USAGE
-----
  # safe preview, writes NOTHING (default):
  python distill_from_bitnet.py --dry-run --limit 10

  # real distillation (engine up on :3334, bitnet.cpp built):
  python distill_from_bitnet.py --commit --limit 200

  # use your own prompt corpus (jsonl with "text" or "prompt"/"question" fields,
  # or a plain .txt of one prompt per line):
  python distill_from_bitnet.py --commit --corpus data\\mega_chunk_00.jsonl --limit 100

  # mine KAI's weak spots as prompts (asks KAI, keeps the ones it answers poorly):
  python distill_from_bitnet.py --commit --weakspots --limit 50

For the SCHEDULED overnight pipeline, set TEACHER_PROVIDER=bitnet in
C:\\KAI\\tools\\oracle-discord\\.env — that routes overnight_pipeline.py's whole
tutor/quiz teacher to BitNet automatically inside the existing training windows.
"""

import argparse
import json
import os
import re
import sys
import time

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

# ── Reuse the live pipeline's helpers (import is side-effect-free; its loop is
#    guarded by __main__). ask_teacher_bitnet is the OFFLINE BitNet teacher. ──────
try:
    from overnight_pipeline import (
        ask_teacher_bitnet,
        ask_kai,
        bulk_ingest,
        parse_json_safe,
        _bitnet_available,
        BITNET_CLI,
        BITNET_MODEL,
        KAI_CHAT_API,
        KAI_INGEST_API,
    )
except Exception as e:  # pragma: no cover - import-time environment guard
    print(f"[distill] Could not import helpers from overnight_pipeline.py: {e}")
    print("[distill] Run this from C:\\KAI (next to overnight_pipeline.py).")
    sys.exit(2)


# ── Prompt sourcing ───────────────────────────────────────────────────────────
SEED_PROMPTS = [
    "What is the capital of France, and why is it significant?",
    "Explain what a prime number is in one sentence.",
    "Summarize what photosynthesis does for a plant.",
    "What is the difference between weather and climate?",
    "Give a simple definition of gravity.",
    "What does the word 'ephemeral' mean? Use it in a sentence.",
    "Explain the water cycle in two sentences.",
    "What is 17 multiplied by 23?",
    "Who wrote Romeo and Juliet, and what kind of play is it?",
    "In plain language, what is machine learning?",
    "Why does ice float on water?",
    "What is the function of red blood cells?",
    "Define 'democracy' simply.",
    "What causes the seasons to change?",
    "Explain what an algorithm is to a beginner.",
]


def _extract_prompt_from_corpus_line(obj):
    """Pull a usable prompt out of a corpus JSONL record. Handles {"prompt"},
    {"question"}, or {"text": "User: ..."} shapes (the mega_corpus format stores
    turns as 'User:'/'Assistant:' inside one text field)."""
    if not isinstance(obj, dict):
        return None
    for k in ("prompt", "question"):
        v = obj.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    txt = obj.get("text")
    if isinstance(txt, str) and txt.strip():
        # Only keep the USER side as a prompt; skip Assistant-only records.
        m = re.match(r"\s*(?:User|Human|Q)\s*:\s*(.+)", txt, re.IGNORECASE | re.DOTALL)
        if m:
            # cut at the first Assistant turn if both are in the same blob
            body = m.group(1)
            body = re.split(r"\n\s*(?:Assistant|AI|A)\s*:", body, maxsplit=1)[0]
            return body.strip()[:1200]
        return None
    return None


def load_prompts(corpus, limit):
    """Load prompts from a corpus file (.jsonl or .txt) or fall back to seeds."""
    prompts = []
    if corpus:
        if not os.path.exists(corpus):
            print(f"[distill] corpus not found: {corpus} — using built-in seeds instead.")
        else:
            with open(corpus, "r", encoding="utf-8", errors="ignore") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    if corpus.lower().endswith(".jsonl"):
                        try:
                            p = _extract_prompt_from_corpus_line(json.loads(line))
                        except Exception:
                            p = None
                    else:  # plain text, one prompt per line
                        p = line
                    if p:
                        prompts.append(p)
                    if limit and limit > 0 and len(prompts) >= limit:
                        break
    if not prompts:
        prompts = list(SEED_PROMPTS)
    if limit and limit > 0:
        prompts = prompts[:limit]
    return prompts


def mine_weakspots(seed_pool, limit, pace):
    """Use KAI's OWN weak answers as the distillation target set: ask KAI each
    seed prompt; keep the ones where KAI's reply is short/empty/uncertain (the
    cells most in need of BitNet's signal). Returns a list of prompts."""
    weak = []
    pool = list(seed_pool)
    for q in pool:
        reply = ask_kai(q)
        if reply is None:
            # infra down — fall back to using all seeds rather than blocking
            print("  [weakspots] KAI unavailable — using raw seed prompts.")
            return pool[:limit] if limit else pool
        low = reply.strip().lower()
        uncertain = (len(reply.strip()) < 25
                     or any(s in low for s in ("i'm not sure", "i am not sure",
                                               "i don't know", "i do not know",
                                               "not sure", "what does", "?")))
        if uncertain:
            weak.append(q)
            print(f"  [weakspot] KAI weak on: {q[:70]}")
        if pace:
            time.sleep(pace)
        if limit and limit > 0 and len(weak) >= limit:
            break
    return weak or pool[: (limit or len(pool))]


# ── STaR-style rationale reinforcement (reuses star_reasoning's idea) ──────────
def kai_rationale_for(prompt, golden):
    """Ask KAI to explain WHY BitNet's answer is correct (a reasoning bridge),
    so we ingest understanding, not just a parroted string. Returns text or ''."""
    ask = (
        f"{prompt}\n\n"
        f"The correct answer is: {golden}\n"
        f"In 1-3 short sentences, explain WHY that answer is correct. "
        f"IMPORTANT: If you have any related memories or context, use them to form a connection that helps you understand this better, rather than just guessing. "
        f"Reasoning:"
    )
    reply = ask_kai(ask)
    if not reply:
        return ""
    txt = reply.strip()
    low = txt.lower()
    if "reasoning:" in low:
        txt = txt[low.rfind("reasoning:") + len("reasoning:"):].strip()
    return txt[:600]


# ── Build ingest entries (prompt -> BitNet answer) ────────────────────────────
def build_entries(prompt, answer, rationale):
    """Shape (prompt -> BitNet-answer) into bulk-ingest entries. Region/strength
    mirror the live pipeline so the lattice treats them as real tutoring cells."""
    entries = [
        # Clean answer alone — the high-priority recall target.
        {"text": answer,
         "region": "language", "source": "bitnet_distill", "strength": 2.0},
        # Q:A pair — exact-match retrieval bridge.
        {"text": f"Q: {prompt}\nA: {answer}",
         "region": "tutoring", "source": "bitnet_distill", "strength": 2.4},
        # Pattern hint — wires the question shape to the answer.
        {"text": f"When asked '{prompt[:160]}', answer: {answer}",
         "region": "meta", "source": "bitnet_distill", "strength": 1.4},
    ]
    if rationale:
        # Reasoning region: informs recall but is never recited verbatim as an answer.
        entries.append({
            "text": f"Reasoning for '{prompt[:120]}': {rationale}",
            "region": "reasoning", "source": "bitnet_distill_star", "strength": 1.8,
        })
    return entries


# ── Convergence / agreement score ─────────────────────────────────────────────
_WORD_RE = re.compile(r"[a-z0-9]+")


def _tokens(s):
    return set(_WORD_RE.findall((s or "").lower()))


def agreement_score(kai_text, bitnet_text):
    """Token-overlap (Jaccard) similarity in [0,100] between KAI's answer and
    BitNet's. Crude but monotonic: it RISES as KAI converges toward BitNet. A
    lattice can never match an LLM verbatim, so we track the trend, not 100."""
    a, b = _tokens(kai_text), _tokens(bitnet_text)
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return round(100.0 * inter / union, 1)


def run_convergence_check(held_out, pace):
    """Ask BOTH BitNet and KAI each held-out prompt; print + average the agreement.
    Held-out prompts are NEVER ingested, so this is an honest probe of drift."""
    if not held_out:
        return None
    print("\n  --- CONVERGENCE CHECK (held-out, not ingested) ---")
    scores = []
    for q in held_out:
        bn = ask_teacher_bitnet([{"role": "user", "content": q}])
        if not bn:
            print(f"    [conv] BitNet unavailable for: {q[:50]} — skipped.")
            continue
        ka = ask_kai(q)
        if not ka:
            print(f"    [conv] KAI unavailable for: {q[:50]} — skipped.")
            continue
        sc = agreement_score(ka, bn)
        scores.append(sc)
        print(f"    [conv] agree={sc:5.1f}  Q: {q[:60]}")
        if pace:
            time.sleep(pace)
    if scores:
        avg = round(sum(scores) / len(scores), 1)
        print(f"  --- CONVERGENCE: KAI<->BitNet agreement = {avg}/100 "
              f"(over {len(scores)} held-out prompts) ---")
        return avg
    print("  --- CONVERGENCE: no usable held-out comparisons this round ---")
    return None


# ── Main distillation loop ────────────────────────────────────────────────────
def run_distill(prompts, dry_run=True, use_star=True, pace=1.0,
                eval_every=25, holdout=None):
    holdout = holdout or []
    all_entries = []
    taught, skipped = 0, 0
    convergence_history = []

    total = len(prompts)
    print(f"\n[distill] {total} prompts | star={'on' if use_star else 'off'} | "
          f"mode={'DRY-RUN' if dry_run else 'COMMIT'}")

    for n, prompt in enumerate(prompts, 1):
        print(f"\n[{n}/{total}] PROMPT: {prompt[:90]}")
        answer = ask_teacher_bitnet([{"role": "user", "content": prompt}])
        if not answer:
            print("  [skip] BitNet produced no answer (unavailable/failed) — not counted.")
            skipped += 1
            continue
        ans_safe = answer.encode("ascii", "ignore").decode("ascii")
        print(f"  [BitNet] {ans_safe[:160]}{'...' if len(ans_safe) > 160 else ''}")

        rationale = ""
        if use_star:
            rationale = kai_rationale_for(prompt, answer)
            if rationale:
                r_safe = rationale.encode("ascii", "ignore").decode("ascii")
                print(f"  [KAI rationale] {r_safe[:120]}")

        entries = build_entries(prompt, answer, rationale)
        all_entries.extend(entries)
        taught += 1
        print(f"  [TEACH] +{len(entries)} ingest entries")

        # LIVE SESSION: expose the current step so the dashboard classroom reflects the REAL
        # prompt/answer happening now (not canned). Atomic write so the reader never sees a
        # partial file. Never raises — telemetry must not break the pipeline.
        try:
            import json as _json, time as _time, os as _os
            _live = {"phase": "weave", "n": n, "total": total,
                     "prompt": str(prompt)[:200], "answer": ans_safe[:280],
                     "rationale": (rationale or "")[:200], "teach": len(entries),
                     "ts": int(_time.time())}
            _lp = _os.path.join("C:\\KAI", "data", "kai_live_session.json")
            with open(_lp + ".tmp", "w", encoding="utf-8") as _f:
                _json.dump(_live, _f)
            _os.replace(_lp + ".tmp", _lp)
        except Exception:
            pass

        if not dry_run:
            # Commit incrementally so a long run isn't lost if interrupted, and so
            # the convergence check sees the effect of what we've taught so far.
            ok = bulk_ingest(entries)
            if not ok:
                print("  [commit] bulk_ingest FAILED for this item (continuing).")

        # Periodic convergence probe.
        if eval_every and holdout and n % eval_every == 0:
            avg = run_convergence_check(holdout, pace)
            if avg is not None:
                convergence_history.append((n, avg))

        if pace:
            time.sleep(pace)

    # ── Summary ──────────────────────────────────────────────────────────────
    print("\n" + "=" * 64)
    print(f"[distill] taught={taught}  skipped={skipped}  "
          f"ingest_entries={len(all_entries)}")

    if dry_run:
        print("\n[DRY-RUN] Nothing was written. Sample of entries that WOULD go to "
              f"{KAI_INGEST_API}:")
        for e in all_entries[:8]:
            print(f"  - [{e['region']}/{e['source']} s={e['strength']}] "
                  f"{e['text'][:84].replace(chr(10), ' / ')}")
        if len(all_entries) > 8:
            print(f"  ... and {len(all_entries) - 8} more")

    # Final convergence check (held-out).
    final = run_convergence_check(holdout, pace)
    if final is not None:
        convergence_history.append(("final", final))
    if convergence_history:
        print("\n[distill] convergence trend (KAI<->BitNet agreement):")
        for at, sc in convergence_history:
            print(f"    @{at}: {sc}/100")
        print("  (Run this repeatedly over time — a RISING score = KAI is "
              "distilling BitNet's behaviour into its lattice.)")
    return all_entries


def main():
    ap = argparse.ArgumentParser(
        description="Stage-2 distillation: BitNet (offline teacher) -> KAI lattice."
    )
    ap.add_argument("--corpus", default=None,
                    help="Prompt source: .jsonl (text/prompt/question fields) or "
                         ".txt (one prompt per line). Omit to use built-in seeds.")
    ap.add_argument("--weakspots", action="store_true",
                    help="Mine KAI's OWN weak answers as the prompt set (asks KAI "
                         "the seeds, keeps the ones it answers poorly).")
    ap.add_argument("--limit", type=int, default=0,
                    help="Max prompts to process (0 = all).")
    ap.add_argument("--pace", type=float, default=1.0,
                    help="Seconds to sleep between items (be kind to the engine).")
    ap.add_argument("--no-star", dest="use_star", action="store_false",
                    help="Disable STaR rationale reinforcement (faster).")
    ap.add_argument("--eval-every", type=int, default=25,
                    help="Run a convergence check every N items (0 = only at end).")
    ap.add_argument("--holdout", type=int, default=5,
                    help="How many prompts to hold out for the convergence check "
                         "(never ingested).")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--dry-run", dest="dry_run", action="store_true",
                   help="Preview only; write NOTHING. This is the DEFAULT.")
    g.add_argument("--commit", dest="dry_run", action="store_false",
                   help="Actually bulk-ingest the (prompt -> BitNet answer) pairs.")
    ap.set_defaults(dry_run=True, use_star=True)
    args = ap.parse_args()

    print("KAI <- BitNet  Stage-2 Distillation Driver")
    print(f"  chat endpoint:   {KAI_CHAT_API}")
    print(f"  ingest endpoint: {KAI_INGEST_API}")
    print(f"  BitNet CLI:      {BITNET_CLI}")
    print(f"  BitNet model:    {BITNET_MODEL}")
    print(f"  mode: {'DRY-RUN (no writes)' if args.dry_run else 'COMMIT (will ingest)'}")

    if not _bitnet_available():
        print("\n[distill] BitNet OFFLINE teacher not available on disk.")
        print(f"          Looked for CLI : {BITNET_CLI}")
        print(f"          Looked for MODEL: {BITNET_MODEL}")
        print("          bitnet.cpp is normally pre-built at "
              "C:\\KAI\\bitnet\\build\\bin\\Release\\llama-cli.exe.")
        print("          If missing, build it:")
        print("            cd C:\\KAI\\bitnet")
        print("            python setup_env.py -md C:\\KAI\\models\\BitNet -q i2_s")
        print("          Or set BITNET_CLI / BITNET_MODEL env vars to the right paths.")
        sys.exit(1)

    # Build the prompt set.
    if args.weakspots:
        base = load_prompts(args.corpus, 0) if args.corpus else SEED_PROMPTS
        prompts = mine_weakspots(base, args.limit, args.pace)
    else:
        prompts = load_prompts(args.corpus, args.limit)

    # Hold out a few prompts for the (un-ingested) convergence check.
    holdout = []
    if args.holdout and len(prompts) > args.holdout:
        holdout = prompts[-args.holdout:]
        prompts = prompts[:-args.holdout]

    print(f"  prompts: {len(prompts)}  held-out: {len(holdout)}")
    run_distill(
        prompts,
        dry_run=args.dry_run,
        use_star=args.use_star,
        pace=args.pace,
        eval_every=args.eval_every,
        holdout=holdout,
    )


if __name__ == "__main__":
    main()
