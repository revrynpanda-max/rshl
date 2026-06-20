"""Extract tokenizer from the BitNet GGUF file — include merges for proper BPE."""
import struct, json, os

GGUF_PATH = "models/BitNet/bitnet-b1.58-2B-4T.gguf"
OUT_PATH = "models/BitNet/tokenizer.json"

def read_string(f):
    length = struct.unpack("<Q", f.read(8))[0]
    return f.read(length).decode("utf-8", errors="replace")

def read_gguf_metadata(path):
    meta = {}
    with open(path, "rb") as f:
        magic = f.read(4)
        if magic != b"GGUF":
            raise ValueError("Not a GGUF file")
        version = struct.unpack("<I", f.read(4))[0]
        n_tensors = struct.unpack("<Q", f.read(8))[0]
        n_kv = struct.unpack("<Q", f.read(8))[0]

        for _ in range(n_kv):
            key = read_string(f)
            value_type = struct.unpack("<I", f.read(4))[0]

            if value_type == 0: val = struct.unpack("<B", f.read(1))[0]
            elif value_type == 1: val = struct.unpack("<b", f.read(1))[0]
            elif value_type == 2: val = struct.unpack("<H", f.read(2))[0]
            elif value_type == 3: val = struct.unpack("<h", f.read(2))[0]
            elif value_type == 4: val = struct.unpack("<I", f.read(4))[0]
            elif value_type == 5: val = struct.unpack("<i", f.read(4))[0]
            elif value_type == 6: val = struct.unpack("<f", f.read(4))[0]
            elif value_type == 7: val = struct.unpack("<B", f.read(1))[0] != 0
            elif value_type == 8: val = read_string(f)
            elif value_type == 9:
                arr_type = struct.unpack("<I", f.read(4))[0]
                arr_len = struct.unpack("<Q", f.read(8))[0]
                arr = []
                for _ in range(arr_len):
                    if arr_type == 8: arr.append(read_string(f))
                    elif arr_type == 6: arr.append(struct.unpack("<f", f.read(4))[0])
                    elif arr_type == 5: arr.append(struct.unpack("<i", f.read(4))[0])
                    elif arr_type == 4: arr.append(struct.unpack("<I", f.read(4))[0])
                    elif arr_type == 0: arr.append(struct.unpack("<B", f.read(1))[0])
                    elif arr_type == 3: arr.append(struct.unpack("<h", f.read(2))[0])
                    elif arr_type == 2: arr.append(struct.unpack("<H", f.read(2))[0])
                    elif arr_type == 7: arr.append(struct.unpack("<B", f.read(1))[0] != 0)
                    elif arr_type == 10: arr.append(struct.unpack("<Q", f.read(8))[0])
                    elif arr_type == 11: arr.append(struct.unpack("<q", f.read(8))[0])
                    elif arr_type == 12: arr.append(struct.unpack("<d", f.read(8))[0])
                val = arr
            elif value_type == 10: val = struct.unpack("<Q", f.read(8))[0]
            elif value_type == 11: val = struct.unpack("<q", f.read(8))[0]
            elif value_type == 12: val = struct.unpack("<d", f.read(8))[0]
            else: val = None

            meta[key] = val
    return meta

meta = read_gguf_metadata(GGUF_PATH)

tokens = meta.get("tokenizer.ggml.tokens", [])
merges = meta.get("tokenizer.ggml.merges", [])
bos_id = meta.get("tokenizer.ggml.bos_token_id", 128000)
eos_id = meta.get("tokenizer.ggml.eos_token_id", 128001)

vocab = {token: i for i, token in enumerate(tokens)}

bos_token = tokens[bos_id] if bos_id < len(tokens) else "<|begin_of_text|>"
eos_token = tokens[eos_id] if eos_id < len(tokens) else "<|end_of_text|>"

added_tokens = []
for i, token in enumerate(tokens):
    token_type = meta.get("tokenizer.ggml.token_type", [])[i] if i < len(meta.get("tokenizer.ggml.token_type", [])) else 0
    if token_type == 3 or token_type == 4:  # control/special tokens
        added_tokens.append({
            "id": i,
            "content": token,
            "single_word": False,
            "lstrip": False,
            "rstrip": False,
            "normalized": False,
            "special": True
        })

if not any(t["id"] == bos_id for t in added_tokens):
    added_tokens.append({"id": bos_id, "content": bos_token, "single_word": False, "lstrip": False, "rstrip": False, "normalized": False, "special": True})
if not any(t["id"] == eos_id for t in added_tokens):
    added_tokens.append({"id": eos_id, "content": eos_token, "single_word": False, "lstrip": False, "rstrip": False, "normalized": False, "special": True})

tokenizer_json = {
    "version": "1.0",
    "truncation": None,
    "padding": None,
    "added_tokens": sorted(added_tokens, key=lambda x: x["id"]),
    "normalizer": None,
    "pre_tokenizer": {"type": "ByteLevel", "add_prefix_space": False, "trim_offsets": True, "use_regex": True},
    "post_processor": None,
    "decoder": {"type": "ByteLevel", "add_prefix_space": True, "trim_offsets": True, "use_regex": True},
    "model": {
        "type": "BPE",
        "dropout": None,
        "unk_token": None,
        "continuing_subword_prefix": None,
        "end_of_word_suffix": None,
        "fuse_unk": False,
        "byte_fallback": False,
        "vocab": vocab,
        "merges": merges
    }
}

with open(OUT_PATH, "w", encoding="utf-8") as f:
    json.dump(tokenizer_json, f, ensure_ascii=False)

print(f"Wrote {OUT_PATH} with {len(vocab)} tokens and {len(merges)} merges")
print(f"BOS: {bos_id} ({bos_token}), EOS: {eos_id} ({eos_token})")
print(f"Added tokens (special): {len(added_tokens)}")
