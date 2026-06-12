import urllib.request, json, time

def ask(msg):
    data = json.dumps({'from': 'Ryan', 'text': msg}).encode()
    req = urllib.request.Request(
        'http://127.0.0.1:3334/api/oracle-turn',
        data=data,
        headers={'Content-Type': 'application/json'}
    )
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.loads(r.read())

turns = [
    'Hello KAI, how are you today?',
    'Are your systems functioning normally?',
    'What do you think about the semantic lattice?',
    'That is a very interesting concept. Please tell me more about it.',
    'Okay, goodbye for now!'
]

for q in turns:
    print(f'\n[Ryan]: {q}')
    try:
        r = ask(q)
        if isinstance(r, dict):
            print(f'[KAI]: {r.get("reply", str(r))}')
        else:
            print(f'[KAI]: {r}')
    except Exception as e:
        print(f'[KAI]: ERROR - {e}')
    time.sleep(1)
