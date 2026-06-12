import urllib.request
import json
import sys
import time

def test_kai(text):
    url = "http://127.0.0.1:3334/api/oracle-turn"
    payload = json.dumps({"from": "Ryan", "text": text}).encode('utf-8')
    headers = {"Content-Type": "application/json"}
    
    for _ in range(120):
        try:
            req = urllib.request.Request(url, data=payload, headers=headers)
            response = urllib.request.urlopen(req)
            data = json.loads(response.read().decode('utf-8'))
            print(f"\n--- KAI MATH & OUTPUT ---")
            print(f"Input: {text}")
            print(f"Final Reply: {data.get('reply', data)}")
            print("-------------------------\n")
            return
        except Exception as e:
            time.sleep(3)
    
    print("Failed to reach KAI after 6 minutes.")

if __name__ == "__main__":
    test_phrase = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "how are you feeling internally right now?"
    test_kai(test_phrase)
