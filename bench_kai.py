#!/usr/bin/env python3
r"""
bench_kai.py - performance + vitals + POWER-DRAW benchmark for the CURRENT KAI engine.

The spiritual successor to your old KAI v29.1 bench, updated for the live Rust engine
(HTTP on 127.0.0.1:3334). Measures retrieval + generation latency, throughput, the
brain's vitals (phi_g / chi / cells / synapses / tick rate), RAM, and POWER DRAW
during load. Writes a Markdown report you can paste straight into the Codex.

PREREQ: the engine must be running.  Either `.\Start-KAI.ps1` (full system) or just
the engine:  `.\target\release\kai.exe --oracle`  (give it a minute to warm up).

Run:   python C:\KAI\bench_kai.py
       python C:\KAI\bench_kai.py --queries 100 --gen 8

POWER NOTE: true system power draw is read from the BATTERY discharge rate, so for a
real wattage number, run this on a LAPTOP that is UNPLUGGED. On AC power the battery
isn't discharging (reads 0); it then falls back to GPU power (nvidia-smi) + CPU%/RAM.
"""
import argparse, json, statistics, subprocess, threading, time, urllib.request
from datetime import datetime, timezone

ENGINE = "http://127.0.0.1:3334"

# Representative probes (echo the old bench's dimensions: facts, reasoning, identity, KAI-internal).
QUERIES = [
    "what is the lattice", "how does memory work", "resonance and emergence",
    "who are you", "what is RSHL", "ternary weights", "the drive system",
    "contradiction and coherence", "how do synapses form", "what is phi",
]
GEN_PROMPTS = [
    "In one sentence, what are you?",
    "Explain resonance simply.",
    "What did we talk about?",
    "How do you store a memory?",
    "What makes you different from a chatbot?",
]

def http(path, payload=None, timeout=30):
    url = ENGINE + path
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data,
            headers={"Content-Type": "application/json"}, method="POST" if data else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))

def ps(cmd):
    try:
        return subprocess.run(["powershell", "-NoProfile", "-Command", cmd],
                              capture_output=True, text=True, timeout=8).stdout.strip()
    except Exception:
        return ""

def sample_power():
    """Return (battery_watts_or_None, gpu_watts_or_None, kai_ram_mb)."""
    bat = None
    out = ps("(Get-CimInstance -Namespace root\\wmi -ClassName BatteryStatus -EA SilentlyContinue | "
             "Select-Object -First 1 -ExpandProperty DischargeRate)")
    try:
        mw = float(out)
        if mw > 0: bat = mw / 1000.0  # mW -> W
    except Exception:
        pass
    gpu = None
    try:
        g = subprocess.run(["nvidia-smi", "--query-gpu=power.draw", "--format=csv,noheader,nounits"],
                           capture_output=True, text=True, timeout=6).stdout.strip().splitlines()
        if g: gpu = float(g[0])
    except Exception:
        pass
    ram = 0.0
    try:
        tl = subprocess.run(["tasklist", "/FI", "IMAGENAME eq kai.exe", "/FO", "CSV", "/NH"],
                           capture_output=True, text=True, timeout=8).stdout
        import re
        for line in tl.splitlines():
            m = re.search(r'"([\d,]+)\s*K"', line)
            if m: ram += int(m.group(1).replace(",", "")) / 1024.0
    except Exception:
        pass
    return bat, gpu, ram

class PowerMonitor(threading.Thread):
    def __init__(self, interval=1.0):
        super().__init__(daemon=True)
        self.interval = interval; self.stop = False
        self.bat, self.gpu, self.ram = [], [], []
    def run(self):
        while not self.stop:
            b, g, r = sample_power()
            if b is not None: self.bat.append(b)
            if g is not None: self.gpu.append(g)
            if r: self.ram.append(r)
            time.sleep(self.interval)

def pct(xs, p):
    if not xs: return 0.0
    xs = sorted(xs); k = (len(xs) - 1) * p / 100.0
    f = int(k); return xs[f] if f + 1 >= len(xs) else xs[f] + (xs[f+1] - xs[f]) * (k - f)

def avg(xs): return sum(xs)/len(xs) if xs else 0.0

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--queries", type=int, default=50)
    ap.add_argument("--gen", type=int, default=5)
    ap.add_argument("--out", default=r"C:\KAI\bench_kai_report.md")
    args = ap.parse_args()

    # 0. engine reachable?
    try:
        s0 = http("/api/session", timeout=5)
    except Exception as e:
        print(f"ENGINE NOT REACHABLE on {ENGINE} ({e}).")
        print(r"Start it first:  .\target\release\kai.exe --oracle   (wait for warmup), then re-run.")
        return

    def vit(s):
        return {k: s.get(k) for k in ("phi_g", "chi", "rho", "cells", "synapses", "tick",
                                      "coherence", "stability", "mood")}
    print("Engine up. Sampling baseline power for 5s...")
    mon = PowerMonitor(); mon.start()
    time.sleep(5)
    base_bat, base_gpu = avg(mon.bat), avg(mon.gpu)
    mon.bat.clear(); mon.gpu.clear(); mon.ram.clear()

    # 1. retrieval latency
    print(f"Running {args.queries} retrieval queries...")
    q_lat = []
    for i in range(args.queries):
        q = QUERIES[i % len(QUERIES)]
        t = time.perf_counter()
        try: http("/api/rshl/query", {"query": q, "n": 8}, timeout=20)
        except Exception: pass
        q_lat.append((time.perf_counter() - t) * 1000.0)
    q_total_s = sum(q_lat) / 1000.0

    # 2. generation latency (oracle-turn)
    print(f"Running {args.gen} generation turns...")
    g_lat, g_samples = [], []
    for i in range(args.gen):
        p = GEN_PROMPTS[i % len(GEN_PROMPTS)]
        t = time.perf_counter()
        reply = ""
        try:
            r = http("/api/oracle-turn", {"text": p, "speaker": "bench"}, timeout=60)
            reply = (r.get("reply") or r.get("response") or r.get("text") or "")[:120] if isinstance(r, dict) else str(r)[:120]
        except Exception as e:
            reply = f"(error: {e})"
        g_lat.append((time.perf_counter() - t) * 1000.0)
        g_samples.append((p, reply))

    mon.stop = True; time.sleep(1.2)
    s1 = http("/api/session", timeout=5)

    # 3. compute
    load_bat, load_gpu, load_ram = avg(mon.bat), avg(mon.gpu), avg(mon.ram)
    tick_rate = None
    try:
        dt = (s1.get("tick", 0) - s0.get("tick", 0))
        tick_rate = dt  # ticks during the whole run
    except Exception: pass

    L = []
    L.append(f"# KAI Engine Benchmark - {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} (recorded {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')})")
    L.append("")
    L.append("## Latency")
    L.append(f"- Retrieval `/api/rshl/query` ({args.queries} runs): mean **{avg(q_lat):.1f} ms**, "
             f"p50 {pct(q_lat,50):.1f}, p95 {pct(q_lat,95):.1f}, p99 {pct(q_lat,99):.1f} ms")
    L.append(f"- Throughput: **{args.queries/q_total_s:.1f} queries/sec**" if q_total_s else "- Throughput: n/a")
    L.append(f"- Generation `/api/oracle-turn` ({args.gen} runs): mean **{avg(g_lat):.0f} ms**, "
             f"p50 {pct(g_lat,50):.0f}, p95 {pct(g_lat,95):.0f} ms")
    L.append("")
    L.append("## Brain vitals (before -> after)")
    for k in ("phi_g", "chi", "rho", "coherence", "stability", "cells", "synapses", "tick"):
        a, b = s0.get(k), s1.get(k)
        if a is not None or b is not None:
            L.append(f"- {k}: {a} -> {b}")
    if tick_rate is not None:
        L.append(f"- ticks during run: {tick_rate}")
    L.append("")
    L.append("## Resources + POWER DRAW (during load)")
    L.append(f"- KAI RAM (working set): **{load_ram:,.0f} MB**")
    if load_bat:
        L.append(f"- System power (battery discharge): **{load_bat:.1f} W** during load "
                 f"(idle baseline {base_bat:.1f} W -> KAI delta ~**{max(0,load_bat-base_bat):.1f} W**)")
    else:
        L.append("- System power (battery): not on battery (plugged in) - unplug the laptop for a real wattage number.")
    if load_gpu:
        L.append(f"- GPU power: **{load_gpu:.1f} W** during load (idle {base_gpu:.1f} W -> delta ~{max(0,load_gpu-base_gpu):.1f} W)")
    else:
        L.append("- GPU power: no NVIDIA GPU detected (nvidia-smi). CPU work only.")
    L.append("")
    L.append("## Generation samples")
    for p, r in g_samples:
        L.append(f"- Q: {p}\n  A: {r}")
    L.append("")
    L.append("*Bench: bench_kai.py. Power from battery discharge rate (real system watts when unplugged) "
             "+ nvidia-smi GPU. Compare against your old KAI v29.1 bench in C:\\Kai 2.0.*")

    report = "\n".join(L)
    print("\n" + report + "\n")
    try:
        with open(args.out, "w", encoding="utf-8") as f: f.write(report)
        print(f"Saved: {args.out}  (paste it into the Codex changelog).")
    except Exception as e:
        print(f"(could not save report: {e})")

if __name__ == "__main__":
    main()
