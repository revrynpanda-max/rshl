"""
RSHL basic usage — Python

Demonstrates: store memories, recall by resonance, Hebbian reinforcement, decay.
Requires: numpy

Run: python examples/basic-py.py
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from rshl_core import RSHLCore

# ── 1. Create engine ──────────────────────────────────────────────────────────
# dim=10000, sparsity=0.95 → 500 active dims per vector

engine = RSHLCore(dim=10_000, sparsity=0.95)

# ── 2. Store memories ─────────────────────────────────────────────────────────

engine.remember("api-timeout",  "api connection timeout endpoint failed retry")
engine.remember("board-pass",   "test station board calibration passed all checks")
engine.remember("deploy-done",  "deployment pipeline completed successfully all stages")
engine.remember("mem-error",    "memory allocation error in worker thread process")
engine.remember("config-drift", "configuration drift detected on node cluster settings")
engine.remember("auth-token",   "authentication token issued user session started")
engine.remember("sensor-range", "sensor reading out of expected range threshold exceeded")

# Reinforce something accessed often
engine.reinforce("api-timeout", amount=0.5)
engine.reinforce("board-pass",  amount=0.3)

# ── 3. Recall by resonance ────────────────────────────────────────────────────

queries = [
    "api error timeout",
    "test board passed",
    "memory problem crash",
]

for q in queries:
    hits = engine.resonance(q, top_k=3)
    print(f'\nQuery: "{q}"')
    for key, score, strength in hits:
        bar = "█" * round(score * 20)
        print(f"  {bar:<20} {score:.3f}  [{key}]  strength={strength:.2f}")

# ── 4. Decay and weak spots ───────────────────────────────────────────────────

print("\nBefore decay:", engine.summary())
engine.decay(rate_per_hour=2.0)   # fast decay for demo
print("After decay: ", engine.summary())

weak = engine.weak_spots(threshold=0.5)
if weak:
    print(f"Weak memories (strength < 0.5): {weak}")

# ── 5. Binding example — associate question with answer ──────────────────────
# bind(q_vec, a_vec) stores the association.
# bind(association, q_vec) retrieves ≈ a_vec.

import numpy as np

question = engine._ternary("what is the capital of France")
answer   = engine._ternary("Paris")
bound    = engine.bind_xor(question, answer)

# Retrieve: bind(bound, question) ≈ answer
retrieved = engine.bind_xor(bound, question)
sim = float(np.dot(retrieved.astype(np.float32), answer.astype(np.float32)) /
            (np.linalg.norm(retrieved) * np.linalg.norm(answer) + 1e-6))
print(f"\nBinding retrieval similarity: {sim:.3f}  (1.0 = perfect)")
