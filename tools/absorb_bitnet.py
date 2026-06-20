import sys
import enum
import struct

try:
    import gguf
    from gguf.gguf_reader import GGMLQuantizationType
except ImportError:
    print("pip install gguf needed")
    sys.exit(1)

# Monkey-patch GGUF to recognize I2_S (36)
try:
    def missing(cls, value):
        if value == 36:
            obj = int.__new__(cls, value)
            obj._name_ = "I2_S"
            obj._value_ = 36
            return obj
        return super(cls.__class__, cls)._missing_(value)
    GGMLQuantizationType._missing_ = classmethod(missing)
    import gguf.gguf_reader
    i2s_enum = GGMLQuantizationType(36)
    gguf.gguf_reader.GGML_QUANT_SIZES[i2s_enum] = (128, 32)
except Exception as e:
    print("Error patching:", e)

def decode_i2_s_block(block_bytes):
    # decodes bytes into ternary values
    map_2_bit = [-1, 0, 1, 0]
    decoded = []
    for b in block_bytes:
        b = int(b)
        decoded.append(map_2_bit[(b >> 6) & 0x3])
        decoded.append(map_2_bit[(b >> 4) & 0x3])
        decoded.append(map_2_bit[(b >> 2) & 0x3])
        decoded.append(map_2_bit[(b >> 0) & 0x3])
    return decoded

def extract():
    print("Starting native BitNet assimilation...")
    reader = gguf.GGUFReader("models/BitNet/bitnet-b1.58-2B-4T.gguf")
    
    target_tensor = None
    for tensor in reader.tensors:
        if tensor.name == "blk.0.attn_k.weight":
            target_tensor = tensor
            break

    if not target_tensor:
        print("Could not find tensor.")
        return

    print(f"Extracting {target_tensor.name} - Shape: {target_tensor.shape}")
    
    raw_data = target_tensor.data
    
    total_weights = 1
    for dim in target_tensor.shape:
        total_weights *= dim

    # flatten first
    flat_data = raw_data.flatten()
    all_ternary = decode_i2_s_block(flat_data[: (total_weights // 4)])
    
    non_zero = sum(1 for x in all_ternary if x != 0)
    print(f"Decoded {len(all_ternary)} weights. Non-zero (synapses): {non_zero}")

    with open("models/BitNet/extracted_blk0_k.bin", "wb") as f:
        f.write(struct.pack("<I", len(all_ternary)))
        f.write(struct.pack("<I", non_zero))
        for i, val in enumerate(all_ternary):
            if val != 0:
                f.write(struct.pack("<H", i % 65535))
        for val in all_ternary:
            if val != 0:
                f.write(struct.pack("<b", val))

    print("Assimilation of Layer 0 complete! Native KAI memory file generated.")

if __name__ == "__main__":
    extract()
