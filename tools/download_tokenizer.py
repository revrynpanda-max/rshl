import urllib.request
url = "https://huggingface.co/1bitLLM/bitnet_b1_58-2B/resolve/main/tokenizer.json"
try:
    response = urllib.request.urlopen(url, timeout=10)
    data = response.read()
    with open("models/BitNet/tokenizer.json", "wb") as f:
        f.write(data)
    print(f"Downloaded tokenizer.json ({len(data)} bytes)")
except Exception as e:
    print(f"BitNet repo failed: {e}")
    print("Trying meta-llama/Llama-3.2-1B tokenizer instead...")
    # The BitNet 2B-4T model uses llama3 tokenizer with 128256 vocab
    url2 = "https://huggingface.co/meta-llama/Llama-3.2-1B/resolve/main/tokenizer.json"
    try:
        response = urllib.request.urlopen(url2, timeout=10)
        data = response.read()
        with open("models/BitNet/tokenizer.json", "wb") as f:
            f.write(data)
        print(f"Downloaded Llama3.2 tokenizer.json ({len(data)} bytes)")
    except Exception as e2:
        print(f"Llama3.2 also failed: {e2}")
        print("We'll use the TinyLlama tokenizer as fallback (may not match vocab size)")
