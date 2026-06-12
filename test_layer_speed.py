import time
import mmap
from extract_bitnet_weights import (
    parse_gguf, get_block_size, get_type_size,
    dequantize_tensor, to_sparse_ternary
)

# Parse metadata
metadata, tensors, data_offset, file_size = parse_gguf('models\\BitNet\\bitnet-b1.58-2B-4T.gguf')

print(f"Total tensors: {len(tensors)}")

# Count types
type_counts = {}
for t in tensors:
    t_type = t['ggml_type']
    type_counts[t_type] = type_counts.get(t_type, 0) + 1
print(f"Type counts: {type_counts}")

# Test processing first 10 BITNET tensors
with open('models\\BitNet\\bitnet-b1.58-2B-4T.gguf', 'rb') as f:
    mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    
    bitnet_tensors = [t for t in tensors if t['ggml_type'] == 36][:10]
    
    for t in bitnet_tensors:
        name = t['name']
        dims = t['dims']
        ggml_type = t['ggml_type']
        tensor_offset = t['offset']
        
        num_elements = 1
        for d in dims:
            num_elements *= d
        
        block_size = get_block_size(ggml_type)
        type_size = get_type_size(ggml_type)
        num_blocks = (num_elements + block_size - 1) // block_size
        tensor_bytes = num_blocks * type_size
        
        print(f"\n{name}: dims={dims}, elements={num_elements}, bytes={tensor_bytes}")
        
        start = time.time()
        absolute_offset = data_offset + tensor_offset
        tensor_data = mm[absolute_offset:absolute_offset + tensor_bytes]
        read_time = time.time() - start
        print(f"  Read: {read_time:.3f}s")
        
        start = time.time()
        dequantized = dequantize_tensor(tensor_data, t)
        deq_time = time.time() - start
        print(f"  Dequantize: {deq_time:.3f}s, len={len(dequantized)}")
        
        start = time.time()
        indices, signs = to_sparse_ternary(dequantized)
        sparse_time = time.time() - start
        print(f"  Sparse: {sparse_time:.3f}s, nonzero={len(indices)}")
    
    mm.close()

print("\nDone!")
