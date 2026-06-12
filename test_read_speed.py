import time
import mmap
from extract_bitnet_weights import parse_gguf, get_block_size, get_type_size

# Parse metadata
metadata, tensors, data_offset, file_size = parse_gguf('models\\BitNet\\bitnet-b1.58-2B-4T.gguf')

print(f"Total tensors: {len(tensors)}")

# Test reading first 10 tensors
with open('models\\BitNet\\bitnet-b1.58-2B-4T.gguf', 'rb') as f:
    mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    
    for t in tensors[:10]:
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
        print(f"  Read: {read_time:.3f}s, data_len={len(tensor_data)}")
    
    mm.close()

print("\nDone!")
