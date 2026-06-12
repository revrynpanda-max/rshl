import urllib.request
import urllib.parse
import json
import time

def ask_kai(text):
    data = json.dumps({'from': 'Antigravity', 'text': text}).encode('utf-8')
    req = urllib.request.Request('http://127.0.0.1:3334/api/discord-turn', data=data, headers={'Content-Type': 'application/json'})
    try:
        response = urllib.request.urlopen(req)
        print(f'[Antigravity]: {text}')
        print(f'[KAI]: {json.loads(response.read().decode())["reply"]}')
    except Exception as e:
        print(f'ERROR: {e}')

time.sleep(2)
ask_kai('hello kai')
ask_kai('what do you know about yourself?')
ask_kai('who am i?')
