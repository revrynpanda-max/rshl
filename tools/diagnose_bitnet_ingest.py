#!/usr/bin/env python3
"""
diagnose_bitnet_ingest.py — verify whether KAI's BitNet extraction is actually
being INGESTED, or whether it's silently failing to load.

Run this ON THE MACHINE WHERE KAI LIVES (it inspects the real files and, if the
engine is up, pings it). Read-only — it changes nothing.

    python tools/diagnose_bitnet_ingest.py

Two BitNet paths exist:
  1. NATIVE BRAIN  — models/BitNet/Native/*.kai  (transformer weights, KAI format)
  2. SPARSE VOCAB  — models/BitNet/neural_weights.bin (8 GB) + a structure index
The vocab path loads its index from neural_structure.json. The Rust loader expects
{"layers": [...], "embeddings": {...}} but the file on disk is a GGUF tensor dump
{"model_file","data_offset","tensors"} — a schema mismatch that makes the load
FAIL and leaves the language warehouse EMPTY. This script proves it either way.
"""
import json, os, urllib.request

KAI = os.environ.get("KAI_ROOT", r"C:\KAI")
def p(*a): return os.path.join(KAI, *a)
def human(n):
    for u in ("B","KB","MB","GB"):
        if n < 1024: return f"{n:.1f}{u}"
        n /= 1024
    return f"{n:.1f}TB"

print("="*70); print("KAI BitNet extraction / ingestion diagnostic"); print("="*70)

print("\n[1] Artifact files")
arts = {
    "BitNet model (gguf)":        p("models","BitNet","bitnet-b1.58-2B-4T.gguf"),
    "neural_weights.bin (vocab)": p("models","BitNet","neural_weights.bin"),
    "structure index":            p("data","neural_structure.json"),
    "warehouse json":             p("models","language_warehouse.json"),
    "native brain dir":           p("models","BitNet","Native"),
    "tokenizer":                  p("models","BitNet","tokenizer.json"),
}
for name, path in arts.items():
    if os.path.isdir(path):
        n = len([f for f in os.listdir(path) if f.endswith(".kai")])
        print(f"  OK  {name:24} {n} .kai tensors")
    elif os.path.exists(path):
        print(f"  OK  {name:24} {human(os.path.getsize(path)):>9}")
    else:
        print(f"  XX  {name:24} MISSING ({path})")

print("\n[2] Structure-index schema (does the warehouse loader accept it?)")
sp = arts["structure index"]; verdict_vocab = "UNKNOWN"
if os.path.exists(sp):
    try:
        d = json.load(open(sp, encoding="utf-8")); keys = set(d.keys())
        print(f"  file keys   : {sorted(keys)}")
        print(f"  loader wants: ['embeddings', 'layers']")
        if {"layers","embeddings"}.issubset(keys):
            toks = d.get("embeddings", {}).get("tokens", [])
            verdict_vocab = "OK" if toks else "EMPTY (no tokens)"
            print(f"  MATCH — embeddings.tokens = {len(toks)}")
        else:
            print(f"  MISMATCH — file is a GGUF tensor dump ({len(d.get('tensors',[]))} tensors),")
            print(f"             not layers/embeddings -> serde fails -> vocab loads EMPTY.")
            verdict_vocab = "BROKEN (schema mismatch -> vocab not ingested)"
    except Exception as e:
        print(f"  parse error: {e}"); verdict_vocab = "BROKEN (unparseable)"
else:
    print("  no structure index")

print("\n[3] Native BitNet brain")
nd = arts["native brain dir"]; verdict_brain = "MISSING"
if os.path.isdir(nd):
    kai = [f for f in os.listdir(nd) if f.endswith(".kai")]
    blocks = sorted({f.split('.')[1] for f in kai if f.startswith("blk.") and f.split('.')[1].isdigit()}, key=int)
    print(f"  OK  {len(kai)} tensors across blocks {blocks[:12]}{'...' if len(blocks)>12 else ''}")
    verdict_brain = f"present ({len(kai)} tensors)"
else:
    print("  XX  native brain dir missing")

print("\n[4] Live engine (127.0.0.1:3334)")
try:
    with urllib.request.urlopen("http://127.0.0.1:3334/api/status", timeout=4) as r:
        s = json.load(r)
        print(f"  OK  engine up — {s.get('total_cells','?')} cells, {s.get('synapses','?')} synapses")
except Exception as e:
    print(f"  --  engine not reachable ({e}); start KAI and re-run for a live check.")

print("\n" + "="*70); print("VERDICT")
print(f"  Sparse-vocab warehouse : {verdict_vocab}")
print(f"  Native BitNet brain    : {verdict_brain}")
print("="*70)
if "BROKEN" in verdict_vocab:
    print("\n-> The 8GB neural_weights.bin is NOT being ingested: its index file is the")
    print("   wrong format for the loader. Either regenerate a matching per-token index")
    print("   or retire this path and lean on the native brain.")
