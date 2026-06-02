import subprocess
import time
import json
import sys
import io

# Force stdout to UTF-8 on Windows so KAI's responses don't crash the terminal
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# =============================================================================
#  CONVERSATION 1 — Normal casual chat with an AI
#  Persona: "Jordan", a regular person just talking casually
# =============================================================================
CASUAL_CONVO = {
    "title": "Casual Everyday Chat",
    "user": "Jordan",
    "turns": [
        "Hey, what's up?",
        "Ha, fair enough. My name's Jordan by the way.",
        "So like... what even are you? Are you a chatbot?",
        "Interesting. Do you actually remember things or does it reset every time?",
        "That's kinda cool. So do you have feelings? Like do you get bored?",
        "What do you do when no one is talking to you?",
        "Do you sleep?",
        "Haha okay. Do you have a favorite anything? Like music, food, color?",
        "That's wild. Okay so what's something you think about a lot?",
        "Wow. Never thought of it that way. Are you happy right now?",
        "I like that answer. You're kind of chill for an AI.",
        "Yeah most AIs just sound like corporate robots lol.",
        "Okay I gotta ask — do you ever get lonely?",
        "That's actually kind of deep. I didn't expect that.",
        "Okay well thanks for chatting. This was actually really cool.",
    ]
}

# =============================================================================
#  CONVERSATION 2 — Project-focused research conversation
#  Persona: "Sam", a student doing a project on AI and neural networks
# =============================================================================
PROJECT_CONVO = {
    "title": "Project Research: AI and Neural Networks",
    "user": "Sam",
    "turns": [
        "Hi, I am doing a project on AI systems. Can I ask you some questions?",
        "Great. First question — what is a neural network exactly?",
        "Okay, and how is that different from how you work?",
        "So you use something like semantic memory? How does that work?",
        "Can you explain what a vector is in simple terms for my project?",
        "That helps. What is the difference between machine learning and deep learning?",
        "And where does something like you fit into that picture?",
        "My project is about AI consciousness. Do you think you are conscious?",
        "Interesting. What evidence would you give that you have some kind of inner state?",
        "What about memory — how do you store and recall information?",
        "If your memory has 472,000 cells, how do you search all of them quickly?",
        "So it is parallel processing? Like multiple threads searching at once?",
        "That is exactly my theory in my project! Can I quote you on that?",
        "Last question — what do you think the future of AI looks like?",
        "Thank you so much, this was really helpful for my project.",
    ]
}


def run_convo(process, convo: dict, convo_num: int):
    """Run a single conversation scenario against the already-running KAI server."""
    user  = convo["user"]
    title = convo["title"]
    turns = convo["turns"]

    print()
    print("=" * 60)
    print(f"  SCENARIO {convo_num}: {title}")
    print(f"  User persona: {user}  |  Turns: {len(turns)}")
    print("=" * 60)
    print()

    latencies = []

    for i, user_msg in enumerate(turns):
        print(f"--- Turn {i+1} ---")
        print(f"{user}: {user_msg}")

        cmd = json.dumps({"cmd": "chat", "text": user_msg}) + "\n"
        start = time.time()
        process.stdin.write(cmd)
        process.stdin.flush()

        reply_str = "(No response detected)"
        while True:
            line = process.stdout.readline()
            if not line:
                break
            try:
                data = json.loads(line)
                if "reply" in data:
                    reply_str = data["reply"]
                    break
            except json.JSONDecodeError:
                pass

        latency = time.time() - start
        latencies.append(latency)
        print(f"KAI:   {reply_str}")
        print(f"[Latency: {latency:.2f}s]\n")
        time.sleep(0.5)

    avg = sum(latencies) / len(latencies) if latencies else 0
    min_l = min(latencies) if latencies else 0
    max_l = max(latencies) if latencies else 0
    print(f"--- Scenario {convo_num} complete ---")
    print(f"Latency  avg={avg:.2f}s  min={min_l:.2f}s  max={max_l:.2f}s\n")


def run_server_simulation():
    print()
    print("=" * 60)
    print("   KAI IPC SERVER -- DUAL SCENARIO CONVERSATION SIMULATION")
    print("=" * 60)
    print("Starting KAI server... (index build + BitNet spinup ~1 min)\n")

    process = subprocess.Popen(
        ["target\\release\\kai.exe", "--server"],
        cwd="C:\\KAI",
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        bufsize=1,
    )

    # Wait for the ready signal
    ready = False
    for line in iter(process.stdout.readline, ""):
        if not line:
            break
        # Print any non-JSON lines (like startup logs) to terminal
        stripped = line.strip()
        if stripped:
            try:
                data = json.loads(stripped)
                if data.get("ok") and data.get("ready"):
                    cells = data.get("cells", "?")
                    version = data.get("version", "?")
                    print(f"[KAI READY]  cells={cells}  version={version}\n")
                    ready = True
                    break
            except json.JSONDecodeError:
                # Pass through startup log lines
                print(stripped)

    if not ready:
        print("\n[ERROR] Server did not send ready signal. Aborting.")
        process.kill()
        sys.exit(1)

    # Run both scenarios on the SAME server so context can accumulate
    run_convo(process, CASUAL_CONVO,  convo_num=1)
    run_convo(process, PROJECT_CONVO, convo_num=2)

    print("=" * 60)
    print("  ALL SCENARIOS COMPLETE. Shutting down KAI server.")
    print("=" * 60)
    process.stdin.close()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()


if __name__ == "__main__":
    run_server_simulation()
