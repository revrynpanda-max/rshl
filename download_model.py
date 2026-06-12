import urllib.request
import sys
import os
import time

MODEL_URL = "https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf/resolve/main/Phi-3-mini-4k-instruct-q4.gguf"
TOKENIZER_URL = "https://huggingface.co/microsoft/Phi-3-mini-4k-instruct/resolve/main/tokenizer.json"

MODEL_DEST = r"C:\KAI\models\model.gguf"
TOKENIZER_DEST = r"C:\KAI\models\tokenizer.json"

def report_hook(count, block_size, total_size):
    global start_time
    if count == 0:
        start_time = time.time()
        return
    duration = time.time() - start_time
    progress_size = int(count * block_size)
    speed = int(progress_size / (1024 * duration)) if duration > 0 else 0
    percent = min(int(count*block_size*100/total_size), 100)
    sys.stdout.write(f"\r...{percent}% | {progress_size / (1024 * 1024):.2f} MB downloaded | {speed} KB/s")
    sys.stdout.flush()

def main():
    os.makedirs(r"C:\KAI\models", exist_ok=True)
    
    print(f"Downloading tokenizer from {TOKENIZER_URL}")
    urllib.request.urlretrieve(TOKENIZER_URL, TOKENIZER_DEST)
    print("\nTokenizer downloaded successfully.")
    
    print(f"Downloading model from {MODEL_URL} (This is ~2.4GB and will take a few minutes...)")
    try:
        urllib.request.urlretrieve(MODEL_URL, MODEL_DEST, reporthook=report_hook)
        print("\nModel downloaded successfully.")
    except Exception as e:
        print(f"\nError downloading model: {e}")

if __name__ == "__main__":
    main()
