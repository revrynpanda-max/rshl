import urllib.request
import json
import time
import threading
import sys
import queue

print("======================================================")
print(" KAI SOVEREIGN TERMINAL (ASYNC)")
print("======================================================\n")
print("You can type and send messages to KAI at any time.")
print("Type 'quit' to exit.\n")

msg_queue = queue.Queue()

def poll_interjections(stop_event):
    while not stop_event.is_set():
        try:
            req = urllib.request.Request("http://127.0.0.1:3334/api/interjections")
            resp = urllib.request.urlopen(req, timeout=5)
            data = json.loads(resp.read().decode('utf-8'))
            for interjection in data.get("interjections", []):
                frm = interjection.get("from")
                text = interjection.get("text")
                if frm == "KAI_SPEAKING":
                    sys.stdout.write(f"\r\033[K\nKAI: {text}\n> ")
                    sys.stdout.flush()
                elif frm == "KAI_FINAL":
                    # We might not even need KAI_FINAL if everything is streamed, but let's keep it
                    pass
                else:
                    sys.stdout.write(f"\r\033[K\n[KAI THINKING]: {text}\n> ")
                    sys.stdout.flush()
        except:
            pass
        time.sleep(1.0)

def send_message(text):
    url = "http://127.0.0.1:3334/api/oracle-turn"
    payload = json.dumps({"from": "User", "text": text, "async_mode": True}).encode('utf-8')
    headers = {"Content-Type": "application/json"}
    try:
        req = urllib.request.Request(url, data=payload, headers=headers)
        urllib.request.urlopen(req, timeout=5)
    except Exception as e:
        sys.stdout.write(f"\r\033[K\n[System Error: {e}]\n> ")
        sys.stdout.flush()

def main():
    stop_event = threading.Event()
    poller = threading.Thread(target=poll_interjections, args=(stop_event,))
    poller.daemon = True
    poller.start()

    sys.stdout.write("> ")
    sys.stdout.flush()

    try:
        while True:
            text = input()
            if text.strip().lower() == 'quit':
                break
            if text.strip():
                sys.stdout.write("> ")
                sys.stdout.flush()
                # Run the network request in a background thread so the terminal never blocks
                threading.Thread(target=send_message, args=(text,), daemon=True).start()
    except KeyboardInterrupt:
        pass
    finally:
        stop_event.set()

if __name__ == "__main__":
    main()
