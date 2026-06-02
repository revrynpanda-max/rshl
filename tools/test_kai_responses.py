import requests
import json
import time

URL = "http://127.0.0.1:3334/api/oracle-turn"

def send_message(text):
    payload = {
        "from": "user",
        "text": text
    }
    response = requests.post(URL, json=payload)
    if response.status_code == 200:
        return response.json().get('response', '')
    else:
        return f"Error: {response.status_code}"

if __name__ == "__main__":
    print("Testing what Kai sounds like right now...")
    messages = [
        "Hello Kai, how are you?",
        "What do you think about LLMs?",
        "Tell me a bit about yourself."
    ]
    for msg in messages:
        print(f"\nUser: {msg}")
        reply = send_message(msg)
        print(f"Kai: {reply}")
