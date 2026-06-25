#!/usr/bin/env python3
"""
KAI Sovereign Supervisor — self-healing watchdog.

The system shouldn't need a human to press "reset." This watches KAI's critical
local services and AUTO-RECOVERS them the moment they go down, instead of just
alerting you:

  * Ollama  (127.0.0.1:11434) — KAI's local language mouth + teacher fallback.
        If the port refuses connections, it runs `ollama serve` itself.
  * Engine  (127.0.0.1:3334)  — kai.exe --oracle-server (the lattice/brain API).
        If the port is truly DEAD (connection refused), it relaunches kai.exe.
        If the port is just BUSY (accepts then closes = mid index-rebuild), it
        LEAVES IT ALONE — restarting a warming-up engine would only hurt.

Safety: per-service cooldowns prevent restart storms; it never restarts a service
that's merely busy; it reports every self-heal to Discord so you can see what it
did while you were away.

Run once and leave it:   python C:\\KAI\\kai_supervisor.py
"""
import socket, subprocess, time, json, os, re, urllib.request

# ── Config ────────────────────────────────────────────────────────────────────
KAI_DIR        = r"C:\KAI"
# IMPORTANT: the live binary is target\release\kai.exe (what cargo builds and what
# sovereign-start.ps1 / phoenix-watchdog.ps1 / ingest_master.ps1 all launch). The
# old C:\KAI\kai.exe is a STALE copy — pointing here meant a supervisor relaunch
# could silently downgrade to an out-of-date build. Prefer the fresh build; fall
# back to the legacy path only if the release binary is missing.
ENGINE_EXE     = (r"C:\KAI\target\release\kai.exe"
                  if os.path.exists(r"C:\KAI\target\release\kai.exe")
                  else r"C:\KAI\kai.exe")
ENGINE_ARGS    = ["--oracle-server"]
ENGINE_PORT    = 3334
OLLAMA_PORT    = 11434
CHECK_EVERY    = 45          # seconds between sweeps (was 20 — gentler on a busy PC)
COOLDOWN       = 180         # min seconds between two restarts of the SAME service
ENGINE_GRACE   = 90          # after launching the engine, don't judge it for this long (warmup)
DEAD_STREAK    = 2           # require N consecutive 'dead' reads before restarting (ignores transient blips)
DISCORD_WEBHOOK = ""         # optional: paste a webhook URL to get self-heal notices
# ── OVERNIGHT BITNET INGEST LOCK ─────────────────────────────────────────────
# The overnight BitNet ingest+weave (overnight_pipeline.py) needs the engine on
# :3334 STABLE for the whole 3 AM window. While this lockfile exists, the RAM
# recycler below MUST NOT kill/restart the engine mid-weave (that would abort the
# distillation and drop the lattice writes). The ingest creates this file when it
# starts and removes it when it stops for consolidation. Override path to match
# overnight_pipeline's KAI_INGEST_LOCKFILE if you change it there.
INGEST_LOCKFILE = os.environ.get("KAI_INGEST_LOCKFILE", r"C:\KAI\data\overnight_ingest.lock")

# ── Engine memory ceiling (RAM relief, no Rust rebuild needed) ──────────────────
# The engine deep-clones the WHOLE Universe every 180s to autosave, which roughly
# doubles peak RAM; Windows keeps those freed pages, so RSS settles near the peak.
# Since the engine autosaves every 180s with ATOMIC, corruption-proof writes, we can
# safely recycle it when it crosses a ceiling: a restart reloads the persisted brain
# at its compact size. Worst case a HARD kill loses <=180s of training (never
# corrupts — atomic tmp+rename). Set KAI_ENGINE_RSS_RESTART_MB=0 to DISABLE this.
# Keep the engine UNDER total RAM so the OS + Discord fleet + Ollama don't get
# swapped to disk (swapping is what stutters Leo's audio). AUTO-SIZED to ~58% of
# this machine's real RAM: 32GB -> ~18GB, 16GB -> ~9GB. A recycle reloads the brain
# at its compact size, atomic-safe (loses <=180s). Override with KAI_ENGINE_RSS_RESTART_MB.
def _total_ram_mb():
    """Total physical RAM in MB via stdlib ctypes (no pip deps). 0 if unknown."""
    try:
        import ctypes
        class _MS(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
        m = _MS(); m.dwLength = ctypes.sizeof(_MS)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
        return int(m.ullTotalPhys / (1024 * 1024))
    except Exception:
        return 0
def _auto_ceiling_mb():
    total = _total_ram_mb()
    if total <= 0:
        return 9000                       # unknown -> safe default
    return max(8000, int(total * 0.58))   # ~58% of real RAM, never below 8 GB
RESTART_RSS_MB  = int(os.environ.get("KAI_ENGINE_RSS_RESTART_MB") or _auto_ceiling_mb())  # restart kai.exe above this working-set
RSS_COOLDOWN    = int(os.environ.get("KAI_ENGINE_RSS_COOLDOWN_S", "900"))    # min seconds between RAM-triggered restarts

# ── RAM-relief env FORCED onto every engine launch ──────────────────────────────
# The whole reason the supervisor recycles the engine is RAM. But a recycle only
# helps lastingly if the relaunched engine itself runs with the RAM-relief flags.
# launch() inherits this process's env, so if the supervisor was started WITHOUT
# those flags (e.g. by hand, not via Start-KAI), a recycle would bring the engine
# back in the OLD high-RAM mode and immediately balloon again. So we set them here
# explicitly: streaming autosave (no whole-Universe clone) + a Rayon thread cap.
# We only DEFAULT them — anything already set in the environment wins, so Start-KAI
# or a manual override is still respected.
def _engine_env():
    env = dict(os.environ)
    env.setdefault("KAI_STREAMING_SAVE", "1")   # stream the save instead of cloning the Universe (kills the 2x spike)
    env.setdefault("RAYON_NUM_THREADS", "6")    # cap brain threads to physical cores (less peak working set)
    env.setdefault("RUST_BACKTRACE", "1")
    return env

_last_restart = {"ollama": 0.0, "engine": 0.0}
_dead_streak  = {"ollama": 0,   "engine": 0}    # consecutive dead reads per service
_engine_launched_at = 0.0
_last_rss_restart   = 0.0

def notify(title, msg):
    print(f"  [Supervisor] {title}: {msg}")
    if not DISCORD_WEBHOOK:
        return
    try:
        body = json.dumps({"embeds": [{"title": title, "description": msg, "color": 15844367}]}).encode()
        req = urllib.request.Request(DISCORD_WEBHOOK, data=body,
                                     headers={"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=10)
    except Exception:
        pass

def port_state(port, connect_timeout=0.4, http_timeout=0.8):
    """Returns 'dead' (refused), 'busy' (accepts then closes / no HTTP), or 'ok'.
    Short timeouts: a healthy local service answers in <50ms, so we don't need to
    block for seconds per probe. The only cost of a tight timeout is a rare false
    'busy' on a genuinely slow warmup — which we IGNORE anyway (busy = leave alone)."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=connect_timeout):
            pass
    except (ConnectionRefusedError, OSError):
        return "dead"
    # TCP accepted — probe HTTP to tell "ok" from "busy/warming up".
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=http_timeout)
        return "ok"
    except urllib.error.HTTPError:
        return "ok"        # any HTTP status means it's serving
    except Exception:
        return "busy"      # connected but no clean HTTP yet — likely warming up

def can_restart(name):
    return (time.time() - _last_restart[name]) > COOLDOWN

def launch(cmd, cwd=None, env=None):
    flags = 0
    if os.name == "nt":
        flags = subprocess.CREATE_NEW_CONSOLE  # detached window so it survives this script
    return subprocess.Popen(cmd, cwd=cwd, creationflags=flags, env=env)

# ── Recovery logic ────────────────────────────────────────────────────────────
def heal_ollama():
    state = port_state(OLLAMA_PORT)
    _dead_streak["ollama"] = _dead_streak["ollama"] + 1 if state == "dead" else 0
    if _dead_streak["ollama"] >= DEAD_STREAK and can_restart("ollama"):
        notify("Self-heal: Ollama was down", "KAI's local language backend (11434) refused connections — starting `ollama serve` automatically.")
        try:
            launch(["ollama", "serve"])
            _last_restart["ollama"] = time.time()
        except FileNotFoundError:
            notify("Ollama not installed?", "`ollama` not found on PATH — can't auto-start it. Install Ollama or set TEACHER to cloud.")
        _dead_streak["ollama"] = 0

def heal_engine():
    global _engine_launched_at
    # Respect the warmup grace window after we (re)launch it.
    if (time.time() - _engine_launched_at) < ENGINE_GRACE:
        return
    state = port_state(ENGINE_PORT)
    _dead_streak["engine"] = _dead_streak["engine"] + 1 if state == "dead" else 0
    if _dead_streak["engine"] >= DEAD_STREAK and can_restart("engine"):
        if not os.path.exists(ENGINE_EXE):
            notify("Engine missing", f"{ENGINE_EXE} not found — can't auto-launch the KAI engine.")
            return
        notify("Self-heal: KAI engine was down", "The lattice API (3334) was refusing connections — relaunching `kai.exe --oracle-server` automatically.")
        launch([ENGINE_EXE] + ENGINE_ARGS, cwd=KAI_DIR, env=_engine_env())
        _last_restart["engine"] = time.time()
        _engine_launched_at = time.time()
        _dead_streak["engine"] = 0
    # state == 'busy' => mid index-rebuild => deliberately do nothing.

# ── Engine RAM relief ───────────────────────────────────────────────────────────
def _engine_rows():
    """Rows for kai.exe via tasklist (built into Windows — no pip deps).
    Returns list of (pid, working_set_mb)."""
    try:
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq kai.exe", "/FO", "CSV", "/NH"],
                             capture_output=True, text=True, timeout=10).stdout or ""
    except Exception:
        return []
    rows = []
    for line in out.splitlines():
        # "kai.exe","12345","Console","1","1,234,567 K"
        parts = [p.strip().strip('"') for p in line.split('","')]
        if len(parts) >= 5 and parts[0].lower().startswith("kai"):
            pid = re.sub(r"\D", "", parts[1])
            mb = re.sub(r"[^\d]", "", parts[-1])  # last col "x,xxx K" -> KB
            if pid and mb:
                rows.append((pid, int(mb) / 1024.0))
    return rows

def heal_engine_memory():
    """If the engine's working set crosses RESTART_RSS_MB, recycle it: graceful kill
    first (give its 180s autosave/shutdown-save a chance), then force any straggler,
    then relaunch. Atomic writes mean a worst-case force-kill loses <=180s, never
    corrupts. Disabled when RESTART_RSS_MB <= 0."""
    global _last_rss_restart, _engine_launched_at
    if RESTART_RSS_MB <= 0:
        return
    # RECONCILE: while the overnight BitNet ingest holds its lock, do NOT recycle the
    # engine for RAM — a mid-weave restart aborts the distillation. The ingest releases
    # the lock when it stops for consolidation, after which normal recycling resumes.
    if os.path.exists(INGEST_LOCKFILE):
        return
    if (time.time() - _engine_launched_at) < ENGINE_GRACE:   # just (re)launched — let it settle
        return
    if (time.time() - _last_rss_restart) < RSS_COOLDOWN:     # don't thrash
        return
    rows = _engine_rows()
    if not rows:
        return
    total_mb = sum(mb for _, mb in rows)
    if total_mb < RESTART_RSS_MB:
        return
    notify("Engine RAM ceiling hit",
           f"kai.exe at {total_mb:.0f} MB (> {RESTART_RSS_MB} MB). Recycling it to release the "
           f"autosave-clone overhead — reloads the persisted brain compact. Loses <=180s of "
           f"training at worst (atomic-safe, no corruption).")
    pids = [pid for pid, _ in rows]
    # 1) graceful: taskkill WITHOUT /F so the engine can run its shutdown-save
    for pid in pids:
        try: subprocess.run(["taskkill", "/PID", pid], capture_output=True, timeout=10)
        except Exception: pass
    # 2) give the graceful save up to ~25s to flush and exit
    for _ in range(25):
        time.sleep(1)
        if not _engine_rows():
            break
    # 3) force any stragglers (still atomic-safe; loses <=180s only)
    for pid, _ in _engine_rows():
        try: subprocess.run(["taskkill", "/F", "/PID", pid], capture_output=True, timeout=10)
        except Exception: pass
    # 4) relaunch WITH the RAM-relief env so the fresh engine doesn't just balloon again
    if os.path.exists(ENGINE_EXE):
        launch([ENGINE_EXE] + ENGINE_ARGS, cwd=KAI_DIR, env=_engine_env())
        _engine_launched_at = time.time()
        _last_restart["engine"] = time.time()
    _last_rss_restart = time.time()

def main():
    print("=" * 60)
    print(" KAI Sovereign Supervisor — self-healing watchdog")
    print(f" Watching Ollama:{OLLAMA_PORT} + Engine:{ENGINE_PORT} every {CHECK_EVERY}s ({DEAD_STREAK} dead reads before a restart).")
    print(" It restarts a DEAD service itself; leaves a BUSY (warming-up) one alone.")
    if RESTART_RSS_MB > 0:
        print(f" Engine RAM ceiling: recycles kai.exe if it exceeds {RESTART_RSS_MB} MB (every {RSS_COOLDOWN}s max).")
    else:
        print(" Engine RAM ceiling: DISABLED (KAI_ENGINE_RSS_RESTART_MB=0).")
    print(" Ctrl+C to stop.")
    print("=" * 60)
    while True:
        try:
            heal_ollama()
            heal_engine()
            heal_engine_memory()
        except Exception as e:
            print(f"  [Supervisor] sweep error (continuing): {e}")
        time.sleep(CHECK_EVERY)

if __name__ == "__main__":
    main()
