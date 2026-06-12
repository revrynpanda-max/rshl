import subprocess
import os

models = [
    "Oracle-Sovereign:latest",
    "X-Sovereign:latest",
    "Groq-Sovereign:latest",
    "Gemini-Sovereign:latest",
    "Claudey-Sovereign:latest",
    "Leo-Sovereign:latest",
    "Researcher-Sovereign:latest",
    "Kai-Coder-Sovereign:latest",
    "KAI-Sovereign:latest",
    "Analyst-Sovereign:latest"
]

for model in models:
    print(f"Fixing {model}...")
    try:
        # Get modelfile
        result = subprocess.run(["ollama", "show", "--modelfile", model], capture_output=True, text=True, encoding="utf-8")
        if result.returncode != 0:
            print(f"Model {model} not found or error. Skipping.")
            continue
            
        modelfile = result.stdout
        
        # Remove old num_ctx if present
        lines = modelfile.split('\n')
        new_lines = []
        for line in lines:
            if "PARAMETER num_ctx" not in line:
                new_lines.append(line)
                
        # Append new num_ctx
        new_lines.append("PARAMETER num_ctx 4096")
        
        new_modelfile = '\n'.join(new_lines)
        
        with open("temp_modelfile.txt", "w", encoding="utf-8") as f:
            f.write(new_modelfile)
            
        subprocess.run(["ollama", "create", model, "-f", "temp_modelfile.txt"])
        print(f"Successfully clamped {model} context window.")
    except Exception as e:
        print(f"Error on {model}: {e}")

if os.path.exists("temp_modelfile.txt"):
    os.remove("temp_modelfile.txt")
print("Done!")
