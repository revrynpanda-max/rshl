import os

def simpler_shrink(input_file, output_file):
    print(f"Shrinking {input_file}...")
    target = b'"synaptic_layer":'
    
    with open(input_file, 'rb') as f, open(output_file, 'wb') as out_f:
        chunk_size = 64 * 1024 * 1024 # 64MB
        buf = b""
        
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                out_f.write(buf)
                break
                
            buf += chunk
            idx = buf.find(target)
            
            if idx != -1:
                # Found it! Write everything up to the target
                out_f.write(buf[:idx])
                
                # Append a clean, empty synaptic_layer and close the JSON object
                clean_layer = b'"synaptic_layer":{"synapses":[],"index":{},"latent_traces":[],"tick":0,"total_ltp":0,"total_ltd":0,"total_pruned":0}}'
                out_f.write(clean_layer)
                print(f"Successfully truncated. Original size was ~8.9GB.")
                return
            else:
                # Not found yet. Write out everything except the last few bytes (in case the target overlaps chunks)
                write_len = len(buf) - len(target)
                if write_len > 0:
                    out_f.write(buf[:write_len])
                    buf = buf[write_len:]
                    
    print("WARNING: Did not find synaptic_layer in the file!")

if __name__ == "__main__":
    inp = "C:/KAI/data/kai-mind.json"
    outp = "C:/KAI/data/kai-mind.shrunk.json"
    simpler_shrink(inp, outp)
