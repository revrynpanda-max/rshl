import urllib.request, json, time

def ask(msg):
    data = json.dumps({'from': 'Antigravity', 'text': msg}).encode()
    req = urllib.request.Request(
        'http://127.0.0.1:3334/api/oracle-turn',
        data=data,
        headers={'Content-Type': 'application/json'}
    )
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.loads(r.read())

turns = [
    'Write me a short poem about a robot learning to love.',
    'How do I make a chocolate chip cookie? Give me a short recipe.',
    'Can you help me write a Python script to reverse a string?',
    'What\'s the meaning of life?',
    'Tell me a joke.',
]

for q in turns:
    print(f'\n[Antigravity]: {q}')
    try:
        r = ask(q)
        # Handle dict or string response appropriately
        if isinstance(r, dict):
            print(f'[KAI]: {r.get("reply", str(r))}')
        else:
            print(f'[KAI]: {r}')
    except Exception as e:
        print(f'[KAI]: ERROR - {e}')
    time.sleep(2)
