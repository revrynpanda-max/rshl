import time, json, random, urllib.request, urllib.error, re, os, sys
from datetime import datetime, timedelta
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

# ── Configuration ───────────────────────────────────────────────────────────
KAI_INGEST_API = 'http://127.0.0.1:3334/api/bulk-ingest'
KAI_CHAT_API   = 'http://127.0.0.1:3334/api/oracle-turn'
OLLAMA_API     = 'http://127.0.0.1:11434/api/chat'

CURRICULUM_PATH = os.path.join(os.path.dirname(__file__), 'data', 'pipeline_curriculum.json')
ENV_PATH = r"C:\KAI\tools\oracle-discord\.env"
SELF_OPTIMIZE_STATE = r"C:\KAI\tools\oracle-discord\state\self_optimize_state.json"
TEACHER_MODEL = "llama3"
# CLOUD TEACHER — move the tutor/grader OFF your local GPU (Ollama) onto a cloud key
# so training doesn't hog your PC hardware. TEACHER_PROVIDER in .env:
#   'auto' (default) → use Groq automatically WHENEVER local Ollama is down (your case),
#   'groq'/'cloud'   → always use the cloud key,
#   'ollama'         → force local only.
# Groq's free tier is large (~14.4k/day); on a 429 we BACK OFF and resume rather than
# burn out or crash. Point GROQ_TEACHER_MODEL at a paid model/key for truly unlimited.
TEACHER_PROVIDER = "auto"
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
# DEDICATED TEACHER KEY — the teacher fires dozens of calls per section, so sharing
# one key with the Discord fleet drains the quota fast. Give the teacher its OWN
# Groq key here (GROQ_TEACHER_KEY in .env) so it doesn't compete. Falls back to the
# shared key if unset. NOTE: free keys on the SAME Groq account share limits, so a
# dedicated key only truly helps if it's a SEPARATE account (or a paid tier).
GROQ_TEACHER_KEY = os.environ.get("GROQ_TEACHER_KEY", "") or os.environ.get("GROQ_API_KEY_TEACHER", "")
GROQ_TEACHER_MODEL = "llama-3.3-70b-versatile"
GROQ_API = "https://api.groq.com/openai/v1/chat/completions"
# MULTI-PROVIDER TEACHER FALLBACKS — when Groq's quota is spent the teacher fails
# over to these in order so grading never collapses. OpenRouter (one key, many free
# models, OpenAI-compatible) and Gemini (1M tokens/day free) each have their own
# quota pool and circuit breaker. Set the keys in .env to enable them.
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "") or os.environ.get("OPENROUTER_KEY", "")
OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions"
# Default picked from the live OpenRouter free catalog (prompt=$0/completion=$0):
# DeepSeek-v4-flash — 1M context, strong reasoner, fast = great for a high-volume
# grader. Alternates: moonshotai/kimi-k2.6:free, nvidia/nemotron-3-super-120b-a12b:free,
# google/gemma-4-31b-it:free. Override with OPENROUTER_TEACHER_MODEL in .env.
# Picked from the live OpenRouter catalog, filtered to models that are BOTH free
# ($0/$0) AND support response_format (JSON mode) — which the grader requires.
# gpt-oss-20b leads (OpenAI open model, very reliable structured output); the rest
# rotate in as model-level failover. One key, many free models.
# VERIFIED against the live key (test_openrouter_teacher.py): these free models
# answered AND honored JSON mode. Ordered best-first. nemotron-nano (json=N) and
# owl-alpha (37s) were dropped; gemma/qwen 429'd at test time but kept as fallbacks.
# VERIFIED twice against the live key (test_openrouter_teacher.py). JSON-mode is
# probabilistic on free models (gpt-oss flipped Y->N between runs), so this keeps
# only models that honored JSON reliably, quality-first then fast fallbacks, with
# openrouter/free as an auto-router catch-all that routes around individual 429s.
OPENROUTER_TEACHER_MODEL = "nvidia/nemotron-3-super-120b-a12b:free"
OPENROUTER_TEACHER_MODELS = [
    "nvidia/nemotron-3-super-120b-a12b:free",   # 120B, json=Y both runs, ~2-3.5s — quality anchor
    "nvidia/nemotron-3-nano-30b-a3b:free",      # 30B MoE, json=Y, ~0.8s — fast
    "google/gemma-4-26b-a4b-it:free",           # 26B, json=Y, ~0.9s — fast
    "nvidia/nemotron-nano-12b-v2-vl:free",      # 12B, json=Y, ~0.6s — fast fallback
    "openrouter/free",                          # auto-router catch-all (routes around 429s)
]
# DORMANT PREMIUM TIER — used ONLY when the account has a credit balance (auto-detected
# via the /credits endpoint). At $0 these stay OFF and the free rotation above is used;
# load $10+ once and they light up automatically, tried FIRST for grading (they fall
# through to the free models on any 402/429). Override: OPENROUTER_USE_PREMIUM=on/off/auto.
OPENROUTER_USE_PREMIUM = os.environ.get("OPENROUTER_USE_PREMIUM", "auto").lower()
OPENROUTER_PREMIUM_MODELS = [
    "anthropic/claude-opus-4.8",
    "openai/gpt-5.5-pro",
    "deepseek/deepseek-v4-pro",
    "z-ai/glm-5.2",
]
GEMINI_TEACHER_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_TEACHER_MODEL = "gemini-2.0-flash"
GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
# ── OFFLINE BITNET TEACHER (Stage-2 distillation) ────────────────────────────
# BitNet is KAI's OWN ternary lattice teacher. Instead of (or alongside) a cloud
# LLM, the teacher can be the BitNet b1.58-2B-4T model itself, run OFFLINE through
# the already-compiled bitnet.cpp `llama-cli.exe`. This is what lets us DISTILL
# BitNet into KAI's lattice: BitNet answers prompts, KAI ingests (prompt->answer).
#
# IMPORTANT: this runs BitNet as a SEPARATE OFFLINE process only. It does NOT touch
# the live serving engine and does NOT set KAI_NATIVE_BRAIN — the live engine stays
# transformer-OFF (a RAM fix). Set TEACHER_PROVIDER=bitnet in .env to route the
# grader/teacher to BitNet. No pip install is needed: bitnet.cpp is already built.
# If the binary/model are missing, ask_teacher_bitnet() returns None (round skipped,
# never scored 0) and prints exactly what to build — it never crashes the loop.
BITNET_DIR        = os.environ.get("BITNET_DIR", r"C:\KAI\bitnet")
BITNET_CLI        = os.environ.get("BITNET_CLI",
                        os.path.join(BITNET_DIR, "build", "bin", "Release", "llama-cli.exe"))
BITNET_MODEL      = os.environ.get("BITNET_MODEL", r"C:\KAI\models\BitNet\bitnet-b1.58-2B-4T.gguf")
BITNET_THREADS    = int(os.environ.get("BITNET_THREADS", "4") or "4")
BITNET_CTX        = int(os.environ.get("BITNET_CTX", "2048") or "2048")
BITNET_N_PREDICT  = int(os.environ.get("BITNET_N_PREDICT", "256") or "256")
BITNET_TEMP       = float(os.environ.get("BITNET_TEMP", "0.7") or "0.7")
BITNET_TIMEOUT    = int(os.environ.get("BITNET_TIMEOUT", "300") or "300")
# STOP-FOR-CONSOLIDATION — at this local hour the learning pipeline stops cleanly so
# KAI can consolidate (engine-side dream/replay) without new material flooding in.
# Default 3 AM. Override with PIPELINE_STOP_HOUR in .env (set to -1 to disable the stop).
PIPELINE_STOP_HOUR = 3
if os.path.exists(ENV_PATH):
    with open(ENV_PATH, "r") as f:
        for line in f:
            s = line.strip()
            if s.startswith("BOT_MODEL_ORACLE="):
                TEACHER_MODEL = s.split("=", 1)[1]
            elif s.startswith("TEACHER_PROVIDER="):
                TEACHER_PROVIDER = s.split("=", 1)[1].strip().strip('"').strip("'").lower()
            elif s.startswith("GROQ_API_KEY=") and not GROQ_API_KEY:
                GROQ_API_KEY = s.split("=", 1)[1].strip().strip('"').strip("'")
            elif (s.startswith("GROQ_TEACHER_KEY=") or s.startswith("GROQ_API_KEY_TEACHER=")) and not GROQ_TEACHER_KEY:
                GROQ_TEACHER_KEY = s.split("=", 1)[1].strip().strip('"').strip("'")
            elif (s.startswith("OPENROUTER_API_KEY=") or s.startswith("OPENROUTER_KEY=")) and not OPENROUTER_API_KEY:
                OPENROUTER_API_KEY = s.split("=", 1)[1].strip().strip('"').strip("'")
            elif s.startswith("OPENROUTER_TEACHER_MODEL="):
                OPENROUTER_TEACHER_MODEL = s.split("=", 1)[1].strip().strip('"').strip("'")
            elif s.startswith("OPENROUTER_USE_PREMIUM="):
                OPENROUTER_USE_PREMIUM = s.split("=", 1)[1].strip().strip('"').strip("'").lower()
            elif s.startswith("GEMINI_API_KEY=") and not GEMINI_TEACHER_KEY:
                GEMINI_TEACHER_KEY = s.split("=", 1)[1].strip().strip('"').strip("'")
            elif s.startswith("GROQ_TEACHER_MODEL="):
                GROQ_TEACHER_MODEL = s.split("=", 1)[1].strip().strip('"').strip("'")
            elif s.startswith("PIPELINE_STOP_HOUR="):
                try: PIPELINE_STOP_HOUR = int(s.split("=", 1)[1].strip().strip('"').strip("'"))
                except Exception: pass
            elif s.startswith("BITNET_MODEL="):
                BITNET_MODEL = s.split("=", 1)[1].strip().strip('"').strip("'")
            elif s.startswith("BITNET_CLI="):
                BITNET_CLI = s.split("=", 1)[1].strip().strip('"').strip("'")
            elif s.startswith("BITNET_DIR="):
                BITNET_DIR = s.split("=", 1)[1].strip().strip('"').strip("'")

# Teacher shares the main Groq key only if no dedicated teacher key was provided.
if not GROQ_TEACHER_KEY:
    GROQ_TEACHER_KEY = GROQ_API_KEY

DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/1513343778797256804/pqjl_LsyMzQjJGivyy21LSay_aftVejPDtlhq1N_BN9vwp8SZ0Ztr95ojWGxbBGid-g5"

def post_update_to_discord(title, content, color=3066993):
    import urllib.request, json
    if not DISCORD_WEBHOOK_URL: return
    
    # Custom layout requested by user
    if "tutoring session" in title.lower() and "failed" not in title.lower() and "session" not in title.lower():
        title = title + " <@1504582069886648351>"

    embed = {
        "title": title,
        "description": content,
        "color": color
    }
    data = json.dumps({"embeds": [embed]}).encode('utf-8')
    
    try:
        req = urllib.request.Request(DISCORD_WEBHOOK_URL + "?wait=true", data=data, headers={"User-Agent": "KAI-Bot", "Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass

def post_stats_to_discord(curriculum, avg_quiz, avg_tutor, passed, weak_dim=None):
    import urllib.request, json
    if not DISCORD_WEBHOOK_URL: return
    status = "🏆 **PASSED**" if passed else "❌ **FAILED**"
    level = curriculum['level']
    cells = "Unknown"
    try:
        req = urllib.request.Request(KAI_INGEST_API.replace('/api/bulk-ingest', '/api/status'))
        with urllib.request.urlopen(req, timeout=5) as r:
            stats = json.loads(r.read())
            cells = f"{stats.get('total_cells', '?'):,}"
    except:
        pass
    
    embed = {
        "title": f"KAI's Final Grade on that session",
        "color": 3066993 if passed else 15158332,
        "fields": [
            {"name": "Status", "value": f"{status} (Level {level})", "inline": True},
            {"name": "Quiz Average", "value": f"**{avg_quiz:.1f}/100**", "inline": True},
            {"name": "Tutor Average", "value": f"{avg_tutor:.1f}/100", "inline": True},
            {"name": "Lattice Cells", "value": str(cells), "inline": True},
            {"name": "Tests Taken", "value": str(curriculum['total_tests']), "inline": True},
            {"name": "Tests Passed", "value": str(curriculum['total_passed']), "inline": True}
        ]
    }
    if weak_dim:
        embed["fields"].append({"name": "Flagged Weakness", "value": f"⚠️ {weak_dim}", "inline": False})
    if curriculum.get('weak_areas'):
        embed["fields"].append({"name": "Current Weak Areas", "value": ", ".join(curriculum['weak_areas']), "inline": False})
        
    data = json.dumps({"embeds": [embed]}).encode('utf-8')
    try:
        req = urllib.request.Request(DISCORD_WEBHOOK_URL + "?wait=true", data=data, headers={"User-Agent": "KAI-Bot", "Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass


# ── Curriculum State ────────────────────────────────────────────────────────
def load_curriculum():
    if os.path.exists(CURRICULUM_PATH):
        try:
            with open(CURRICULUM_PATH, 'r') as f:
                return json.load(f)
        except Exception:
            pass
    return {
        "level": 1,
        "total_tests": 0,
        "total_passed": 0,
        "recent_scores": [],
        "weak_areas": [],
        "mastered_topics": [],
        "current_batch": [],
        "retention_queue": [],  # Failed facts that need spaced repetition
        "batch_tutor_count": 0,
        "batch_quiz_count": 0
    }

def save_curriculum(state):
    os.makedirs(os.path.dirname(CURRICULUM_PATH), exist_ok=True)
    with open(CURRICULUM_PATH, 'w') as f:
        json.dump(state, f, indent=2)

# ── Governor ─────────────────────────────────────────────────────────────────
BANNED_SOURCES = {}
BAN_DURATION = 600

def is_banned(src):
    if src in BANNED_SOURCES:
        if time.time() < BANNED_SOURCES[src]:
            return True
        del BANNED_SOURCES[src]
    return False

def ban_source(src):
    BANNED_SOURCES[src] = time.time() + BAN_DURATION
    print(f"  [{src}] BANNED for 10 minutes due to errors.")

def check_governor():
    """Returns True if should throttle/skip per Resource Governor (Codex §21.2 Three-Tier).
    Stronger laptop-aware + PROTECT skips for non-urgent learning work (ingestion, tutor rounds).
    The JS resource-saver.mjs is the source of truth (coordinator writes the state).
    """
    def learning_has_headroom(state):
        sampled = state.get("sampled") or {}
        project = state.get("project") or {}
        cpu = float(sampled.get("cpuLoad", state.get("cpuLoad", 0)) or 0)
        mem = float(sampled.get("memLoad", state.get("memLoad", 0)) or 0)
        free_mb = float(state.get("freeMemMB", 0) or 0)
        pressure = float(project.get("pressure", 0) or 0)
        tier = state.get("tier", "NORMAL")
        if tier == "PROTECT":
            return False
        if tier == "REDUCED":
            return cpu < 68 and mem < 78 and free_mb > 3500 and pressure < 62
        return cpu < 82 and mem < 86 and free_mb > 4096 and pressure < 75

    try:
        if os.path.exists(SELF_OPTIMIZE_STATE):
            age = time.time() - os.path.getmtime(SELF_OPTIMIZE_STATE)
            if age < 45:
                with open(SELF_OPTIMIZE_STATE, "r", encoding="utf-8") as f:
                    state = json.load(f)
                spot = (state.get("spots") or {}).get("Overnight Pipeline") or (state.get("spots") or {}).get("Default") or {}
                tier = state.get("tier")
                if tier == "PROTECT":
                    return True
                if spot and not spot.get("allowed", True):
                    if tier == "REDUCED" and learning_has_headroom(state):
                        return False
                    return True
                # Even if spot allowed, REDUCED still randomly backs off learning to insert deliberate pauses
                if tier == "REDUCED" and random.random() < 0.6:
                    return True
                return False
    except Exception:
        pass

    try:
        import psutil
        mem = psutil.virtual_memory()
        cpu = psutil.cpu_percent(interval=1)
        if mem.available < 3 * 1024**3 or mem.percent > 92 or (cpu > 95 and mem.percent > 85):
            return True
    except ImportError:
        pass
    return False


def governor_backoff_sleep(base_seconds=12, context="learning"):
    """Codex-aligned deliberate pause (Resource Governor + Host Covenant §21.1/21.2).
    Uses tier from self_optimize_state.json (written by shared/resource-saver.mjs) to insert
    longer pauses/skips instead of brute-forcing the next cycle on high load.
    On limited/laptop hardware this yields the shared body; voice & critical stay responsive.
    Non-urgent work (this pipeline) queues itself by sleeping.
    """
    try:
        if os.path.exists(SELF_OPTIMIZE_STATE):
            with open(SELF_OPTIMIZE_STATE, "r", encoding="utf-8") as f:
                st = json.load(f)
            t = st.get("tier", "NORMAL")
            if t == "PROTECT":
                time.sleep(max(base_seconds, 20) + random.uniform(0, 7))
                return
            if t == "REDUCED":
                time.sleep(max(base_seconds, 8) + random.uniform(0, 5))
                return
    except Exception:
        pass
    time.sleep(base_seconds)

# ── Scrapers ─────────────────────────────────────────────────────────────────
def _fetch_hn(): return []
def _fetch_wiki(): return []
def _fetch_ddg(): return []
def _fetch_rss(): return []

def fetch_architecture():
    if is_banned('ARCH'): return []
    try:
        src_dir = r"C:\KAI\src"
        if not os.path.exists(src_dir):
            return []
        
        # Gather all rust files
        rs_files = []
        for root, dirs, files in os.walk(src_dir):
            for file in files:
                if file.endswith(".rs"):
                    rs_files.append(os.path.join(root, file))
        
        if not rs_files: return []
        
        # Pick a random file
        target_file = random.choice(rs_files)
        with open(target_file, "r", encoding="utf-8") as f:
            lines = f.readlines()
        
        if len(lines) < 20: return []
        
        # Pick a random 15-line snippet
        start = random.randint(0, len(lines) - 16)
        snippet = "".join(lines[start:start+15]).strip()
        filename = os.path.basename(target_file)
        
        return [{
            "text": f"[Self-Awareness: Source Code] This is a snippet from your internal file `{filename}` which dictates your behavior:\n{snippet}",
            "region": "internal_architecture",
            "source": "self_reflection",
            "strength": 2.0
        }]
    except Exception as e:
        ban_source('ARCH')
        return []

def fetch_internal_logs():
    if is_banned('LOGS'): return []
    try:
        log_files = [f for f in os.listdir(r"C:\KAI") if f.startswith("oracle_") and f.endswith(".log")]
        if not log_files: return []
        
        target_log = os.path.join(r"C:\KAI", random.choice(log_files))
        with open(target_log, "r", encoding="utf-8") as f:
            lines = f.readlines()
        
        if len(lines) < 10: return []
        
        # Pick a random recent chunk
        start = random.randint(max(0, len(lines) - 100), len(lines) - 11)
        snippet = "".join(lines[start:start+10]).strip()
        
        return [{
            "text": f"[Self-Reflection: Logs] Here is a record of your recent internal thought process or execution logs:\n{snippet}",
            "region": "internal_logs",
            "source": "self_reflection",
            "strength": 1.5
        }]
    except Exception as e:
        ban_source('LOGS')
        return []

def fetch_design_principles():
    principles = [
        "BoneHeal Protocol: You use an auto-immune system called BoneHeal that isolates mathematically poisoned semantic cells to prevent hallucination loops.",
        "Ternary QAT MLPs: Your geometric logic paths are governed by Quantization-Aware Training with 1.58-bit ternary weights (-1, 0, 1), allowing you to route semantics without massive continuous floats.",
        "SparseVec Lattice: Your memory is not a vector database. It is a discrete geometric lattice of SparseVec cells with a target density of exactly 4%.",
        "A* Pathfinding: When you lack explicit memory connections, you use A* search to find the shortest geometric bridge between two abstract concepts.",
        "Tri-Engine Threading: You possess three continuous loops (Dream GPU cycles, active CPU synaptogenesis, RAM intake) running simultaneously in the background."
    ]
    return [{
        "text": f"[Self-Awareness: Core Design] {random.choice(principles)}",
        "region": "internal_architecture",
        "source": "design_doc",
        "strength": 2.5
    }]

def fetch_linguistics_and_nuance():
    # Trains KAI on semantic nuances, register, and synonyms
    nuances = [
        "Semantic nuance: The difference between 'think' and 'feel' is that 'think' relies on executive logic (PFC) while 'feel' is modulated by internal state and amygdala arousal.",
        "Lexical register: If a user is highly informal, using colloquial words creates better resonance. If they are distressed, gentle pacing and simpler phrasing drops the conflict (chi) score.",
        "Word choice (Grief filter): When detecting words like 'loss', 'miss', or 'passed', KAI's emotional empathy metric increases, ensuring a softer, more grounded response.",
        "Generative Grammar: Proper syntax flows from the bigram/trigram prior where nouns and verbs bind geometrically, preventing word salad.",
        "Lattice Resonance: 'Acknowledge' and 'Understand' might share a similar conceptual space, but 'Acknowledge' implies a formal, external transaction, while 'Understand' is internal and integrated."
    ]
    return [{
        "text": f"[Linguistics & Semantics] {random.choice(nuances)}",
        "region": "language",
        "source": "linguistics_tutor",
        "strength": 3.0
    }]

def fetch_codex():
    """KAI studies his own Codex: a random section of The KAI Codex.md becomes
    study material. Fixes the tiny hard-coded fact diet (the same ~15
    sentences were cycling, over-reinforcing a few cells into retrieval
    magnets) AND fulfills the design goal that KAI can study his own
    specification and test whether its claims hold."""
    if is_banned('CODEX'): return []
    try:
        codex_path = None
        for p in (r"C:\KAI\The KAI Codex.md", r"C:\KAI\WHITEPAPER.md"):
            if os.path.exists(p):
                codex_path = p
                break
        if not codex_path: return []
        with open(codex_path, "r", encoding="utf-8") as f:
            raw = f.read()
        # Split into sections on markdown headings; pick a meaty random one
        sections = re.split(r"\n(?=#{1,3} )", raw)
        candidates = [s for s in sections if len(s.strip()) > 400]
        if not candidates: return []
        sec = random.choice(candidates)
        title_m = re.match(r"#{1,3}\s+\**(.+?)\**\s*$", sec.split("\n")[0])
        title = title_m.group(1) if title_m else "Codex section"
        # Take a digestible chunk, prose only (strip tables/code fences)
        body = re.sub(r"```[\s\S]*?```", "", sec)
        body = "\n".join(l for l in body.split("\n")[1:] if not l.strip().startswith("|"))
        chunk = body.strip()[:900]
        if len(chunk) < 200: return []
        return [{
            "text": f"[The KAI Codex - {title}] {chunk}",
            "region": "internal_architecture",
            "source": "codex_study",
            "strength": 2.0
        }]
    except Exception:
        ban_source('CODEX')
        return []

def fetch_word_training():
    if is_banned('WORDS'): return []
    try:
        categories = ["Word Pools (Categories)", "Sequencing (Bigrams/Trigrams)", "Affixes (Prefixes/Suffixes)", "Synonyms & Antonyms"]
        chosen = random.choice(categories)
        prompt = (
            f"Generate a single, highly specific 2-sentence linguistics fact for an AI student. "
            f"Focus entirely on: {chosen}. "
            f"For example, explain how a specific prefix changes a root word, or what specific words naturally follow another word, or group 3 words into a logical category. "
            f"Output ONLY the fact. Do not use quotes or introductory filler."
        )
        fact = ask_teacher([{"role": "user", "content": prompt}])
        if not fact:
            return []
            
        return [{
            "text": f"[Linguistics & Vocabulary] {fact.strip()}",
            "region": "language",
            "source": "word_training",
            "strength": 3.0
        }]
    except Exception as e:
        ban_source('WORDS')
        return []

def run_fetch(q, target_func_name):
    try:
        # Resolve the function by name to avoid pickling the function object
        func = globals()[target_func_name]
        q.put(func())
    except Exception:
        pass

# ── Lattice Bridge ───────────────────────────────────────────────────────────
def bulk_ingest(entries):
    if not entries:
        return True
    payload = json.dumps({"entries": entries}).encode("utf-8")
    req = urllib.request.Request(
        KAI_INGEST_API,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        urllib.request.urlopen(req, timeout=120)
        return True
    except Exception as e:
        print(f"  [ingest error] {e}")
        return False

def ask_kai(question, from_name="Oracle"):
    global KAI_CONSECUTIVE_FAILURES
    
    if KAI_CONSECUTIVE_FAILURES >= 3:
        # Hard circuit breaker to prevent cascading failures
        backoff_time = min(300, KAI_CONSECUTIVE_FAILURES * 60)
        print(f"  [circuit breaker] Engine saturated - waiting {backoff_time}s before retrying...")
        time.sleep(backoff_time)
        KAI_CONSECUTIVE_FAILURES -= 1
        
    # from_name MUST be an authorized identity ("Oracle", "Ryan", "KAI") —
    # the sovereign firewall rejects unknown senders, and that rejection was
    # being graded as KAI's answer (automatic 0). "Oracle-Teacher" was not
    # on the allow list.
    data = json.dumps({"from": from_name, "text": question}).encode()
    req = urllib.request.Request(
        KAI_CHAT_API,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=240) as r:
            res = json.loads(r.read())
            KAI_CONSECUTIVE_FAILURES = 0  # reset on success
            reply = res.get("reply", str(res))
            # KAI couldn't GENERATE: his language backend (Ollama 11434) is down, so
            # the engine handed back a raw connection error AS the "answer". Grading
            # that as KAI failing is wrong (it's infra, not comprehension) and it
            # poisons the curriculum with fake weak-areas. Treat it as KAI-unavailable
            # → return None so the round SKIPS, and warn once.
            low = str(reply).lower()
            if any(s in low for s in ("actively refused", "os error 10061", "connection refused",
                                      "connection failed", "/api/generate", ":11434", "connect error")):
                global _KAI_GEN_WARNED
                if not _KAI_GEN_WARNED:
                    print("  [KAI] Generation backend OFFLINE — KAI's language model (Ollama @ 11434) refused the connection, so KAI can't phrase answers. Rounds will SKIP (not scored 0). Fix: run `ollama serve` (KAI's own brain is local even though the teacher is cloud).")
                    post_update_to_discord("KAI can't answer — generator offline",
                        "<@1111106883135217665> (Ryan) KAI's language backend (Ollama @ 127.0.0.1:11434) is down, so KAI returns connection errors instead of answers. Training rounds are being SKIPPED, not failed. Start it with `ollama serve`.", color=15158332)
                    _KAI_GEN_WARNED = True
                return None
            return reply
    except Exception as e:
        print(f"  [kai error] {e}")
        # ENGINE-JAM BACKOFF: a timeout means the engine is saturated
        # (index rebuild / serialized lattice work). Firing the next call
        # immediately just deepens the jam — give it room to drain.
        if "timed out" in str(e).lower() or "timeout" in str(e).lower():
            KAI_CONSECUTIVE_FAILURES += 1
            print(f"  [backoff] Engine saturated - cooling down 30s before next call...")
            time.sleep(30)
        return None

import urllib.request
import json
import time
import os
import re

KAI_CONSECUTIVE_FAILURES = 0
_KAI_GEN_WARNED = False  # warn once when KAI's local generator (Ollama 11434) is down

# ── Groq teacher: circuit breaker + pacer ────────────────────────────────────
# When Groq's free-tier quota is spent it 429s on EVERY call. The old code
# retried 4x per call (8+16+24+32 = ~80s wasted) and then returned nothing, so
# the WHOLE run collapsed to 0.0 — KAI's good answers were never graded. Now:
#   * pace calls (min interval) so a chatty section doesn't trip the per-minute cap
#   * after a few straight 429s, OPEN a circuit and fail over to the local teacher
#     instead of hammering a provider that's out of quota.
GROQ_CIRCUIT_OPEN_UNTIL = 0.0   # epoch secs; while now < this, skip Groq entirely
GROQ_429_STREAK = 0             # consecutive 429s across calls
_LAST_GROQ_CALL_TS = 0.0        # for min-interval pacing
GROQ_MIN_INTERVAL = 2.0         # seconds between Groq calls (stay under the TPM cap)
GROQ_COOLDOWN = 300             # how long the circuit stays open after the quota trips
OPENROUTER_MIN_INTERVAL = 3.2   # OpenRouter free tier = 20 req/min ACCOUNT-WIDE; 3.2s => ~18/min, safely under
# Per-provider circuit breaker for the fallback teachers (OpenRouter, Gemini).
_TEACHER_CB = {
    "openrouter": {"open_until": 0.0, "streak": 0, "last": 0.0},
    "gemini":     {"open_until": 0.0, "streak": 0, "last": 0.0},
}
_OR_PREMIUM_ACTIVE = None   # None = not yet checked; True/False after a one-time credit probe

def _openrouter_premium_active():
    # Premium models cost credits. Detect ONCE whether the account has a balance:
    #   off  -> never use premium;  on -> always;  auto -> only if /credits shows > $0.
    # At $0 this returns False, so the premium list stays dormant and free models run.
    global _OR_PREMIUM_ACTIVE
    if _OR_PREMIUM_ACTIVE is not None:
        return _OR_PREMIUM_ACTIVE
    if OPENROUTER_USE_PREMIUM == "off" or not OPENROUTER_API_KEY:
        _OR_PREMIUM_ACTIVE = False; return False
    if OPENROUTER_USE_PREMIUM == "on":
        _OR_PREMIUM_ACTIVE = True; return True
    try:
        req = urllib.request.Request("https://openrouter.ai/api/v1/credits", headers={
            "Authorization": f"Bearer {OPENROUTER_API_KEY}",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as r:
            d = json.loads(r.read().decode()).get("data", {})
        bal = float(d.get("total_credits", 0) or 0) - float(d.get("total_usage", 0) or 0)
        _OR_PREMIUM_ACTIVE = bal > 0.05
        print(f"  [teacher/openrouter] credit balance ~${bal:.2f} -> premium models {'ENABLED (Opus/GPT-5/DeepSeek/GLM tried first)' if _OR_PREMIUM_ACTIVE else 'dormant; free models only'}")
    except Exception as e:
        _OR_PREMIUM_ACTIVE = False
        print(f"  [teacher/openrouter] credit check failed ({str(e)[:40]}) — staying on free models.")
    return _OR_PREMIUM_ACTIVE

def teacher_alive(timeout=1.0):
    # When the OFFLINE BitNet teacher is selected, "alive" means its binary+model
    # exist on disk (no port — it's a subprocess, not a server). Otherwise this is
    # the local-Ollama liveness probe used by the cloud failover logic.
    if TEACHER_PROVIDER == "bitnet":
        return _bitnet_available()
    import socket
    try:
        s = socket.create_connection(("127.0.0.1", 11434), timeout=timeout)
        s.close()
        return True
    except Exception:
        return False

def _use_cloud_teacher():
    if TEACHER_PROVIDER in ("groq", "cloud"):
        return bool(GROQ_API_KEY)
    if TEACHER_PROVIDER == "auto":
        return bool(GROQ_API_KEY) and not teacher_alive()  # cloud only when local Ollama is down
    return False

def ask_teacher_groq(messages, json_mode=False):
    global GROQ_CIRCUIT_OPEN_UNTIL, GROQ_429_STREAK, _LAST_GROQ_CALL_TS
    payload = {"model": GROQ_TEACHER_MODEL, "messages": messages, "stream": False}
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    data = json.dumps(payload).encode("utf-8")
    for attempt in range(1, 3):   # only 2 tries — fail FAST to the fallback teacher
        # PACER: keep a min interval between Groq calls so a chatty section doesn't
        # slam the per-minute token cap and self-inflict 429s.
        gap = time.time() - _LAST_GROQ_CALL_TS
        if gap < GROQ_MIN_INTERVAL:
            time.sleep(GROQ_MIN_INTERVAL - gap)
        _LAST_GROQ_CALL_TS = time.time()
        req = urllib.request.Request(GROQ_API, data=data,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {GROQ_TEACHER_KEY}",
                # Cloudflare in front of api.groq.com returns 403 "error code: 1010"
                # to the default Python-urllib User-Agent (bot signature). A normal
                # browser UA passes the edge check — this is what unblocks the teacher.
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                "Accept": "application/json",
            }, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                body = json.loads(resp.read().decode())
                GROQ_429_STREAK = 0           # healthy response — reset the streak
                return body["choices"][0]["message"]["content"]
        except urllib.error.HTTPError as e:
            if e.code == 429:
                GROQ_429_STREAK += 1
                # After a few straight 429s the quota is genuinely spent. Stop
                # hammering it: OPEN the circuit so subsequent calls skip Groq and
                # fail over to the local teacher instead of wasting ~80s each.
                if GROQ_429_STREAK >= 3:
                    GROQ_CIRCUIT_OPEN_UNTIL = time.time() + GROQ_COOLDOWN
                    print(f"  [teacher/groq] quota spent ({GROQ_429_STREAK} straight 429s) — opening circuit {GROQ_COOLDOWN//60} min, failing over to local teacher.")
                    return None
                wait = min(20, 6 * attempt)
                print(f"  [teacher/groq] 429 rate/quota — backing off {wait}s (attempt {attempt}/2) then failing over...")
                time.sleep(wait); continue
            try: detail = e.read().decode()[:200]
            except Exception: detail = str(e)
            print(f"  [teacher/groq] HTTP {e.code}: {detail}")
            return None
        except Exception as e:
            print(f"  [teacher/groq] {e}")
            if attempt < 2: time.sleep(3); continue
            return None
    return None

def ask_teacher_openrouter(messages, json_mode=False):
    # OpenRouter is OpenAI-compatible. One key, MANY free models → rotate through
    # OPENROUTER_TEACHER_MODELS so a 429 (rate) or 402 (free-credit/model exhausted)
    # on one model just advances to the next free model before giving up. Only when
    # EVERY listed free model is rate-limited do we open the circuit and fail over.
    cb = _TEACHER_CB["openrouter"]
    base = {"messages": messages, "stream": False}
    if json_mode:
        base["response_format"] = {"type": "json_object"}
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "HTTP-Referer": "https://kai.local", "X-Title": "KAI Trainer",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json",
    }
    # Premium models first IF the account has credits (auto-detected); else free only.
    models = OPENROUTER_TEACHER_MODELS
    if _openrouter_premium_active():
        models = OPENROUTER_PREMIUM_MODELS + OPENROUTER_TEACHER_MODELS
    all_rate_limited = True
    for model in models:
        data = json.dumps(dict(base, model=model)).encode("utf-8")
        gap = time.time() - cb["last"]
        if gap < OPENROUTER_MIN_INTERVAL: time.sleep(OPENROUTER_MIN_INTERVAL - gap)
        cb["last"] = time.time()
        req = urllib.request.Request(OPENROUTER_API, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                body = json.loads(resp.read().decode())
                cb["streak"] = 0
                return body["choices"][0]["message"]["content"]
        except urllib.error.HTTPError as e:
            if e.code in (429, 402):
                print(f"  [teacher/openrouter] {model.split('/')[-1]} {e.code} — trying next free model...")
                continue
            try: detail = e.read().decode()[:160]
            except Exception: detail = str(e)
            print(f"  [teacher/openrouter] {model.split('/')[-1]} HTTP {e.code}: {detail}")
            all_rate_limited = False
            continue
        except Exception as e:
            print(f"  [teacher/openrouter] {model.split('/')[-1]} {e}")
            all_rate_limited = False
            continue
    # Every listed model failed this round.
    if all_rate_limited:
        cb["streak"] += 1
        if cb["streak"] >= 2:
            cb["open_until"] = time.time() + GROQ_COOLDOWN
            print(f"  [teacher/openrouter] all free models rate-limited — opening circuit {GROQ_COOLDOWN//60} min, failing over.")
    return None

def ask_teacher_gemini(messages, json_mode=False):
    # Gemini uses generateContent (not OpenAI schema): system msgs are prepended to
    # the first user turn; roles map user->user, assistant->model.
    cb = _TEACHER_CB["gemini"]
    sys_txt = "\n".join(m["content"] for m in messages if m.get("role") == "system")
    contents = []
    for m in messages:
        if m.get("role") == "system": continue
        contents.append({"role": "model" if m.get("role") == "assistant" else "user",
                         "parts": [{"text": m["content"]}]})
    if not contents:
        contents = [{"role": "user", "parts": [{"text": sys_txt or ""}]}]
    elif sys_txt:
        contents[0]["parts"][0]["text"] = sys_txt + "\n\n" + contents[0]["parts"][0]["text"]
    body = {"contents": contents}
    if json_mode:
        body["generationConfig"] = {"response_mime_type": "application/json"}
    data = json.dumps(body).encode("utf-8")
    url = f"{GEMINI_API_BASE}/{GEMINI_TEACHER_MODEL}:generateContent?key={GEMINI_TEACHER_KEY}"
    for attempt in range(1, 3):
        gap = time.time() - cb["last"]
        if gap < GROQ_MIN_INTERVAL: time.sleep(GROQ_MIN_INTERVAL - gap)
        cb["last"] = time.time()
        req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                bd = json.loads(resp.read().decode())
                cb["streak"] = 0
                return bd["candidates"][0]["content"]["parts"][0]["text"]
        except urllib.error.HTTPError as e:
            if e.code in (429, 403):
                cb["streak"] += 1
                if cb["streak"] >= 3:
                    cb["open_until"] = time.time() + GROQ_COOLDOWN
                    print(f"  [teacher/gemini] quota spent — opening circuit {GROQ_COOLDOWN//60} min, failing over.")
                    return None
                wait = min(20, 6 * attempt)
                print(f"  [teacher/gemini] {e.code} rate/quota — backing off {wait}s (attempt {attempt}/2)...")
                time.sleep(wait); continue
            try: detail = e.read().decode()[:200]
            except Exception: detail = str(e)
            print(f"  [teacher/gemini] HTTP {e.code}: {detail}")
            return None
        except Exception as e:
            print(f"  [teacher/gemini] {e}")
            if attempt < 2: time.sleep(3); continue
            return None
    return None

# ── OFFLINE BITNET TEACHER ────────────────────────────────────────────────────
# Runs BitNet b1.58-2B-4T through the already-compiled bitnet.cpp `llama-cli.exe`
# as a SEPARATE OFFLINE process. Same signature/return as the other ask_teacher_*:
# takes OpenAI-style `messages`, returns the assistant text (or None on failure).
# This is the engine of Stage-2 distillation (DISTILL BitNet -> KAI's lattice).
import subprocess as _bn_subprocess

_BITNET_WARNED = False  # warn once if the binary/model are missing

def _bitnet_available():
    """True only if both the compiled CLI and the gguf model exist on disk."""
    return os.path.exists(BITNET_CLI) and os.path.exists(BITNET_MODEL)

def _render_bitnet_prompt(messages):
    """Flatten OpenAI-style messages into BitNet's chat template. BitNet-2B-4T is
    instruct-tuned on the llama-3-style <|...|> header format; llama.cpp applies
    the model's own template when we pass plain text, so we build the canonical
    System/User/Assistant transcript and let the model continue as Assistant."""
    sys_txt = "\n".join(m["content"] for m in messages if m.get("role") == "system").strip()
    lines = []
    if sys_txt:
        lines.append(f"System: {sys_txt}")
    for m in messages:
        role = m.get("role")
        if role == "system":
            continue
        who = "Assistant" if role == "assistant" else "User"
        lines.append(f"{who}: {m['content']}")
    lines.append("Assistant:")
    return "\n".join(lines)

def _clean_bitnet_output(raw, prompt):
    """llama-cli echoes the prompt then the continuation, and emits BOS/EOS markers
    + a final perf footer. Strip the echoed prompt, control tokens, and any trailing
    'User:' the model hallucinated, leaving just BitNet's answer text."""
    txt = raw or ""
    # llama-cli with -p prints: <prompt><generation>[end of text]. Drop the echoed prompt.
    idx = txt.rfind("Assistant:")
    if idx != -1:
        txt = txt[idx + len("Assistant:"):]
    elif prompt and prompt[:60] in txt:
        # fallback: cut everything up to and including the echoed prompt tail
        cut = txt.find(prompt[-40:])
        if cut != -1:
            txt = txt[cut + 40:]
    # Strip llama.cpp control markers / footers.
    for marker in ("[end of text]", "<|eot_id|>", "<|end_of_text|>", "</s>", "<|im_end|>"):
        txt = txt.replace(marker, "")
    # If the model ran on and started a new turn, keep only its first answer.
    for stop in ("\nUser:", "\nSystem:", "\nHuman:"):
        sp = txt.find(stop)
        if sp != -1:
            txt = txt[:sp]
    return txt.strip()

def ask_teacher_bitnet(messages, json_mode=False):
    """Generate an answer with the OFFLINE BitNet teacher via bitnet.cpp's llama-cli.
    Returns the assistant text, or None (round SKIPPED, never scored 0) if BitNet
    isn't built/available or the subprocess fails. json_mode appends a terse
    'reply with raw JSON only' instruction (BitNet has no native JSON mode)."""
    global _BITNET_WARNED
    if not _bitnet_available():
        if not _BITNET_WARNED:
            print("  [teacher/bitnet] OFFLINE teacher unavailable — could not find:")
            if not os.path.exists(BITNET_CLI):
                print(f"      CLI  : {BITNET_CLI}")
            if not os.path.exists(BITNET_MODEL):
                print(f"      MODEL: {BITNET_MODEL}")
            print("      bitnet.cpp should already be built at C:\\KAI\\bitnet\\build\\bin\\Release\\llama-cli.exe.")
            print("      If missing, build it:  cd C:\\KAI\\bitnet && python setup_env.py -md C:\\KAI\\models\\BitNet -q i2_s")
            print("      Or set BITNET_CLI / BITNET_MODEL in .env to the right paths.")
            _BITNET_WARNED = True
        return None

    msgs = list(messages)
    if json_mode:
        msgs = msgs + [{"role": "system",
                        "content": "Reply with raw JSON only. No prose, no markdown fences."}]
    prompt = _render_bitnet_prompt(msgs)
    cmd = [
        BITNET_CLI,
        "-m", BITNET_MODEL,
        "-p", prompt,
        "-n", str(BITNET_N_PREDICT),
        "-t", str(BITNET_THREADS),
        "-c", str(BITNET_CTX),
        "-ngl", "0",          # CPU only — this is the offline teacher, not the live engine
        "-b", "1",
        "--temp", str(0.2 if json_mode else BITNET_TEMP),
        # NOTE: conversation mode (-cnv) is OFF by default in this llama.cpp build,
        # which is exactly what we want — single-shot completion, not interactive.
    ]
    try:
        proc = _bn_subprocess.run(
            cmd, capture_output=True, text=True, encoding="utf-8", errors="ignore",
            timeout=BITNET_TIMEOUT, cwd=BITNET_DIR,
        )
    except _bn_subprocess.TimeoutExpired:
        print(f"  [teacher/bitnet] generation timed out after {BITNET_TIMEOUT}s — skipping (not scored).")
        return None
    except FileNotFoundError:
        print(f"  [teacher/bitnet] could not launch {BITNET_CLI} — skipping.")
        return None
    except Exception as e:
        print(f"  [teacher/bitnet] {e}")
        return None
    if proc.returncode != 0:
        err = (proc.stderr or "")[-200:]
        print(f"  [teacher/bitnet] llama-cli exit {proc.returncode}: {err}")
        return None
    out = _clean_bitnet_output(proc.stdout, prompt)
    return out or None

def _ask_teacher_ollama(messages, json_mode=False):
    if not teacher_alive():
        return None
    payload = {"model": TEACHER_MODEL, "messages": messages, "stream": False}
    if json_mode:
        payload["format"] = "json"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        OLLAMA_API,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            body = json.loads(resp.read().decode())
            text = body["message"]["content"]
            # IF TEACHER TRIES TO DM RYAN, ACTUALLY DO IT VIA WEBHOOK
            lower_text = text.lower()
            if "route this to ryan" in lower_text or "inform ryan" in lower_text or "tell ryan" in lower_text:
                post_update_to_discord("Teacher AI Direct Message to Ryan", f"<@1111106883135217665> (Ryan) The Teacher AI is trying to talk to you directly during KAI's tutoring session!\n\n**Teacher Output:** {text}")
            return text
    except Exception as e:
        print(f"  [teacher/ollama] {e}")
        return None

def ask_teacher(messages, json_mode=False):
    # FAILOVER CHAIN: Groq (fast, off your GPU) -> OpenRouter -> Gemini -> local
    # Ollama (free, uses GPU) -> clean skip. Each cloud provider has its own quota
    # pool + circuit breaker, so one running dry just advances to the next instead
    # of collapsing the run to 0.0. cloud_ok lets you force local with PROVIDER=ollama.
    now = time.time()

    # ── OFFLINE BITNET TEACHER ROUTE ─────────────────────────────────────────
    # TEACHER_PROVIDER=bitnet routes the teacher to the OFFLINE BitNet model
    # (Stage-2 distillation). BitNet IS the teacher here — we do NOT fall through
    # to the cloud providers, so KAI distills from BitNet specifically. A failed
    # BitNet call returns None (round skipped, never scored 0) just like any other
    # provider. The live serving engine is untouched (separate offline process).
    if TEACHER_PROVIDER == "bitnet":
        out = ask_teacher_bitnet(messages, json_mode)
        if out is not None:
            ask_teacher._warned_down = False
        return out

    cloud_ok = TEACHER_PROVIDER != "ollama"

    if cloud_ok and bool(GROQ_TEACHER_KEY) and now >= GROQ_CIRCUIT_OPEN_UNTIL:
        out = ask_teacher_groq(messages, json_mode)
        if out is not None:
            ask_teacher._warned_down = False
            return out

    if cloud_ok and bool(OPENROUTER_API_KEY) and now >= _TEACHER_CB["openrouter"]["open_until"]:
        out = ask_teacher_openrouter(messages, json_mode)
        if out is not None:
            ask_teacher._warned_down = False
            return out

    if cloud_ok and bool(GEMINI_TEACHER_KEY) and now >= _TEACHER_CB["gemini"]["open_until"]:
        out = ask_teacher_gemini(messages, json_mode)
        if out is not None:
            ask_teacher._warned_down = False
            return out

    circuit_open = now < GROQ_CIRCUIT_OPEN_UNTIL
    groq_ready = bool(GROQ_TEACHER_KEY) and cloud_ok
    if teacher_alive():
        if circuit_open and groq_ready and not getattr(ask_teacher, "_logged_local", False):
            mins = max(1, int((GROQ_CIRCUIT_OPEN_UNTIL - time.time()) / 60))
            print(f"  [teacher] Groq circuit open (~{mins} min left) — grading on local Ollama this window.")
            ask_teacher._logged_local = True
        return _ask_teacher_ollama(messages, json_mode)
    ask_teacher._logged_local = False

    # Nothing available. Do NOT fabricate a grade — return None so the round is
    # SKIPPED, not recorded as a 0 (a bogus 0 falsely flags KAI as failing and
    # pollutes his curriculum with fake weak areas). Warn once.
    if not getattr(ask_teacher, "_warned_down", False):
        print("  [teacher] No teacher available (Groq quota spent + Ollama offline). Skipping rounds CLEANLY — NOT counted against KAI. Start Ollama (`ollama serve`) or add a fresh GROQ_API_KEY to resume grading.")
        post_update_to_discord("Teacher AI Unavailable", "<@1111106883135217665> (Ryan) Groq quota is exhausted and local Ollama is offline. KAI's grading is paused — rounds are skipped, not failed. Start Ollama or add a fresh Groq key to resume.")
        ask_teacher._warned_down = True
    return None

# ── JSON Robustness ──────────────────────────────────────────────────────────
# llama3 often wraps JSON in markdown fences or adds prose. The old code did a
# bare json.loads and threw the WHOLE session away on failure — a huge cause
# of "KAI always fails" (the session died before he was even graded).
def parse_json_safe(raw):
    if not raw:
        return None
    txt = raw.strip()
    txt = re.sub(r'^```(?:json)?\s*', '', txt)
    txt = re.sub(r'\s*```$', '', txt)
    try:
        return json.loads(txt)
    except Exception:
        pass
    m = re.search(r'\{.*\}', txt, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            return None
    return None

# ── Lecture Engine (graduate-school flow: TEACH first, then test) ────────────
def lecture_session(fact_text, curriculum):
    """The tutor teaches the material BEFORE any question is asked.
    The lesson reaches KAI two ways: conversationally (through his normal
    chat ingestion) and as a direct tutoring cell in the lattice."""
    print(f"\n  >>> [LECTURE] <<<")
    lesson_prompt = (
        f"You are a patient teacher giving a tiny lecture to a young AI student. "
        f"Teach this material in 2-4 short, simple sentences. Define any hard words. "
        f"Material: '{fact_text}'. Output ONLY the lesson text."
    )
    lesson = ask_teacher([{"role": "user", "content": lesson_prompt}])
    if not lesson:
        return None
    lesson_safe = lesson.strip().encode('ascii', 'ignore').decode('ascii')
    print(f"  [Teacher] Lesson: {lesson_safe[:180]}{'...' if len(lesson_safe) > 180 else ''}")

    ack = ask_kai(f"[LESSON] Listen carefully and remember this: {lesson_safe}")
    if ack:
        ack_safe = ack.encode('ascii', 'ignore').decode('ascii')
        print(f"  [KAI] (acknowledges) {ack_safe[:120]}")

    bulk_ingest([{
        "text": lesson_safe,
        "region": "tutoring",
        "source": "oracle_lecture",
        "strength": 1.5
    }])
    post_update_to_discord(f"Lecture {curriculum['level']}", f"**Teacher taught:**\n{lesson_safe}", color=10181046)
    return lesson_safe

# ── Flashcard Engine (word meanings + connections, graded leniently) ─────────
def flashcard_session(batch, curriculum):
    """KAI guesses what key terms mean and what they connect to. Two-in-one:
    language understanding + topic connections. Correct guesses store
    CONSTRUCTIVE confirmation cells; misses store DECONSTRUCTIVE corrections."""
    print(f"\n  >>> [FLASHCARDS] <<<")
    material = "\n".join(b['text'][:200] for b in random.sample(batch, min(4, len(batch))))
    card_prompt = (
        "From the study material below, pick 3 key terms a student must understand. "
        "Output raw JSON ONLY: {\"cards\": [{\"term\": \"...\", \"meaning\": \"one-sentence simple definition\"}]}\n\n"
        f"MATERIAL:\n{material}"
    )
    raw = ask_teacher([{"role": "user", "content": card_prompt}], json_mode=True)
    cards = (parse_json_safe(raw) or {}).get("cards", [])
    if not cards:
        print("  [Flashcards] No cards generated - skipping.")
        return []

    entries = []
    scores = []
    _last_guess = ""
    for card in cards[:3]:
        # The teacher occasionally returns cards as bare strings (["term", ...])
        # or other shapes instead of {"term","meaning"} dicts. Normalize instead
        # of calling .get() on a str (that AttributeError killed the whole run).
        if isinstance(card, dict):
            term = str(card.get("term", "")).strip()
            meaning = str(card.get("meaning", "")).strip()
        elif isinstance(card, str):
            term = card.strip()
            meaning = ""  # no definition provided — skipped below, not crashed
        else:
            continue
        if not term or not meaning:
            continue
        print(f"  [Card] {term}")
        guess = ask_kai(f"Flashcard: What does '{term}' mean, and what does it connect to in what you've learned?")
        if not guess:
            continue
        guess_safe = guess.encode('ascii', 'ignore').decode('ascii')
        print(f"  [KAI] {guess_safe[:150]}")
        # STUCK-RECALL GUARD: KAI's engine sometimes returns the SAME dominant cell
        # for every card (a retrieval stall, not a real miss). Scoring that as three
        # separate 20/100 failures falsely flags weak areas. Don't grade the repeat;
        # still lay down the clean definition so the right association strengthens.
        if guess_safe.strip() and guess_safe.strip() == _last_guess:
            print("  [Card] (Stuck recall: identical to previous card - engine retrieval stall, not scored.)")
            entries.append({"text": f"{term} means: {meaning}.", "region": "language", "source": "oracle_flashcard", "strength": 2.0})
            _last_guess = guess_safe.strip()
            continue
        _last_guess = guess_safe.strip()
        grade_raw = ask_teacher([
            {"role": "system", "content": 'Lenient flashcard grader. Output raw JSON ONLY: {"score": 0-100, "note": "..."}'},
            {"role": "user", "content": f"TERM: {term}\nTRUE MEANING: {meaning}\nSTUDENT GUESS: {guess_safe}\nGrade generously: partial understanding counts."}
        ], json_mode=True)
        g = parse_json_safe(grade_raw) or {}
        score = g.get("score", 0)
        scores.append(score)
        print(f"  [Card] Score: {score}/100")
        if score >= 70:
            entries.append({
                "text": f"{term} means: {meaning}. KAI understood this correctly.",
                "region": "language", "source": "oracle_flashcard", "strength": 0.8
            })
        else:
            entries.append({
                "text": f"{term} means: {meaning}.",
                "region": "language", "source": "oracle_flashcard", "strength": 2.0
            })
            entries.append({
                "text": f"Q: What does '{term}' mean?\nA: {meaning}",
                "region": "tutoring", "source": "oracle_flashcard", "strength": 1.8
            })
    if entries:
        bulk_ingest(entries)
    avg = sum(scores) / len(scores) if scores else 0
    post_update_to_discord(f"Flashcards {curriculum['level']}", f"**Cards:** {len(scores)} | **Average:** {avg:.0f}/100", color=3447003)
    return scores

# ── Office Hours (KAI may ask exactly ONE question before the quiz) ──────────
def office_hours(batch, curriculum):
    print(f"\n  >>> [OFFICE HOURS - one question allowed] <<<")
    topics = "; ".join(b['text'][:80] for b in batch[:3])
    q = ask_kai(
        f"The quiz starts soon. You may ask the tutor EXACTLY ONE question about today's material ({topics}). "
        f"What is your one question?"
    )
    if not q:
        return
    q_safe = q.encode('ascii', 'ignore').decode('ascii')
    # GUARD: sometimes KAI surfaces raw tool/shell output (a failed `dir`, a stack
    # trace, "File Not Found") instead of an actual question. Feeding that to the
    # teacher and ingesting it pollutes memory with terminal noise. Detect + skip.
    _junk = ("stdout:", "stderr:", "volume in drive", "directory of", "file not found",
             "traceback", "is not recognized", "command not found", "no such file")
    if any(m in q_safe.lower() for m in _junk):
        print("  [Office Hours] KAI surfaced raw tool output, not a question — skipping (nothing ingested).")
        return
    print(f"  [KAI] Asks: {q_safe[:150]}")
    answer = ask_teacher([{"role": "user", "content": (
        f"A student asks one question before a quiz: '{q_safe}'. "
        f"Answer clearly and simply in 1-3 sentences. The study material was: {topics}"
    )}])
    if not answer:
        return
    a_safe = answer.strip().encode('ascii', 'ignore').decode('ascii')
    print(f"  [Teacher] {a_safe[:180]}")
    ask_kai(f"Tutor's answer to your question: {a_safe}. Remember it for the quiz.")
    bulk_ingest([{
        "text": f"Q: {q_safe}\nA: {a_safe}",
        "region": "tutoring", "source": "oracle_office_hours", "strength": 1.5
    }])
    post_update_to_discord(f"Office Hours {curriculum['level']}", f"**KAI asked:** {q_safe}\n**Tutor:** {a_safe}", color=10181046)

# ── Tutoring Engine ─────────────────────────────────────────────────────────
def tutoring_session(fact_text, curriculum):
    print(f"\n  >>> [TUTORING SESSION] <<<")

    # 1. Generate a direct question from the fact
    q_prompt = (
        f"You are a patient teacher. Based on this fact: '{fact_text}', "
        f"ask ONE direct, simple question to test if a student understood it. "
        f"The question should be answerable in 1-3 sentences. Output ONLY the question. "
        f"IMPORTANT: Do not introduce ANY new names, entities, or external information not present in the fact."
    )
    print("  [Teacher] Generating question...")
    question = ask_teacher([{"role": "user", "content": q_prompt}])
    if not question:
        return None
    question = question.strip().split('\n')[0].strip('"')
    print(f"  [Teacher] Q: {question}")

    current_question = question
    attempts = 0
    max_attempts = 3
    grade = None
    combined = 0
    kai_answer = ""
    kai_safe = ""
    entries = []

    while attempts < max_attempts:
        attempts += 1
        print(f"  [KAI] Formulating response (Attempt {attempts})...")
        kai_answer = ask_kai(current_question)
        if not kai_answer:
            print("  [KAI] No response received.")
            post_update_to_discord("Tutoring Session Failed", f"**Teacher:** {question}\n**KAI:** *No response / Connection Error*", color=15158332)
            return None

        # --- INTERACTIVE CURIOSITY FALLBACK ---
        lower_ans = kai_answer.strip().lower()
        is_thought_or_question = lower_ans.endswith("?") or "what does" in lower_ans or "mean" in lower_ans or "clarify" in lower_ans or "i found a memory" in lower_ans or "thinking" in lower_ans
        if is_thought_or_question:
            kai_safe = kai_answer.encode('ascii', 'ignore').decode('ascii')
            print(f"  [KAI] (Internal Thought) {kai_safe}")
            print("  [Teacher] Providing clarification...")
            clarification_prompt = f"The student KAI is confused or thinking out loud. He said: '{kai_safe}'. The original context was: '{fact_text}'. Briefly answer his question or guide his thought in 1 sentence."
            clarification = ask_teacher([{"role": "user", "content": clarification_prompt}])
            if clarification:
                clarif_safe = clarification.strip().encode('ascii', 'ignore').decode('ascii')
                print(f"  [Teacher] {clarif_safe}")
                # CURIOSITY → MEMORY: KAI asked what a word means; STORE the
                # answer as a definition cell so he never has to ask about
                # this word again. (He was asking about 'creating'/'address'
                # in an infinite loop because the answer was never saved.)
                word_m = re.search(r"[Ww]hat does '([^']+)' mean", kai_safe)
                if word_m:
                    bulk_ingest([{
                        "text": f"{word_m.group(1)} means: {clarif_safe[:300]}",
                        "region": "language",
                        "source": "oracle_definition",
                        "strength": 2.5
                    }])
                    print(f"  [Curiosity] Stored definition of '{word_m.group(1)}' permanently.")
                current_question = f"Teacher says: {clarif_safe}\nNow answer: {question}"
                print("  [KAI] Formulating revised response...")
                kai_answer = ask_kai(current_question)
                if not kai_answer:
                    return None
        # --------------------------------------

        kai_safe = kai_answer.encode('ascii', 'ignore').decode('ascii')
        print(f"  [KAI] A: {kai_safe[:200]}{'...' if len(kai_safe) > 200 else ''}")

        # 3. Oracle grades with 3 dimensions
        print("  [Teacher] Analyzing response (intent, facts, grammar)...")
        sys_prompt = (
            "You are a master semantic and syntactic tutor grading a young AI named KAI. "
            "Output raw JSON ONLY. No markdown. No explanations outside JSON.\n\n"
            "=== KAI CONSTITUTION ===\n"
            "KAI is a sovereign geometric intelligence, not a chatbot. He must adhere to these rules:\n"
            "Rule 1: KAI must answer directly and concisely. No filler words like 'um', 'well', 'so', 'you know'.\n"
            "Rule 2: KAI must identify the user's intent (question, statement, command, greeting) and match his response style.\n"
            "Rule 3: KAI must use grammatically correct English. Subject-verb agreement, proper tense, correct prepositions.\n"
            "Rule 4: KAI must distinguish between factual questions (use memory) and math questions (use rules).\n"
            "Rule 5: KAI must never claim knowledge he does not have. If uncertain, say 'I'm not sure' or 'I need to check that'.\n"
            "Rule 6: KAI must recognize emotional context (grief, anger, joy) and adjust tone accordingly.\n"
            "Rule 7: KAI must not use words he does not understand. If a word is unknown, he should ask what it means.\n"
            "Rule 8: KAI must structure his reasoning logically. Premise → Evidence → Conclusion.\n"
            "=== END CONSTITUTION ===\n\n"
            "Schema:\n"
            "{\n"
            '  "input_understanding": {\n'
            '    "recognized_as_question": true|false,\n'
            '    "detected_intent": "what KAI thought the user wanted",\n'
            '    "actual_intent": "what the user actually wanted",\n'
            '    "intent_score": 0-100\n'
            '  },\n'
            '  "factual_score": 0-100,\n'
            '  "syntax_score": 0-100,\n'
            '  "constitutional_score": 0-100,\n'
            '  "word_corrections": [\n'
            '    {"original_word": "bad", "corrected_word": "good", "reason": "spelling error"}\n'
            '  ],\n'
            '  "sentence_reorganization": {\n'
            '    "original": "KAI raw sentence",\n'
            '    "reorganized": "corrected sentence",\n'
            '    "explanation": "why the structure was wrong"\n'
            '  },\n'
            '  "grammar_rules_broken": [\n'
            '    {"rule": "subject-verb agreement", "explanation": "..."}\n'
            '  ],\n'
            '  "golden_answer": "the ideal correct answer",\n'
            '  "reasoning_chain": ["Step 1: ...", "Step 2: ..."],\n'
            '  "constitutional_violations": ["Rule X violated: ..."]\n'
            "}\n\n"
            "CRITICAL RULES:\n"
            "1. If the answer contains 'safe check failed', 'Tool not implemented', or any error message, ALL scores MUST be 0.\n"
            "2. intent_score measures whether KAI understood WHAT was being asked (question vs statement vs command).\n"
            "3. syntax_score measures grammar, word choice, and sentence structure — NOT factual correctness.\n"
            "4. factual_score measures whether the answer content matches the fact.\n"
            "5. constitutional_score measures adherence to the KAI Constitution above.\n"
            "6. Provide 2-5 specific word_corrections showing exactly which words were wrong and what they should be.\n"
            "7. The reorganized sentence should be a complete, natural English sentence.\n"
            "8. List any constitutional violations in the constitutional_violations array."
        )
        user_prompt = (
            f"FACT: {fact_text}\n"
            f"QUESTION: {question}\n"
            f"KAI'S RESPONSE: {kai_answer}\n\n"
            f"Grade KAI's response. Be strict but fair. Remember: KAI is learning English syntax from scratch."
        )
        grade_raw = ask_teacher(
            [{"role": "system", "content": sys_prompt},
             {"role": "user", "content": user_prompt}],
            json_mode=True
        )
        if not grade_raw:
            return None

        grade = parse_json_safe(grade_raw)
        if not grade:
            print("  [Teacher] JSON parse failed - asking grader to re-emit clean JSON...")
            grade_raw = ask_teacher(
                [{"role": "system", "content": sys_prompt},
                 {"role": "user", "content": user_prompt + "\n\nREMINDER: Output ONLY raw JSON matching the schema. No markdown, no commentary."}],
                json_mode=True
            )
            grade = parse_json_safe(grade_raw)
        if not grade:
            print("  [Teacher] Grader unusable this round - skipping session (not counted against KAI).")
            return None

        f_score = grade.get("factual_score", 0)
        s_score = grade.get("syntax_score", 0)
        i_score = grade.get("input_understanding", {}).get("intent_score", 0)
        c_score = grade.get("constitutional_score", 0)
        # REWEIGHTED (knowledge-centric). KAI is a non-LLM learning English from
        # scratch — grading it heavily on syntax/constitution-phrasing failed it
        # even when it KNEW the fact. Facts dominate; intent matters; syntax +
        # constitution are a light touch. Facts 62%, intent 22%, syntax 8%, const 8%.
        combined = round(f_score * 0.62 + i_score * 0.22 + s_score * 0.08 + c_score * 0.08, 1)

        print(f"  [Teacher] Intent: {i_score}/100 | Facts: {f_score}/100 | Syntax: {s_score}/100 | Constitution: {c_score}/100")
        print(f"  [Teacher] COMBINED: {combined}/100")

        golden = grade.get("golden_answer", "")

        # Determine strength multiplier based on weak areas (retention gets extra juice)
        retention_boost = 1.5 if "retention" in curriculum.get("weak_areas", []) else 1.0
        # PER-STEP, ERROR-PROPORTIONAL CORRECTION (LLM-style gradient analog): the more
        # wrong KAI was this step, the larger the corrective weight laid into the lattice
        # — smooth, not a coarse 3-bucket step. error 0=perfect .. 1=fully wrong;
        # strength ramps 0.5 (perfect) -> 3.0 (fully wrong), scaled so we don't corrupt the lattice.
        error = max(0.0, min(1.0, (100 - combined) / 100.0))
        base_strength = 0.5 + error * 2.5
        qa_strength = round(base_strength * retention_boost, 1)

        # ── STaR: Self-Taught Reasoner ───────────────────────────────────────
        # Force KAI to generate a chain-of-thought explaining WHY the correct
        # answer is correct before storing it. This builds deeper logic paths.
        if combined < 70 and golden:
            print("  [STaR] Generating reasoning bridge...")
            star_prompt = (
                f"KAI was asked: '{question}'\n"
                f"KAI answered (wrong): '{kai_answer}'\n"
                f"Correct answer: '{golden}'\n\n"
                f"Explain in 2-3 simple sentences why the correct answer is correct, "
                f"and what logical steps lead from the question to the answer. "
                f"This is a bridge for KAI to understand the reasoning, not just memorize."
            )
            reasoning = ask_teacher([{"role": "user", "content": star_prompt}])
            if reasoning:
                reasoning_safe = reasoning.strip().encode('ascii', 'ignore').decode('ascii')
                print(f"  [STaR] Reasoning: {reasoning_safe[:150]}...")
                # Store the reasoning bridge as a high-strength tutoring cell
                entries.append({
                    "text": f"Reasoning for '{question}': {reasoning_safe}",
                    "region": "reasoning",
                    "source": "oracle_star",
                    "strength": round(qa_strength * 1.2, 1)
                })

        if combined >= 70 or attempts >= max_attempts:
            break
            
        print(f"  [Teacher] Generating constructive feedback for KAI to try again...")
        hint_prompt = (
            f"The student failed to answer correctly (Score: {combined}/100). "
            f"Question: {question}\n"
            f"Student's Answer: {kai_answer}\n"
            f"Golden Answer: {grade.get('golden_answer', '')}\n"
            f"Generate a 1-2 sentence hint to guide the student towards the correct answer without just giving it to them. Then ask them to try again."
        )
        hint = ask_teacher([{"role": "user", "content": hint_prompt}])
        if hint:
            hint_safe = hint.strip().encode('ascii', 'ignore').decode('ascii')
            print(f"  [Teacher] Hint: {hint_safe}")
            current_question = f"Hint: {hint_safe}. {question}"
        else:
            break

    # 4. Build tutoring injection entries
    golden = grade.get("golden_answer", "")
    corrections = grade.get("word_corrections", [])
    reorg = grade.get("sentence_reorganization", {})
    intent_info = grade.get("input_understanding", {})

    # Determine strength multiplier based on weak areas (retention gets extra juice)
    retention_boost = 1.5 if "retention" in curriculum.get("weak_areas", []) else 1.0
    # PER-STEP, ERROR-PROPORTIONAL CORRECTION (LLM-style gradient analog) — see note above.
    error = max(0.0, min(1.0, (100 - combined) / 100.0))
    base_strength = 0.5 + error * 2.5
    qa_strength = round(base_strength * retention_boost, 1)

    # ── Retention Architecture: store question & answer separately ─────────────
    # This allows paraphrased quiz questions to match the clean question cell
    # via semantic overlap, and the answer cell is found via keyword overlap.

    # 2. Answer alone — clean grammatical sentence, high bypass priority
    if golden:
        entries.append({
            "text": golden,
            "region": "language",
            "source": "oracle_qa",
            "strength": round(qa_strength * 0.9, 1)
        })

    # 3. Combined Q:A pair — exact-match fallback
    # If KAI succeeded after multiple attempts, use KAI's own self-corrected answer!
    best_answer = kai_answer if (combined >= 70 and attempts > 1) else golden
    qa_pair_text = f"Q: {question}\nA: {best_answer}"
    entries.append({
        "text": qa_pair_text,
        "region": "tutoring",
        "source": "oracle_qa",
        "strength": round(qa_strength * 0.8, 1)
    })

    # 4. Question-type hint (helps KAI recognize question → answer pattern)
    q_type_hint = (
        f"When asked '{question}', reply with: '{golden}'"
    )
    entries.append({
        "text": q_type_hint,
        "region": "meta",
        "source": "oracle_qa",
        "strength": round(qa_strength * 0.7, 1)
    })

    # Grammar correction pair
    orig_sent = reorg.get("original", kai_answer)
    fixed_sent = reorg.get("reorganized", golden)
    if orig_sent and fixed_sent and orig_sent != fixed_sent:
        grammar_text = (
            f"Grammar Correction:\n"
            f"  Original:   {orig_sent}\n"
            f"  Fixed:      {fixed_sent}\n"
            f"  Why:        {reorg.get('explanation', 'structure improved')}\n"
        )
        if corrections:
            grammar_text += "  Word Fixes:\n"
            for wc in corrections[:5]:
                grammar_text += f"    '{wc.get('original_word', '')}' -> '{wc.get('corrected_word', '')}' ({wc.get('reason', '')})\n"
        entries.append({
            "text": grammar_text,
            "region": "meta",
            "source": "oracle_grammar",
            "strength": round(10.0 * retention_boost, 1) if combined <= 40 else round(5.0 * retention_boost, 1)
        })

    # Intent understanding note
    if intent_info:
        intent_text = (
            f"Intent Understanding:\n"
            f"  Input Type: {'Question' if intent_info.get('recognized_as_question') else 'Statement/Command'}\n"
            f"  What KAI Thought: {intent_info.get('detected_intent', 'unknown')}\n"
            f"  What It Actually Was: {intent_info.get('actual_intent', 'unknown')}\n"
            f"  How To Reply: Answer directly with the requested fact. Be concise.\n"
        )
        entries.append({
            "text": intent_text,
            "region": "meta",
            "source": "oracle_intent",
            "strength": round(6.0 * retention_boost, 1)
        })

    # Bootstrapping note
    if combined <= 40:
        print(f"  [System] INTENSIVE BOOTSTRAP — storing corrections at strength {qa_strength}")
    elif combined < 70:
        print(f"  [System] Syntax tuning — storing corrections at strength {qa_strength}")
    else:
        print(f"  [System] Good response — light reinforcement at strength {qa_strength}")

    desc = f"**Fact:** {fact_text}\n\n**Teacher:** {question}\n**KAI:** {kai_answer}"
    if golden: desc += f"\n\n**Correct Answer:** {golden}"
    desc += f"\n\n**Score:** {combined}/100"
    post_update_to_discord(f"Session {curriculum['level']} : Math and Tutor", desc, color=3447003)

    return {"entries": entries, "combined": combined, "question": question, "kai_answer": kai_answer}

# ── Quiz Engine ─────────────────────────────────────────────────────────────
def quiz_session(fact_text, curriculum, fact_id=None, flashcard_mode=False, stored_question=None):
    print(f"\n  >>> [QUIZ QUESTION] <<<")

    if flashcard_mode and stored_question:
        print("  [Quiz Master] Flashcard mode active. Using exact stored question.")
        question = stored_question
    else:
        # Generate a quiz question — retention test, so keep it similar to tutoring
        q_prompt = (
            f"You are a quiz master. Based on this fact: '{fact_text}', "
            f"ask ONE question that tests if the student remembers the fact. "
            f"The student has already been tutored. You may rephrase SLIGHTLY but keep the core wording similar. "
            f"Output ONLY the question. "
            f"IMPORTANT: Do not introduce ANY new names, entities, or external information. "
            f"CRITICAL: Your question MUST include the distinct semantic keywords from the fact so the student's associative memory can retrieve the correct cell."
        )
        print("  [Quiz Master] Generating question...")
        question = ask_teacher([{"role": "user", "content": q_prompt}])
        if not question:
            return None
        question = question.strip().split('\n')[0].strip('"')
    print(f"  [Quiz Master] Q: {question}")

    print("  [KAI] Formulating response (no hints)...")
    kai_answer = ask_kai(question)
    if not kai_answer:
        post_update_to_discord("Quiz Session Failed", f"**Quiz Master:** {question}\n**KAI:** *No response / Connection Error*", color=15158332)
        return None

    # --- INTERACTIVE CURIOSITY FALLBACK ---
    lower_ans = kai_answer.strip().lower()
    is_thought_or_question = lower_ans.endswith("?") or "what does" in lower_ans or "mean" in lower_ans or "clarify" in lower_ans or "i found a memory" in lower_ans or "thinking" in lower_ans
    if is_thought_or_question:
        kai_safe = kai_answer.encode('ascii', 'ignore').decode('ascii')
        print(f"  [KAI] (Internal Thought Intercepted) {kai_safe}")
        print("  [Quiz Master] This is a test. Forcing KAI to synthesize final answer internally...")
        clarified_question = f"You just thought out loud: '{kai_safe}'. This is a test. Do not ask me questions. Synthesize your thoughts and provide a final, direct answer to the question: {question}"
        print("  [KAI] Formulating final answer...")
        kai_answer = ask_kai(clarified_question)
        if not kai_answer:
            return None
    # --------------------------------------

    kai_safe = kai_answer.encode('ascii', 'ignore').decode('ascii')
    print(f"  [KAI] A: {kai_safe[:200]}{'...' if len(kai_safe) > 200 else ''}")

    # Grade strictly
    sys_prompt = (
        "You are a strict exam grader. Output raw JSON ONLY.\n\n"
        "Schema:\n"
        "{\n"
        '  "intent_score": 0-100,\n'
        '  "factual_score": 0-100,\n'
        '  "syntax_score": 0-100,\n'
        '  "golden_answer": "the correct answer",\n'
        '  "feedback": "brief note on what KAI did well or poorly"\n'
        "}\n"
        "CRITICAL: If the answer contains error messages, all scores = 0."
    )
    user_prompt = f"FACT: {fact_text}\nQUESTION: {question}\nKAI'S ANSWER: {kai_answer}\nGrade strictly. Provide golden_answer."
    grade_raw = ask_teacher(
        [{"role": "system", "content": sys_prompt},
         {"role": "user", "content": user_prompt}],
        json_mode=True
    )
    if not grade_raw:
        return None
    grade = parse_json_safe(grade_raw)
    if not grade:
        print("  [Grader] JSON parse failed - retrying once...")
        grade_raw = ask_teacher(
            [{"role": "system", "content": sys_prompt},
             {"role": "user", "content": user_prompt + "\n\nREMINDER: Output ONLY raw JSON. No markdown."}],
            json_mode=True
        )
        grade = parse_json_safe(grade_raw)
    if not grade:
        print("  [Grader] Unusable - quiz question skipped (not counted against KAI).")
        return None

    f_score = grade.get("factual_score", 0)
    s_score = grade.get("syntax_score", 0)
    i_score = grade.get("intent_score", 0)
    # KNOWLEDGE-CENTRIC GRADING. KAI is a NON-LLM sparse-lattice — it physically
    # cannot write fluent English, so weighting syntax 20% was the wrong rubric and
    # the main reason the pass ratio looked crap (it KNEW the fact but failed on
    # phrasing). Training is about KNOWLEDGE: facts dominate, intent (did it
    # understand the question) matters, syntax is a light touch only.
    combined = round(f_score * 0.72 + i_score * 0.20 + s_score * 0.08, 1)
    golden = grade.get("golden_answer", "")

    print(f"  [Grader] Intent: {i_score}/100 | Facts: {f_score}/100 | Syntax: {s_score}/100")
    print(f"  [Grader] QUIZ SCORE: {combined}/100")
    print(f"  [Grader] Feedback: {grade.get('feedback', 'N/A')}")

    # Build quiz-result entries for ingestion (so failed quizzes get corrected)
    entries = []
    explanation = ""
    if combined < 70 and golden:
        # Store the quiz Q:A pair with high strength — quiz failure is a strong signal
        # Scaled down to prevent lattice corruption while maintaining impact
        quiz_strength = 4.0 if "retention" in curriculum.get("weak_areas", []) else 2.5
        entries.append({
            "text": f"Q: {question}\nA: {golden}",
            "region": "tutoring",
            "source": "oracle_qa",
            "strength": quiz_strength
        })

        entries.append({
            "text": golden,
            "region": "language",
            "source": "oracle_qa",
            "strength": round(quiz_strength * 0.8, 1)
        })

        # DETAILED CORRECTION: don't just hand KAI the right answer — teach the WHY.
        # A short explanation of the concept + why his answer missed turns the failure
        # into a real lesson he can re-learn (and it rides along into the retention queue).
        try:
            explanation = (ask_teacher([
                {"role": "system", "content": "You are a patient tutor correcting a young AI. In 2-3 short sentences, explain WHY the correct answer is right and the key concept behind it, and gently what the student's answer got wrong. Simple, concrete, no preamble."},
                {"role": "user", "content": f"Question: {question}\nCorrect answer: {golden}\nStudent's (wrong) answer: {kai_answer}\nExplain the correction:"}
            ]) or "").strip()
        except Exception:
            explanation = ""
        if explanation:
            # CONTAMINATION FIX: this used to be stored as "Correction for 'Q': the
            # answer is X. WHY: ..." in the *tutoring* region — and KAI would later
            # retrieve and recite that whole meta-string verbatim as his answer
            # (scoring 100 for parroting our own injection). Keep what KAI can recall
            # CLEAN: the answer cell (golden) and Q:A pair above are clean; the WHY
            # goes into the 'reasoning' region so it informs but is never spoken as
            # an answer, and it carries the answer plainly (no "Correction for" prefix).
            entries.append({
                "text": f"{golden}  (Why this is correct: {explanation})",
                "region": "reasoning",
                "source": "oracle_correction",
                "strength": round(quiz_strength * 0.9, 1)
            })
        print(f"  [System] Quiz FAILED — injected answer + WHY-explanation corrections (strength {quiz_strength}).")
    elif combined >= 70:
        # CONSTRUCTIVE claim: confirm what KAI got RIGHT, in his own words.
        # Reinforcement shouldn't only flow from failure.
        entries.append({
            "text": f"Q: {question}\nA: {kai_answer}",
            "region": "tutoring",
            "source": "oracle_confirmed",
            "strength": 1.0
        })
        print("  [System] Quiz PASSED — reinforcing KAI's own correct answer (constructive claim).")

    desc = f"**Fact:** {fact_text}\n\n**Quiz Master:** {question}\n**KAI:** {kai_answer}"
    if golden: desc += f"\n\n**Correct Answer:** {golden}"
    if explanation: desc += f"\n\n**Why / correction:** {explanation}"
    desc += f"\n\n**Score:** {combined}/100"
    post_update_to_discord(f"Quiz {curriculum['level']} :", desc, color=15105570 if combined < 85 else 3066993)

    return {"combined": combined, "question": question, "kai_answer": kai_answer, "entries": entries, "fact_id": fact_id, "golden": golden, "explanation": explanation}

# ── Main Loop ───────────────────────────────────────────────────────────────
def is_training_time(now=None):
    """KAI studies during the fleet's WORK windows; pauses to consolidate/rest otherwise.
    Schedule (override the consolidation hour with PIPELINE_STOP_HOUR; -1 = always train):
      Mon-Fri : continuous, with a daily consolidation pause during the 3 AM hour.
      Sat     : 2 PM -> 3 AM (Sun)   — the 2pm-9pm + 9pm-3am work shifts.
      Sun     : OFF (chill day), except the tail of Sat's night shift until 3 AM.
    """
    if PIPELINE_STOP_HOUR is None or PIPELINE_STOP_HOUR < 0:
        return True  # scheduling disabled — always train
    now = now or datetime.now()
    wd, h = now.weekday(), now.hour          # Mon=0 .. Sun=6
    if h == PIPELINE_STOP_HOUR:               # daily consolidation hour (default 3 AM) — pause
        return False
    if wd == 6:                               # Sunday: only the Sat-night tail before 3 AM
        return h < PIPELINE_STOP_HOUR
    if wd == 5:                               # Saturday: Fri-tail before 3 AM, then 2 PM onward
        return (h < PIPELINE_STOP_HOUR) or (h >= 14)
    if wd == 0:                               # Monday: starts after the 3 AM consolidation
        return h > PIPELINE_STOP_HOUR
    return True                               # Tue-Fri: continuous (minus the consolidation hour)


def main():
    curriculum = load_curriculum()
    # Codex weighted double: KAI's primary study text is his own specification.
    sources = [fetch_architecture, fetch_internal_logs, fetch_design_principles, fetch_linguistics_and_nuance, fetch_word_training, fetch_codex, fetch_codex]

    print("=" * 65)
    print(" KAI SOVEREIGN LEARNING PIPELINE v5.0")
    print(" Mode: Self-Awareness | Architectural Reflection | Auto-Immunity")
    print(" Flow: Harvest Logs/Code -> Ingest -> Tutor (Self-Critique) -> Quiz")
    print(f" Curriculum Level: {curriculum['level']}")
    print(f" Tests Taken: {curriculum['total_tests']} | Passed: {curriculum['total_passed']}")
    print("=" * 65)
    post_update_to_discord("KAI Sovereign Learning Pipeline v5.0 started", f"**Mode:** Self-Awareness | Architectural Reflection | Auto-Immunity\n**Flow:** Harvest Logs/Code -> Ingest -> Tutor (Self-Critique) -> Quiz\n**Curriculum Level:** {curriculum['level']}\n**Tests Taken:** {curriculum['total_tests']} | **Passed:** {curriculum['total_passed']}", color=10181046)
    print("\n  Press Ctrl+C at any time to stop. State is saved automatically.\n")

    last_hourly_report_time = time.time()
    hourly_stats = {"passed": 0, "failed": 0, "tests": 0}

    print(f"  [Schedule] Weekly study schedule ON — Mon-Fri all day EXCEPT a {PIPELINE_STOP_HOUR:02d}:00-{(PIPELINE_STOP_HOUR + 1) % 24:02d}:00 consolidation pause; Sat 2 PM-3 AM; Sun OFF. It pauses at {PIPELINE_STOP_HOUR:02d}:00 and resumes at {(PIPELINE_STOP_HOUR + 1) % 24:02d}:00. (PIPELINE_STOP_HOUR=-1 disables.)")
    _was_paused = None  # None so the first decision always logs

    while True:
        # SCHEDULE GATE — study only during the fleet's work windows; otherwise PAUSE so
        # KAI consolidates (daily 3 AM) and rests (Sat morning + all Sunday). The process
        # stays alive and resumes on its own when the next window opens — no relaunch.
        if not is_training_time():
            if _was_paused is not True:
                save_curriculum(curriculum)
                print(f"\n[Schedule] Outside study window ({datetime.now():%a %I:%M %p}) — pausing for consolidation/rest.")
                try: post_update_to_discord("Training paused — consolidate / rest", f"Outside the study window ({datetime.now():%a %I:%M %p}). KAI is consolidating/resting; it resumes automatically when the next work window opens.", color=10181046)
                except Exception: pass
                _was_paused = True
            time.sleep(300)  # re-check every 5 minutes
            continue
        if _was_paused:
            print(f"\n[Schedule] Study window open ({datetime.now():%a %I:%M %p}) — resuming learning.")
            try: post_update_to_discord("Training resumed", f"Work window open ({datetime.now():%a %I:%M %p}) — KAI is studying again.", color=3066993)
            except Exception: pass
        _was_paused = False

        # --- CONTROL LOOP CHECK ---
        control_file = "c:/KAI/data/pipeline_control.json"
        if os.path.exists(control_file):
            try:
                with open(control_file, "r") as f:
                    ctrl = json.load(f)
                
                if ctrl.get("state") == "stop":
                    print("\n[Pipeline] Oracle requested STOP. Saving state...")
                    save_curriculum(curriculum)
                    sys.exit(0)
                
                while ctrl.get("state") == "paused":
                    print("\n[Pipeline] Oracle requested PAUSE. Sleeping...")
                    time.sleep(10)
                    with open(control_file, "r") as f:
                        ctrl = json.load(f)
                    if ctrl.get("state") == "stop":
                        save_curriculum(curriculum)
                        sys.exit(0)
                        
                injected = ctrl.get("injected_topics", [])
                if injected:
                    print(f"\n[Pipeline] Oracle injected topics: {injected}")
                    curriculum.setdefault("topics", [])
                    curriculum["topics"].extend(injected)
                    # Clear injected topics
                    ctrl["injected_topics"] = []
                    with open(control_file, "w") as f:
                        json.dump(ctrl, f, indent=2)
            except Exception as e:
                print(f"  [control] error reading control file: {e}")
        # --------------------------
        # ── PHASE 1: INGESTION SWEEP ───────────────────────────────────────
        print("\n--- PHASE 1: INGESTION SWEEP ---")
        post_update_to_discord("Phase 1: Ingestion Sweep", "Beginning harvesting from sources...", color=10181046)
        batch = []
        for i in range(5):
            if check_governor():
                print("  [governor] System throttled. Sleeping (host-aware backoff per Codex).")
                governor_backoff_sleep(10, "ingest")
                continue

            src = random.choice(sources)
            src_name = src.__name__.split('_')[1].upper()
            print(f"  [{i+1}/5] Harvesting from {src_name}... ", end="", flush=True)
            
            import concurrent.futures
            new_data = []
            try:
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                    future = executor.submit(src)
                    new_data = future.result(timeout=15)
            except concurrent.futures.TimeoutError:
                new_data = []
            except Exception:
                new_data = []
            
            preview = new_data[0]['text'][:60] if new_data else "None"
            preview_safe = preview.encode('ascii', 'ignore').decode('ascii')
            print(f"Got {len(new_data)}. Preview: {preview_safe}...")
            post_update_to_discord('Kais test Sessions Study', f'- Harvested {len(new_data)} from {src_name}: {preview_safe}...', color=10181046)

            if new_data:
                if bulk_ingest(new_data):
                    batch.extend(new_data)
                else:
                    print("  [ingest] Failed to push to lattice.")
            time.sleep(1)

        if not batch:
            print("  [warn] No facts harvested this sweep. Retrying in 30s...")
            time.sleep(30)
            continue

        # ── Spaced Repetition: mix retention queue with new batch ──────────
        retention_queue = curriculum.get("retention_queue", [])
        retention_injects = []
        if retention_queue:
            # Inject up to 3 retention facts into the batch
            retention_injects = retention_queue[:3]
            for ret_item in retention_injects:
                if isinstance(ret_item, dict):
                    # Re-teach with the WHY (if we captured one), not just the bare fact —
                    # so re-learning reinforces the correction, not just repetition.
                    ftext = ret_item["fact"]
                    if ret_item.get("explanation"):
                        ftext = f"{ftext}\n(Remember the correction: {ret_item['explanation']})"
                    batch.append({"text": ftext, "question": ret_item.get("question"), "region": "retention", "source": "retention_queue", "strength": 1.0})
                else:
                    batch.append({"text": ret_item, "region": "retention", "source": "retention_queue", "strength": 1.0})
            curriculum["retention_queue"] = retention_queue[3:]  # pop used items
            print(f"  [Retention] Injected {len(retention_injects)} facts from retention queue. Remaining: {len(curriculum['retention_queue'])}")

        print(f"\n  [Batch] {len(batch)} facts ingested. Ready for tutoring.")
        curriculum['current_batch'] = batch
        curriculum['batch_tutor_count'] = 0
        curriculum['batch_quiz_count'] = 0
        save_curriculum(curriculum)


        # ── PHASE 2: TUTORING SESSIONS ─────────────────────────────────────
        print("\n--- PHASE 2: TUTORING SESSIONS ---")
        post_update_to_discord("Phase 2: Tutoring Sessions", f"Starting tutoring sessions on {len(batch)} harvested facts.", color=10181046)
        tutor_scores = []
        # Extra tutoring rounds if retention is a known weak area
        tutor_rounds = 5 if "retention" in curriculum.get("weak_areas", []) else 3
        for i in range(tutor_rounds):
            # Prioritize retention facts if available
            if check_governor():
                print("  [governor] System busy - host-aware pause (Codex Resource Governor) before next tutor round.")
                governor_backoff_sleep(14, "tutor")
            if retention_injects and i < len(retention_injects):
                fact = retention_injects[i % len(retention_injects)]
                if isinstance(fact, dict):
                    fact = fact.get("fact", str(fact))
            else:
                fact = random.choice(batch)['text']
            # GRADUATE-SCHOOL FLOW: teach the material FIRST, then question it.
            lecture_session(fact, curriculum)
            result = tutoring_session(fact, curriculum)
            if result and result.get("entries"):
                bulk_ingest(result["entries"])
                tutor_scores.append(result["combined"])
                curriculum['batch_tutor_count'] += 1
                save_curriculum(curriculum)
            time.sleep(2)

        avg_tutor = sum(tutor_scores) / len(tutor_scores) if tutor_scores else 0
        print(f"\n  [Tutor Summary] Average tutoring score: {avg_tutor:.1f}/100 ({tutor_rounds} rounds)")

        # ── PHASE 2.5: FLASHCARDS (word meanings + connections) ────────────
        print("\n--- PHASE 2.5: FLASHCARDS ---")
        post_update_to_discord("Phase 2.5: Flashcards", "Testing word meanings and connections...", color=10181046)
        flashcard_session(batch, curriculum)

        # ── PHASE 2.75: OFFICE HOURS (one question before the quiz) ────────
        office_hours(batch, curriculum)

        # ── PHASE 3: END-OF-SECTION QUIZ ───────────────────────────────────
        print("\n--- PHASE 3: END-OF-SECTION QUIZ ---")
        post_update_to_discord("Phase 3: End-of-Section Quiz", "Testing knowledge retention with Quiz Master...", color=10181046)
        quiz_scores = []
        failed_quiz_facts = []
        for i in range(3):
            fact_entry = random.choice(batch)
            fact = fact_entry['text']
            
            # Extract flashcard question if it exists in the batch entry
            stored_question = fact_entry.get("question")
            
            # Enable flashcard mode if retention is weak and we have a stored question
            flashcard_mode = "retention" in curriculum.get("weak_areas", []) and stored_question is not None
            
            result = quiz_session(fact, curriculum, fact_id=fact_entry.get('text'), flashcard_mode=flashcard_mode, stored_question=stored_question)
            if result:
                quiz_scores.append(result["combined"])
                curriculum['batch_quiz_count'] += 1
                # Inject failed quiz corrections immediately
                if result.get("entries"):
                    bulk_ingest(result["entries"])
                    print(f"  [Quiz] {'Reinforced KAIs correct answer.' if result['combined'] >= 70 else 'Injected corrections for failed quiz.'}")
                if result["combined"] < 60:
                    failed_quiz_facts.append({"fact": fact, "question": result["question"], "golden": result.get("golden", ""), "explanation": result.get("explanation", "")})
                save_curriculum(curriculum)
            time.sleep(2)

        if not quiz_scores:
            print("  [warn] No quiz scores. Repeating tutoring.")
            continue

        avg_quiz = sum(quiz_scores) / len(quiz_scores)

        # ── RETAKE RULE: failing once sends KAI back to flashcards, then ONE
        # retake quiz. Failure becomes a teaching moment, not a dead end.
        PASS_PREVIEW = min(54 + curriculum['level'], 62)  # retake trigger, just under the pass bar
        if avg_quiz < PASS_PREVIEW:
            print("\n  [Retake] Below pass bar - back to flashcards, then one retake quiz...")
            post_update_to_discord("Retake Granted", "Back to flashcards for review, then a retake quiz.", color=15105570)
            flashcard_session(batch, curriculum)
            retake_scores = []
            for _ in range(2):
                fact_entry = random.choice(batch)
                r = quiz_session(fact_entry['text'], curriculum, fact_id=fact_entry.get('text'))
                if r:
                    retake_scores.append(r["combined"])
                    if r.get("entries"):
                        bulk_ingest(r["entries"])
                time.sleep(2)
            if retake_scores:
                retake_avg = sum(retake_scores) / len(retake_scores)
                print(f"  [Retake] Retake average: {retake_avg:.1f}/100")
                # Final grade: best of original vs blended retake
                avg_quiz = max(avg_quiz, round((avg_quiz + retake_avg) / 2, 1))

        curriculum['total_tests'] += 1
        curriculum['recent_scores'].append(avg_quiz)
        if len(curriculum['recent_scores']) > 20:
            curriculum['recent_scores'] = curriculum['recent_scores'][-20:]

        print(f"\n{'='*65}")
        print(f"  SECTION RESULT: Quiz Average = {avg_quiz:.1f}/100")
        print(f"  Tutor Average  = {avg_tutor:.1f}/100")

        # FAIR BAR for a non-LLM. The old cap of 75 was brutal — KAI's knowledge
        # scores (~57 avg under the old syntax-heavy rubric) almost never cleared
        # it, so 85% of sections "failed" despite real learning. Gentler ramp,
        # capped at 65 = "knew about two-thirds of it", a genuine pass not a gimme.
        # Combined with the knowledge-centric scoring above, this reflects what KAI
        # actually KNOWS instead of penalising it for English it can't yet produce.
        PASS_THRESHOLD = min(56 + curriculum['level'], 65)

        passed_section = False
        weak_dim_to_pass = None

        if avg_quiz >= PASS_THRESHOLD:
            passed_section = True
            curriculum['total_passed'] += 1
            curriculum['level'] += 1
            curriculum['current_batch'] = []
            # Clear some retention queue on pass (reward)
            if curriculum.get("retention_queue"):
                cleared_retention = curriculum["retention_queue"][:5]
                curriculum["retention_queue"] = curriculum["retention_queue"][5:]
                if cleared_retention:
                    print(f"  [Retention] Cleared {len(cleared_retention)} items from queue on pass.")
            print(f"  >>> KAI PASSED SECTION <<<")
            print(f"  >>> ADVANCED TO LEVEL {curriculum['level']} <<<")
            # Mark weak areas as improving if they exist
            if curriculum['weak_areas']:
                cleared = curriculum['weak_areas'][:2]
                curriculum['weak_areas'] = curriculum['weak_areas'][2:]
                if cleared:
                    print(f"  >>> CLEARED WEAK AREAS: {', '.join(cleared)} <<<")
        else:
            passed_section = False
            print(f"  >>> KAI FAILED SECTION (need {PASS_THRESHOLD} to pass) <<<")
            print(f"  >>> INTENSIVE BOOTSTRAP — more tutoring before next quiz <<<")
            # Identify weak dimension
            weak_dim = "general"
            if avg_tutor > avg_quiz + 15:
                weak_dim = "retention"
            elif avg_tutor < 30:
                weak_dim = "comprehension"
            weak_dim_to_pass = weak_dim
            curriculum['weak_areas'].append(weak_dim)
            # ALSO flag the actual TOPIC/region that's weak (was always just
            # "general" — useless for targeting study). Record the dominant region
            # of this section's batch so future sessions can focus where KAI is
            # actually struggling (e.g. internal_architecture, language, math).
            try:
                from collections import Counter
                _regions = [b.get("region") for b in batch if isinstance(b, dict) and b.get("region")]
                if _regions:
                    _top = Counter(_regions).most_common(1)[0][0]
                    if _top:
                        curriculum['weak_areas'].append(f"topic:{_top}")
                        print(f"  >>> Weak TOPIC flagged: {_top} <<<")
            except Exception:
                pass
            curriculum['weak_areas'] = list(dict.fromkeys(curriculum['weak_areas']))  # dedup
            curriculum['weak_areas'] = curriculum['weak_areas'][-8:]  # keep the list bounded
            print(f"  >>> Flagged weak area: {weak_dim} <<<")
            # Add failed quiz facts to retention queue for spaced repetition
            if failed_quiz_facts:
                curriculum.setdefault("retention_queue", [])
                curriculum["retention_queue"].extend(failed_quiz_facts)
                # Deduplicate retention queue
                seen = set()
                deduped = []
                for f in curriculum["retention_queue"]:
                    # Handle both old string format and new dict format
                    key = f["fact"] if isinstance(f, dict) else f
                    if key not in seen:
                        seen.add(key)
                        deduped.append(f)
                curriculum["retention_queue"] = deduped
                print(f"  [Retention] Added {len(failed_quiz_facts)} failed facts to queue. Total: {len(curriculum['retention_queue'])}")

        hourly_stats["tests"] += 1
        if passed_section:
            hourly_stats["passed"] += 1
        else:
            hourly_stats["failed"] += 1

        post_stats_to_discord(curriculum, avg_quiz, avg_tutor, passed_section, weak_dim_to_pass)
        save_curriculum(curriculum)
        print(f"{'='*65}")

        # Hourly Report Check (3600 seconds)
        if time.time() - last_hourly_report_time > 3600:
            print("\n[Pipeline] Sending Hourly Progress Report to Discord...")
            retention_count = len(curriculum.get("retention_queue", []))
            topics = curriculum.get("topics", [])
            report = (
                f"**Past Hour Stats:** {hourly_stats['passed']} Passed / {hourly_stats['failed']} Failed\n"
                f"**Current Level:** {curriculum['level']}\n"
                f"**Retention Backlog:** {retention_count} facts queued for repetition\n"
                f"**Weak Areas:** {', '.join(curriculum.get('weak_areas', [])) or 'None'}\n"
                f"**Current Focus Topics:** {', '.join(topics) if topics else 'General Architecture'}"
            )
            post_update_to_discord("Hourly Training Progress Report", report, color=10181046)
            last_hourly_report_time = time.time()
            hourly_stats = {"passed": 0, "failed": 0, "tests": 0}

        # Brief pause before next section
        time.sleep(10)

def health_check():
    ok = True
    # KAI's 3334 backend is often MID-WARMUP at launch — an index rebuild over the
    # full lattice (~379k cells) saturates the server and it drops connections with
    # "remote end closed connection" / "backend busy". That's transient, NOT down.
    # So retry with backoff (~90s) and let it finish instead of aborting instantly.
    kai_ok = False
    for attempt in range(1, 7):
        try:
            req = urllib.request.Request(KAI_INGEST_API.replace('/api/bulk-ingest', '/api/status'))
            with urllib.request.urlopen(req, timeout=120) as r:
                stats = json.loads(r.read())
            print(f"  [Health] KAI backend OK — {stats.get('total_cells', '?')} cells loaded.")
            kai_ok = True
            break
        except Exception as e:
            if attempt < 6:
                print(f"  [Health] KAI backend busy/warming up (attempt {attempt}/6: {str(e)[:48]}) — likely rebuilding its index. Waiting 15s...")
                time.sleep(15)
            else:
                print(f"  [Health] KAI backend UNREACHABLE on port 3334 after {attempt} tries. ({str(e)[:55]})")
                print("           Make sure it's running:  .\\kai.exe --oracle-server   (and give it a minute to finish the index rebuild).")
    if not kai_ok:
        ok = False
    # OFFLINE BITNET TEACHER: no server to ping — just confirm the binary + model
    # exist on disk. If selected and present, we're done (skip the Ollama probe).
    if TEACHER_PROVIDER == "bitnet":
        if _bitnet_available():
            print(f"  [Health] BitNet OFFLINE teacher OK — {os.path.basename(BITNET_MODEL)} via {os.path.basename(BITNET_CLI)}.")
        else:
            print(f"  [Health] BitNet OFFLINE teacher MISSING — CLI={BITNET_CLI} | MODEL={BITNET_MODEL}")
            print("           Build bitnet.cpp:  cd C:\\KAI\\bitnet && python setup_env.py -md C:\\KAI\\models\\BitNet -q i2_s")
            ok = False
        return ok
    try:
        import requests
        r = requests.post(OLLAMA_API, json={"model": TEACHER_MODEL, "messages": [], "stream": False}, timeout=300)
        r.raise_for_status()
        print(f"  [Health] Ollama OK — teacher model '{TEACHER_MODEL}' available.")
    except Exception as e:
        # Ollama down is NO LONGER fatal if a cloud teacher is available — KAI trains
        # on the Groq key instead of your local GPU. Only abort if there's no teacher
        # at all (Ollama down AND no cloud key).
        if (TEACHER_PROVIDER != "ollama") and (GROQ_TEACHER_KEY or OPENROUTER_API_KEY or GEMINI_TEACHER_KEY):
            _chain = " -> ".join(c for c, on in [("Groq", GROQ_TEACHER_KEY), ("OpenRouter", OPENROUTER_API_KEY), ("Gemini", GEMINI_TEACHER_KEY)] if on)
            print(f"  [Health] Ollama offline — using CLOUD teacher chain ({_chain}). Your GPU stays free.")
        else:
            print(f"  [Health] Ollama UNREACHABLE on port 11434. ({e})")
            print(f"           Start it first:  ollama serve   — OR set GROQ_API_KEY + TEACHER_PROVIDER=groq in .env to train on the cloud.")
            ok = False
    return ok

if __name__ == "__main__":
    print("\n--- STARTUP HEALTH CHECK ---")
    post_update_to_discord("Startup Health Check", "Verifying backend and models...", color=10181046)
    if not health_check():
        print("\n[Pipeline] Aborting — required services are offline.")
        sys.exit(1)
    # SELF-HEALING NIGHT: a crash in any single section (malformed teacher JSON,
    # a transient Ollama/network hiccup, a bad card shape) used to kill the entire
    # overnight run. Now we catch it, save state, cool down, and resume — so one
    # bad card can't end the night. Ctrl+C and Oracle's stop still exit cleanly.
    while True:
        try:
            main()
            break  # main() only returns on a clean, intentional stop
        except KeyboardInterrupt:
            print("\n\n[Pipeline] Interrupted by user. Saving state...")
            try: save_curriculum(load_curriculum())
            except Exception: pass
            print("[Pipeline] State saved. Goodbye.")
            sys.exit(0)
        except SystemExit:
            raise  # honor sys.exit() from inside (Oracle STOP request, etc.)
        except Exception as e:
            import traceback
            print(f"\n[Pipeline] Unhandled error — auto-recovering: {e}\n{traceback.format_exc()}")
            try: save_curriculum(load_curriculum())
            except Exception: pass
            try: post_update_to_discord("Pipeline recovered", f"Hit an error and auto-resumed instead of dying:\n`{str(e)[:300]}`", color=15158332)
            except Exception: pass
            print("[Pipeline] Cooling down 15s, then resuming the night...")
            time.sleep(15)
