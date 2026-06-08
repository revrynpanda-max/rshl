import time, json, random, urllib.request, re, os, sys
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

# ── Configuration ───────────────────────────────────────────────────────────
KAI_INGEST_API = 'http://127.0.0.1:3334/api/bulk-ingest'
KAI_CHAT_API   = 'http://127.0.0.1:3334/api/oracle-turn'
OLLAMA_API     = 'http://127.0.0.1:11434/api/chat'

CURRICULUM_PATH = os.path.join(os.path.dirname(__file__), 'data', 'pipeline_curriculum.json')
ENV_PATH = r"C:\KAI\tools\oracle-discord\.env"
TEACHER_MODEL = "llama3"
if os.path.exists(ENV_PATH):
    with open(ENV_PATH, "r") as f:
        for line in f:
            if line.startswith("BOT_MODEL_ORACLE="):
                TEACHER_MODEL = line.strip().split("=", 1)[1]

DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/1513343778797256804/pqjl_LsyMzQjJGivyy21LSay_aftVejPDtlhq1N_BN9vwp8SZ0Ztr95ojWGxbBGid-g5"

class PipelineDashboard:
    def __init__(self):
        self.message_id = None
        self.previous_results_embed = None
        self.study_embeds = []
        self.tutor_embeds = []
        self.quiz_embeds = []
        self.grade_embed = None
        
    def start_new_session(self):
        self.message_id = None
        self.study_embeds = []
        self.tutor_embeds = []
        self.quiz_embeds = []
        self.grade_embed = None
        # Previous grade embed is carried over.
        
    def _add_to_embed_list(self, embed_list, title, content, color):
        if not embed_list:
            embed_list.append({"title": title, "description": content, "color": color})
            return
            
        # Append to the last embed in the list
        last_embed = embed_list[-1]
        new_desc = last_embed["description"] + "\n\n" + content
        if len(new_desc) > 3900:
            # Create a new embed if it gets too large
            embed_list.append({"title": title + " (Cont.)", "description": content, "color": color})
        else:
            last_embed["description"] = new_desc

    def render(self):
        import urllib.request, json
        if not DISCORD_WEBHOOK_URL: return
        embeds = []
        if self.previous_results_embed: embeds.append(self.previous_results_embed)
        embeds.extend(self.study_embeds)
        embeds.extend(self.tutor_embeds)
        embeds.extend(self.quiz_embeds)
        if self.grade_embed: embeds.append(self.grade_embed)
        
        # Discord limit is 10 embeds per message.
        if len(embeds) > 10:
            embeds = embeds[:10]
            
        data = json.dumps({"embeds": embeds}).encode('utf-8')
        
        try:
            if self.message_id:
                req = urllib.request.Request(DISCORD_WEBHOOK_URL + "/messages/" + self.message_id, data=data, headers={"User-Agent": "KAI-Bot", "Content-Type": "application/json"}, method="PATCH")
                urllib.request.urlopen(req, timeout=5)
            else:
                req = urllib.request.Request(DISCORD_WEBHOOK_URL + "?wait=true", data=data, headers={"User-Agent": "KAI-Bot", "Content-Type": "application/json"}, method="POST")
                with urllib.request.urlopen(req, timeout=5) as r:
                    resp = json.loads(r.read())
                    self.message_id = resp.get("id")
        except Exception:
            if self.message_id:
                self.message_id = None
                self.render()

DASHBOARD = PipelineDashboard()

def post_update_to_discord(title, content, color=3066993):
    if "started" in title.lower() or "startup" in title.lower():
        pass
    elif "phase 1" in title.lower():
        DASHBOARD.start_new_session()
        DASHBOARD.render()
    elif "sessions study" in title.lower():
        DASHBOARD._add_to_embed_list(DASHBOARD.study_embeds, "Kais test Sessions Study", content, color=color)
        DASHBOARD.render()
    elif "phase 2" in title.lower():
        DASHBOARD.render()
    elif "tutoring session" in title.lower():
        DASHBOARD._add_to_embed_list(DASHBOARD.tutor_embeds, "Kais Phase questions and answers", content, color=color)
        DASHBOARD.render()
    elif "phase 3" in title.lower():
        DASHBOARD.render()
    elif "quiz session" in title.lower():
        DASHBOARD._add_to_embed_list(DASHBOARD.quiz_embeds, "Kais Quiz Questions and answers", content, color=color)
        DASHBOARD.render()
    else:
        DASHBOARD._add_to_embed_list(DASHBOARD.study_embeds, "Kais test Sessions Study", content, color=color)
        DASHBOARD.render()

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
        "title": f"kais final grade on that session",
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
        
    DASHBOARD.grade_embed = embed
    
    import copy
    prev_embed = copy.deepcopy(embed)
    prev_embed["title"] = f"Comparison from Last tests"
    DASHBOARD.previous_results_embed = prev_embed
    
    DASHBOARD.render()

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
    try:
        import psutil
        mem = psutil.virtual_memory()
        if mem.used > 35 * 1024**3 or psutil.cpu_percent(interval=1) > 90:
            return True
    except ImportError:
        pass
    return False

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

def ask_kai(question, from_name="Oracle-Teacher"):
    data = json.dumps({"from": from_name, "text": question}).encode()
    req = urllib.request.Request(
        KAI_CHAT_API,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            res = json.loads(r.read())
            return res.get("reply", str(res))
    except Exception as e:
        print(f"  [kai error] {e}")
        return None

# ── Oracle Teacher ────────────────────────────────────────────────────────────
def ask_teacher(messages, json_mode=False):
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
            return body["message"]["content"]
    except Exception as e:
        print(f"  [oracle error] {e}")
        return None

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
        if kai_answer.strip().endswith("?") and "clarify" in kai_answer.lower():
            kai_safe = kai_answer.encode('ascii', 'ignore').decode('ascii')
            print(f"  [KAI] {kai_safe}")
            print("  [Teacher] Providing clarification...")
            clarification_prompt = f"The student KAI is confused. He asked: '{kai_safe}'. The original context was: '{fact_text}'. Briefly answer his question in 1 sentence."
            clarification = ask_teacher([{"role": "user", "content": clarification_prompt}])
            if clarification:
                clarif_safe = clarification.strip().encode('ascii', 'ignore').decode('ascii')
                print(f"  [Teacher] {clarif_safe}")
                current_question = f"Context: {clarif_safe}\nNow answer: {question}"
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

        try:
            grade = json.loads(grade_raw)
        except Exception as e:
            print(f"  [Teacher] JSON parse error: {e}")
            print(f"  [Teacher] Raw: {grade_raw[:300]}")
            return None

        f_score = grade.get("factual_score", 0)
        s_score = grade.get("syntax_score", 0)
        i_score = grade.get("input_understanding", {}).get("intent_score", 0)
        c_score = grade.get("constitutional_score", 0)
        # Weighted: facts 30%, syntax 25%, intent 20%, constitution 25%
        combined = round(f_score * 0.30 + s_score * 0.25 + i_score * 0.20 + c_score * 0.25, 1)

        print(f"  [Teacher] Intent: {i_score}/100 | Facts: {f_score}/100 | Syntax: {s_score}/100 | Constitution: {c_score}/100")
        print(f"  [Teacher] COMBINED: {combined}/100")

        golden = grade.get("golden_answer", "")

        # Determine strength multiplier based on weak areas (retention gets extra juice)
        retention_boost = 1.5 if "retention" in curriculum.get("weak_areas", []) else 1.0
        # Scaled down to physically realistic geometric resonance so we don't corrupt KAI's lattice
        base_strength = 3.0 if combined <= 40 else (1.5 if combined < 70 else 0.5)
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
            current_question = f"Teacher says: {hint_safe}\nNow try again: {question}"
        else:
            break

    # 4. Build tutoring injection entries
    golden = grade.get("golden_answer", "")
    corrections = grade.get("word_corrections", [])
    reorg = grade.get("sentence_reorganization", {})
    intent_info = grade.get("input_understanding", {})

    # Determine strength multiplier based on weak areas (retention gets extra juice)
    retention_boost = 1.5 if "retention" in curriculum.get("weak_areas", []) else 1.0
    base_strength = 3.0 if combined <= 40 else (1.5 if combined < 70 else 0.5)
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
    post_update_to_discord("Tutoring Session", desc, color=3447003)

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
            f"IMPORTANT: Do not introduce ANY new names, entities, or external information not present in the fact."
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
    if kai_answer.strip().endswith("?") and "clarify" in kai_answer.lower():
        kai_safe = kai_answer.encode('ascii', 'ignore').decode('ascii')
        print(f"  [KAI] {kai_safe}")
        print("  [Quiz Master] Providing clarification...")
        clarification_prompt = f"The student KAI is confused. He asked: '{kai_safe}'. The original context was: '{fact_text}'. Briefly answer his question in 1 sentence."
        clarification = ask_teacher([{"role": "user", "content": clarification_prompt}])
        if clarification:
            clarif_safe = clarification.strip().encode('ascii', 'ignore').decode('ascii')
            print(f"  [Quiz Master] {clarif_safe}")
            clarified_question = f"Context: {clarif_safe}\nNow answer: {question}"
            print("  [KAI] Formulating revised response...")
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
    try:
        grade = json.loads(grade_raw)
    except Exception:
        return None

    f_score = grade.get("factual_score", 0)
    s_score = grade.get("syntax_score", 0)
    i_score = grade.get("intent_score", 0)
    combined = round(f_score * 0.40 + s_score * 0.35 + i_score * 0.25, 1)
    golden = grade.get("golden_answer", "")

    print(f"  [Grader] Intent: {i_score}/100 | Facts: {f_score}/100 | Syntax: {s_score}/100")
    print(f"  [Grader] QUIZ SCORE: {combined}/100")
    print(f"  [Grader] Feedback: {grade.get('feedback', 'N/A')}")

    # Build quiz-result entries for ingestion (so failed quizzes get corrected)
    entries = []
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
        print(f"  [System] Quiz FAILED — injecting high-strength corrections (strength {quiz_strength})")

    desc = f"**Fact:** {fact_text}\n\n**Quiz Master:** {question}\n**KAI:** {kai_answer}"
    if golden: desc += f"\n\n**Correct Answer:** {golden}"
    desc += f"\n\n**Score:** {combined}/100"
    post_update_to_discord("Quiz Session", desc, color=15105570 if combined < 85 else 3066993)

    return {"combined": combined, "question": question, "kai_answer": kai_answer, "entries": entries, "fact_id": fact_id}

# ── Main Loop ───────────────────────────────────────────────────────────────
def main():
    curriculum = load_curriculum()
    sources = [fetch_architecture, fetch_internal_logs, fetch_design_principles, fetch_linguistics_and_nuance]

    print("=" * 65)
    print(" KAI SOVEREIGN LEARNING PIPELINE v5.0")
    print(" Mode: Self-Awareness | Architectural Reflection | Auto-Immunity")
    print(" Flow: Harvest Logs/Code -> Ingest -> Tutor (Self-Critique) -> Quiz")
    print(f" Curriculum Level: {curriculum['level']}")
    print(f" Tests Taken: {curriculum['total_tests']} | Passed: {curriculum['total_passed']}")
    print("=" * 65)
    post_update_to_discord("KAI Sovereign Learning Pipeline v5.0 started", f"**Mode:** Self-Awareness | Architectural Reflection | Auto-Immunity\n**Flow:** Harvest Logs/Code -> Ingest -> Tutor (Self-Critique) -> Quiz\n**Curriculum Level:** {curriculum['level']}\n**Tests Taken:** {curriculum['total_tests']} | **Passed:** {curriculum['total_passed']}", color=10181046)
    print("\n  Press Ctrl+C at any time to stop. State is saved automatically.\n")

    while True:
        # ── PHASE 1: INGESTION SWEEP ───────────────────────────────────────
        print("\n--- PHASE 1: INGESTION SWEEP ---")
        post_update_to_discord("Phase 1: Ingestion Sweep", "Beginning harvesting from sources...", color=10181046)
        batch = []
        for i in range(5):
            if check_governor():
                print("  [governor] System throttled. Sleeping 10s.")
                time.sleep(10)
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
                    batch.append({"text": ret_item["fact"], "question": ret_item["question"], "region": "retention", "source": "retention_queue", "strength": 1.0})
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
            if retention_injects and i < len(retention_injects):
                fact = retention_injects[i % len(retention_injects)]
            else:
                fact = random.choice(batch)['text']
            result = tutoring_session(fact, curriculum)
            if result and result.get("entries"):
                bulk_ingest(result["entries"])
                tutor_scores.append(result["combined"])
                curriculum['batch_tutor_count'] += 1
                save_curriculum(curriculum)
            time.sleep(2)

        avg_tutor = sum(tutor_scores) / len(tutor_scores) if tutor_scores else 0
        print(f"\n  [Tutor Summary] Average tutoring score: {avg_tutor:.1f}/100 ({tutor_rounds} rounds)")

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
                    print(f"  [Quiz] Injected corrections for failed quiz.")
                if result["combined"] < 60:
                    failed_quiz_facts.append({"fact": fact, "question": result["question"]})
                save_curriculum(curriculum)
            time.sleep(2)

        if not quiz_scores:
            print("  [warn] No quiz scores. Repeating tutoring.")
            continue

        avg_quiz = sum(quiz_scores) / len(quiz_scores)
        curriculum['total_tests'] += 1
        curriculum['recent_scores'].append(avg_quiz)
        if len(curriculum['recent_scores']) > 20:
            curriculum['recent_scores'] = curriculum['recent_scores'][-20:]

        print(f"\n{'='*65}")
        print(f"  SECTION RESULT: Quiz Average = {avg_quiz:.1f}/100")
        print(f"  Tutor Average  = {avg_tutor:.1f}/100")

        PASS_THRESHOLD = 60 + (curriculum['level'] * 5)  # harder each level
        PASS_THRESHOLD = min(PASS_THRESHOLD, 85)

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
            curriculum['weak_areas'] = list(dict.fromkeys(curriculum['weak_areas']))  # dedup
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

        post_stats_to_discord(curriculum, avg_quiz, avg_tutor, passed_section, weak_dim_to_pass)
        save_curriculum(curriculum)
        print(f"{'='*65}")

        # Brief pause before next section
        time.sleep(10)

def health_check():
    ok = True
    try:
        req = urllib.request.Request(KAI_INGEST_API.replace('/api/bulk-ingest', '/api/status'))
        with urllib.request.urlopen(req, timeout=120) as r:
            stats = json.loads(r.read())
            print(f"  [Health] KAI backend OK — {stats.get('total_cells', '?')} cells loaded.")
    except Exception as e:
        print(f"  [Health] KAI backend UNREACHABLE on port 3334. ({e})")
        print("           Start it first:  .\\kai.exe --oracle-server")
        ok = False
    try:
        import requests
        r = requests.post(OLLAMA_API, json={"model": TEACHER_MODEL, "messages": [], "stream": False}, timeout=300)
        r.raise_for_status()
        print(f"  [Health] Ollama OK — teacher model '{TEACHER_MODEL}' available.")
    except Exception as e:
        print(f"  [Health] Ollama UNREACHABLE on port 11434. ({e})")
        print(f"           Start it first:  ollama serve")
        ok = False
    return ok

if __name__ == "__main__":
    print("\n--- STARTUP HEALTH CHECK ---")
    post_update_to_discord("Startup Health Check", "Verifying backend and models...", color=10181046)
    if not health_check():
        print("\n[Pipeline] Aborting — required services are offline.")
        sys.exit(1)
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n[Pipeline] Interrupted by user. Saving state...")
        save_curriculum(load_curriculum())
        print("[Pipeline] State saved. Goodbye.")
        sys.exit(0)
