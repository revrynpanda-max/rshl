import urllib.request, json, time, random, sys, os

sys.stdout.reconfigure(encoding='utf-8', errors='replace', line_buffering=True)
BASE = "http://127.0.0.1:3334"

CONVERSATION_SEEDS = [
    ("a tired father",        "his teenage son",      "We need to talk about what happened at school today."),
    ("two old friends",       "reuniting after years","I can't believe it's been so long. You look exactly the same."),
    ("a nervous job applicant","a calm interviewer",   "Thanks for coming in. Tell me a little about yourself."),
    ("a grieving daughter",   "her quiet mother",     "I miss him so much. I don't know how to do this."),
    ("a frustrated customer", "a patient employee",   "This is the third time I've had this problem. I'm done."),
    ("a new neighbor",        "a friendly local",     "Hi, I just moved in next door. I'm still finding my way around."),
    ("a first date",          "his date",             "So, what made you want to try this restaurant?"),
    ("a doctor",              "a scared patient",     "The results came back. I want to talk you through everything."),
    ("a mentor",              "a struggling student", "I can see you're working hard. What's actually going on?"),
    ("two coworkers",         "after a long day",     "I don't know how much longer I can keep doing this."),
    ("a child",               "her grandmother",      "Grandma, why do people have to die?"),
    ("an apology",            "a hurt friend",        "I know I messed up. I'm not sure what to say except I'm sorry."),
    ("a couple arguing",      "about something small","It's not about the dishes. You know that, right?"),
    ("a soldier returning",   "to his hometown",      "Everything looks smaller than I remembered."),
    ("a person alone",        "talking to themselves","Why do I always do this? Every single time."),
    ("a mother",              "her adult child",      "I just want to know you're okay. That's all."),
    ("two strangers",         "sharing an umbrella",  "Didn't expect rain today, did you?"),
    ("a young man",           "his dying grandfather","Tell me something I don't know about you."),
    ("a person at 3am",       "unable to sleep",      "Some nights the quiet gets too loud."),
    ("a coach",               "a beaten athlete",     "You gave everything. That's not nothing."),
]

def kai_turn(text, context="experience"):
    payload = json.dumps({"from": context, "text": text}).encode('utf-8')
    req = urllib.request.Request(
        f"{BASE}/api/oracle-turn",
        data=payload,
        headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read().decode('utf-8', errors='replace'))
            reply = body.get("kai_reply") or body.get("reply") or body.get("response") or body.get("text") or ""
            # Guard: if reply is empty or looks like a raw JSON dump, treat as failure
            if not reply or reply.startswith("{'from'") or reply.startswith('{"from"') or len(reply.strip()) < 8:
                return None
            return reply
    except Exception as e:
        return None

def store_experience(text, region="experience", source="lived_experience", strength=1.2):
    """Store text directly into the lattice via /api/rshl/store"""
    payload = json.dumps({
        "text": text,
        "region": region,
        "source": source,
        "strength": strength
    }).encode('utf-8')
    req = urllib.request.Request(
        f"{BASE}/api/rshl/store",
        data=payload,
        headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status == 200
    except:
        return False

def log_corpus(input_text, reply_text):
    """Log the conversation pair to the training corpus"""
    payload = json.dumps({
        "input": input_text,
        "reply": reply_text,
        "user_id": "experiential_training",
        "channel_id": "simulation"
    }).encode('utf-8')
    req = urllib.request.Request(
        f"{BASE}/api/corpus-log",
        data=payload,
        headers={"Content-Type": "application/json"}
    )
    try:
        urllib.request.urlopen(req, timeout=10)
    except:
        pass

def save_lattice():
    try:
        req = urllib.request.Request(f"{BASE}/api/lattice/compact-save", method="POST")
        urllib.request.urlopen(req, timeout=60)
        return True
    except:
        return False

def run_conversation(count):
    seed = random.choice(CONVERSATION_SEEDS)
    persona_a, persona_b, opener = seed

    print(f"\n[{count}] {persona_a} <-> {persona_b}", flush=True)
    print(f"[{count}] Opening: \"{opener}\"", flush=True)

    # Store the scenario as a memory in the lattice
    store_experience(f"Human moment: {persona_a} says to {persona_b}: \"{opener}\"")

    # Turn 1: KAI responds as persona_b
    prompt1 = (
        f"You are witnessing a real human conversation. "
        f"{persona_a.capitalize()} says to {persona_b}: \"{opener}\" "
        f"Respond naturally as {persona_b} would — be authentic, emotional, human. "
        f"Do not explain. Just speak."
    )
    response1 = kai_turn(prompt1)
    if not response1:
        print(f"[{count}] Oracle timeout — skipping", flush=True)
        return False

    r1_short = response1[:120]
    print(f"[{count}] {persona_b}: {r1_short}...", flush=True)
    store_experience(f"{persona_b} says: {response1}", region="experience", source="conversation")
    log_corpus(prompt1, response1)

    # Turn 2: KAI responds as persona_a
    prompt2 = (
        f"Continuing the conversation. {persona_b} just said: \"{response1[:200]}\" "
        f"Now respond as {persona_a} — keep it real, keep it human. "
        f"Show how this moment lands emotionally."
    )
    response2 = kai_turn(prompt2)
    if not response2:
        print(f"[{count}] Oracle timeout on turn 2 — partial save", flush=True)
        return False

    r2_short = response2[:120]
    print(f"[{count}] {persona_a}: {r2_short}...", flush=True)
    store_experience(f"{persona_a} says: {response2}", region="experience", source="conversation")
    log_corpus(prompt2, response2)

    # Turn 3: KAI reflects
    reflection_prompt = (
        f"You just witnessed this between {persona_a} and {persona_b}: "
        f"\"{opener}\" ... \"{response1[:150]}\" ... \"{response2[:150]}\" "
        f"What does this teach you about how humans connect, hurt, and heal? "
        f"Speak from your own understanding."
    )
    reflection = kai_turn(reflection_prompt)
    if reflection:
        print(f"[{count}] KAI reflects: {reflection[:150]}...", flush=True)
        store_experience(
            f"[KAI on {persona_a}/{persona_b}]: {reflection}",
            region="experience",
            source="self_reflection",
            strength=1.5  # Higher weight for reflections
        )
        log_corpus(reflection_prompt, reflection)

    return True

# ---------------------------------------------------------------------------
print("\n" + "="*60, flush=True)
print("  EXPERIENTIAL TRAINING — KAI Self-Simulated Conversations", flush=True)
print("  Storing via: /api/rshl/store + /api/corpus-log", flush=True)
print("  Duration: 3 hours", flush=True)
print("="*60, flush=True)

# Wait for KAI server
print("Checking KAI server...", flush=True)
for attempt in range(30):
    try:
        data = json.dumps({"from": "warmup", "text": "hello"}).encode()
        req = urllib.request.Request(f"{BASE}/api/oracle-turn", data=data, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode())
            print(f"KAI is online! Reply: {str(body)[:80]}", flush=True)
            break
    except Exception as e:
        print(f"  [{attempt+1}/30] Waiting 10s... ({e})", flush=True)
        time.sleep(10)

END_TIME = time.time() + (3.0 * 3600)
count = 0
successes = 0
failures = 0

def adaptive_sleep():
    try:
        path = 'c:/KAI/tools/oracle-discord/state/self_optimize_state.json'
        if os.path.exists(path):
            with open(path, 'r') as f:
                state = json.load(f)
                tier = state.get('tier', 'NORMAL')
                if tier == 'PROTECT':
                    time.sleep(15)
                elif tier == 'REDUCED':
                    time.sleep(6)
                else:
                    pass
    except:
        pass

while time.time() < END_TIME:
    adaptive_sleep()
    ok = run_conversation(count)
    if ok:
        successes += 1
    else:
        failures += 1
        time.sleep(15)

    count += 1
    time.sleep(random.uniform(2, 5))

    if count > 0 and count % 20 == 0:
        remaining_mins = int((END_TIME - time.time()) / 60)
        print(f"\n[{count}] CHECKPOINT | OK={successes} FAIL={failures} | ~{remaining_mins}min left", flush=True)
        if save_lattice():
            print(f"[{count}] Lattice saved.", flush=True)
        else:
            print(f"[{count}] Save failed.", flush=True)

print("\n" + "="*60, flush=True)
print(f"  TRAINING COMPLETE", flush=True)
print(f"  Conversations: {count} | OK: {successes} | Failed: {failures}", flush=True)
print("="*60, flush=True)
save_lattice()
print("Final save done.", flush=True)
