import requests
import json
import time

def ingest_file(filename, region):
    with open(filename, 'r', encoding='utf-8') as f:
        text = f.read()
    
    paragraphs = [p.strip() for p in text.split('\n\n') if len(p.strip()) > 50]
    
    data = []
    for p in paragraphs:
        data.append({
            "text": p,
            "region": region,
            "source": "manual_ingest",
            "strength": 1.0
        })
    
    print(f"Ingesting {len(data)} paragraphs from {filename}...")
    try:
        resp = requests.post("http://127.0.0.1:3334/api/bulk-ingest", json={"entries": data})
        print(f"Ingest response: {resp.status_code}")
    except Exception as e:
        print(f"Error ingesting: {e}")

def ask_kai(question):
    try:
        resp = requests.post("http://127.0.0.1:3334/api/chat", json={"message": question, "user_id": "test_script"}, timeout=60)
        if resp.status_code == 200:
            return resp.json().get("reply", "")
        return f"HTTP {resp.status_code}"
    except Exception as e:
        return f"Error: {e}"

if __name__ == "__main__":
    # Ingest the files again with a strength of 5.0 to override existing memories
    def ingest_file_high_strength(filename, region):
        with open(filename, 'r', encoding='utf-8') as f:
            text = f.read()
        paragraphs = [p.strip() for p in text.split('\n\n') if len(p.strip()) > 50]
        data = [{"text": p, "region": region, "source": "manual_ingest", "strength": 5.0} for p in paragraphs]
        try:
            resp = requests.post("http://127.0.0.1:3334/api/bulk-ingest", json={"entries": data})
            print(f"Ingest response: {resp.status_code}")
        except Exception as e:
            print(f"Error ingesting: {e}")

    ingest_file_high_strength("data/ingest/particle_life.txt", "physics")
    ingest_file_high_strength("data/ingest/symbolic_regression.txt", "math")
    
    print("\nWaiting 5 seconds for synaptogenesis to settle...")
    time.sleep(5)
    
    questions = [
        "What is Particle Life?",
        "How does Symbolic Regression differ from standard regression?",
        "What are the simple rules of Particle Life?",
        "Why is Symbolic Regression considered interpretable?"
    ]
    
    for q in questions:
        print(f"\nQ: {q}")
        ans = ask_kai(q)
        print(f"KAI: {ans}")
