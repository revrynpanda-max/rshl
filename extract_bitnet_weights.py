#!/usr/bin/env python3
"""
extract_bitnet_weights.py — Custom GGUF Parser for BitNet Type 36 (Ternary) Quantization

Extracts the complete neural network weights from BitNet-b1.58 GGUF and converts to KAI's
native sparse ternary format. Uses a split architecture:
  - neural_structure.json: Metadata, shapes, offsets, sparsity (small, ~few MB)
  - neural_weights.bin: Binary ternary weights (compact, ~1-2GB)

BitNet uses ternary weights {-1, 0, +1} which maps 1:1 to KAI's RSHL lattice.
"""

import struct
import json
import sys
import os
import mmap
from pathlib import Path
from typing import Dict, List, Tuple, Any


# ── GGUF Constants ──────────────────────────────────────────────────────────
GGUF_MAGIC = b"GGUF"
GGUF_VERSION = 3

GGUF_TYPE_SIZES = {
    0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1,
    8: None, 9: None, 10: 8, 11: 8, 12: 8,
}

GGUF_TYPE_FMT = {
    0: "B", 1: "b", 2: "H", 3: "h", 4: "I", 5: "i",
    6: "f", 7: "?", 10: "Q", 11: "q", 12: "d",
}

GGML_QUANT_TYPES = {
    0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 4: "Q4_2", 5: "Q4_3",
    6: "Q5_0", 7: "Q5_1", 8: "Q8_0", 9: "Q8_1", 10: "Q2_K", 11: "Q3_K",
    12: "Q4_K", 13: "Q5_K", 14: "Q6_K", 15: "Q8_K", 16: "IQ2_XXS",
    17: "IQ2_XS", 18: "IQ3_XXS", 19: "IQ3_S", 20: "IQ4_NL", 21: "IQ4_XS",
    22: "IQ1_S", 23: "IQ1_M", 24: "IQ4_K", 25: "IQ2_K", 26: "IQ3_K",
    27: "IQ4_KS", 28: "IQ5_K", 29: "IQ6_K", 30: "IQ3_KN",
    31: "TQ1_0", 32: "TQ2_0", 33: "IQ4_KSS", 34: "Q4_0_4_4", 35: "Q4_0_4_8",
    36: "BITNET",  # BitNet b1.58 custom ternary quantization
}


def read_string(f) -> str:
    """Read GGUF string (length as uint64, then bytes)."""
    length = struct.unpack("<Q", f.read(8))[0]
    if length == 0:
        return ""
    data = f.read(length)
    return data.decode('utf-8', errors='replace')


def read_value(f, val_type: int) -> Any:
    """Read a single GGUF value based on type."""
    if val_type == 8:  # STRING
        return read_string(f)
    elif val_type == 9:  # ARRAY
        arr_type = struct.unpack("<I", f.read(4))[0]
        arr_len = struct.unpack("<Q", f.read(8))[0]
        arr = []
        for _ in range(arr_len):
            arr.append(read_value(f, arr_type))
        return arr
    else:
        size = GGUF_TYPE_SIZES[val_type]
        fmt = GGUF_TYPE_FMT[val_type]
        return struct.unpack(f"<{fmt}", f.read(size))[0]


def parse_gguf(gguf_path: str) -> Tuple[Dict, List[Dict], int]:
    """
    Parse a GGUF file and return metadata, tensor info, and data offset.
    """
    file_size = os.path.getsize(gguf_path)
    
    with open(gguf_path, "rb") as f:
        # Magic
        magic = f.read(4)
        if magic != GGUF_MAGIC:
            raise ValueError(f"Invalid GGUF magic: {magic}")
        
        # Version
        version = struct.unpack("<I", f.read(4))[0]
        print(f"[GGUF] Version: {version}")
        
        # Tensor count and metadata count
        tensor_count = struct.unpack("<Q", f.read(8))[0]
        metadata_count = struct.unpack("<Q", f.read(8))[0]
        print(f"[GGUF] Tensors: {tensor_count}, Metadata KV: {metadata_count}")
        
        # Read metadata
        metadata = {}
        for i in range(metadata_count):
            key = read_string(f)
            val_type = struct.unpack("<I", f.read(4))[0]
            value = read_value(f, val_type)
            metadata[key] = value
        
        # Read tensor info
        tensors = []
        for i in range(tensor_count):
            name = read_string(f)
            n_dims = struct.unpack("<I", f.read(4))[0]
            dims = struct.unpack(f"<{n_dims}Q", f.read(n_dims * 8))
            ggml_type = struct.unpack("<I", f.read(4))[0]
            offset = struct.unpack("<Q", f.read(8))[0]
            tensors.append({
                "name": name,
                "dims": list(dims),
                "ggml_type": ggml_type,
                "type_name": GGML_QUANT_TYPES.get(ggml_type, f"UNKNOWN_{ggml_type}"),
                "offset": offset,
            })
        
        data_offset = f.tell()
        
    return metadata, tensors, data_offset, file_size


def get_block_size(ggml_type: int) -> int:
    """Get block size for quantization type."""
    if ggml_type in (0, 1):  # F32, F16
        return 1
    elif ggml_type in (2, 3, 4, 5, 6, 7):  # Q4_0, Q4_1, etc.
        return 32
    elif ggml_type in (8, 9, 10, 11, 12, 13, 14, 15):  # Q8_0, Q8_1, QK variants
        return 256
    elif ggml_type == 36:  # BITNET
        return 32
    return 32


def get_type_size(ggml_type: int) -> int:
    """Get bytes per block for quantization type."""
    if ggml_type == 0:  # F32
        return 4
    elif ggml_type == 1:  # F16
        return 2
    elif ggml_type == 2:  # Q4_0
        return 18
    elif ggml_type == 3:  # Q4_1
        return 20
    elif ggml_type == 36:  # BITNET
        return 9
    return 4


def dequantize_bitnet(data: bytes, num_elements: int) -> 'np.ndarray':
    """
    Dequantize BitNet type 36 (ternary) data using numpy.
    Returns numpy array of ternary values (-1, 0, 1).
    """
    import numpy as np
    
    block_size = 32
    block_bytes = 9
    num_blocks = (num_elements + block_size - 1) // block_size
    
    # Convert to numpy array
    arr = np.frombuffer(data, dtype=np.uint8)
    
    # Extract scales (every 9th byte starting from index 8)
    scales = arr[8::9].astype(np.float32) / 127.0
    scales[scales == 0] = 1.0
    
    # Extract data bytes (all bytes except scales)
    data_bytes = np.delete(arr, np.arange(8, len(arr), 9))
    
    # Unpack 2-bit values from each byte
    # Each byte has 4 x 2-bit values
    val0 = (data_bytes & 0b11)
    val1 = ((data_bytes >> 2) & 0b11)
    val2 = ((data_bytes >> 4) & 0b11)
    val3 = ((data_bytes >> 6) & 0b11)
    
    # Interleave: [val0[0], val1[0], val2[0], val3[0], val0[1], val1[1], ...]
    values = np.empty(len(data_bytes) * 4, dtype=np.int8)
    values[0::4] = val0
    values[1::4] = val1
    values[2::4] = val2
    values[3::4] = val3
    
    # Map to ternary: 0->0, 1->1, 2->-1, 3->0
    mapping = np.array([0, 1, -1, 0], dtype=np.int8)
    values = mapping[values]
    
    # Apply scales (each block of 32 has its own scale)
    # Repeat each scale 32 times
    scales_repeated = np.repeat(scales, block_size)
    values = values[:len(scales_repeated)] * scales_repeated
    
    # Truncate to num_elements
    values = values[:num_elements]
    
    # Round to nearest integer to get pure ternary {-1, 0, 1}
    values = np.round(values).astype(np.int8)
    
    # Clip to ensure only {-1, 0, 1}
    values = np.clip(values, -1, 1)
    
    return values


def dequantize_f32_to_ternary(data: bytes, num_elements: int, threshold: float = 0.1) -> Tuple[List[int], List[int]]:
    """Dequantize F32 and convert directly to sparse ternary using numpy."""
    import numpy as np
    arr = np.frombuffer(data[:num_elements*4], dtype=np.float32)
    mask = np.abs(arr) > threshold
    indices = np.where(mask)[0].astype(np.int32).tolist()
    signs = np.where(arr[mask] > 0, 1, -1).astype(np.int8).tolist()
    return indices, signs


def dequantize_f16_to_ternary(data: bytes, num_elements: int, threshold: float = 0.1) -> Tuple[List[int], List[int]]:
    """Dequantize F16 and convert directly to sparse ternary using numpy."""
    import numpy as np
    arr = np.frombuffer(data[:num_elements*2], dtype=np.float16).astype(np.float32)
    mask = np.abs(arr) > threshold
    indices = np.where(mask)[0].astype(np.int32).tolist()
    signs = np.where(arr[mask] > 0, 1, -1).astype(np.int8).tolist()
    return indices, signs


def dequantize_tensor(data: bytes, tensor_info: Dict) -> List[float]:
    """Dequantize tensor data based on its GGML type."""
    ggml_type = tensor_info["ggml_type"]
    num_elements = 1
    for d in tensor_info["dims"]:
        num_elements *= d
    
    if ggml_type == 36:  # BITNET
        return dequantize_bitnet(data, num_elements)
    else:
        # Default: read as F32
        import numpy as np
        return np.frombuffer(data[:num_elements*4], dtype=np.float32).tolist()


def to_sparse_ternary(values: List[float], threshold: float = 0.0) -> Tuple[List[int], List[int]]:
    """Convert dense values to sparse ternary format."""
    try:
        import numpy as np
        arr = np.array(values, dtype=np.float32)
        mask = np.abs(arr) > threshold
        indices = np.where(mask)[0].astype(np.int32).tolist()
        signs = np.where(arr[mask] > 0, 1, -1).astype(np.int8).tolist()
        return indices, signs
    except ImportError:
        # Fallback to pure Python
        indices = []
        signs = []
        for i, val in enumerate(values):
            if abs(val) > threshold:
                indices.append(i)
                signs.append(1 if val > 0 else -1)
        return indices, signs


def write_sparse_binary(f, indices: List[int], signs: List[int]):
    """
    Write sparse ternary data to binary file in compact format:
    - 4 bytes: count of nonzero elements
    - 4 bytes each: indices (uint32)
    - 1 byte each: signs (int8)
    """
    import numpy as np
    count = len(indices)
    f.write(struct.pack("<I", count))
    if count > 0:
        indices_arr = np.array(indices, dtype=np.uint32)
        signs_arr = np.array(signs, dtype=np.int8)
        f.write(indices_arr.tobytes())
        f.write(signs_arr.tobytes())


def extract_bitnet_structure(gguf_path: str, max_embeddings: int = 128256, threshold: float = 0.1) -> Tuple[Dict, str]:
    """
    Extract complete BitNet neural structure from GGUF.
    
    Returns:
        (structure_dict, weights_bin_path)
    """
    print(f"\n[BitNet] Parsing GGUF: {gguf_path}")
    
    metadata, tensors, data_offset, file_size = parse_gguf(gguf_path)
    
    # Extract key metadata
    arch = metadata.get("general.architecture", "bitnet")
    vocab_size = metadata.get(f"{arch}.vocab_size", 0)
    embedding_length = metadata.get(f"{arch}.embedding_length", 0)
    block_count = metadata.get(f"{arch}.block_count", 0)
    
    print(f"[BitNet] Architecture: {arch}")
    print(f"[BitNet] Vocab size: {vocab_size}")
    print(f"[BitNet] Embedding dim: {embedding_length}")
    print(f"[BitNet] Block count: {block_count}")
    print(f"[BitNet] Total tensors: {len(tensors)}")
    
    # Get vocabulary
    vocab_tokens = metadata.get("tokenizer.ggml.tokens", [])
    
    # Create binary weights file
    weights_bin_path = Path(gguf_path).parent / "neural_weights.bin"
    
    # Structure output (metadata only, no actual weights)
    structure = {
        "metadata": {
            "source_model": metadata.get("general.name", "bitnet-b1.58-2B-4T"),
            "architecture": arch,
            "vocab_size": vocab_size,
            "embedding_length": embedding_length,
            "block_count": block_count,
            "total_tensors": len(tensors),
        },
        "layers": [],
        "embeddings": {
            "count": 0,
            "tokens": [],
        },
    }
    
    # Open file with mmap for fast random access
    with open(gguf_path, "rb") as f:
        mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        
        # Open binary output file
        with open(weights_bin_path, "wb") as out_f:
            # Write header
            out_f.write(struct.pack("<I", 0x4B414957))  # Magic: "KAIW" in little-endian
            out_f.write(struct.pack("<I", 1))  # Version
            
            # Process each tensor
            for idx, tensor in enumerate(tensors):
                name = tensor["name"]
                dims = tensor["dims"]
                ggml_type = tensor["ggml_type"]
                type_name = tensor["type_name"]
                tensor_offset = tensor["offset"]
                
                # Calculate tensor size in bytes
                num_elements = 1
                for d in dims:
                    num_elements *= d
                
                block_size = get_block_size(ggml_type)
                type_size = get_type_size(ggml_type)
                num_blocks = (num_elements + block_size - 1) // block_size
                tensor_bytes = num_blocks * type_size
                
                # Read tensor data using mmap
                absolute_offset = data_offset + tensor_offset
                tensor_data = mm[absolute_offset:absolute_offset + tensor_bytes]
                
                # Convert to ternary
                if ggml_type == 1:  # F16
                    indices, signs = dequantize_f16_to_ternary(tensor_data, num_elements, threshold)
                elif ggml_type == 0:  # F32
                    indices, signs = dequantize_f32_to_ternary(tensor_data, num_elements, threshold)
                elif ggml_type == 36:  # BITNET
                    dequantized = dequantize_tensor(tensor_data, tensor)
                    indices, signs = to_sparse_ternary(dequantized)
                else:
                    indices, signs = [], []
                
                # Write binary weights
                weight_offset = out_f.tell()
                write_sparse_binary(out_f, indices, signs)
                weight_size = out_f.tell() - weight_offset
                
                # Store layer metadata
                layer_info = {
                    "name": name,
                    "dims": dims,
                    "ggml_type": ggml_type,
                    "type_name": type_name,
                    "offset": tensor_offset,
                    "num_elements": num_elements,
                    "nonzero_count": len(indices),
                    "sparsity": 1.0 - (len(indices) / num_elements) if num_elements > 0 else 0,
                    "weight_offset": weight_offset,
                    "weight_size": weight_size,
                }
                
                structure["layers"].append(layer_info)
                
                # If this is the embedding layer, extract embeddings
                if "token_embd" in name or "embed" in name.lower():
                    print(f"[BitNet] Processing embedding layer: {name} ({num_elements} elements)")
                    
                    # Note: dims are [embedding_length, vocab_size] (transposed)
                    if len(dims) == 2 and dims[0] == embedding_length and dims[1] == vocab_size:
                        embeddings_list = []
                        
                        for i in range(min(vocab_size, max_embeddings)):
                            start = i * embedding_length
                            end = start + embedding_length
                            vec_data = tensor_data[start*2:end*2] if ggml_type == 1 else tensor_data[start*4:end*4]
                            
                            # Get token
                            if i < len(vocab_tokens):
                                token_bytes = vocab_tokens[i]
                                if isinstance(token_bytes, bytes):
                                    try:
                                        token = token_bytes.decode('utf-8', errors='replace')
                                    except:
                                        token = str(token_bytes)
                                else:
                                    token = str(token_bytes)
                            else:
                                token = f"<token_{i}>"
                            
                            # Clean token
                            if token.startswith('▁'):
                                token = token[1:]
                            if token.startswith('Ġ'):
                                token = token[1:]
                            if token.startswith('##'):
                                token = token[2:]
                            
                            # Convert to ternary
                            if ggml_type == 1:
                                idxs, sgs = dequantize_f16_to_ternary(vec_data, embedding_length, threshold)
                            else:
                                idxs, sgs = dequantize_f32_to_ternary(vec_data, embedding_length, threshold)
                            
                            if len(idxs) > 0:
                                emb_offset = out_f.tell()
                                write_sparse_binary(out_f, idxs, sgs)
                                emb_size = out_f.tell() - emb_offset
                                
                                embeddings_list.append({
                                    "token": token,
                                    "offset": emb_offset,
                                    "size": emb_size,
                                    "nonzero": len(idxs),
                                })
                        
                        structure["embeddings"]["count"] = len(embeddings_list)
                        structure["embeddings"]["tokens"] = embeddings_list
                        print(f"[BitNet] Extracted {len(embeddings_list)} embeddings")
                
                # Progress
                if (idx + 1) % 50 == 0 or idx == len(tensors) - 1:
                    print(f"[BitNet] Processed {idx + 1}/{len(tensors)} tensors")
        
        mm.close()
    
    return structure, str(weights_bin_path)


def save_neural_structure(data: Dict, weights_path: str, output_path: str):
    """Save neural structure to JSON with compact format."""
    print(f"\n[BitNet] Saving metadata to {output_path}")
    print(f"[BitNet] Weights stored in {weights_path}")
    
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    
    json_size = Path(output_path).stat().st_size / (1024 * 1024)
    bin_size = Path(weights_path).stat().st_size / (1024 * 1024)
    print(f"[BitNet] JSON size: {json_size:.1f} MB")
    print(f"[BitNet] Binary size: {bin_size:.1f} MB")
    
    # Stats
    total_layers = len(data["layers"])
    total_params = sum(l["num_elements"] for l in data["layers"])
    total_nonzero = sum(l["nonzero_count"] for l in data["layers"])
    avg_sparsity = total_nonzero / total_params if total_params > 0 else 0
    
    print(f"\n[BitNet] Summary:")
    print(f"  - Total layers: {total_layers}")
    print(f"  - Total parameters: {total_params:,}")
    print(f"  - Nonzero parameters: {total_nonzero:,}")
    print(f"  - Average sparsity: {avg_sparsity:.4f} ({avg_sparsity*100:.1f}%)")
    print(f"  - Embeddings extracted: {data['embeddings']['count']}")


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Extract BitNet neural structure")
    parser.add_argument("--model", required=True, help="Path to BitNet GGUF file")
    parser.add_argument("--output", default="neural_structure.json", help="Output JSON path")
    parser.add_argument("--max-embeddings", type=int, default=128256, help="Max embeddings to extract")
    parser.add_argument("--threshold", type=float, default=0.1, help="Threshold for F16/F32 to ternary")
    
    args = parser.parse_args()
    
    if not Path(args.model).exists():
        print(f"[ERROR] Model not found: {args.model}")
        sys.exit(1)
    
    try:
        data, weights_path = extract_bitnet_structure(args.model, args.max_embeddings, args.threshold)
        save_neural_structure(data, weights_path, args.output)
        print("\n[BitNet] Done! neural_structure.json is ready for KAI.")
    except Exception as e:
        print(f"[ERROR] {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
