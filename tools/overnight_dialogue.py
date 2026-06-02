import urllib.request, json, time, random

BASE = "http://127.0.0.1:3334"

print("--- Starting Parallel Dialogue Ingestion ---")
print("Script will terminate automatically before 11:00 AM.")

# ~50 conversational inputs
DIALOGUE_SEEDS = [
    "what's your favorite thing to do", "i feel really tired today",
    "do you think things will get better", "what are you thinking about right now",
    "tell me a secret", "i can't stop worrying about tomorrow",
    "this weather is making me sleepy", "i don't know what to do next",
    "what does music feel like to you", "do you ever get lonely",
    "i'm so frustrated with work", "what makes you happy",
    "tell me something interesting", "i need some advice",
    "i feel like i'm falling behind", "i'm proud of what i did today",
    "what do you dream about", "how do you handle anger",
    "do you believe in luck", "i just want to relax today",
    "can we talk about something else", "i made a mistake today",
    "i miss how things used to be", "what is your biggest fear",
    "how do you show you care", "what is trust to you",
    "i feel like nobody listens", "tell me a story",
    "what's the best way to spend a saturday", "do you like the rain",
    "i'm excited for tomorrow", "what makes a good friend",
    "how do you deal with stress", "i feel overwhelmed",
    "what is your favorite memory", "i wish i had more time",
    "do you think i'm doing okay", "what is the meaning of all this",
    "i'm bored", "tell me a joke", "i feel so productive today",
    "what do you think of humans", "i want to learn something new",
    "how do you stay positive", "i feel stuck", "what is your purpose"
]

END_TIME = time.time() + (5.5 * 3600)
count = 0
while time.time() < END_TIME: # Run until limit
    random.shuffle(DIALOGUE_SEEDS)
    for seed in DIALOGUE_SEEDS:
        try:
            req = urllib.request.Request(
                f"{BASE}/api/oracle-turn",
                data=json.dumps({"from": "conversation", "text": seed}).encode(),
                headers={"Content-Type": "application/json"}
            )
            urllib.request.urlopen(req, timeout=10)
            count += 1
            if count % 100 == 0:
                print(f"[{count}] Dialogue turns generated...")
        except:
            pass

print("--- Parallel Dialogue Ingestion Complete (Time Limit Reached) ---")
