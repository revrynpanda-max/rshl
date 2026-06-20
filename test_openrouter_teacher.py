#!/usr/bin/env python3
"""
OpenRouter capability tester for KAI — "what can I actually do with my key?"

Reads OPENROUTER_API_KEY from .env, then:
  1) shows your key's real limits / tier,
  2) summarizes the live catalog (counts, free vs paid, modalities),
  3) pings EVERY free model with a real JSON-mode grade (what KAI's grader does),
  4) checks the legacy model names you listed (found / gone),
  5) checks a few premium models (so you see "needs credits"),
  6) prints a clean "USABLE NOW" shortlist.

Run:  python C:\\KAI\\test_openrouter_teacher.py
Then paste the whole output back to Claude.
"""
import json, time, os, urllib.request, urllib.error

ENV = r"C:\KAI\tools\oracle-discord\.env"
KEY = os.environ.get("OPENROUTER_API_KEY", "")
if not KEY and os.path.exists(ENV):
    for line in open(ENV, encoding="utf-8"):
        if line.strip().startswith("OPENROUTER_API_KEY="):
            KEY = line.split("=", 1)[1].strip().strip('"').strip("'"); break
if not KEY:
    raise SystemExit("No OPENROUTER_API_KEY found in env or .env")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
H = {"Authorization": f"Bearer {KEY}", "User-Agent": UA,
     "Accept": "application/json", "Content-Type": "application/json"}
PACE = 3.2  # seconds between calls (free tier = 20/min account-wide)

def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=H), timeout=30) as r:
        return json.loads(r.read().decode())

def is_free(m):
    p = m.get("pricing", {}) or {}
    return str(p.get("prompt")) == "0" and str(p.get("completion")) == "0"
def supports_json(m):
    return "response_format" in (m.get("supported_parameters") or [])

# 1) KEY LIMITS ---------------------------------------------------------------
print("=" * 66)
print("1) YOUR KEY")
try:
    k = get("https://openrouter.ai/api/v1/key").get("data", {})
    print(f"   tier         : {'FREE-tier account' if k.get('is_free_tier') else 'pay-as-you-go (not free-tier flag)'}")
    print(f"   credits spent: {k.get('usage')}   balance limit: {k.get('limit')}   remaining: {k.get('limit_remaining')}")
    print("   -> balance None/0 + paid models 402 = you have $0 loaded; free models still work.")
except Exception as e:
    print("   could not fetch key info:", e)

# 2) CATALOG ------------------------------------------------------------------
print("=" * 66)
print("2) CATALOG")
cat = {m["id"]: m for m in get("https://openrouter.ai/api/v1/models").get("data", [])}
free_ids = [mid for mid, m in cat.items() if is_free(m)]
free_json_ids = sorted(mid for mid in free_ids if supports_json(cat[mid]))
from collections import Counter
modin = Counter(); modout = Counter()
for m in cat.values():
    a = m.get("architecture", {}) or {}
    for x in (a.get("input_modalities") or []): modin[x] += 1
    for x in (a.get("output_modalities") or []): modout[x] += 1
print(f"   total models: {len(cat)} | free: {len(free_ids)} | free+JSON: {len(free_json_ids)}")
print(f"   inputs accepted : {dict(modin)}")
print(f"   outputs produced: {dict(modout)}   (mostly text-out; little image/audio gen)")

def ping(mid):
    body = {"model": mid, "max_tokens": 50,
            "response_format": {"type": "json_object"},
            "messages": [{"role": "system", "content": "Output raw JSON only."},
                         {"role": "user", "content": 'Grade: 2+2=4. Reply {"score":<0-100>}.'}]}
    req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions",
                                 data=json.dumps(body).encode(), headers=H, method="POST")
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=70) as r:
            out = json.loads(r.read().decode())
        ms = int((time.time() - t) * 1000)
        txt = (out.get("choices", [{}])[0].get("message", {}) or {}).get("content", "")
        try: json.loads(txt); j = "Y"
        except Exception: j = "N"
        return ms, j, None
    except urllib.error.HTTPError as e:
        try: d = json.loads(e.read().decode()).get("error", {}).get("message", "")[:45]
        except Exception: d = ""
        return None, None, f"HTTP {e.code} {d}"
    except Exception as e:
        return None, None, f"ERR {str(e)[:45]}"

usable = []  # free + works + json=Y
# 3) TEST EVERY FREE MODEL ----------------------------------------------------
print("=" * 66)
print(f"3) FREE MODELS — pinging all {len(free_ids)} (this is what you can run at $0):")
print("-" * 66)
for mid in sorted(free_ids):
    ms, j, err = ping(mid)
    if err: print(f"   {mid:50s} {err}")
    else:
        print(f"   {mid:50s} OK {ms:>6}ms json={j}")
        if j == "Y": usable.append((mid, ms))
    time.sleep(PACE)

# 4) LEGACY NAMES YOU LISTED --------------------------------------------------
legacy = {
    "WizardLM-2 8x22B": "microsoft/wizardlm-2-8x22b", "GPT-4 Turbo": "openai/gpt-4-turbo",
    "Claude 3 Haiku": "anthropic/claude-3-haiku", "Mistral Large": "mistralai/mistral-large",
    "GPT-3.5 Turbo 0613": "openai/gpt-3.5-turbo-0613", "GPT-4 Turbo Preview": "openai/gpt-4-turbo-preview",
    "GPT-3.5 Turbo Instruct": "openai/gpt-3.5-turbo-instruct", "GPT-3.5 Turbo 16k": "openai/gpt-3.5-turbo-16k",
    "Weaver (alpha)": "mancer/weaver", "ReMM SLERP 13B": "undi95/remm-slerp-l2-13b",
    "MythoMax 13B": "gryphe/mythomax-l2-13b", "GPT-3.5 Turbo": "openai/gpt-3.5-turbo", "GPT-4": "openai/gpt-4",
}
print("=" * 66)
print("4) LEGACY NAMES YOU LISTED — still on OpenRouter?")
print("-" * 66)
for name, mid in legacy.items():
    in_cat = mid in cat
    tag = ("FREE" if (in_cat and is_free(cat[mid])) else "PAID") if in_cat else "NOT IN CATALOG (removed)"
    print(f"   {name:24s} {mid:34s} {tag}")

# 5) PREMIUM SPOT-CHECK -------------------------------------------------------
print("=" * 66)
print("5) PREMIUM SPOT-CHECK (expect 402 until you load credits):")
print("-" * 66)
for mid in ["anthropic/claude-opus-4.8", "openai/gpt-5.5-pro", "deepseek/deepseek-v4-pro", "z-ai/glm-5.2"]:
    if mid in cat:
        ms, j, err = ping(mid)
        print(f"   {mid:50s} {err or f'OK {ms}ms json={j}'}")
        time.sleep(PACE)
    else:
        print(f"   {mid:50s} not in catalog")

# SUMMARY ---------------------------------------------------------------------
print("=" * 66)
print("USABLE NOW (free, answered, JSON-capable) — best for KAI's grader:")
for mid, ms in sorted(usable, key=lambda x: x[1]):
    print(f"   {mid:50s} {ms:>6}ms")
print("=" * 66)
print("Done. Paste this whole output back to Claude.")
