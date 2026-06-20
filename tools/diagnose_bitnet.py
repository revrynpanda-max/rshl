"""
BitNet Weight Diagnostic Tool
Checks:
1. How many bytes per block in I2_S format
2. Whether there are embedded scales in the packed data
3. The distribution of 2-bit values (should be ~1/3 each for -1, 0, +1)
4. Cross-reference with llama.cpp's actual I2_S block format
"""
import struct
import sys
import os
import numpy as np

def analyze_kai_file(filepath):
    """Analyze a .kai compressed weight file"""
    with open(filepath, 'rb') as f:
        magic = f.read(4)
        assert magic == b'KAI2', f"Bad magic: {magic}"
        rows = struct.unpack('<I', f.read(4))[0]
        cols = struct.unpack('<I', f.read(4))[0]
        scale = struct.unpack('<f', f.read(4))[0]
        data_len = struct.unpack('<I', f.read(4))[0]
        data = f.read(data_len)
    
    return rows, cols, scale, data

def check_ternary_distribution(data, rows, cols):
    """Check distribution of 2-bit values in packed data"""
    counts = [0, 0, 0, 0]  # counts for 0, 1, 2, 3
    
    for b in data:
        c0 = (b >> 6) & 0x3
        c1 = (b >> 4) & 0x3
        c2 = (b >> 2) & 0x3
        c3 = (b >> 0) & 0x3
        counts[c0] += 1
        counts[c1] += 1
        counts[c2] += 1
        counts[c3] += 1
    
    total = sum(counts)
    print(f"  Total weight elements decoded: {total}")
    print(f"  Expected elements (rows*cols): {rows * cols}")
    print(f"  Distribution:")
    print(f"    Value 0 (mapped to -1): {counts[0]:>10} ({100*counts[0]/total:.1f}%)")
    print(f"    Value 1 (mapped to  0): {counts[1]:>10} ({100*counts[1]/total:.1f}%)")
    print(f"    Value 2 (mapped to +1): {counts[2]:>10} ({100*counts[2]/total:.1f}%)")
    print(f"    Value 3 (INVALID!):     {counts[3]:>10} ({100*counts[3]/total:.1f}%)")
    
    if counts[3] > 0:
        print(f"  [WARN] Found {counts[3]} invalid value-3 entries!")
        print(f"  This strongly suggests the bit packing format is WRONG.")
    
    return counts

def check_block_structure(filepath_gguf):
    """Analyze the raw GGUF tensor data to understand I2_S block format"""
    try:
        import gguf
        from gguf.gguf_reader import GGMLQuantizationType
        
        # Monkey-patch for I2_S
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
        
        reader = gguf.GGUFReader(filepath_gguf)
        
        # Find first I2_S tensor
        for tensor in reader.tensors:
            if tensor.tensor_type.value == 36:
                print(f"\n=== GGUF I2_S Tensor Analysis: {tensor.name} ===")
                print(f"  Shape: {tensor.shape}")
                print(f"  Type: {tensor.tensor_type.name} (value={tensor.tensor_type.value})")
                
                raw = bytes(tensor.data)
                print(f"  Raw data size: {len(raw)} bytes")
                
                # If pure 2-bit packing with no overhead:
                # elements = shape[0] * shape[1], bytes = elements / 4
                if len(tensor.shape) == 2:
                    elements = tensor.shape[0] * tensor.shape[1]
                else:
                    elements = tensor.shape[0]
                    
                pure_bytes = elements // 4
                print(f"  Expected pure 2-bit packed bytes: {pure_bytes}")
                print(f"  Actual bytes: {len(raw)}")
                print(f"  Ratio actual/expected: {len(raw)/pure_bytes:.4f}")
                
                if len(raw) != pure_bytes:
                    overhead = len(raw) - pure_bytes
                    print(f"  [WARN] OVERHEAD: {overhead} extra bytes!")
                    print(f"  This likely means there are BLOCK HEADERS with scales!")
                    
                    # I2_S block format: block_size=128 elements, type_size=32 bytes
                    # 128 elements at 2 bits = 32 bytes just for weights
                    # type_size=32 bytes total means 0 bytes overhead per block
                    # OR: type_size includes something we're not accounting for
                    
                    n_blocks = elements // 128
                    print(f"  Number of 128-element blocks: {n_blocks}")
                    print(f"  Bytes per block: {len(raw) / n_blocks:.1f}")
                    
                    # Let's look at the first few blocks
                    bytes_per_block = len(raw) // n_blocks
                    print(f"\n  First block raw hex ({bytes_per_block} bytes):")
                    block = raw[:bytes_per_block]
                    for i in range(0, min(bytes_per_block, 64), 16):
                        hex_str = ' '.join(f'{b:02x}' for b in block[i:i+16])
                        print(f"    [{i:4d}] {hex_str}")
                    
                    # Check if there are embedded float scales
                    # Common pattern: first 2 or 4 bytes are a float16/float32 scale
                    if bytes_per_block >= 34:  # 2 bytes scale + 32 bytes weights
                        scale_f16 = np.frombuffer(block[:2], dtype=np.float16)[0]
                        scale_f32_from_first4 = struct.unpack('<f', block[:4])[0] if bytes_per_block >= 36 else None
                        print(f"\n  If first 2 bytes are f16 scale: {scale_f16}")
                        if scale_f32_from_first4 is not None:
                            print(f"  If first 4 bytes are f32 scale: {scale_f32_from_first4}")
                else:
                    print(f"  [OK] Pure 2-bit packing, no overhead")
                
                # Show first 64 bytes hex
                print(f"\n  First 64 bytes hex dump:")
                for i in range(0, min(64, len(raw)), 16):
                    hex_str = ' '.join(f'{b:02x}' for b in raw[i:i+16])
                    print(f"    [{i:4d}] {hex_str}")
                
                break
                
    except ImportError:
        print("GGUF library not available, skipping GGUF analysis")

def main():
    native_dir = "models/BitNet/Native"
    gguf_path = "models/BitNet/bitnet-b1.58-2B-4T.gguf"
    
    # 1. Analyze a compressed weight file
    test_file = os.path.join(native_dir, "blk.0.attn_q.weight.kai")
    print(f"=== Analyzing: {test_file} ===")
    rows, cols, scale, data = analyze_kai_file(test_file)
    print(f"  Rows: {rows}, Cols: {cols}, Scale: {scale}")
    print(f"  Data size: {len(data)} bytes")
    
    expected_bytes = rows * cols // 4
    print(f"  Expected bytes for pure 2-bit packing: {expected_bytes}")
    
    if len(data) != expected_bytes:
        print(f"  [WARN] MISMATCH! Data has {len(data) - expected_bytes} extra bytes")
        print(f"  This means the raw GGUF dump includes block headers/scales!")
    else:
        print(f"  [OK] Size matches pure 2-bit packing")
    
    counts = check_ternary_distribution(data, rows, cols)
    
    # 2. Also check attn_k (smaller: 640x2560)
    test_file2 = os.path.join(native_dir, "blk.0.attn_k.weight.kai")
    print(f"\n=== Analyzing: {test_file2} ===")
    rows2, cols2, scale2, data2 = analyze_kai_file(test_file2)
    print(f"  Rows: {rows2}, Cols: {cols2}, Scale: {scale2}")
    print(f"  Data size: {len(data2)} bytes")
    expected2 = rows2 * cols2 // 4
    print(f"  Expected pure 2-bit: {expected2}")
    if len(data2) != expected2:
        print(f"  [WARN] MISMATCH! Extra {len(data2) - expected2} bytes")
    check_ternary_distribution(data2, rows2, cols2)
    
    # 3. Analyze GGUF directly
    if os.path.exists(gguf_path):
        check_block_structure(gguf_path)
    
    # 4. Quick sanity: what does our matmul produce for a known input?
    print(f"\n=== Quick Matmul Sanity Check ===")
    # Take the first row of attn_q weights, multiply by a simple activation
    bytes_per_row = cols // 4
    first_row = data[:bytes_per_row]
    
    # Create a simple test activation (all 1.0)
    activations = [1.0] * cols
    
    # Manual matmul for first row
    result = 0.0
    act_idx = 0
    pos_count = 0
    neg_count = 0
    zero_count = 0
    for b in first_row:
        c0 = (b >> 6) & 0x3
        c1 = (b >> 4) & 0x3
        c2 = (b >> 2) & 0x3
        c3 = (b >> 0) & 0x3
        for c in [c0, c1, c2, c3]:
            if c == 2:
                result += activations[act_idx]
                pos_count += 1
            elif c == 0:
                result -= activations[act_idx]
                neg_count += 1
            else:
                zero_count += 1
            act_idx += 1
    
    print(f"  First row of attn_q: +1 count={pos_count}, -1 count={neg_count}, 0 count={zero_count}")
    print(f"  Sum with all-ones activation: {result}")
    print(f"  (Should be close to 0 for a well-trained ternary layer)")

if __name__ == "__main__":
    main()
