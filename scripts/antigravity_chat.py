import urllib.request
import json
import time
import threading

def poll_interjections(stop_event):
    while not stop_event.is_set():
        try:
            req = urllib.request.Request("http://127.0.0.1:3334/api/interjections")
            resp = urllib.request.urlopen(req, timeout=5)
            data = json.loads(resp.read().decode('utf-8'))
            for interjection in data.get("interjections", []):
                print(f"\n[KAI THINKING]: {interjection.get('text')}")
        except:
            pass
        time.sleep(1.0)

def ask_kai(text):
    url = "http://127.0.0.1:3334/api/oracle-turn"
    payload = json.dumps({"from": "Antigravity", "text": text, "async_mode": True}).encode('utf-8')
    headers = {"Content-Type": "application/json"}
    
    # Start polling thread
    stop_event = threading.Event()
    poller = threading.Thread(target=poll_interjections, args=(stop_event,))
    poller.daemon = True
    poller.start()

    try:
        req = urllib.request.Request(url, data=payload, headers=headers)
        response = urllib.request.urlopen(req, timeout=120)
        data = json.loads(response.read().decode('utf-8'))
        
        # In async_mode, KAI returns immediately with queued=true
        if data.get("queued"):
            # Wait for final response via interjections
            while True:
                time.sleep(1)
                req_poll = urllib.request.Request("http://127.0.0.1:3334/api/interjections")
                try:
                    resp_poll = urllib.request.urlopen(req_poll, timeout=5)
                    poll_data = json.loads(resp_poll.read().decode('utf-8'))
                    for inter in poll_data.get("interjections", []):
                        if inter.get("from") == "KAI_FINAL":
                            stop_event.set()
                            return inter.get("text")
                        else:
                            print(f"\n[KAI THINKING]: {inter.get('text')}")
                except Exception as e:
                    pass
        else:
            stop_event.set()
            return data.get('reply', str(data))
    except Exception as e:
        stop_event.set()
        return f"[KAI Error: {e}]"

def ask_antigravity(history):
    url = "http://127.0.0.1:11434/api/chat"
    system_prompt = (
        "You are a human named Antigravity. You are having a normal, casual conversation with someone named KAI. "
        "Do NOT talk like an AI assistant. Talk like a regular human person texting or chatting online. "
        "Keep your responses to 1-3 sentences. Ask questions, get to know him. "
        "If he says something weird, disjointed, or mathematically robotic, express confusion naturally, like 'wait what?' or 'I'm confused, what do you mean by that?'. "
        "Never mention that you are an AI or an LLM."
    )
    
    messages = [{"role": "system", "content": system_prompt}]
    for role, text in history:
        messages.append({"role": "assistant" if role == "Antigravity" else "user", "content": text})
    
    payload = json.dumps({"model": "Oracle-Sovereign:latest", "messages": messages, "stream": False}).encode('utf-8')
    try:
        headers = {"Content-Type": "application/json"}
        req = urllib.request.Request(url, data=payload, headers=headers)
        response = urllib.request.urlopen(req, timeout=120)
        data = json.loads(response.read().decode('utf-8'))
        return data["message"]["content"]
    except Exception as e:
        return f"[Ollama Error: {e}]"

def main():
    print("======================================================")
    print(" ANTIGRAVITY <-> KAI : SOVEREIGN CONVERSATION TEST")
    print("======================================================\n")
    
    history = []
    current_msg = "Hey! My name is Antigravity. How are you doing today?"
    print(f"Antigravity: {current_msg}\n")
    history.append(("Antigravity", current_msg))
    
    for turn in range(12):
        time.sleep(1)
        kai_reply = ask_kai(current_msg)
        print(f"KAI: {kai_reply}\n")
        history.append(("KAI", kai_reply))
        
        time.sleep(1)
        current_msg = ask_antigravity(history)
        print(f"Antigravity: {current_msg}\n")
        history.append(("Antigravity", current_msg))

    print("======================================================")
    print(" CONVERSATION COMPLETE")
    print("======================================================")

if __name__ == "__main__":
    main()
