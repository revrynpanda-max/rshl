/**
 * RSHL Core — Sparse Ternary Hyperdimensional Computing
 *
 * Port of kai_unified/rshl_core.py to TypeScript.
 *
 * Vectors are sparse ternary {-1, 0, +1} stored as sorted [index, trit] pairs.
 * 4096 dims at 5% density = ~205 non-zero elements per vector.
 *
 * Why ternary: balanced ternary carries more information per dimension than binary
 * and maps naturally to signed associations (positive / neutral / negative).
 * The Soviet Setun computer proved this out in 1958 — we're just applying it to
 * hyperdimensional associative memory.
 *
 * Key properties:
 * - Two random vectors are nearly orthogonal (dot ≈ 0) — good for discrimination
 * - Superposition of N vecs stores a compressed mixture of all N
 * - Resonance (cosine sim) finds the closest match in the mixture
 * - Sparse storage means queries are O(k) where k = ~205, not O(4096)
 */

export type Trit = -1 | 1;
/** Sparse ternary vector: sorted array of [dimension_index, value] pairs. */
export type SparseVec = Array<[number, Trit]>;

const DIM = 4096;
const SPARSITY = 0.95; // 5% active = 205 non-zero dims

// ── Deterministic hash (FNV-1a 32-bit) ──────────────────────────────────────

function fnv32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// ── Seeded LCG PRNG ──────────────────────────────────────────────────────────

function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

// ── Vector generation ────────────────────────────────────────────────────────

/**
 * Generate a deterministic sparse ternary vector for a single token.
 * Same token always produces the same vector (seeded, no randomness).
 */
export function tokenVec(token: string, dim = DIM, sparsity = SPARSITY): SparseVec {
  const lcg = makeLcg(fnv32(token));
  const numActive = Math.max(1, Math.round(dim * (1 - sparsity)));

  // Pick numActive unique indices from [0, dim)
  const chosen = new Set<number>();
  let attempts = 0;
  while (chosen.size < numActive && attempts < numActive * 8) {
    chosen.add(lcg() % dim);
    attempts++;
  }

  // Assign ternary signs and sort by index
  const result: SparseVec = Array.from(chosen)
    .sort((a, b) => a - b)
    .map((idx) => [idx, (lcg() & 1) ? 1 : -1] as [number, Trit]);
  return result;
}

/**
 * Encode text as a sparse ternary vector via bag-of-words superposition.
 * Includes unigrams + bigrams for better discriminability.
 * "hey whats up kai" → vecs for "hey", "whats", "up", "kai", "hey_whats", "whats_up", "up_kai"
 */
export function textVec(text: string, dim = DIM, sparsity = SPARSITY): SparseVec {
  const words = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter(Boolean);
  if (words.length === 0) return [];

  const tokens: string[] = [...words];
  for (let i = 0; i < words.length - 1; i++) {
    tokens.push(`${words[i]}_${words[i + 1]}`);
  }

  const vecs = tokens.map((t) => tokenVec(t, dim, sparsity));
  return superposeVecs(vecs, dim);
}

// ── Vector algebra ────────────────────────────────────────────────────────────

/**
 * Threshold a dense accumulation back to sparse ternary {-1, 0, +1}.
 * Zero values are dropped (sparse storage).
 */
function thresholdDense(acc: Int16Array): SparseVec {
  const result: SparseVec = [];
  for (let i = 0; i < acc.length; i++) {
    if (acc[i] > 0) result.push([i, 1]);
    else if (acc[i] < 0) result.push([i, -1]);
    // acc[i] === 0 → omit (sparse)
  }
  return result;
}

/**
 * Additive superposition of multiple sparse ternary vectors.
 * Accumulates into a dense int16 buffer, thresholds back to sparse ternary.
 * This is the core "store multiple memories" operation.
 */
export function superposeVecs(vecs: SparseVec[], dim = DIM): SparseVec {
  if (vecs.length === 0) return [];
  if (vecs.length === 1) return vecs[0];

  const acc = new Int16Array(dim);
  for (const vec of vecs) {
    for (const [idx, val] of vec) {
      acc[idx] += val;
    }
  }
  return thresholdDense(acc);
}

/**
 * XOR-style binding: element-wise multiplication where both vectors have non-zero values.
 * Used to associate a key with a value: bind(question_vec, answer_vec).
 * Binding is reversible: bind(bind(q, a), q) ≈ a.
 */
export function bindVecs(a: SparseVec, b: SparseVec): SparseVec {
  if (a.length === 0 || b.length === 0) return [];
  const mapB = new Map<number, Trit>(b);
  const result: SparseVec = [];
  for (const [idx, va] of a) {
    const vb = mapB.get(idx);
    if (vb !== undefined) {
      result.push([idx, (va * vb) as Trit]);
    }
  }
  return result;
}

// ── Similarity ────────────────────────────────────────────────────────────────

/**
 * Cosine similarity between two sparse ternary vectors. Returns [-1, 1].
 * Uses two-pointer walk on sorted arrays → O(k) not O(dim).
 * Since all active values are ±1: magnitude = sqrt(count of non-zeros).
 */
export function cosineSim(a: SparseVec, b: SparseVec): number {
  if (a.length === 0 || b.length === 0) return 0;

  let dot = 0;
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const ia = a[i][0], ib = b[j][0];
    if (ia === ib) {
      dot += a[i][1] * b[j][1]; // ±1 × ±1 = ±1
      i++; j++;
    } else if (ia < ib) {
      i++;
    } else {
      j++;
    }
  }

  return dot / (Math.sqrt(a.length) * Math.sqrt(b.length));
}

/**
 * Resonance score normalized to [0, 1].
 * 1.0 = perfect match, 0.5 = orthogonal (unrelated), 0.0 = perfect anti-match.
 */
export function resonance(a: SparseVec, b: SparseVec): number {
  return (cosineSim(a, b) + 1) * 0.5;
}

// ── Serialization ────────────────────────────────────────────────────────────

export function serializeVec(vec: SparseVec): string {
  return JSON.stringify(vec);
}

export function deserializeVec(s: string): SparseVec {
  try {
    return JSON.parse(s) as SparseVec;
  } catch {
    return [];
  }
}
