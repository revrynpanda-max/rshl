import sys
import os
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

def extract_all():
    print("Starting Mass Extraction of BitNet 2B Parameters with Scales...")
    gguf_path = "models/BitNet/bitnet-b1.58-2B-4T.gguf"
    reader = gguf.GGUFReader(gguf_path)
    
    out_dir = "models/BitNet/Native"
    os.makedirs(out_dir, exist_ok=True)
    
    count = 0
    total_extracted_bytes = 0

    with open(gguf_path, "rb") as f_gguf:
        for tensor in reader.tensors:
            if tensor.tensor_type.name == "I2_S" or tensor.tensor_type.value == 36:
                raw_data = tensor.data
                
                # Extract the scale factor from the 32-byte gap at the end of the tensor data
                end_pos = tensor.data_offset + tensor.n_bytes
                f_gguf.seek(end_pos)
                scale_bytes = f_gguf.read(4)
                scale = struct.unpack("<f", scale_bytes)[0]
                
                shape = tensor.shape
                if len(shape) == 1:
                    cols, rows = shape[0], 1
                else:
                    cols, rows = shape[0], shape[1]
                    
                filename = os.path.join(out_dir, tensor.name + ".kai")
                
                with open(filename, "wb") as f:
                    f.write(b"KAI2")
                    f.write(struct.pack("<I", rows))
                    f.write(struct.pack("<I", cols))
                    f.write(struct.pack("<f", scale))
                    f.write(struct.pack("<I", len(raw_data.tobytes())))
                    f.write(raw_data.tobytes())
                    
                count += 1
                total_extracted_bytes += len(raw_data.tobytes())
                print(f"Extracted [{count}]: {tensor.name} -> {rows}x{cols} (scale={scale:.6f})")

    print(f"\nMass Extraction Complete! Extracted {count} I2_S tensors.")
    print(f"Total Native Disk Footprint: {total_extracted_bytes / 1024 / 1024:.2f} MB")

if __name__ == "__main__":
    extract_all()
