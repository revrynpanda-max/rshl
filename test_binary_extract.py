import time
import mmap
import struct
import numpy as np
from pathlib import Path
from extract_bitnet_weights import (
    parse_gguf, get_block_size, get_type_size,
    dequantize_f16_to_ternary, dequantize_f32_to_ternary,
    dequantize_tensor, to_sparse_ternary, write_sparse_binary
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
    
    # Find embedding tensor
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
        
        print(f"\nEmbedding tensor: {name}, dims={dims}, type={ggml_type}")
        
        # Read tensor data
        num_elements = 1
        for d in dims:
            num_elements *= d
        tensor_bytes = num_elements * 2 if ggml_type == 1 else num_elements * 4
        
        absolute_offset = data_offset + offset
        tensor_data = mm[absolute_offset:absolute_offset + tensor_bytes]
        
        print(f"Tensor data size: {len(tensor_data)} bytes")
        
        # Test extracting 1000 embeddings
        max_embeddings = 1000
        threshold = 0.1
        
        print(f"\nExtracting {max_embeddings} embeddings...")
        start = time.time()
        
        with open('test_weights.bin', 'wb') as out_f:
            # Write header
            out_f.write(struct.pack("<I", 0x4B414957))  # Magic
            out_f.write(struct.pack("<I", 1))  # Version
            
            embeddings_list = []
            
            for i in range(min(vocab_size, max_embeddings)):
                start_idx = i * embedding_length
                end_idx = start_idx + embedding_length
                vec_data = tensor_data[start_idx*2:end_idx*2]
                
                # Get token
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
            
            total_time = time.time() - start
            print(f"Extracted {len(embeddings_list)} embeddings in {total_time:.2f}s")
            print(f"Binary file size: {out_f.tell() / (1024*1024):.1f} MB")
        
        mm.close()

print("\nDone!")
