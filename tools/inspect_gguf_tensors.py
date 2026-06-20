import gguf
import struct

def main():
    gguf_path = "models/BitNet/bitnet-b1.58-2B-4T.gguf"
    
    # Monkey-patch GGUF to recognize I2_S (36)
    try:
        from gguf.gguf_reader import GGMLQuantizationType
        def missing(cls, value):
            if value == 36:
                obj = int.__new__(cls, value)
                obj._name_ = "I2_S"
                obj._value_ = 36
                return obj
            return None
        GGMLQuantizationType._missing_ = classmethod(missing)
        import gguf.gguf_reader
        i2s_enum = GGMLQuantizationType(36)
        gguf.gguf_reader.GGML_QUANT_SIZES[i2s_enum] = (128, 32)
    except Exception as e:
        print("Patch error:", e)

    reader = gguf.GGUFReader(gguf_path)
    
    print(f"=== GGUF Tensors ({len(reader.tensors)}) ===")
    for idx, tensor in enumerate(reader.tensors):
        shape = tensor.shape
        t_type = tensor.tensor_type
        print(f"[{idx:3d}] name: {tensor.name:<30} | shape: {str(shape):<15} | type: {t_type.name:<10} | bytes: {tensor.n_bytes}")
        if idx >= 15:
            print("... and more ...")
            break

if __name__ == "__main__":
    main()
