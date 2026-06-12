import time
print("Starting test...")

start = time.time()

# Test 1: parse metadata
print("Test 1: Parsing metadata...")
from extract_bitnet_weights import parse_gguf
metadata, tensors, data_offset, file_size = parse_gguf('models\\BitNet\\bitnet-b1.58-2B-4T.gguf')
print(f"  Done in {time.time()-start:.2f}s")

# Test 2: read first tensor data
print("Test 2: Reading first tensor...")
start = time.time()
import mmap
with open('models\\BitNet\\bitnet-b1.58-2B-4T.gguf', 'rb') as f:
    mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    t = tensors[0]
    offset = data_offset + t['offset']
    num_elements = 1
    for d in t['dims']:
        num_elements *= d
    tensor_bytes = num_elements * 2  # F16
    data = mm[offset:offset + tensor_bytes]
    print(f"  Read {len(data)} bytes in {time.time()-start:.2f}s")
    mm.close()

# Test 3: dequantize to ternary
print("Test 3: Dequantize to ternary...")
start = time.time()
from extract_bitnet_weights import dequantize_f16_to_ternary
indices, signs = dequantize_f16_to_ternary(data, num_elements, 0.1)
print(f"  Done in {time.time()-start:.2f}s, nonzero={len(indices)}")

# Test 4: extract single embedding
print("Test 4: Extract single embedding...")
start = time.time()
emb_length = t['dims'][1]
vec_data = data[:emb_length*2]
idxs, sgs = dequantize_f16_to_ternary(vec_data, emb_length, 0.1)
print(f"  Done in {time.time()-start:.2f}s, nonzero={len(idxs)}")

# Test 5: extract 10 embeddings
print("Test 5: Extract 10 embeddings...")
start = time.time()
for i in range(10):
    start_idx = i * emb_length
    end_idx = start_idx + emb_length
    vec_data = data[start_idx*2:end_idx*2]
    idxs, sgs = dequantize_f16_to_ternary(vec_data, emb_length, 0.1)
print(f"  Done in {time.time()-start:.2f}s")

# Test 6: extract 100 embeddings
print("Test 6: Extract 100 embeddings...")
start = time.time()
for i in range(100):
    start_idx = i * emb_length
    end_idx = start_idx + emb_length
    vec_data = data[start_idx*2:end_idx*2]
    idxs, sgs = dequantize_f16_to_ternary(vec_data, emb_length, 0.1)
print(f"  Done in {time.time()-start:.2f}s")

# Test 7: JSON serialization
print("Test 7: JSON serialization of 100 embeddings...")
import json
embeddings = {}
for i in range(100):
    start_idx = i * emb_length
    end_idx = start_idx + emb_length
    vec_data = data[start_idx*2:end_idx*2]
    idxs, sgs = dequantize_f16_to_ternary(vec_data, emb_length, 0.1)
    embeddings[f"token_{i}"] = {"indices": idxs, "signs": sgs}

start = time.time()
json_str = json.dumps(embeddings)
print(f"  Done in {time.time()-start:.2f}s, size={len(json_str)} bytes")

print("\nAll tests passed!")
