#!/usr/bin/env python3
r"""
KAI Healthcheck — v9.8.0 verification data collector.

Run:   python C:\KAI\kai_healthcheck.py

Collects everything needed to verify the v9.8.0 engine-RAM / governor work and
decide next steps, WITHOUT changing anything (read-only). Prints a clean report
to the screen AND writes it to  C:\KAI\kai_healthcheck_report.txt  so you can
paste it back. Every check is wrapped so one failure can't abort the run.
"""
import os, sys, re, json, socket, subprocess, ctypes, time
from datetime import datetime, timezone

KAI_DIR = r"C:\KAI"
ENGINE_PORT = 3334
OLLAMA_PORT = 11434
STATE_FILE  = r"C:\KAI\tools\oracle-discord\state\self_optimize_state.json"

_buf = []
def out(line=""):
    print(line)
    _buf.append(str(line))

def section(title):
    out("")
    out("=" * 70)
    out(f"  {title}")
    out("=" * 70)

def run(cmd, timeout=15):
    """Run a command, return stdout (str) or '' on any error."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                           shell=isinstance(cmd, str))
        return (r.stdout or "") + (("\n[stderr] " + r.stderr) if r.returncode and r.stderr else "")
    except Exception as e:
        return f"[error running {cmd!r}: {e}]"

def file_info(path):
    try:
        st = os.stat(path)
        mb = st.st_size / (1024 * 1024)
        mt = datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S")
        return f"{path}  |  {mb:,.1f} MB  |  modified {mt}", st.st_mtime
    except Exception as e:
        return f"{path}  |  [not found: {e}]", None

# ── 0. Header ───────────────────────────────────────────────────────────────────
section("KAI HEALTHCHECK — system verification (version map below)")
out(f"Run at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} local  "
    f"({datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')} UTC)")
out(f"Python: {sys.version.split()[0]}   Host: {os.environ.get('COMPUTERNAME','?')}")

# ── 1. Build / version ──────────────────────────────────────────────────────────
section("1. BUILD / VERSION  (your version map — which number is which)")
# THE authoritative system version = the Codex title page.
try:
    with open(os.path.join(KAI_DIR, "The KAI Codex.md"), "r", encoding="utf-8", errors="replace") as f:
        ch = f.read(4000)
    cv = (re.search(r'\*\*Version\*\*\s*\|\s*\*\*([^|*]+?)\*\*', ch) or [None, "??"])[1]
    cu = (re.search(r'\*\*Last Updated\*\*\s*\|\s*([^|]+?)\s*\|', ch) or [None, "??"])[1]
    out(f"SYSTEM version (Codex, authoritative): {cv.strip()}")
    out(f"  last updated: {cu.strip()}")
except Exception as e:
    out(f"Codex version       : [error {e}]")
# Cargo.toml version (engine binary stamp — only moves on a Rust change/rebuild)
try:
    with open(os.path.join(KAI_DIR, "Cargo.toml"), "r", encoding="utf-8", errors="replace") as f:
        head = f.read(2000)
    m = re.search(r'^\s*version\s*=\s*"([^"]+)"', head, re.M)
    out(f"ENGINE binary (Cargo.toml): {m.group(1) if m else '??'}   (compile stamp; lags Codex if only Node/config changed — that's normal)")
except Exception as e:
    out(f"Cargo.toml          : [error {e}]")
# Discord fleet npm version (cosmetic, NOT the system version)
try:
    with open(os.path.join(KAI_DIR, "tools", "oracle-discord", "package.json"), "r", encoding="utf-8", errors="replace") as f:
        pj = f.read(2000)
    pv = (re.search(r'"version"\s*:\s*"([^"]+)"', pj) or [None, "??"])[1]
    out(f"Discord fleet (package.json): {pv}   (npm number only — ignore for 'what version is the system')")
except Exception:
    pass

# kai.exe locations + mtime vs the source files I edited (build must be NEWER than source)
exe_candidates = [os.path.join(KAI_DIR, "kai.exe"),
                  os.path.join(KAI_DIR, "target", "release", "kai.exe")]
newest_exe_mt = None
for p in exe_candidates:
    info, mt = file_info(p)
    out("kai.exe             : " + info)
    if mt and (newest_exe_mt is None or mt > newest_exe_mt):
        newest_exe_mt = mt
src_files = [r"src\persistence.rs", r"src\bridge\oracle_server.rs", r"src\core\synapse.rs"]
out("")
out("Source files I patched (build must be NEWER than these):")
for rel in src_files:
    info, mt = file_info(os.path.join(KAI_DIR, rel))
    flag = ""
    if mt and newest_exe_mt:
        flag = "   <-- OK build is newer" if newest_exe_mt >= mt else "   <-- WARNING: exe OLDER than source (rebuild needed!)"
    out("  " + info + flag)

# ── 2. Patch presence in source (confirms what the build compiled) ───────────────
section("2. PATCH PRESENCE IN SOURCE  (what this build contains)")
def grep_file(rel, pattern):
    try:
        with open(os.path.join(KAI_DIR, rel), "r", encoding="utf-8", errors="replace") as f:
            return sum(1 for ln in f if re.search(pattern, ln))
    except Exception as e:
        return f"[error {e}]"
checks = [
    (r"src\persistence.rs",            r"pub fn serialize_brain",      "streaming serialize_brain()"),
    (r"src\persistence.rs",            r"pub fn write_brain_streamed", "streaming write_brain_streamed()"),
    (r"src\bridge\oracle_server.rs",   r"KAI_STREAMING_SAVE",          "autosave flag gate"),
    (r"src\core\synapse.rs",           r"LATENT_TRACES_CAP",           "latent_traces bound"),
]
for rel, pat, label in checks:
    n = grep_file(rel, pat)
    out(f"  {'OK ' if (isinstance(n,int) and n>0) else 'MISSING'}  {label:32s}  ({n} match)  [{rel}]")

# ── 3. System memory (the headline problem) ──────────────────────────────────────
section("3. SYSTEM MEMORY")
class MEMORYSTATUSEX(ctypes.Structure):
    _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
try:
    ms = MEMORYSTATUSEX(); ms.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms))
    gb = 1024**3
    out(f"RAM total : {ms.ullTotalPhys/gb:6.1f} GB")
    out(f"RAM in use: {ms.dwMemoryLoad:6d} %   (free {ms.ullAvailPhys/gb:.1f} GB)")
except Exception as e:
    out(f"[memory query failed: {e}]")

# ── 4. Per-process RAM (is the engine still ~20GB?) ──────────────────────────────
section("4. KAI PROCESS RAM  (tasklist working sets)")
def proc_rows(image):
    out_txt = run(["tasklist", "/FI", f"IMAGENAME eq {image}", "/FO", "CSV", "/NH"])
    rows = []
    for line in out_txt.splitlines():
        parts = [p.strip().strip('"') for p in line.split('","')]
        if len(parts) >= 5 and parts[0].lower().startswith(image.split('.')[0].lower()):
            pid = re.sub(r"\D", "", parts[1]); mb = re.sub(r"[^\d]", "", parts[-1])
            if pid and mb:
                rows.append((parts[0], pid, int(mb)/1024.0))
    return rows
grand = 0.0
for image in ["kai.exe", "node.exe", "python.exe", "ollama.exe"]:
    rows = proc_rows(image)
    if not rows:
        out(f"{image:12s}: (none running)"); continue
    sub = sum(r[2] for r in rows)
    grand += sub
    out(f"{image:12s}: {len(rows)} proc, {sub:8,.0f} MB total")
    for name, pid, mb in sorted(rows, key=lambda r: -r[2])[:6]:
        flag = "   <<< the big one" if (image=="kai.exe" and mb > 12000) else ""
        out(f"     pid {pid:>7}  {mb:8,.0f} MB{flag}")
out(f"\nKAI-stack RSS total: {grand:,.0f} MB")

# ── 4b. Single-engine + file-system duplicate check ──────────────────────────────
section("4b. SINGLE-ENGINE + FILE-SYSTEM DUP CHECK")
eng = proc_rows("kai.exe")
verdict = "OK — single engine" if len(eng) <= 1 else f"WARNING — {len(eng)} ENGINES RUNNING (should be 1)"
out(f"Running kai.exe instances: {len(eng)}   -> {verdict}")
if len(eng) > 1:
    for name, pid, mb in eng:
        out(f"     pid {pid:>7}  {mb:,.0f} MB   <-- duplicate engine; keep one, kill the rest")

# One walk of C:\KAI: collect every kai.exe binary AND every big (>200MB) file.
from collections import Counter
kai_bins, big = [], []
SKIP = {".git", "node_modules", "$RECYCLE.BIN"}
for root, dirs, files in os.walk(KAI_DIR):
    dirs[:] = [d for d in dirs if d not in SKIP]
    for fn in files:
        p = os.path.join(root, fn)
        try: sz = os.path.getsize(p)
        except Exception: continue
        if fn.lower() == "kai.exe":
            try: mt = os.path.getmtime(p)
            except Exception: mt = 0
            kai_bins.append((p, sz, mt))
        if sz > 200 * 1024 * 1024:
            big.append((sz, p))

live = os.path.normcase(os.path.join(KAI_DIR, "target", "release", "kai.exe"))
out("\nkai.exe binaries on disk (should ideally be just the live one):")
for p, sz, mt in sorted(kai_bins, key=lambda x: -x[1]):
    if os.path.normcase(p) == live:
        tag = "   <-- LIVE (every launcher uses this)"
    else:
        tag = "   <-- extra/stale copy — safe to delete to avoid confusion"
    mts = datetime.fromtimestamp(mt).strftime("%Y-%m-%d %H:%M") if mt else "?"
    out(f"  {sz/1e6:6.1f} MB  {mts}  {p}{tag}")
if len(kai_bins) <= 1:
    out("  (only one kai.exe — clean)")

big.sort(reverse=True)
size_counts = Counter(s for s, _ in big)
out("\nLargest files >200MB (identical sizes flagged as likely duplicates):")
if not big:
    out("  (none)")
for s, p in big[:15]:
    dup = "   <-- DUP? identical size to another file" if size_counts[s] > 1 else ""
    out(f"  {s/1024**3:5.2f} GB  {p}{dup}")

# ── 5. Env flags (do the new switches reach the right processes?) ─────────────────
section("5. ENV FLAGS  (must be set where the engine/supervisor launch)")
flags = ["KAI_STREAMING_SAVE", "KAI_ENGINE_RSS_RESTART_MB", "KAI_ENGINE_RSS_COOLDOWN_S",
         "KAI_FORCE_LIMITED", "LEO_THINK_DELAY_MS", "LEO_THINK_VOL", "KAI_PROC_CACHE_MS"]
out("As seen by THIS script's process:")
for k in flags:
    out(f"  {k:28s} = {os.environ.get(k, '(unset)')}")
out("\nPersistent USER env (reg query HKCU\\Environment):")
reg = run(["reg", "query", "HKCU\\Environment"])
for k in flags:
    m = re.search(rf"{k}\s+REG\w*\s+(.+)", reg)
    out(f"  {k:28s} = {m.group(1).strip() if m else '(not persisted)'}")

# ── 6. Ports / services ──────────────────────────────────────────────────────────
section("6. PORTS  (engine 3334 / ollama 11434)")
def port_state(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1.0):
            pass
    except Exception:
        return "DEAD (refused)"
    try:
        import urllib.request
        urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1.0); return "OK (serving)"
    except Exception as e:
        return f"BUSY/other ({type(e).__name__})"
out(f"engine    :{ENGINE_PORT}  -> {port_state(ENGINE_PORT)}")
out(f"ollama    :{OLLAMA_PORT} -> {port_state(OLLAMA_PORT)}")
out(f"dashboard :3001  -> {port_state(3001)}   (the Oracle Roundtable web UI — open http://localhost:3001)")
out(f"openjarvis:8080  -> {port_state(8080)}   (fused brain; optional, warms up slowly)")

# ── 6b. Engine vitals + native-brain (answers WITHOUT Ollama) check ───────────────
section("6b. ENGINE VITALS + NATIVE-BRAIN (no-Ollama) CHECK")
import urllib.request
try:
    with urllib.request.urlopen(f"http://127.0.0.1:{ENGINE_PORT}/api/session", timeout=4) as r:
        data = json.loads(r.read().decode("utf-8", "replace"))
    out(f"GET /api/session -> 200 OK")
    for k in ("tick", "cells", "synapses", "cellCount", "synapseCount", "mode", "status", "round"):
        if k in data:
            out(f"   {k}: {data[k]}")
    v = data.get("vitals") or {}
    if isinstance(v, dict) and v:
        out("   vitals: " + ", ".join(f"{k}={v[k]}" for k in list(v)[:10]))
except Exception as e:
    out(f"GET /api/session -> NOT reachable ({type(e).__name__})  — engine likely not running yet")

# Native-vs-Ollama from the engine's own log (definitive markers).
logs = [os.path.join(KAI_DIR, "scratch", "oracle-discord-kai.out.log"),
        os.path.join(KAI_DIR, "scratch", "oracle-discord-kai.err.log")]
txt = ""
for lp in logs:
    try:
        with open(lp, "r", encoding="utf-8", errors="replace") as f:
            f.seek(0, 2); size = f.tell(); f.seek(max(0, size - 300000))  # last ~300 KB
            txt += f.read()
    except Exception:
        pass
fused   = txt.count("Native transformer fused successfully")
booting = txt.count("Booting native transformer")
ndecode = txt.count("[BitNetBrain] native_decode")
ollama  = txt.count("no response from ollama") + txt.count("calling ollama") + txt.lower().count("ollama error")
crashes = txt.count("panicked") + txt.count("memory allocation of") + txt.count("0xc0000409")
out("\nNative-brain evidence in engine log (scratch/oracle-discord-kai.*.log):")
out(f"   'Native transformer fused successfully' : {fused}   (BitNet brain mounted at startup)")
out(f"   '[BitNetBrain] native_decode' events    : {ndecode}   (KAI generated via native BitNet — NOT Ollama)")
out(f"   ollama call/error markers               : {ollama}")
out(f"   crash markers (panic/alloc-fail)        : {crashes}")
if ndecode > 0:
    out("   => VERDICT: NATIVE ACTIVE — KAI is answering through his own BitNet brain, no Ollama dependency. ✓")
elif fused > 0 or booting > 0:
    out("   => VERDICT: native brain MOUNTED but hasn't generated yet — ask KAI something in Discord, then re-run this.")
else:
    out("   => VERDICT: no native evidence yet (engine off, or log rotated). Start it and ask KAI a question, then re-run.")

# ── 7. Governor state file (the fleet's own view) ────────────────────────────────
section("7. GOVERNOR STATE FILE")
try:
    age = time.time() - os.path.getmtime(STATE_FILE)
    out(f"{STATE_FILE}\n  (updated {age:.0f}s ago)")
    with open(STATE_FILE, "r", encoding="utf-8", errors="replace") as f:
        s = json.load(f)
    out(f"  cpu={s.get('cpuLoad')}%  gpu={s.get('gpuLoad')}%  mem={s.get('memLoad'):.0f}%  "
        f"total={s.get('totalMemMB')}MB free={s.get('freeMemMB')}MB")
    pj = s.get("project", {})
    out(f"  KAI fleet: {pj.get('processCount')} procs, {pj.get('memoryMB')} MB, tier={s.get('tier')}")
    rows = s.get("processRows") or s.get("topOffenders") or []
    out("  top processes:")
    for p in sorted(rows, key=lambda r: -(r.get('workingSetMB') or 0))[:8]:
        out(f"     {(p.get('workingSetMB') or 0):8.0f} MB  {p.get('role') or p.get('name')}")
except Exception as e:
    out(f"  [could not read state file: {e}]")

# ── 8. Disk ──────────────────────────────────────────────────────────────────────
section("8. DISK")
def folder_mb(path):
    total = 0
    try:
        for root, _, files in os.walk(path):
            for fn in files:
                try: total += os.path.getsize(os.path.join(root, fn))
                except Exception: pass
    except Exception:
        return None
    return total / (1024*1024)
try:
    fb = ctypes.c_ulonglong(0); tb = ctypes.c_ulonglong(0)
    ctypes.windll.kernel32.GetDiskFreeSpaceExW(ctypes.c_wchar_p("C:\\"), None,
                                               ctypes.byref(tb), ctypes.byref(fb))
    out(f"C: drive : {tb.value/1024**3:.0f} GB total, {fb.value/1024**3:.0f} GB free "
        f"({100*(1-fb.value/tb.value):.0f}% used)")
except Exception as e:
    out(f"C: drive : [error {e}]")
for label, path in [("data\\ folder (live)", r"C:\KAI\data"),
                    ("target\\debug (delete - build cache)", r"C:\KAI\target\debug"),
                    ("offload folder (move/delete)", r"C:\KAI\_DUPLICATE_BACKUPS_move_to_external")]:
    mb = folder_mb(path)
    out(f"{label:36s}: {mb/1024:,.1f} GB" if mb is not None else f"{label:36s}: (gone — good)")
# PROTOCOL backups live OUTSIDE C:\KAI (backup-kai.ps1 -> C:\KAI_Secure_Backups)
_sbk_label = "C:\\KAI_Secure_Backups (protocol)"
sbk = folder_mb(r"C:\KAI_Secure_Backups")
if sbk is not None:
    out(f"{_sbk_label:36s}: {sbk/1024:,.1f} GB   (your REAL backups - prune with backup-kai.ps1 -PruneOnly)")
else:
    out(f"{_sbk_label:36s}: (none yet - run tools\\backup-kai.ps1 to take one)")

# ── 9. Assets / supervisor ───────────────────────────────────────────────────────
section("9. THINKING SOUND + SUPERVISOR")
for p in [r"C:\KAI\tools\oracle-discord\assets\sounds\thinking.wav",
          r"C:\KAI\tools\oracle-discord\assets\sounds\thinking.mp3"]:
    info, _ = file_info(p); out("  " + info)
sup = run('wmic process where "name=\'python.exe\'" get CommandLine /format:list')
running = "kai_supervisor" in sup
_sup_msg = "YES" if running else r"NO  (start it:  python C:\KAI\kai_supervisor.py)"
out("\n  kai_supervisor.py running: " + _sup_msg)

# ── Write report ─────────────────────────────────────────────────────────────────
section("DONE")
report = os.path.join(KAI_DIR, "kai_healthcheck_report.txt")
try:
    with open(report, "w", encoding="utf-8") as f:
        f.write("\n".join(_buf))
    out(f"Report saved to: {report}")
    out("Paste that file's contents back to continue.")
except Exception as e:
    out(f"[could not write report file: {e}] — just copy the text above.")
