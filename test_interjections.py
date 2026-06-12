import urllib.request
import json
import time
import threading

def poll_interjections(stop_event):
    while not stop_event.is_set():
        try:
            req = urllib.request.Request('http://127.0.0.1:3334/api/interjections')
            resp = urllib.request.urlopen(req, timeout=5)
            data = json.loads(resp.read().decode('utf-8'))
            for interjection in data.get('interjections', []):
                print(f'\n[KAI THINKING]: {interjection.get("text")}')
        except:
            pass
        time.sleep(1.0)

url = 'http://127.0.0.1:3334/api/oracle-turn'
payload = json.dumps({'from': 'Antigravity', 'text': 'run command dir', 'async_mode': True}).encode('utf-8')
headers = {'Content-Type': 'application/json'}

stop_event = threading.Event()
poller = threading.Thread(target=poll_interjections, args=(stop_event,))
poller.daemon = True
poller.start()

try:
    print('Sending command to KAI...')
    req = urllib.request.Request(url, data=payload, headers=headers)
    response = urllib.request.urlopen(req, timeout=120)
    data = json.loads(response.read().decode('utf-8'))
    
    if data.get('queued'):
        while True:
            time.sleep(1)
            req_poll = urllib.request.Request('http://127.0.0.1:3334/api/interjections')
            try:
                resp_poll = urllib.request.urlopen(req_poll, timeout=5)
                poll_data = json.loads(resp_poll.read().decode('utf-8'))
                for inter in poll_data.get('interjections', []):
                    if inter.get('from') == 'KAI_FINAL':
                        stop_event.set()
                        print(f'\n[FINAL]: {inter.get("text")}')
                        exit(0)
                    else:
                        print(f'\n[KAI THINKING]: {inter.get("text")}')
            except Exception as e:
                pass
    else:
        stop_event.set()
        print('Synchronous reply:', data)
except Exception as e:
    print('Error:', e)
