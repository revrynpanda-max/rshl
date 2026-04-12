"""RSHL HDC core for kai_unified.

Sparse ternary int8 vectors (10k dims), XOR-style binding, superposition,
additive analogy, cosine resonance, Hebbian reinforcement, and decay.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Dict, List, Tuple

import numpy as np


@dataclass
class MemoryCell:
    key: str
    vec: np.ndarray
    strength: float
    updated_at: float


class RSHLCore:
    def __init__(self, dim: int = 10_000, sparsity: float = 0.95) -> None:
        self.dim = dim
        self.sparsity = max(0.0, min(0.99, sparsity))
        self.cells: Dict[str, MemoryCell] = {}

    def _ternary(self, seed: str) -> np.ndarray:
        rng = np.random.default_rng(abs(hash(seed)) % (2**32))
        v = np.zeros(self.dim, dtype=np.int8)
        k = max(1, int(self.dim * (1.0 - self.sparsity)))
        idx = rng.choice(self.dim, size=k, replace=False)
        signs = rng.choice([-1, 1], size=k)
        v[idx] = signs.astype(np.int8)
        return v

    @staticmethod
    def _threshold(v: np.ndarray) -> np.ndarray:
        out = np.zeros_like(v, dtype=np.int8)
        out[v > 0] = 1
        out[v < 0] = -1
        return out

    def bind_xor(self, a: np.ndarray, b: np.ndarray) -> np.ndarray:
        # Signed-XOR proxy for ternary vectors.
        return self._threshold(a.astype(np.int16) * b.astype(np.int16))

    def superpose(self, vecs: List[np.ndarray]) -> np.ndarray:
        if not vecs:
            return np.zeros(self.dim, dtype=np.int8)
        s = np.sum(np.stack(vecs).astype(np.int16), axis=0)
        return self._threshold(s)

    def analogy(self, a: np.ndarray, b: np.ndarray, c: np.ndarray) -> np.ndarray:
        # a:b :: c:?
        return self._threshold(c.astype(np.int16) + b.astype(np.int16) - a.astype(np.int16))

    def remember(self, key: str, text: str, reinforce: float = 0.2) -> None:
        now = time.time()
        vec = self._ternary(text)
        old = self.cells.get(key)
        if old is None:
            self.cells[key] = MemoryCell(key=key, vec=vec, strength=1.0, updated_at=now)
            return
        merged = self._threshold(old.vec.astype(np.int16) + vec.astype(np.int16))
        old.vec = merged
        old.strength = min(5.0, old.strength + max(0.0, reinforce))
        old.updated_at = now

    def decay(self, rate_per_hour: float = 0.02) -> None:
        now = time.time()
        for c in self.cells.values():
            dt_h = max(0.0, (now - c.updated_at) / 3600.0)
            c.strength = max(0.0, c.strength * math.exp(-rate_per_hour * dt_h))
            c.updated_at = now

    def reinforce(self, key: str, amount: float = 0.1) -> None:
        c = self.cells.get(key)
        if c:
            c.strength = min(5.0, c.strength + max(0.0, amount))
            c.updated_at = time.time()

    def resonance(self, probe_text: str, top_k: int = 5) -> List[Tuple[str, float, float]]:
        p = self._ternary(probe_text).astype(np.float32)
        pn = float(np.linalg.norm(p) + 1e-6)
        rows: List[Tuple[str, float, float]] = []
        for k, c in self.cells.items():
            v = c.vec.astype(np.float32)
            sim = float(np.dot(p, v) / (pn * (float(np.linalg.norm(v)) + 1e-6)))
            score = (sim + 1.0) * 0.5
            rows.append((k, score, c.strength))
        rows.sort(key=lambda x: x[1], reverse=True)
        return rows[:top_k]

    def weak_spots(self, threshold: float = 0.3) -> List[str]:
        return [k for k, c in self.cells.items() if c.strength < threshold]

    def summary(self) -> dict:
        strengths = [c.strength for c in self.cells.values()]
        return {
            "total": len(self.cells),
            "mean_strength": float(np.mean(strengths)) if strengths else 0.0,
            "weak_count": len(self.weak_spots()),
            "dim": self.dim,
            "sparsity": self.sparsity,
        }

