import time
from extract_bitnet_weights import parse_gguf, get_block_size, get_type_size

start = time.time()
metadata, tensors, data_offset, file_size = parse_gguf('models\\BitNet\\bitnet-b1.58-2B-4T.gguf')
print(f'Parse time: {time.time()-start:.2f}s')
print(f'Data offset: {data_offset}')
print(f'File size: {file_size}')

# Check first tensor
for t in tensors[:3]:
    num_elements = 1
    for d in t['dims']:
        num_elements *= d
    block_size = get_block_size(t['ggml_type'])
    type_size = get_type_size(t['ggml_type'])
    num_blocks = (num_elements + block_size - 1) // block_size
    tensor_bytes = num_blocks * type_size
    print(f"{t['name']}: type={t['type_name']}, elements={num_elements}, bytes={tensor_bytes}")
