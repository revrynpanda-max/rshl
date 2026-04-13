"""
rshl_core.py — Sparse Ternary HDC Engine (Python port)

Canonical spec matches rshl-core.js exactly:
  - 4096 dimensions, 5% density (~205 active per token)
  - FNV-1a 32-bit hash per token
  - LCG PRNG for index/sign generation
  - textVec = tokenize → superpose per-token vectors → threshold
  - cosineSim = dot / (sqrt(nnz_a) * sqrt(nnz_b))

Same input produces same vector in Python and JS.
Requires: numpy
"""
from __future__ import annotations

import math
import re
import time
from dataclasses import dataclass, field
from typing import Dict, List, Tuple

import numpy as np

# ── Constants (must match rshl-core.js) ──────────────────────────────────────
DIM       = 4096
DENSITY   = 0.05
ACTIVE    = round(DIM * DENSITY)   # 205
FNV_PRIME = 0x01000193
FNV_INIT  = 0x811c9dc5
MASK32    = 0xFFFFFFFF


# ── FNV-1a 32-bit (matches JS fnv1a) ─────────────────────────────────────────
def fnv1a(s: str) -> int:
    h = FNV_INIT
    for ch in s:
        h ^= ord(ch)
        h = (h * FNV_PRIME) & MASK32
    return h


# ── LCG PRNG (matches JS lcgNext) ────────────────────────────────────────────
def lcg_next(state: int) -> int:
    return (state * 1664525 + 1013904223) & MASK32


# ── Single token → dense ternary vector ──────────────────────────────────────
def token_vec(token: str) -> np.ndarray:
    state = fnv1a(token)
    used  = bytearray(DIM >> 3)           # bit-set for collision avoidance
    vec   = np.zeros(DIM, dtype=np.int8)

    for _ in range(ACTIVE):
        attempts = 0
        while True:
            state    = lcg_next(state)
            idx      = state % DIM
            attempts += 1
            if not (used[idx >> 3] & (1 << (idx & 7))):
                break
            if attempts > 100:
                break
        used[idx >> 3] |= 1 << (idx & 7)
        state  = lcg_next(state)
        vec[idx] = 1 if (state & 1) else -1

    return vec


# ── Text → superposed ternary vector ─────────────────────────────────────────
def text_vec(text: str) -> np.ndarray:
    tokens = re.sub(r"[^\w\s]", " ", text.lower()).split()
    if not tokens:
        return token_vec(text)
    if len(tokens) == 1:
        return token_vec(tokens[0])

    acc = np.zeros(DIM, dtype=np.int16)
    for tok in tokens:
        acc += token_vec(tok).astype(np.int16)

    out = np.zeros(DIM, dtype=np.int8)
    out[acc > 0] =  1
    out[acc < 0] = -1
    return out


# ── Cosine similarity (matches JS cosineSim) ─────────────────────────────────
def cosine_sim(a: np.ndarray, b: np.ndarray) -> float:
    nnz_a = int(np.count_nonzero(a))
    nnz_b = int(np.count_nonzero(b))
    if nnz_a == 0 or nnz_b == 0:
        return 0.0
    dot = float(np.dot(a.astype(np.float32), b.astype(np.float32)))
    return dot / (math.sqrt(nnz_a) * math.sqrt(nnz_b))


# ── Resonance [0, 1] (matches JS resonance) ──────────────────────────────────
def resonance(a: np.ndarray, b: np.ndarray) -> float:
    return (cosine_sim(a, b) + 1.0) * 0.5


# ── Memory cell ───────────────────────────────────────────────────────────────
@dataclass
class MemoryCell:
    key:        str
    vec:        np.ndarray
    strength:   float
    updated_at: float


# ── RSHLCore ──────────────────────────────────────────────────────────────────
class RSHLCore:
    """
    Sparse ternary HDC memory engine.

    Canonical encoding matches rshl-core.js:
      dim=4096, density=5%, FNV-1a token hashing, LCG index/sign generation,
      per-token superposition, cosine similarity via sqrt(nnz) normalisation.

    Example
    -------
    >>> engine = RSHLCore()
    >>> engine.remember("timeout", "api connection timeout endpoint failed")
    >>> engine.remember("passed",  "test station board calibration passed")
    >>> engine.reinforce("timeout", 0.5)
    >>> hits = engine.recall("api error retry", top_k=3)
    >>> hits[0][0]
    'timeout'
    """

    def __init__(self) -> None:
        self.cells: Dict[str, MemoryCell] = {}

    # ── Write path ──────────────────────────────────────────────────────────
    def remember(self, key: str, text: str, reinforce: float = 0.2) -> None:
        now = time.time()
        vec = text_vec(text)
        old = self.cells.get(key)
        if old is None:
            self.cells[key] = MemoryCell(key=key, vec=vec,
                                          strength=1.0, updated_at=now)
            return
        merged = np.zeros(DIM, dtype=np.int8)
        s = old.vec.astype(np.int16) + vec.astype(np.int16)
        merged[s > 0] =  1
        merged[s < 0] = -1
        old.vec        = merged
        old.strength   = min(5.0, old.strength + max(0.0, reinforce))
        old.updated_at = now

    def reinforce(self, key: str, amount: float = 0.1) -> None:
        c = self.cells.get(key)
        if c:
            c.strength   = min(5.0, c.strength + max(0.0, amount))
            c.updated_at = time.time()

    # ── Read path ───────────────────────────────────────────────────────────
    def recall(self, query_text: str, top_k: int = 5) -> List[Tuple[str, float, float]]:
        """Return [(key, resonance_score, strength)] sorted descending."""
        qvec = text_vec(query_text)
        rows: List[Tuple[str, float, float]] = []
        for k, c in self.cells.items():
            score = resonance(qvec, c.vec)
            rows.append((k, score, c.strength))
        rows.sort(key=lambda x: x[1], reverse=True)
        return rows[:top_k]

    # ── Decay ───────────────────────────────────────────────────────────────
    def decay(self, rate_per_hour: float = 0.02) -> None:
        now = time.time()
        for c in self.cells.values():
            dt_h       = max(0.0, (now - c.updated_at) / 3600.0)
            c.strength = max(0.0, c.strength * math.exp(-rate_per_hour * dt_h))
            c.updated_at = now

    # ── Superposition helpers ───────────────────────────────────────────────
    def bind_xor(self, a: np.ndarray, b: np.ndarray) -> np.ndarray:
        """Signed-XOR proxy for ternary vectors."""
        s = np.zeros(DIM, dtype=np.int8)
        p = a.astype(np.int16) * b.astype(np.int16)
        s[p > 0] =  1
        s[p < 0] = -1
        return s

    def superpose(self, vecs: List[np.ndarray]) -> np.ndarray:
        if not vecs:
            return np.zeros(DIM, dtype=np.int8)
        acc = np.sum(np.stack(vecs).astype(np.int16), axis=0)
        out = np.zeros(DIM, dtype=np.int8)
        out[acc > 0] =  1
        out[acc < 0] = -1
        return out

    # ── Diagnostics ─────────────────────────────────────────────────────────
    def weak_spots(self, threshold: float = 0.3) -> List[str]:
        return [k for k, c in self.cells.items() if c.strength < threshold]

    def summary(self) -> dict:
        strengths = [c.strength for c in self.cells.values()]
        return {
            "total":         len(self.cells),
            "mean_strength": float(np.mean(strengths)) if strengths else 0.0,
            "weak_count":    len(self.weak_spots()),
            "dim":           DIM,
            "density":       DENSITY,
        }
