import time
import mmap
import numpy as np
from extract_bitnet_weights import parse_gguf, dequantize_f16_to_ternary

metadata, tensors, data_offset, file_size = parse_gguf('models\\BitNet\\bitnet-b1.58-2B-4T.gguf')

# Get vocab
tokens = metadata.get('tokenizer.ggml.tokens', [])
print(f"Vocab size: {len(tokens)}")

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
    vocab_size = dims[0]
    embedding_length = dims[1]
    
    print(f"Embedding tensor: {name}, dims={dims}, type={ggml_type}")
    
    # Read first 100 embeddings
    max_embeddings = 100
    with open('models\\BitNet\\bitnet-b1.58-2B-4T.gguf', 'rb') as f:
        mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        
        total_start = time.time()
        embeddings = {}
        
        for i in range(min(vocab_size, max_embeddings)):
            start = i * embedding_length
            end = start + embedding_length
            vec_data = mm[data_offset + offset + start*2:data_offset + offset + end*2]
            
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
            
            # Clean token
            if token.startswith('▁'):
                token = token[1:]
            if token.startswith('Ġ'):
                token = token[1:]
            if token.startswith('##'):
                token = token[2:]
            
            if len(idxs) > 0:
                embeddings[token] = {"indices": idxs, "signs": sgs}
        
        total_time = time.time() - total_start
        print(f"Extracted {len(embeddings)} embeddings in {total_time:.2f}s")
        print(f"First 5 embeddings: {list(embeddings.keys())[:5]}")
        
        mm.close()

print("Done!")
