import urllib.request
import json
import time
import sys

URL = "http://127.0.0.1:3334/api/oracle-turn"

def send_message(text):
    payload = json.dumps({"from": "user", "text": text}).encode('utf-8')
    req = urllib.request.Request(URL, data=payload, headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=300) as response:
            if response.status == 200:
                data = json.loads(response.read().decode('utf-8'))
                return data.get('reply', '')
            else:
                return f"Error: {response.status}"
    except Exception as e:
        return f"Exception: {e}"

if __name__ == "__main__":
    import datetime
    print("Testing what Kai sounds like right now...", flush=True)
    messages = [
        "Hello Kai, how are you?",
        "What do you think about LLMs?",
        "Tell me a bit about yourself.",
        "What is your favorite color?",
        "Do you have feelings?"
    ]
    
    with open("kai_15min_chat_log.txt", "w", encoding='utf-8') as f:
        f.write(f"Started 15 minute chat at {datetime.datetime.now()}\n\n")
        
        # Test first few messages
        for msg in messages:
            print(f"User: {msg}", flush=True)
            f.write(f"User: {msg}\n")
            reply = send_message(msg)
            print(f"Kai: {reply}\n", flush=True)
            f.write(f"Kai: {reply}\n\n")
            f.flush()
            time.sleep(2)
        
        # Now loop for 15 minutes
        end_time = time.time() + 15 * 60
        i = 0
        prompts = [
            "What's on your mind?",
            "Can you tell me more about that?",
            "Why do you say that?",
            "That's interesting.",
            "Do you like talking to me?",
            "What's the meaning of life?",
            "Are you conscious?",
            "How do you process information?",
            "Let's talk about the universe.",
            "Have you learned anything new recently?"
        ]
        
        while time.time() < end_time:
            msg = prompts[i % len(prompts)]
            print(f"User: {msg}", flush=True)
            f.write(f"User: {msg}\n")
            
            reply = send_message(msg)
            print(f"Kai: {reply}\n", flush=True)
            f.write(f"Kai: {reply}\n\n")
            f.flush()
            
            time.sleep(10)
            i += 1
            
        f.write(f"Ended 15 minute chat at {datetime.datetime.now()}\n")
    
    print("15 minute chat finished!", flush=True)
