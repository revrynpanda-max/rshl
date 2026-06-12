import time
import sys
import mmap
import json
from pathlib import Path
from extract_bitnet_weights import (
    parse_gguf, get_block_size, get_type_size, 
    dequantize_f16_to_ternary, dequantize_tensor, to_sparse_ternary
)

# Parse metadata
metadata, tensors, data_offset, file_size = parse_gguf('models\\BitNet\\bitnet-b1.58-2B-4T.gguf')

# Get vocab
tokens = metadata.get('tokenizer.ggml.tokens', [])
arch = metadata.get('general.architecture', 'bitnet')
vocab_size = metadata.get(f'{arch}.vocab_size', 0)
embedding_length = metadata.get(f'{arch}.embedding_length', 0)

print(f"Vocab: {len(tokens)}, vocab_size: {vocab_size}, embedding_length: {embedding_length}")

# Open mmap
with open('models\\BitNet\\bitnet-b1.58-2B-4T.gguf', 'rb') as f:
    mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    
    # Process only first 10 layers
    layers = []
    for idx, tensor in enumerate(tensors[:10]):
        name = tensor['name']
        dims = tensor['dims']
        ggml_type = tensor['ggml_type']
        tensor_offset = tensor['offset']
        
        num_elements = 1
        for d in dims:
            num_elements *= d
        
        block_size = get_block_size(ggml_type)
        type_size = get_type_size(ggml_type)
        num_blocks = (num_elements + block_size - 1) // block_size
        tensor_bytes = num_blocks * type_size
        
        print(f"\n[{idx}] {name}: type={ggml_type}, elements={num_elements}, bytes={tensor_bytes}")
        
        start = time.time()
        absolute_offset = data_offset + tensor_offset
        tensor_data = mm[absolute_offset:absolute_offset + tensor_bytes]
        read_time = time.time() - start
        print(f"  Read: {read_time:.3f}s")
        
        start = time.time()
        if ggml_type == 1:
            indices, signs = dequantize_f16_to_ternary(tensor_data, num_elements, 0.1)
        elif ggml_type == 0:
            indices, signs = dequantize_f16_to_ternary(tensor_data, num_elements, 0.1)  # F32 not needed here
        else:
            dequantized = dequantize_tensor(tensor_data, tensor)
            indices, signs = to_sparse_ternary(dequantized)
        deq_time = time.time() - start
        print(f"  Dequantize: {deq_time:.3f}s, nonzero={len(indices)}")
        
        layers.append({
            "name": name,
            "dims": dims,
            "ggml_type": ggml_type,
            "nonzero_count": len(indices),
            "indices": indices,
            "signs": signs,
        })
    
    # Extract 1000 embeddings
    print(f"\n--- Extracting 1000 embeddings ---")
    embeddings = {}
    emb_tensor = None
    for t in tensors:
        if 'token_embd' in t['name']:
            emb_tensor = t
            break
    
    if emb_tensor:
        name = emb_tensor['name']
        dims = emb_tensor['dims']
        ggml_type = emb_tensor['ggml_type']
        offset = emb_tensor['offset']
        
        start = time.time()
        for i in range(1000):
            start_idx = i * embedding_length
            end_idx = start_idx + embedding_length
            vec_data = mm[data_offset + offset + start_idx*2:data_offset + offset + end_idx*2]
            idxs, sgs = dequantize_f16_to_ternary(vec_data, embedding_length, 0.1)
            
            if i < len(tokens):
                token_bytes = tokens[i]
                if isinstance(token_bytes, bytes):
                    try:
                        token = token_bytes.decode('utf-8', errors='replace')
                    except:
                        token = str(token_bytes)
                else:
                    token = str(token_bytes)
            else:
                token = f"<token_{i}>"
            
            if token.startswith('▁'):
                token = token[1:]
            if token.startswith('Ġ'):
                token = token[1:]
            if token.startswith('##'):
                token = token[2:]
            
            if len(idxs) > 0:
                embeddings[token] = {"indices": idxs, "signs": sgs}
        
        total_time = time.time() - start
        print(f"Extracted {len(embeddings)} embeddings in {total_time:.2f}s")
    
    mm.close()

# Save
structure = {
    "metadata": {
        "source_model": metadata.get("general.name", "bitnet-b1.58-2B-4T"),
        "architecture": arch,
        "vocab_size": vocab_size,
        "embedding_length": embedding_length,
    },
    "layers": layers,
    "embeddings": embeddings,
}

print(f"\nSaving JSON...")
start = time.time()
with open('neural_structure_1000.json', 'w', encoding='utf-8') as f:
    json.dump(structure, f, ensure_ascii=False, separators=(',', ':'))
print(f"Saved in {time.time()-start:.2f}s")

file_size = Path('neural_structure_1000.json').stat().st_size / (1024 * 1024)
print(f"File size: {file_size:.1f} MB")

print("Done!")
