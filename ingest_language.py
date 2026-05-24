import json
import urllib.request
import time
import sys

URL = "http://127.0.0.1:3334/api/bulk-ingest"
DICT_PATH = "C:\\KAI\\data\\dictionary.json"

def main():
    print("Loading dictionary...", flush=True)
    try:
        with open(DICT_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print(f"Error loading dictionary: {e}")
        return

    words = list(data.keys())
    total_words = len(words)
    print(f"Loaded {total_words} words. Starting ingestion...", flush=True)

    batch_size = 50
    payload = []
    
    start_time = time.time()
    
    for i, word in enumerate(words):
        definition = data[word]
        # Format the text to anchor the meaning explicitly
        text = f"The definition of the word '{word}' is: {definition}"
        
        payload.append({
            "text": text,
            "region": "dictionary",
            "source": "linguistics",
            "strength": 1.0,
            "user_id": ""
        })

        if len(payload) >= batch_size or i == total_words - 1:
            req_data = {"entries": payload}
            req = urllib.request.Request(URL, method="POST")
            req.add_header('Content-Type', 'application/json')
            body = json.dumps(req_data).encode('utf-8')
            
            try:
                with urllib.request.urlopen(req, data=body) as response:
                    resp_data = response.read()
            except Exception as e:
                print(f"Error pushing batch ending at index {i}: {e}", flush=True)
                time.sleep(5) # Backoff if KAI is overwhelmed
                continue
            
            payload = []
            
            if (i + 1) % 500 == 0 or i == total_words - 1:
                elapsed = time.time() - start_time
                rate = (i + 1) / elapsed
                print(f"[{i + 1} / {total_words}] Ingested. Rate: {rate:.2f} words/sec", flush=True)

if __name__ == "__main__":
    main()
