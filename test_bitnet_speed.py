import time
import mmap
from extract_bitnet_weights import (
    parse_gguf, get_block_size, get_type_size,
    dequantize_bitnet, write_sparse_binary
)

# Parse metadata
metadata, tensors, data_offset, file_size = parse_gguf('models\\BitNet\\bitnet-b1.58-2B-4T.gguf')

# Find a BITNET tensor
bitnet_tensors = [t for t in tensors if t['ggml_type'] == 36]
print(f"BITNET tensors: {len(bitnet_tensors)}")

# Test first one
with open('models\\BitNet\\bitnet-b1.58-2B-4T.gguf', 'rb') as f:
    mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    
    for t in bitnet_tensors[:3]:
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
        
        # Read
        start = time.time()
        absolute_offset = data_offset + tensor_offset
        tensor_data = mm[absolute_offset:absolute_offset + tensor_bytes]
        read_time = time.time() - start
        print(f"  Read: {read_time:.3f}s")
        
        # Dequantize
        start = time.time()
        dequantized = dequantize_bitnet(tensor_data, num_elements)
        deq_time = time.time() - start
        print(f"  Dequantize: {deq_time:.3f}s, len={len(dequantized)}")
        
        # Write binary
        start = time.time()
        with open('test.bin', 'wb') as out_f:
            write_sparse_binary(out_f, list(range(len(dequantized))), dequantized)
        write_time = time.time() - start
        print(f"  Write: {write_time:.3f}s")
    
    mm.close()

print("\nDone!")
