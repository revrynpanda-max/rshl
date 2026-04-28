"""
truth_align.py — Attenuate speculative physics cells to reduce phasor contradiction.

Root cause of E=mc² DISSONANCE:
  1,652 dream-discovery cells + 223 world-bridge cells contribute phasors that
  destructively interfere with the 21 physics-core cells. The phasor sum gives
  chi (χ) values of 0.79–0.91 even for well-established facts.

Strategy (Truth Alignment):
  - dream-discovery cells with LOW convergence_score (< 1.5): attenuate strength to 0.3
    These are the speculative cells that were ingested under contradiction pressure.
  - world-bridge cells: attenuate to 0.4 (they're cross-domain bridges, keep some weight)
  - physics-core cells: BOOST to 4.0 (they are the truth anchors — give them more phasor weight)
  - hlv: section cells: attenuate to 0.2 (raw speculative HLV doc cells, very noisy)

This does NOT delete cells — retrieval still works, but the truth-anchors now
dominate the phasor sum. Chi should drop toward 0.5-0.7 for established facts.

Run with: python truth_align.py
"""

import json, shutil
from datetime import datetime

STATE = "data/kai-state.json"
BACKUP = "data/kai-state.backup-pre-truth-align-" + datetime.now().strftime("%Y%m%d-%H%M%S") + ".json"

print("Loading", STATE, "...")
with open(STATE) as f:
    data = json.load(f)

cells = data["universe"]["cells"]
print("Total cells:", len(cells))

# Count by source before
from collections import defaultdict
before_stats = defaultdict(lambda: {"count": 0, "strength_sum": 0.0})
for c in cells:
    s = c.get("source", "unknown")
    before_stats[s]["count"] += 1
    before_stats[s]["strength_sum"] += c.get("strength", 1.0)

modified = 0

for cell in cells:
    src = cell.get("source", "")
    conv = cell.get("convergence_score", 2.0)
    old_strength = cell.get("strength", 1.0)

    if src == "physics-core":
        # Truth anchors — BOOST phasor weight
        new_strength = max(old_strength, 4.0)
        if new_strength != old_strength:
            cell["strength"] = new_strength
            modified += 1

    elif src == "dream-discovery" and conv < 1.5:
        # High-contradiction speculative cells — attenuate strongly
        new_strength = min(old_strength, 0.3)
        if new_strength != old_strength:
            cell["strength"] = new_strength
            modified += 1

    elif src == "dream-discovery" and conv < 2.5:
        # Moderate contradiction — mild attenuation
        new_strength = min(old_strength, 0.6)
        if new_strength != old_strength:
            cell["strength"] = new_strength
            modified += 1

    elif src == "world-bridge":
        # Cross-domain inference cells — moderate attenuation
        new_strength = min(old_strength, 0.4)
        if new_strength != old_strength:
            cell["strength"] = new_strength
            modified += 1

    elif src.startswith("hlv:") and "Preamble" not in src:
        # Raw speculative HLV document chunks — attenuate
        new_strength = min(old_strength, 0.2)
        if new_strength != old_strength:
            cell["strength"] = new_strength
            modified += 1

print("Cells modified:", modified)

# Show summary
after_stats = defaultdict(lambda: {"count": 0, "strength_sum": 0.0})
for c in cells:
    s = c.get("source", "unknown")
    after_stats[s]["count"] += 1
    after_stats[s]["strength_sum"] += c.get("strength", 1.0)

print()
print(f"{'source':<32} {'cells':>6}  {'avg_strength_before':>20}  {'avg_strength_after':>18}")
print("-" * 82)
all_sources = set(list(before_stats.keys()) + list(after_stats.keys()))
for src in sorted(all_sources, key=lambda s: -after_stats[s]["count"]):
    b = before_stats[src]
    a = after_stats[src]
    b_avg = b["strength_sum"] / b["count"] if b["count"] > 0 else 0
    a_avg = a["strength_sum"] / a["count"] if a["count"] > 0 else 0
    src_short = src[:32]
    print(f"{src_short:<32} {a['count']:>6}  {b_avg:>20.3f}  {a_avg:>18.3f}")

# Backup original and write
print()
print("Backing up to", BACKUP)
shutil.copy2(STATE, BACKUP)

data["universe"]["cells"] = cells
print("Writing truth-aligned state...")
with open(STATE, "w", encoding="utf-8") as f:
    json.dump(data, f, separators=(",", ":"))

print()
print("Truth alignment complete.")
print("physics-core cells boosted to 4.0 phasor weight.")
print("dream-discovery (low conv_score) attenuated to 0.3.")
print("world-bridge attenuated to 0.4.")
print()
print("Next: cargo run --release --bin kai -- --train-truths")
print("Then: start KAI and test E=mc², quasicrystal, ether queries.")
