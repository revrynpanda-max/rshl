#!/usr/bin/env python3
"""
extract_bitnet_to_lattice.py — Project BitNet per-token embeddings into KAI's
16384-dim SPARSE TERNARY lattice space and emit the EXACT artifacts the Rust
`LanguageWarehouse` loader expects.

WHY THIS EXISTS
---------------
The old `extract_bitnet_weights.py` wrote `neural_structure.json` as a GGUF
tensor dump ({"model_file","data_offset","tensors":[...]}). The Rust loader
`LanguageWarehouse::load_neural_structure` deserializes into:

    NeuralStructure   { layers: Vec<LayerMeta>, embeddings: EmbeddingsContainer }
    EmbeddingsContainer { count: usize, tokens: Vec<EmbeddingMeta> }
    EmbeddingMeta     { token: String, offset: usize, size: usize, nonzero: usize }
    LayerMeta         { name: String, dims: Vec<usize>, offset: usize, weight_size: usize }

Schema mismatch -> serde fails -> vocab loads EMPTY -> the engine fell back to
the live transformer. This script writes the CORRECT schema so the lattice
vocab actually loads, and the engine uses its OWN brain (the lattice) instead
of running the 2B transformer.

BYTE CONTRACT (must match the Rust reader exactly)
--------------------------------------------------
The Rust side memory-maps  C:\\KAI\\models\\BitNet\\neural_weights.bin  and for
each token reads the slice [offset .. offset+size]:

    bytes  0 .. 4            : count          (u32 LE)  -- MUST equal meta.nonzero
    bytes  4 .. 4+count*4    : indices        (count * u32 LE, each value < 16384)
    bytes  4+count*4 .. +count : signs         (count * i8, each -1 or +1)

    => size == 4 + count*4 + count == 4 + nonzero*5

Indices MUST be sorted ascending (the cosine merge-walk in SparseTernaryVec /
cosine_mmap assumes ascending order) and strictly < 16384 (they are read as
u16 against dim=16384). `offset` is ABSOLUTE from the start of the .bin file.

This layout is byte-for-byte identical to the old `write_sparse_binary`, so
`get_lazy()` and `cosine_mmap()` read it unchanged.

PROJECTION (matches the lattice's sparse-ternary scheme)
--------------------------------------------------------
KAI's lattice cells are 16384-dim, ~4% dense, ternary {-1,0,+1}. We reproduce
that exact shape for each token:

  1. dense BitNet embedding  e  (dim = embedding_length, e.g. 2560), f32.
  2. logits = R @ e, where R is a FIXED-SEED signed sparse random projection
     (16384 x embedding_length). This is the same family of transform as the
     neural_mapper's frozen W1/W2 probe — a linear map into DIM logits — but
     deterministic and dependency-free so the .bin is fully reproducible and
     self-consistent (no separately-trained checkpoint required at runtime).
  3. ternarize_top_k: keep the top (DIM * density) dims by |logit|, write +1
     where the logit was positive and -1 where negative, 0 elsewhere. density
     defaults to 0.04 -> ~655 nonzeros, matching RSHL SPARSITY.

Because EVERY token goes through the SAME deterministic R and the SAME top-K
rule, the resulting vectors are mutually comparable (cosine) AND comparable to
phrase_embedding output (which is just from_words() superposition of these same
token vectors). Vectors live in the identical 16384-dim, ~4%-dense ternary
space that lattice cells use, so similarities are meaningful.

USAGE (run on the KAI machine — needs numpy + the BitNet model present)
-----------------------------------------------------------------------
  # Canonical: read embeddings AND tokens from the GGUF (index-aligned):
  python extract_bitnet_to_lattice.py \
      --gguf models/BitNet/bitnet-b1.58-2B-4T.gguf \
      --out-bin models/BitNet/neural_weights.bin \
      --out-json data/neural_structure.json

  # Alternative: read embeddings from the already-extracted .kai float layer,
  # with token strings from the GGUF or tokenizer.json:
  python extract_bitnet_to_lattice.py \
      --kai models/BitNet/Native/token_embd.weight.kai \
      --tokenizer models/BitNet/tokenizer.json \
      --out-bin models/BitNet/neural_weights.bin \
      --out-json data/neural_structure.json

Only ADDITIVE: it never touches the .kai native brain or the old extractor.
"""

import argparse
import json
import os
import struct
import sys
from pathlib import Path

# ── KAI lattice constants (must match src/core/sparse_vec.rs) ────────────────
DIM = 16384            # SparseTernaryVec / SparseVec dimension
DEFAULT_DENSITY = 0.04 # RSHL SPARSITY (sparse_vec.rs); ~655 nonzeros
PROJ_SEED = 0xC0FFEE   # fixed seed for the projection matrix (reproducible)
PROJ_NNZ_PER_ROW = 32  # nonzeros per output row in the sparse projection R


# ── GGUF parsing (self-contained, mirrors extract_bitnet_weights.py) ─────────
GGUF_MAGIC = b"GGUF"
GGUF_TYPE_SIZES = {0:1,1:1,2:2,3:2,4:4,5:4,6:4,7:1,8:None,9:None,10:8,11:8,12:8}
GGUF_TYPE_FMT   = {0:"B",1:"b",2:"H",3:"h",4:"I",5:"i",6:"f",7:"?",10:"Q",11:"q",12:"d"}


def _read_string(f):
    (length,) = struct.unpack("<Q", f.read(8))
    if length == 0:
        return ""
    return f.read(length).decode("utf-8", errors="replace")


def _read_value(f, val_type):
    if val_type == 8:  # STRING
        return _read_string(f)
    if val_type == 9:  # ARRAY
        (arr_type,) = struct.unpack("<I", f.read(4))
        (arr_len,) = struct.unpack("<Q", f.read(8))
        return [_read_value(f, arr_type) for _ in range(arr_len)]
    size = GGUF_TYPE_SIZES[val_type]
    fmt = GGUF_TYPE_FMT[val_type]
    return struct.unpack(f"<{fmt}", f.read(size))[0]


def parse_gguf(path):
    with open(path, "rb") as f:
        if f.read(4) != GGUF_MAGIC:
            raise ValueError("Not a GGUF file (bad magic)")
        (version,) = struct.unpack("<I", f.read(4))
        (tensor_count,) = struct.unpack("<Q", f.read(8))
        (metadata_count,) = struct.unpack("<Q", f.read(8))
        metadata = {}
        for _ in range(metadata_count):
            key = _read_string(f)
            (vt,) = struct.unpack("<I", f.read(4))
            metadata[key] = _read_value(f, vt)
        tensors = []
        for _ in range(tensor_count):
            name = _read_string(f)
            (n_dims,) = struct.unpack("<I", f.read(4))
            dims = list(struct.unpack(f"<{n_dims}Q", f.read(n_dims * 8)))
            (ggml_type,) = struct.unpack("<I", f.read(4))
            (offset,) = struct.unpack("<Q", f.read(8))
            tensors.append({"name": name, "dims": dims, "ggml_type": ggml_type, "offset": offset})
        data_offset = f.tell()
    print(f"[GGUF] version={version} tensors={tensor_count} meta_kv={metadata_count}")
    return metadata, tensors, data_offset


# ── Embedding sources ────────────────────────────────────────────────────────
def load_embeddings_from_gguf(gguf_path):
    """Return (embeddings float32 [vocab, dim], tokens list[str])."""
    import numpy as np
    metadata, tensors, data_offset = parse_gguf(gguf_path)
    arch = metadata.get("general.architecture", "bitnet")
    emb_len = metadata.get(f"{arch}.embedding_length", 0)
    vocab_size = metadata.get(f"{arch}.vocab_size", 0)
    tokens = metadata.get("tokenizer.ggml.tokens", [])
    print(f"[GGUF] arch={arch} embedding_length={emb_len} vocab_size={vocab_size} tokens={len(tokens)}")

    tinfo = None
    for t in tensors:
        if "token_embd" in t["name"] or "embed" in t["name"].lower():
            tinfo = t
            break
    if tinfo is None:
        raise ValueError("No token_embd tensor found in GGUF")

    dims = tinfo["dims"]          # GGUF layout: [embedding_length, vocab_size]
    ggml_type = tinfo["ggml_type"]
    if ggml_type not in (0, 1):
        raise ValueError(
            f"token_embd is type {ggml_type}; this script reads F32(0)/F16(1) "
            f"embeddings. For ternary-quantized embeddings extract floats first "
            f"(tools/extract_floats.py) and use --kai."
        )
    emb_dim = dims[0]
    n_vocab = dims[1] if len(dims) > 1 else vocab_size
    n_elems = emb_dim * n_vocab
    nbytes = n_elems * (4 if ggml_type == 0 else 2)

    with open(gguf_path, "rb") as f:
        f.seek(data_offset + tinfo["offset"])
        raw = f.read(nbytes)
    if ggml_type == 0:
        arr = np.frombuffer(raw, dtype=np.float32)
    else:
        arr = np.frombuffer(raw, dtype=np.float16).astype(np.float32)
    arr = arr.reshape(n_vocab, emb_dim)  # row i = token i's embedding
    return arr, list(tokens)


def load_embeddings_from_kai(kai_path):
    """Return (embeddings float32 [rows, cols], None). token_embd.weight.kai is
    a KAI1 FloatLayer: rows=vocab_size, cols=embedding_length (see extract_floats.py)."""
    import numpy as np
    with open(kai_path, "rb") as f:
        magic = f.read(4)
        if magic != b"KAI1":
            raise ValueError(f"{kai_path}: expected KAI1 magic, got {magic!r}")
        (rows,) = struct.unpack("<I", f.read(4))
        (cols,) = struct.unpack("<I", f.read(4))
        (data_len,) = struct.unpack("<I", f.read(4))
        raw = f.read(data_len)
    arr = np.frombuffer(raw, dtype=np.float32).reshape(rows, cols)
    print(f"[KAI] token_embd: rows={rows} cols={cols} ({data_len/1e6:.1f} MB f32)")
    return arr, None


def load_tokens_from_tokenizer(tokenizer_path, n_vocab):
    """Invert tokenizer.json model.vocab ({token: id}) into an index-ordered list."""
    print(f"[tokenizer] loading {tokenizer_path} ...")
    with open(tokenizer_path, "r", encoding="utf-8") as f:
        tj = json.load(f)
    vocab = tj.get("model", {}).get("vocab", {})
    if not vocab:
        raise ValueError("tokenizer.json has no model.vocab map")
    tokens = ["<unk_{}>".format(i) for i in range(n_vocab)]
    for tok, idx in vocab.items():
        if isinstance(idx, int) and 0 <= idx < n_vocab:
            tokens[idx] = tok
    print(f"[tokenizer] mapped {len(vocab)} entries")
    return tokens


def clean_token(tok):
    """Normalise BPE/sentencepiece markers so the warehouse keys are plain words.
    Matches the cleaning the old extractor did (leading space markers, ## )."""
    if not isinstance(tok, str):
        tok = str(tok)
    # SentencePiece space marker U+2581, GPT2 byte-level space marker U+0120
    if tok.startswith("▁"):
        tok = tok[1:]
    if tok.startswith("Ġ"):
        tok = tok[1:]
    if tok.startswith("##"):
        tok = tok[2:]
    return tok


# ── Deterministic sparse signed random projection  R : emb_dim -> DIM ────────
class _XorShift64:
    """Deterministic PRNG (xorshift64*). Independent of numpy RNG versions so the
    .bin is byte-reproducible across machines/numpy releases."""
    __slots__ = ("s",)

    def __init__(self, seed):
        self.s = seed & 0xFFFFFFFFFFFFFFFF
        if self.s == 0:
            self.s = 0x9E3779B97F4A7C15

    def next_u64(self):
        x = self.s
        x ^= (x >> 12) & 0xFFFFFFFFFFFFFFFF
        x ^= (x << 25) & 0xFFFFFFFFFFFFFFFF
        x ^= (x >> 27) & 0xFFFFFFFFFFFFFFFF
        self.s = x & 0xFFFFFFFFFFFFFFFF
        return (self.s * 0x2545F4914F6CDD1D) & 0xFFFFFFFFFFFFFFFF


def build_projection(emb_dim, dim=DIM, nnz_per_row=PROJ_NNZ_PER_ROW, seed=PROJ_SEED):
    """Build a sparse signed projection matrix R (dim x emb_dim) as numpy arrays.

    Each of the `dim` output rows samples `nnz_per_row` input columns with random
    +/-1 signs (Achlioptas sparse random projection). Returned as a CSR-like pair
    (cols [dim, nnz], signs [dim, nnz]) for a fast batched matmul.
    """
    import numpy as np
    rng = _XorShift64(seed)
    cols = np.empty((dim, nnz_per_row), dtype=np.int64)
    signs = np.empty((dim, nnz_per_row), dtype=np.float32)
    for r in range(dim):
        for k in range(nnz_per_row):
            cols[r, k] = rng.next_u64() % emb_dim
            signs[r, k] = 1.0 if (rng.next_u64() & 1) else -1.0
    return cols, signs


def project_logits(emb_batch, cols, signs):
    """logits[b, r] = sum_k signs[r,k] * emb_batch[b, cols[r,k]].  Shapes:
    emb_batch [B, emb_dim] -> logits [B, DIM]."""
    import numpy as np
    # gather: [B, DIM, nnz]  then weighted sum over nnz
    gathered = emb_batch[:, cols]            # [B, DIM, nnz]
    return np.einsum("bdk,dk->bd", gathered, signs, optimize=True).astype(np.float32)


def ternarize_top_k(logits_row, density=DEFAULT_DENSITY):
    """Top-(DIM*density) by |logit|; +1 if logit>0 else -1. Returns (indices_sorted,
    signs) matching ternarize_top_k in neural_mapper.rs. Indices ascending."""
    import numpy as np
    target = int(DIM * density)
    if target <= 0:
        return [], []
    absv = np.abs(logits_row)
    nz = np.nonzero(absv)[0]
    if nz.size == 0:
        return [], []
    if nz.size > target:
        # top-`target` by abs value among nonzeros
        part = nz[np.argpartition(absv[nz], nz.size - target)[nz.size - target:]]
    else:
        part = nz
    idx = np.sort(part)
    sgn = np.where(logits_row[idx] > 0.0, 1, -1).astype(np.int8)
    return idx.astype(np.int64).tolist(), sgn.tolist()


# ── Binary writer (EXACT Rust byte contract) ─────────────────────────────────
def write_sparse_record(out_f, indices, signs):
    """Write one token's sparse-ternary record and return (offset, size, count).

    count (u32 LE) | indices (count * u32 LE) | signs (count * i8)
    size == 4 + count*4 + count.  Caller guarantees indices ascending & < DIM.
    """
    import numpy as np
    offset = out_f.tell()
    count = len(indices)
    out_f.write(struct.pack("<I", count))
    if count:
        out_f.write(np.asarray(indices, dtype="<u4").tobytes())
        out_f.write(np.asarray(signs, dtype=np.int8).tobytes())
    size = out_f.tell() - offset
    assert size == 4 + count * 4 + count, (size, count)
    return offset, size, count


def main():
    ap = argparse.ArgumentParser(description="Project BitNet token embeddings into KAI's 16384-dim sparse-ternary lattice space.")
    ap.add_argument("--gguf", help="BitNet GGUF (reads token_embd + tokenizer.ggml.tokens)")
    ap.add_argument("--kai", help="token_embd.weight.kai (KAI1 FloatLayer) — embeddings only")
    ap.add_argument("--tokenizer", help="tokenizer.json (token strings when using --kai)")
    ap.add_argument("--out-bin", default="models/BitNet/neural_weights.bin",
                    help="output sparse-ternary binary (Rust mmaps this exact path)")
    ap.add_argument("--out-json", default="data/neural_structure.json",
                    help="output structure index (load_neural_structure reads this)")
    ap.add_argument("--max-tokens", type=int, default=0, help="cap tokens (0 = all)")
    ap.add_argument("--density", type=float, default=DEFAULT_DENSITY, help="lattice density (default 0.04)")
    ap.add_argument("--batch", type=int, default=512, help="projection batch size")
    args = ap.parse_args()

    try:
        import numpy as np  # noqa: F401
    except ImportError:
        print("[ERROR] numpy is required: pip install numpy", file=sys.stderr)
        sys.exit(1)

    if not args.gguf and not args.kai:
        print("[ERROR] provide --gguf or --kai", file=sys.stderr)
        sys.exit(1)

    # 1) Load embeddings + tokens
    if args.gguf:
        emb, tokens = load_embeddings_from_gguf(args.gguf)
    else:
        emb, tokens = load_embeddings_from_kai(args.kai)

    n_vocab, emb_dim = emb.shape
    if tokens is None or len(tokens) < n_vocab:
        if args.tokenizer:
            tokens = load_tokens_from_tokenizer(args.tokenizer, n_vocab)
        elif tokens is None:
            print("[ERROR] no token strings available; pass --tokenizer or use --gguf", file=sys.stderr)
            sys.exit(1)

    if args.max_tokens and args.max_tokens > 0:
        n_vocab = min(n_vocab, args.max_tokens)

    print(f"[lattice] projecting {n_vocab} tokens: {emb_dim}-d dense -> {DIM}-d ternary @ density {args.density}")

    # 2) Build deterministic projection
    cols, signs_mat = build_projection(emb_dim, DIM)

    # 3) Project + ternarize + write, batched
    Path(os.path.dirname(args.out_bin) or ".").mkdir(parents=True, exist_ok=True)
    Path(os.path.dirname(args.out_json) or ".").mkdir(parents=True, exist_ok=True)

    embeddings_meta = []
    seen = set()
    total_nz = 0

    tmp_bin = args.out_bin + ".tmp"
    tmp_json = args.out_json + ".tmp"
    with open(tmp_bin, "wb") as out_f:
        b = max(1, args.batch)
        for start in range(0, n_vocab, b):
            end = min(start + b, n_vocab)
            logits = project_logits(emb[start:end], cols, signs_mat)  # [bs, DIM]
            for r in range(end - start):
                gi = start + r
                tok = clean_token(tokens[gi]) if gi < len(tokens) else f"<tok_{gi}>"
                if not tok or tok in seen:
                    # skip empties and duplicate keys (HashMap would collide anyway)
                    continue
                idx, sgn = ternarize_top_k(logits[r], args.density)
                if not idx:
                    continue
                offset, size, count = write_sparse_record(out_f, idx, sgn)
                seen.add(tok)
                total_nz += count
                embeddings_meta.append({
                    "token": tok,
                    "offset": offset,
                    "size": size,
                    "nonzero": count,
                })
            if (end % (b * 20) == 0) or end == n_vocab:
                print(f"[lattice] {end}/{n_vocab} tokens projected ({len(embeddings_meta)} kept)")

    # 4) Write the structure JSON in the EXACT Rust schema.
    #    `layers` is required by NeuralStructure but unused for the vocab path
    #    (get_structural_layer is the only reader, and nothing calls it on this
    #    file), so we emit an empty list — valid and harmless.
    structure = {
        "layers": [],
        "embeddings": {
            "count": len(embeddings_meta),
            "tokens": embeddings_meta,
        },
    }
    with open(tmp_json, "w", encoding="utf-8") as f:
        json.dump(structure, f, ensure_ascii=False, separators=(",", ":"))

    try:
        os.replace(tmp_bin, args.out_bin)
        os.replace(tmp_json, args.out_json)
        bin_mb = os.path.getsize(args.out_bin) / 1e6
        json_mb = os.path.getsize(args.out_json) / 1e6
    except PermissionError:
        print(f"\n[lattice] WARNING: Could not atomically replace files.")
        print("[lattice] The Rust engine likely has the file locked. Skipping overwrite.")
        bin_mb = os.path.getsize(tmp_bin) / 1e6
        json_mb = os.path.getsize(tmp_json) / 1e6
    avg_nz = (total_nz / len(embeddings_meta)) if embeddings_meta else 0
    print("\n[lattice] DONE")
    print(f"  tokens written : {len(embeddings_meta)}")
    print(f"  avg nonzeros   : {avg_nz:.1f} (~{100*avg_nz/DIM:.1f}% dense, target {100*args.density:.1f}%)")
    print(f"  {args.out_bin}  ({bin_mb:.1f} MB)")
    print(f"  {args.out_json} ({json_mb:.2f} MB)")
    print("\n  Copy/confirm the .bin lives at C:\\KAI\\models\\BitNet\\neural_weights.bin")
    print("  Then rebuild KAI (cargo build --release) and restart.")


if __name__ == "__main__":
    main()
