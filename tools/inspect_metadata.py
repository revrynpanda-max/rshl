import sys

# Monkey-patch GGUF to recognize I2_S (36) BEFORE importing gguf
try:
    from gguf.gguf_reader import GGMLQuantizationType
    def missing(cls, value):
        if value == 36 or value == np.uint32(36):
            obj = int.__new__(cls, 36)
            obj._name_ = "I2_S"
            obj._value_ = 36
            return obj
        return None
    import numpy as np
    GGMLQuantizationType._missing_ = classmethod(missing)
    import gguf.gguf_reader
    i2s_enum = GGMLQuantizationType(36)
    gguf.gguf_reader.GGML_QUANT_SIZES[i2s_enum] = (128, 32)
except Exception as e:
    print("Patch error:", e)

import gguf

def main():
    gguf_path = "models/BitNet/bitnet-b1.58-2B-4T.gguf"
    reader = gguf.GGUFReader(gguf_path)
    
    print("=== GGUF Metadata Keys ===")
    for key, field in reader.fields.items():
        print(f"key: {key}")
        # Print some info about field
        if len(field.parts) > 0:
            val = field.parts[-1]
            if len(str(val)) < 200:
                print(f"  value: {val}")
            else:
                print(f"  value: {str(val)[:200]}... (len={len(str(val))})")

if __name__ == "__main__":
    main()
