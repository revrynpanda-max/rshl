# Oracle Lattice OS — VISUAL REFERENCE (for Claude Code, which cannot see images)

Pairs with `DASHBOARD-BACKLOG.md`. The owner sent screenshots; this transcribes what's actually on screen so you can work the UI accurately without seeing it.

## Owner's direction (verbatim intent)
"This is going from simple. The way I really have it already on the browser is already great — just needs fine-tuning and more geometry, since browsers have a hard time. I'm going OUT of browser (hence the native implementation plan Antigravity sent — the Rust/wgpu `kaiverse.exe`). The controls and view all need to be SMOOTH — right now it's boxy. I load the KAIVERSE via `http://localhost:3001/`."

**Read:** the browser dashboard is good and stays as the control surface; the 3D KAIVERSE is being moved native for smooth, high-geometry rendering (browser WebGL is the ceiling). The dashboard's *job* is polish + the fixes in the backlog, NOT a rewrite.

---

## The overall layout (every dashboard screenshot shares this)
Dark, near-black theme with cyan (`#22d9e6`) accents, monospace numbers, rounded "glass" cards.
- **Top bar:** left = a hexagon logo + "ORACLE LATTICE OS / REALM CONTROL CENTER", then the current view name (e.g. "Config · agents & channels", "Nervous System · live signal flow", "Learning & Dreams"). Right = a live clock ("01:59:56 AM · THU, JUN 25, 2026") and three metric chips: **RESONANCE ΦG 4.117**, **LATTICE 389035**, **TRAFFIC 696**, then a green "● LIVE" pill.
- **Left icon rail** (~54px, vertical): home, chat bubble, topology/share, ❄/star (KAIVERSE), moon (Learning & Dreams), gear (Config). The active one is cyan-highlighted.
- **Center:** the current view's content.
- **Right panel** (~300px): "ROOT ADMIN" + the agents list + admin block (described below).

## Right panel — "LATTICE AGENTS 6/9" (this is the one that needs the profile/identity fix)
- Top card: **"Ryan ★ @NASTERMODX · OWNER"** with a green online dot.
- "LATTICE AGENTS 6/9" header, then one row per agent. Each row = a **colored rounded-square avatar with a letter**, the name, a status badge, three stats, and an energy bar:
  - **K = KAI** (green), **L = Leo** (pink), **G = Gemini** (cyan), **C = Claudey** (purple), **X = X** (white/grey), **G = Groq** (pink), **A = Analyst** (blue), **R = Researcher** (green), **K = Kai Coder** (orange).
  - Badge: **LIVE** (green) or **DOWN** (red). Stats read like `⚡70 ↑77 ⟳8.8ms` (energy / health / latency). DOWN agents show `⚡52 ↑0 ⟳—`. In the shots, **Gemini, Claudey, X = DOWN** (asleep), the rest LIVE.
  - A horizontal energy bar (green when healthy, yellow mid) on the right.
- **"HUMANS / GUESTS"** section — currently stuck on **"Loading identities…"** (Backlog A4: must actually load, and clicking a name must open THAT user's profile — when Taz was logged in it wrongly routed to the owner's profile).
- **"ADMIN"** block: "SIGNED IN AS Ryan · owner" (green dot), "DISCORD ID 1111106883135217665 (owner-asserted)", "ADMIN CHANNELS 1 accessible", "CONTROL TOKEN ● set (11 chars)".

## Config view ("Config · agents & channels")
- Center heading: **"AI AGENT CONFIGURATION · EDITABLE · WRITES .ENV + RESTARTS THE BOT"**, then a **3-column grid of agent cards**. Each card: a status dot + name, four rows **PROVIDER / MODEL / VOICE / PORT**, and buttons **DM · EDIT · SLEEP (or WAKE if asleep) · RESTART**. Current values on screen:
  - Oracle — ollama · Oracle-Sovereign · — · :3410
  - **KAI — ollama · KAI-Sovereign · — · :3401**  ← Backlog A7: KAI is RSHL, NOT ollama. The "ollama" label is wrong/misleading; Ollama is only the optional BitNet-transformer path.
  - Leo — gemini · gemini-2.5-flash · Fenrir · :3400
  - Gemini — gemini · gemini-2.5-flash · Aoede · :3402 (DOWN, WAKE)
  - Claudey — gemini · gemini-2.5-flash · Kore · :3403 (DOWN, WAKE)
  - X — gemini · gemini-2.5-flash · Fenrir · :3404 (DOWN, WAKE)
  - Groq — gemini · gemini-2.5-flash · Puck · :3405
  - Analyst — ollama · Analyst-Sovereign · — · :3406
  - Researcher — groq · llama-3.3-70b-versatile · — · :3407
  - Kai Coder — ollama · Kai-Coder-Sovereign · — · :3408
- Below: **"# CHANNEL SETTINGS · 17 channels · PER-CHANNEL OVERLAY"** — channel rows (e.g. `# oracle-chat` with agent tags KAI/Gemini/Claudey/X/Groq/Analyst/Researcher/Kai Coder; `# self-optimize-check` KAI/Analyst; `🔒 sensitive-info` "system-only — no bots"), each "● bridged" + EDIT.
- Backlog A8: this whole center config area should be **on-demand** (opened by a click), not duplicating the right panel.

## The EDIT modal (Leo's config — Backlog A5: it OVERFLOWS the screen)
A centered dark modal, dimmed backdrop. Top note: "engine, social mode and tools… Saving writes the bot's .env keys and queues a restart of just this bot. Only options this AI can use are shown." Fields top-to-bottom:
- **PROVIDER** dropdown = `gemini`
- **MODEL (REAL — TYPEABLE)** = `gemini-2.5-flash`
- **LIVE VOICE (GEMINI NATIVE-AUDIO)** dropdown = `Fenrir`  ("Leave blank to leave voice unchanged")
- **READING ENGINE** group: READING ENGINE (`LEO_READING_ENGINE`)=`live`; MANUAL VAD (`LEO_MANUAL_VAD`)=`1`; THINKING VOLUME (`LEO_THINKING_VOLUME`)=`3.0`
- **TTS & LIVE MODEL** group: LIVE (NATIVE-AUDIO) MODEL (`GEMINI_LIVE_MODEL`)=`models/gemini-2.5-flash-native-audio-latest`; TTS MODEL (`LEO_TTS_MODEL`)=`gemini-2.5-flash-preview-tts`
- **TOOLS / SOCIAL** group: Social mode=`on`; Weather=`enabled`; Codex search=`enabled`; Reading tool=`enabled` (some show "n/a — no backing key")
- **CONTROL TOKEN (IF REQUIRED)** = password field
The modal is **taller than the viewport and runs off the bottom** — it needs `max-height` + internal scroll and to be responsive like every other panel.

## Training Activity panel (Backlog B11 — replace this)
Header: "TRAINING ACTIVITY · lectures · tutor · quiz · flashcards · grades — live #kai-training · 50 · discord". Body is **just a vertical list of bare lines**: "TRAINING 1:33:22 AM", "TRAINING 1:34:58 AM", "TRAINING 1:37:11 AM" … nothing but a label + timestamp. Bottom = a "Message the tutor (posts into #kai-training)…" text box + Send. **This is the wasted space the owner wants replaced by the animated classroom.**

## The CLASSROOM reference photo (the target look for B11)
A real lecture-hall photo, shot from the **back-middle, slightly elevated**:
- Rows of empty **wooden tiered desks** descending toward the front.
- Tall **windows with vertical blinds** down both side walls; a **ceiling-mounted projector**.
- Front wall: a **projector screen with slides** on the left, a **whiteboard covered in equations** center.
- A **female teacher** standing at the front demonstrating; a **second person seated at a side desk with a laptop** (assistant/co-teacher).
- **One lone student in a blue hoodie**, seated mid-room, facing front.
**Map to KAI:** KAI = the lone student; teacher(s) at the front; whiteboard + projector; fixed camera from the back-middle. Build it 8-bit/stylized, animate it in sync with the real pipeline phases (teachers arrive just before 3am, KAI enters ~3:05, listens during lectures, takes notes, "thinks"/writes during reasoning, quiz/flashcard beats), subtitles at the bottom (speaker name + line from the real lecture/quiz text), empty room when idle. Requires `overnight_pipeline.py` to emit phase/event signals the dashboard can subscribe to.

---

## Net guidance for Claude Code
- The dashboard is **good and stays** — apply the backlog fixes surgically; do not rewrite.
- "Boxy / not smooth" is mostly about the **3D KAIVERSE**, which is moving **native (Rust/wgpu)** for smoothness + geometry the browser can't hit. Keep the browser 3D as the in-dashboard view; the heavy smooth version is the `.exe`.
- The dashboard loads at `http://localhost:3001/` — and Backlog A9 wants real per-view URLs (hash routing) so views/popups are deep-linkable.
