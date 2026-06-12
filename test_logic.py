import urllib.request
import json
import sys

def test_kai(question):
    url = "http://127.0.0.1:3334/api/discord-turn"
    payload = {
        "from": "Ryan@Discord",
        "text": f"@KAI {question}"
    }
    
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json'}
    )
    
    print(f"\n[Test] Question: {question}")
    try:
        with urllib.request.urlopen(req) as response:
            result = json.loads(response.read().decode('utf-8'))
            print(f"       KAI: {result.get('reply', 'No reply')}")
    except Exception as e:
        print(f"Error: {e}")

questions = [
    # Math & Voice changes
    "What is 15 + 7?",
    "What is 5 divided by 0?",
    "what is 20 percent of 50?",
    "5 is greater than 3?",

    # Logic changes
    "What is true AND false?",
    "What is true OR false?",
    "What is true XOR true?",
    "What is NOT false?",

    # Lattice Generative Test
    "Who is the president of France?"
]

if __name__ == "__main__":
    for q in questions:
        test_kai(q)
