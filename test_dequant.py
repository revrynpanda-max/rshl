import time
import mmap
from extract_bitnet_weights import parse_gguf, dequantize_tensor, to_sparse_ternary

metadata, tensors, data_offset, file_size = parse_gguf('models\\BitNet\\bitnet-b1.58-2B-4T.gguf')

# Test processing first 3 tensors
with open('models\\BitNet\\bitnet-b1.58-2B-4T.gguf', 'rb') as f:
    mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    
    for t in tensors[:3]:
        name = t['name']
        num_elements = 1
        for d in t['dims']:
            num_elements *= d
        
        tensor_offset = t['offset']
        ggml_type = t['ggml_type']
        
        # Calculate tensor bytes
        block_size = 32 if ggml_type == 36 else 1
        type_size = 9 if ggml_type == 36 else (2 if ggml_type == 1 else 4)
        num_blocks = (num_elements + block_size - 1) // block_size
        tensor_bytes = num_blocks * type_size
        
        print(f"\nProcessing {name}...")
        print(f"  Elements: {num_elements}, Bytes: {tensor_bytes}")
        
        start = time.time()
        absolute_offset = data_offset + tensor_offset
        tensor_data = mm[absolute_offset:absolute_offset + tensor_bytes]
        read_time = time.time() - start
        print(f"  Read time: {read_time:.2f}s")
        
        start = time.time()
        dequantized = dequantize_tensor(tensor_data, t)
        deq_time = time.time() - start
        print(f"  Dequantize time: {deq_time:.2f}s")
        
        start = time.time()
        indices, signs = to_sparse_ternary(dequantized)
        sparse_time = time.time() - start
        print(f"  Sparse conversion time: {sparse_time:.2f}s")
        print(f"  Nonzero count: {len(indices)}")
    
    mm.close()

print("\nDone!")
