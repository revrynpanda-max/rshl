import struct, os

def read_kai_header(path):
    with open(path, "rb") as f:
        magic = f.read(4)
        rows = struct.unpack("<I", f.read(4))[0]
        cols = struct.unpack("<I", f.read(4))[0]
        data_len = struct.unpack("<I", f.read(4))[0]
    return rows, cols, data_len

base = "models/BitNet/Native"
keys = [
    "token_embd.weight",
    "output_norm.weight",
    "blk.0.attn_q.weight",
    "blk.0.attn_k.weight",
    "blk.0.attn_v.weight",
    "blk.0.attn_output.weight",
    "blk.0.attn_norm.weight",
    "blk.0.attn_sub_norm.weight",
    "blk.0.ffn_gate.weight",
    "blk.0.ffn_up.weight",
    "blk.0.ffn_down.weight",
    "blk.0.ffn_norm.weight",
    "blk.0.ffn_sub_norm.weight",
]

for k in keys:
    path = os.path.join(base, k + ".kai")
    if os.path.exists(path):
        rows, cols, data_len = read_kai_header(path)
        print(f"{k}: rows={rows}, cols={cols}, data_len={data_len}")
    else:
        print(f"{k}: NOT FOUND")

# Count blocks
block_count = 0
for i in range(100):
    if os.path.exists(os.path.join(base, f"blk.{i}.attn_q.weight.kai")):
        block_count += 1
    else:
        break
print(f"\nTotal blocks: {block_count}")
