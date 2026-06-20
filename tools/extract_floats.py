import sys
import os
import struct
import numpy as np

try:
    import gguf
    from gguf.gguf_reader import GGMLQuantizationType
except ImportError:
    print("pip install gguf needed")
    sys.exit(1)

# Monkey-patch GGUF
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
    pass

def extract_floats():
    print("Extracting Float Tensors (Embeddings, RMSNorms)...")
    reader = gguf.GGUFReader("models/BitNet/bitnet-b1.58-2B-4T.gguf")
    out_dir = "models/BitNet/Native"
    
    count = 0
    total_extracted = 0

    for tensor in reader.tensors:
        if tensor.tensor_type.name != "I2_S" and tensor.tensor_type.value != 36:
            # It's a float tensor (F16 or F32)
            # We want to convert everything to F32 for KAI's native Rust engine
            
            # GGUF tensor.data is a memoryview of bytes
            raw_bytes = tensor.data
            
            if tensor.tensor_type.name == "F32":
                arr = np.frombuffer(raw_bytes, dtype=np.float32)
            elif tensor.tensor_type.name == "F16":
                arr = np.frombuffer(raw_bytes, dtype=np.float16).astype(np.float32)
            else:
                print(f"Skipping unknown type {tensor.tensor_type.name} for {tensor.name}")
                continue
            
            shape = tensor.shape
            if len(shape) == 1:
                cols, rows = shape[0], 1
            else:
                cols, rows = shape[0], shape[1]
                
            filename = os.path.join(out_dir, tensor.name + ".kai")
            
            f32_bytes = arr.tobytes()
            
            with open(filename, "wb") as f:
                f.write(b"KAI1")
                f.write(struct.pack("<I", rows))
                f.write(struct.pack("<I", cols))
                f.write(struct.pack("<I", len(f32_bytes)))
                f.write(f32_bytes)
                
            count += 1
            total_extracted += len(f32_bytes)
            print(f"Extracted [{count}]: {tensor.name} -> {rows}x{cols} ({len(f32_bytes) / 1024 / 1024:.2f} MB)")

    print(f"\nFloat Extraction Complete! Extracted {count} tensors.")
    print(f"Float Footprint: {total_extracted / 1024 / 1024:.2f} MB")

if __name__ == "__main__":
    extract_floats()
