"""
prune_duplicates.py — Remove duplicate identity cells from kai-state.json.

Problem: 27 identical "My name is KAI." cells (and similar seed duplicates)
add noise to the phasor sum without adding any new information.

Strategy: parse the state JSON, keep only the FIRST occurrence of each
unique (text, source) pair. On duplicate, keep the one with the HIGHER
strength value (in case some were reinforced). Then write back.

Run with: python prune_duplicates.py
"""

import json, sys, shutil, os, re
from datetime import datetime

STATE = "data/kai-state.json"
BACKUP = "data/kai-state.backup-prededup-" + datetime.now().strftime("%Y%m%d-%H%M%S") + ".json"

print("Loading", STATE, "...")
try:
    with open(STATE, "r", encoding="utf-8") as f:
        data = json.load(f)
except json.JSONDecodeError as e:
    print("ERROR: Could not parse", STATE)
    print("  ", e)
    print()
    print("The state file may be truncated (written mid-operation).")
    print("You can recover from a backup:")
    backups = [f for f in os.listdir("data") if f.startswith("kai-state") and "backup" in f]
    for b in sorted(backups, reverse=True)[:5]:
        print("  data/" + b)
    sys.exit(1)

cells = data.get("universe", {}).get("cells", [])
print("Total cells before dedup:", len(cells))

# Build dedup map: key = (text.strip(), source)
# Keep the cell with the highest strength on collision
seen = {}
kept = []
removed = 0

for cell in cells:
    key = (cell.get("text", "").strip(), cell.get("source", ""))
    if key in seen:
        # Keep the stronger one
        existing_idx = seen[key]
        if cell.get("strength", 0) > kept[existing_idx].get("strength", 0):
            kept[existing_idx] = cell
        removed += 1
    else:
        seen[key] = len(kept)
        kept.append(cell)

print("Duplicates removed      :", removed)
print("Cells after dedup       :", len(kept))

if removed == 0:
    print("No duplicates found — nothing to do.")
    sys.exit(0)

# Show what was pruned (top 10 most-duplicated texts)
from collections import Counter
texts = [c.get("text", "").strip() for c in cells]
counts = Counter(texts)
print()
print("Top duplicate texts (removed extras):")
for text, count in counts.most_common(10):
    if count > 1:
        print(f"  [{count}x] {text[:80]}")

# Backup before writing
print()
print("Backing up to", BACKUP)
shutil.copy2(STATE, BACKUP)

# Write repaired state
data["universe"]["cells"] = kept

print("Writing repaired state...")
with open(STATE, "w", encoding="utf-8") as f:
    json.dump(data, f, separators=(",", ":"))

print("Done. State saved.")
print()
print("Summary:")
print("  Before:", len(cells), "cells")
print("  After :", len(kept), "cells")
print("  Pruned:", removed, "duplicates")
print()
print("Restart KAI to load the pruned state.")
