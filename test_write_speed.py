import time
import mmap
import numpy as np
from extract_bitnet_weights import (
    parse_gguf, get_block_size, get_type_size,
    dequantize_bitnet, write_sparse_binary
)

# Parse metadata
metadata, tensors, data_offset, file_size = parse_gguf('models\\BitNet\\bitnet-b1.58-2B-4T.gguf')

# Find a BITNET tensor
bitnet_tensors = [t for t in tensors if t['ggml_type'] == 36]

# Test with first tensor
with open('models\\BitNet\\bitnet-b1.58-2B-4T.gguf', 'rb') as f:
    mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    
    t = bitnet_tensors[0]
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
    
    print(f"{name}: dims={dims}, elements={num_elements}, bytes={tensor_bytes}")
    
    # Read
    absolute_offset = data_offset + tensor_offset
    tensor_data = mm[absolute_offset:absolute_offset + tensor_bytes]
    
    # Dequantize
    start = time.time()
    dequantized = dequantize_bitnet(tensor_data, num_elements)
    deq_time = time.time() - start
    print(f"Dequantize: {deq_time:.3f}s")
    
    # Convert to sparse
    start = time.time()
    indices = np.where(dequantized != 0)[0].astype(np.int32).tolist()
    signs = dequantized[dequantized != 0].astype(np.int8).tolist()
    sparse_time = time.time() - start
    print(f"Sparse conversion: {sparse_time:.3f}s, nonzero={len(indices)}")
    
    # Write binary
    start = time.time()
    with open('test.bin', 'wb') as out_f:
        write_sparse_binary(out_f, indices, signs)
    write_time = time.time() - start
    print(f"Write: {write_time:.3f}s")
    
    mm.close()

print("\nDone!")
