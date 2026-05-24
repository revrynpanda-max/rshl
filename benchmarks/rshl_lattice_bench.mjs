#!/usr/bin/env node
/**
 * rshl_lattice_bench.mjs - RSHL Lattice & Sub-Lattice Throughput / Accuracy Probe
 *
 * Measures the portable RSHL core (RSHL_USB/rshl-core-v3.mjs) - the same engine
 * mirrored from src/core/sparse_vec.rs - and reports:
 *   - Encode Op/s          (text -> 16k sparse ternary vector)
 *   - Cosine Op/s          (full-vector similarity comparisons / sec)
 *   - Dots/sec             (Cosine Op/s * DIM = dimensional MACs / sec)
 *   - Data throughput      (MB of vector data scanned / sec)
 *   - Sparsity efficiency  (active dims vs DIM -> headroom for a sparse kernel)
 *   - VSA recall accuracy  (bundle K vectors, recall each out of full corpus)
 *   - Density vs length    (how the encoder actually behaves on real text)
 *
 * Output: JSON on stdout (so a UI / report can consume it directly).
 */

import { DIM, SPARSITY, TARGET_NNZ, SparseVec, encode } from "../RSHL_USB/rshl-core-v3.mjs";

const hires = () => Number(process.hrtime.bigint()) / 1e6; // ms

const WORDS = ("lattice resonance sovereign cognition geometry vector ternary " +
  "oracle dream synapse boid oscillator phi chi rho entropy memory recall " +
  "claim evidence contradiction region cortex hippocampus thalamus signal").split(" ");
function phrase(i) {
  const a = WORDS[i % WORDS.length];
  const b = WORDS[(i * 7 + 3) % WORDS.length];
  const c = WORDS[(i * 13 + 5) % WORDS.length];
  return `${a} ${b} ${c} ${i}`;
}

// 1. Encode throughput
function benchEncode(n) {
  const s = hires();
  let sink = 0;
  for (let i = 0; i < n; i++) sink += encode(phrase(i)).cachedNorm;
  const ms = hires() - s;
  return { ops: n, ms, opsPerSec: (n / ms) * 1000, _sink: sink };
}

// 2. Cosine throughput
function benchCosine(cells, iter) {
  const a = cells[0], b = cells[1 % cells.length];
  const s = hires();
  let sink = 0;
  for (let i = 0; i < iter; i++) sink += a.cosine(b);
  const ms = hires() - s;
  const opsPerSec = (iter / ms) * 1000;
  return {
    ops: iter, ms, opsPerSec,
    dotsPerSec: opsPerSec * DIM,
    mbPerSec: (opsPerSec * DIM * 2) / (1024 * 1024),
    _sink: sink,
  };
}

// 3. Sparsity efficiency
function benchSparsity(cells) {
  let nnz = 0;
  for (const c of cells) for (let i = 0; i < DIM; i++) if (c.data[i] !== 0) nnz++;
  const avgNnz = nnz / cells.length;
  return {
    dim: DIM,
    avgActiveDims: avgNnz,
    measuredSparsity: avgNnz / DIM,
    targetSparsity: SPARSITY,
    targetNnz: TARGET_NNZ,
    skippableFraction: 1 - avgNnz / DIM,
  };
}

// 4. VSA recall accuracy: bundle K cells, recall each out of the FULL corpus.
function bundle(vs) {
  const acc = new Int32Array(DIM);
  for (const v of vs) for (let i = 0; i < DIM; i++) acc[i] += v.data[i];
  const data = new Int8Array(DIM);
  for (let i = 0; i < DIM; i++) data[i] = acc[i] > 0 ? 1 : acc[i] < 0 ? -1 : 0;
  return new SparseVec(data);
}
function benchAccuracy(cells, bundleSizes) {
  const out = [];
  for (const K of bundleSizes) {
    if (K * 2 > cells.length) continue;
    let recalled = 0, trials = 0;
    let memberSimSum = 0, nonMemberSimSum = 0;
    const groups = Math.min(12, Math.floor(cells.length / K));
    for (let g = 0; g < groups; g++) {
      const memberIdx = new Set();
      for (let k = 0; k < K; k++) memberIdx.add(g * K + k);
      const members = [...memberIdx].map(i => cells[i]);
      const b = bundle(members);
      const sims = cells.map((c, i) => ({ i, s: b.cosine(c) }));
      sims.sort((a, z) => z.s - a.s);
      const topK = new Set(sims.slice(0, K).map(x => x.i));
      for (const mi of memberIdx) { if (topK.has(mi)) recalled++; trials++; }
      for (const x of sims) {
        if (memberIdx.has(x.i)) memberSimSum += x.s;
        else nonMemberSimSum += x.s;
      }
    }
    const memberAvg = memberSimSum / (groups * K);
    const nonMemberAvg = nonMemberSimSum / (groups * (cells.length - K));
    out.push({
      bundleSize: K, trials, recalled,
      recallAtK: trials ? recalled / trials : 0,
      memberCosineAvg: memberAvg,
      nonMemberCosineAvg: nonMemberAvg,
      discriminabilityMargin: memberAvg - nonMemberAvg,
    });
  }
  return out;
}

// 5. Density vs text length (shows how the encoder actually behaves)
function benchDensityVsLength() {
  const out = [];
  for (const words of [1, 3, 8, 20, 50, 120]) {
    const txt = Array.from({ length: words }, (_, i) => WORDS[(i * 17 + 1) % WORDS.length]).join(" ");
    const v = encode(txt);
    let nnz = 0;
    for (let i = 0; i < DIM; i++) if (v.data[i] !== 0) nnz++;
    out.push({ words, activeDims: nnz, density: nnz / DIM });
  }
  return out;
}

// Run
const N_CELLS = 1515; // mirrors KAI's reported live lattice size
console.error(`[bench] encoding ${N_CELLS} cells...`);
const cells = [];
for (let i = 0; i < N_CELLS; i++) cells.push(encode(phrase(i)));

benchCosine(cells, 2000); // warm up JIT

const encodeRes = benchEncode(2000);
const cosineRes = benchCosine(cells, 200000);
const sparsity = benchSparsity(cells);
const accuracy = benchAccuracy(cells, [2, 4, 8, 16, 32, 64]);
const densityCurve = benchDensityVsLength();

const result = {
  meta: {
    dim: DIM,
    sparseIndexWidthBits: 16,
    maxAddressableDim: 65536,
    node: process.version,
    when: new Date().toISOString(),
  },
  lattice: {
    cells: N_CELLS,
    bytesPerCell: DIM,
    totalBytes: N_CELLS * DIM,
    totalMB: (N_CELLS * DIM) / (1024 * 1024),
  },
  encode: encodeRes,
  cosine: cosineRes,
  sparsity,
  accuracy,
  densityCurve,
};
console.log(JSON.stringify(result, null, 2));
