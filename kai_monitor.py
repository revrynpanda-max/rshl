r"""
kai_monitor.py — KAI Brain Health Monitor (Live)
=================================================
Background thread handles ALL csv reading + ECG computation.
Main thread only calls set_data() — zero jank, no busy cursor.

Reads  : C:\KAI\data\kai_ticks.csv
Run    : python C:\KAI\kai_monitor.py

Controls:  Q/Esc quit   R hot-reload   F freeze   +/- window width
"""

import sys, os, threading, time
import pandas as pd
import numpy as np
import matplotlib
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import matplotlib.patches as mpatches
import matplotlib.animation as animation
import matplotlib.gridspec as gridspec
from matplotlib.lines import Line2D
from datetime import datetime

matplotlib.rcParams.update({
    "axes.spines.top":   False,
    "axes.spines.right": False,
    "figure.facecolor":  "#050d0d",
})

# ── Config ─────────────────────────────────────────────────────────────────────
CSV_PATH         = r"C:\KAI\data\kai_ticks.csv"
REFRESH_MS       = 250            # screen redraw — 4× per second
BG_INTERVAL      = 0.5           # background worker — checks CSV every 500 ms
WINDOW_MINUTES   = 60
SESSION_GAP_SECS = 60
ECG_WINDOW_SECS  = 90            # heartbeat panel shows last 90 s
ECG_PPS          = 20            # ECG signal points-per-second

SCRIPT_PATH   = os.path.abspath(__file__)
_script_mtime = os.path.getmtime(SCRIPT_PATH) if os.path.exists(SCRIPT_PATH) else 0.0

MOOD_COLORS = {
    "curious":    "#00cfff",
    "engaged":    "#00ff99",
    "conflicted": "#ff4466",
    "uneasy":     "#ffdd44",
    "dormant":    "#777777",
}
MOOD_LABELS = {
    "curious": "CURIOUS", "engaged": "ENGAGED",
    "conflicted": "CONFLICT", "uneasy": "UNEASY", "dormant": "DORMANT",
}
DEFAULT_MOOD_COLOR = "#888888"
MOOD_ALPHA = 0.03

VITALS = [
    ("phi_g",   "#00cfff", "Φg", "emergence",    (0.00, 0.55)),
    ("rho",     "#ff9900", "ρ",  "field density", (0.00, 1.10)),
    ("chi",     "#ff4466", "χ",  "contradiction", (0.00, 0.55)),
    ("valence", "#cc99ff", "V",  "valence",       (-0.50, 0.50)),
    ("tau_r",   "#00ff99", "τR", "spiral factor", (0.45, 1.05)),
]
HB_COLOR = "#39ff14"

THRESHOLDS = {
    "phi_g":   (0.04, 0.40,  0.01, 0.50),
    "rho":     (0.10, 0.80,  0.05, 0.95),
    "chi":     (-99,  0.08,  -99,  0.20),
    "valence": (-0.05, 0.40, -0.20, 0.50),
    "tau_r":   (0.60, 1.00,  0.45, 1.00),
    "tpm":     (5.0,  35.0,  1.0,  40.0),
}

def readout_color(col, val):
    t = THRESHOLDS.get(col)
    if t is None: return "#cccccc"
    g0, g1, w0, w1 = t
    if g0 <= val <= g1: return "#00ff88"
    if w0 <= val <= w1: return "#ffdd44"
    return "#ff4466"

def do_reload():
    plt.close("all")
    os.execv(sys.executable, [sys.executable, SCRIPT_PATH])

# ── Background worker ──────────────────────────────────────────────────────────
# All CSV IO + ECG math lives here. The main thread reads `shared` under a lock.

_lock  = threading.Lock()
shared = {
    "ready":       False,
    "error":       None,
    # vitals
    "t":           [],          # timestamps (win)
    "vitals":      {},          # col -> np array
    "last_vals":   {},          # col -> float
    "x_min":       None,
    "x_max":       None,
    # ECG
    "ecg_t":       [],
    "ecg_sig":     [],
    "last_tpm":    0.0,
    # mood / status
    "cur_mood":    "dormant",
    "spans":       [],
    "breaks":      [],
    # meta
    "tick_lo":     0,
    "tick_hi":     0,
    "n_rows":      0,
    "updated":     "",
}

_state = {
    "window":   WINDOW_MINUTES,
    "frozen":   False,
    "csv_mtime": 0.0,
    "df":        None,
}

# ── Pre-built PQRST template (vectorised, computed once) ──────────────────────
def _build_template(half_pts):
    """Return a normalised PQRST waveform array of length half_pts*10."""
    n = half_pts * 10
    x = np.linspace(-5, 5, n)
    wave  =  0.12 * np.exp(-((x + 2.5)**2) * 3)   # P
    wave += -0.08 * np.exp(-((x + 1.0)**2) * 3)   # Q
    wave +=  1.00 * np.exp(-( x**2        ) * 4)   # R  ← main spike
    wave += -0.25 * np.exp(-((x - 0.5)**2) * 5)   # S
    wave +=  0.18 * np.exp(-((x - 2.5)**2) * 3)   # T
    return wave

def _make_ecg(df, t_now):
    """Build ECG array in background. Vectorised stamp approach — no Python loop per point."""
    t_start = t_now - pd.Timedelta(seconds=ECG_WINDOW_SECS)
    recent  = df[df["timestamp"] >= t_start]

    n       = ECG_WINDOW_SECS * ECG_PPS
    t_dense = pd.date_range(end=t_now, periods=n,
                             freq=pd.tseries.frequencies.to_offset(f"{1000//ECG_PPS}ms"))
    sig     = np.zeros(n, dtype=np.float32)

    if len(recent) < 2:
        return t_dense, sig

    dts = recent["timestamp"].diff().dt.total_seconds().dropna()
    median_dt = float(dts.median()) if len(dts) > 0 else 5.0
    if np.isnan(median_dt) or median_dt <= 0:
        median_dt = 5.0
    half_pts = max(int(median_dt * ECG_PPS * 0.13), 3)
    tmpl     = _build_template(half_pts).astype(np.float32)
    tl       = len(tmpl)

    t0_ns = t_dense[0].value   # int64 nanoseconds
    dt_ns = (t_dense[1] - t_dense[0]).value

    for _, row in recent.iterrows():
        phi = float(row.get("phi_g", 0.07))
        tau = float(row.get("tau_r", 0.80))
        amp = float(np.clip(phi * 8.0 + tau * 0.4, 0.20, 1.0))
        c   = int((row["timestamp"].value - t0_ns) / dt_ns)
        lo  = c - tl // 2
        hi  = lo + tl
        # Clip to valid range
        sl  = slice(max(lo, 0), min(hi, n))
        tsl = slice(max(0, -lo), max(0, -lo) + (sl.stop - sl.start))
        if sl.stop > sl.start and tsl.stop <= tl:
            sig[sl] += tmpl[tsl] * amp

    return t_dense, np.clip(sig, -0.45, 1.10)

def _calc_mood_spans(ts, moods):
    spans = []
    if len(ts) == 0: return spans
    cm, cs = moods.iloc[0], ts.iloc[0]
    for i in range(1, len(ts)):
        if moods.iloc[i] != cm:
            spans.append((cs, ts.iloc[i], cm))
            cm, cs = moods.iloc[i], ts.iloc[i]
    spans.append((cs, ts.iloc[-1] + pd.Timedelta(seconds=5), cm))
    return spans

def _bg_worker():
    while True:
        try:
            _bg_tick()
        except Exception:
            pass
        time.sleep(BG_INTERVAL)

def _bg_tick():
    if _state["frozen"]:
        return

    # ── Load CSV (only if file changed) ───────────────────────────────────────
    try:
        mtime = os.path.getmtime(CSV_PATH)
    except FileNotFoundError:
        with _lock:
            shared["error"] = f"File not found:\n{CSV_PATH}\nStart KAI first."
        return

    if mtime != _state["csv_mtime"] or _state["df"] is None:
        try:
            df = pd.read_csv(CSV_PATH, parse_dates=["timestamp"])
            df = df.sort_values("timestamp").reset_index(drop=True)
            df["mood"] = df["mood"].astype(str).str.strip().str.lower()
            _state["df"]        = df
            _state["csv_mtime"] = mtime
        except Exception as e:
            with _lock:
                shared["error"] = str(e)
            return
    else:
        df = _state["df"]

    if df is None or df.empty:
        return

    # ── Rolling window for vitals ─────────────────────────────────────────────
    t_end   = df["timestamp"].max()
    t_start = t_end - pd.Timedelta(minutes=_state["window"])
    win     = df[df["timestamp"] >= t_start]
    if win.empty:
        win = df.tail(300)

    t = win["timestamp"]

    # ── Vitals ────────────────────────────────────────────────────────────────
    vitals    = {}
    last_vals = {}
    for (col, _, _, _, _) in VITALS:
        if col in win.columns:
            arr = win[col].to_numpy(dtype=np.float32)
            vitals[col]    = arr
            last_vals[col] = float(arr[-1]) if len(arr) else float("nan")
        else:
            vitals[col]    = np.array([], dtype=np.float32)
            last_vals[col] = float("nan")

    # ── Mood spans & session breaks ───────────────────────────────────────────
    spans = _calc_mood_spans(t, win["mood"])
    breaks = []
    for i in range(1, len(win)):
        wg = (win["timestamp"].iloc[i] - win["timestamp"].iloc[i-1]).total_seconds()
        tj = win["tick"].iloc[i] - win["tick"].iloc[i-1]
        if wg > SESSION_GAP_SECS or tj < -1:
            breaks.append(win["timestamp"].iloc[i-1] + pd.Timedelta(seconds=wg/2))

    # ── ECG ───────────────────────────────────────────────────────────────────
    ecg_t, ecg_sig = _make_ecg(df, t_end)

    # TPM from last 60 s
    r60 = df[df["timestamp"] >= t_end - pd.Timedelta(seconds=60)]
    if len(r60) > 1:
        dt60 = (r60["timestamp"].iloc[-1] - r60["timestamp"].iloc[0]).total_seconds()
        tpm  = (len(r60) - 1) / dt60 * 60.0 if dt60 > 0 else 0.0
    else:
        tpm = 0.0

    # ── Push to shared ────────────────────────────────────────────────────────
    with _lock:
        shared["ready"]     = True
        shared["error"]     = None
        shared["t"]         = t.to_numpy()
        shared["vitals"]    = vitals
        shared["last_vals"] = last_vals
        shared["x_min"]     = t.min()
        shared["x_max"]     = t.max() + pd.Timedelta(seconds=5)
        shared["ecg_t"]     = ecg_t
        shared["ecg_sig"]   = ecg_sig
        shared["last_tpm"]  = tpm
        shared["cur_mood"]  = win["mood"].iloc[-1] if not win.empty else "dormant"
        shared["spans"]     = spans
        shared["breaks"]    = breaks
        shared["tick_lo"]   = int(df["tick"].min())
        shared["tick_hi"]   = int(df["tick"].max())
        shared["n_rows"]    = len(df)
        shared["updated"]   = datetime.now().strftime("%H:%M:%S")

# Start background thread (daemon — dies when main exits)
threading.Thread(target=_bg_worker, daemon=True).start()

# ── Build figure ───────────────────────────────────────────────────────────────
N_PANELS      = len(VITALS) + 1
height_ratios = [1] * len(VITALS) + [1.5]
BG = "#050d0d"; PANEL_BG = "#080f0f"; GRID_C = "#0d1f1f"

fig = plt.figure(figsize=(16, 10), facecolor=BG)
fig.canvas.manager.set_window_title("KAI Brain Health Monitor")

gs = gridspec.GridSpec(N_PANELS, 2,
    width_ratios=[6, 1], height_ratios=height_ratios,
    hspace=0.06, wspace=0.03, left=0.07, right=0.97, top=0.93, bottom=0.06)

axes  = [fig.add_subplot(gs[i, 0]) for i in range(len(VITALS))]
ax_hb = fig.add_subplot(gs[len(VITALS), 0])
ax_st = fig.add_subplot(gs[:, 1])

for ax in axes + [ax_hb]:
    ax.set_facecolor(PANEL_BG)
    ax.tick_params(colors="#3a5555", labelsize=7.5)
    ax.yaxis.label.set_color("#5a7777")
    for sp in ax.spines.values(): sp.set_edgecolor("#0c1e1e")
    ax.grid(axis="y", color=GRID_C, linewidth=0.5, zorder=0)
for ax in axes: ax.tick_params(labelbottom=False)

ax_hb.set_facecolor("#030a03")
for sp in ax_hb.spines.values(): sp.set_edgecolor("#0c1e1e")
ax_hb.grid(axis="y", color="#091509", linewidth=0.4, zorder=0)
ax_hb.set_ylabel("♥  heartbeat\n   PQRST  90s", fontsize=8, labelpad=4, color=HB_COLOR)
ax_hb.set_ylim(-0.45, 1.15)
ax_hb.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M:%S"))
ax_hb.tick_params(axis="x", colors="#3a5555", rotation=20, labelsize=7.5)
ax_hb.set_xlabel("wall-clock time (UTC)", color="#304040", fontsize=8)

ax_st.set_facecolor(PANEL_BG)
ax_st.set_xticks([]); ax_st.set_yticks([])
for sp in ax_st.spines.values(): sp.set_edgecolor("#0c1e1e")

# ── Title ─────────────────────────────────────────────────────────────────────
fig.text(0.01, 0.97, "KAI  BRAIN  HEALTH  MONITOR",
         color="#00cfff", fontsize=13, fontweight="bold",
         va="top", ha="left", fontfamily="monospace")
live_dot      = fig.text(0.38, 0.97, "●  LIVE", color="#00ff88", fontsize=10,
                          fontweight="bold", va="top", ha="left", fontfamily="monospace")
reload_banner = fig.text(0.52, 0.97, "", color="#ffdd44", fontsize=9,
                          fontweight="bold", va="top", ha="left", fontfamily="monospace")
subtitle      = fig.text(0.01, 0.935, "", color="#304040", fontsize=7.5,
                          va="top", ha="left", fontfamily="monospace")

# ── Vital artists ─────────────────────────────────────────────────────────────
lines = []; last_dots = []
for i, (col, lc, short, unit, ylim) in enumerate(VITALS):
    ln,  = axes[i].plot([], [], color=lc, linewidth=1.4, alpha=0.90, zorder=2)
    dot, = axes[i].plot([], [], "o", color=lc, markersize=4, zorder=5)
    lines.append(ln); last_dots.append(dot)
    axes[i].set_ylim(ylim)
    axes[i].set_ylabel(f"{short}  {unit}", fontsize=8, labelpad=4, color="#5a7777")

# ── ECG artists ───────────────────────────────────────────────────────────────
hb_line, = ax_hb.plot([], [], color=HB_COLOR, linewidth=1.2, alpha=0.95, zorder=2)
hb_glow, = ax_hb.plot([], [], color=HB_COLOR, linewidth=5,   alpha=0.05, zorder=1)
hb_dot,  = ax_hb.plot([], [], "o", color=HB_COLOR, markersize=4, zorder=5)

# Zero-line on ECG (baseline reference)
ax_hb.axhline(0, color="#1a3a1a", linewidth=0.8, zorder=0)

# ── Status panel ──────────────────────────────────────────────────────────────
def st(x, y, s, **kw):
    kw.setdefault("ha", "center"); kw.setdefault("va", "top")
    kw.setdefault("transform", ax_st.transAxes)
    kw.setdefault("fontfamily", "monospace")
    return ax_st.text(x, y, s, **kw)
def sdiv(y):
    ax_st.plot([0.05, 0.95], [y, y], color="#0c1e1e", linewidth=0.8,
               transform=ax_st.transAxes, clip_on=False)

mood_txt   = st(0.5, 0.97, "—",  fontsize=13, fontweight="bold", color="#cccccc")
st(0.5, 0.92, "MOOD", fontsize=6.5, color="#304040"); sdiv(0.905)
st(0.5, 0.895, "♥", fontsize=11, color=HB_COLOR, fontweight="bold")
hb_tpm_txt = st(0.5, 0.855, "––", fontsize=20, fontweight="bold", color=HB_COLOR)
st(0.5, 0.815, "ticks/min", fontsize=6.5, color="#304040"); sdiv(0.800)

vital_y = [0.755, 0.615, 0.475, 0.335, 0.195]
vital_val_txt = []
for i, (col, lc, short, unit, _) in enumerate(VITALS):
    yp = vital_y[i]
    st(0.5, yp+0.048, short, fontsize=9, color=lc, fontweight="bold")
    vt = st(0.5, yp, "–.––––", fontsize=17, color="#cccccc", fontweight="bold")
    st(0.5, yp-0.040, unit, fontsize=6, color="#304040")
    vital_val_txt.append(vt)
    if i < len(VITALS)-1: sdiv(yp - 0.052)

# ── Span tracking (explicit-list — no live-iterator bug) ─────────────────────
span_store    = {ax: [] for ax in axes + [ax_hb]}
restart_store = {ax: [] for ax in axes + [ax_hb]}

def _clear(store, ax):
    for h in store[ax]:
        try: h.remove()
        except Exception: pass
    store[ax].clear()

def _draw_overlays(ax, spans, breaks):
    _clear(span_store, ax)
    _clear(restart_store, ax)
    for t0, t1, mood in spans:
        c  = MOOD_COLORS.get(mood, DEFAULT_MOOD_COLOR)
        pc = ax.axvspan(t0, t1, alpha=MOOD_ALPHA, color=c, linewidth=0, zorder=1)
        span_store[ax].append(pc)
    for bt in breaks:
        rl = ax.axvline(bt, color="#ffffff", linewidth=0.7,
                        linestyle="--", alpha=0.28, zorder=3)
        restart_store[ax].append(rl)

# ── Legend ────────────────────────────────────────────────────────────────────
leg = [mpatches.Patch(facecolor=c, label=m.capitalize(),
                       alpha=0.60, edgecolor="#0c1e1e")
       for m, c in MOOD_COLORS.items()]
leg.append(Line2D([0],[0], color="white", linewidth=0.9, linestyle="--",
                  alpha=0.4, label="session restart"))
axes[0].legend(handles=leg, loc="upper left", ncol=len(leg), fontsize=6.8,
               facecolor="#080f0f", edgecolor="#0c1e1e",
               labelcolor="#5a7777", framealpha=0.9)

fig.text(0.01, 0.01,
         "  Q/Esc quit    R hot-reload    F freeze    +/- window width",
         color="#253535", fontsize=7.5, va="bottom", ha="left",
         fontfamily="monospace")

# ── Animation callback — ONLY set_data() here, zero heavy work ───────────────
_anim_tick  = [0]
_reload_ctr = [None]

def update(frame):
    global _script_mtime
    _anim_tick[0] += 1
    blink = (_anim_tick[0] % 4) < 2

    # Hot-reload check
    try:
        nm = os.path.getmtime(SCRIPT_PATH)
    except Exception:
        nm = _script_mtime
    if nm != _script_mtime:
        _script_mtime = nm
        if _reload_ctr[0] is None:
            _reload_ctr[0] = 2
    if _reload_ctr[0] is not None:
        _reload_ctr[0] -= 1
        secs = round(max(0, _reload_ctr[0]) * REFRESH_MS / 1000, 1)
        reload_banner.set_text(f"↻ SCRIPT UPDATED — reload in {secs}s  (R now)")
        reload_banner.set_color("#ffdd44" if blink else "#886600")
        if _reload_ctr[0] <= 0: do_reload()
        return
    else:
        reload_banner.set_text("")

    if _state["frozen"]:
        live_dot.set_text("●  FROZEN")
        live_dot.set_color("#ffdd44" if blink else "#886600")
        return

    with _lock:
        if not shared["ready"]:
            live_dot.set_text("●  LOADING…" if blink else "   LOADING…")
            live_dot.set_color("#ffdd44")
            return
        if shared["error"]:
            live_dot.set_text("●  NO DATA")
            live_dot.set_color("#ff4466" if blink else "#882222")
            subtitle.set_text(shared["error"][:90])
            return

        # Snapshot — copy refs (numpy arrays are fine to read without copy here)
        t        = shared["t"]
        vitals   = shared["vitals"]
        lv       = shared["last_vals"]
        x_min    = shared["x_min"]
        x_max    = shared["x_max"]
        ecg_t    = shared["ecg_t"]
        ecg_sig  = shared["ecg_sig"]
        last_tpm = shared["last_tpm"]
        cur_mood = shared["cur_mood"]
        spans    = shared["spans"]
        breaks   = shared["breaks"]
        tick_lo  = shared["tick_lo"]
        tick_hi  = shared["tick_hi"]
        n_rows   = shared["n_rows"]
        updated  = shared["updated"]

    live_dot.set_text("●  LIVE" if blink else "   LIVE")
    live_dot.set_color("#00ff88" if blink else "#004422")

    subtitle.set_text(
        f"ticks {tick_lo}–{tick_hi}  ·  {n_rows} rows  ·  "
        f"window {_state['window']} min  ·  updated {updated}"
    )

    # Vitals
    for i, (col, lc, short, unit, ylim) in enumerate(VITALS):
        ax = axes[i]
        _draw_overlays(ax, spans, breaks)
        arr = vitals.get(col, np.array([]))
        if len(arr):
            lines[i].set_data(t, arr)
            last_dots[i].set_data([t[-1]], [arr[-1]])
        else:
            lines[i].set_data([], [])
            last_dots[i].set_data([], [])
        ax.set_xlim(x_min, x_max)
        v = lv.get(col, float("nan"))
        if not np.isnan(v):
            vital_val_txt[i].set_text(f"{v:.4f}")
            vital_val_txt[i].set_color(readout_color(col, v))
        else:
            vital_val_txt[i].set_text("– – – –")
            vital_val_txt[i].set_color("#304040")

    # ECG
    if len(ecg_t) and len(ecg_sig):
        hb_line.set_data(ecg_t, ecg_sig)
        hb_glow.set_data(ecg_t, ecg_sig)
        hb_dot.set_data([ecg_t[-1]], [ecg_sig[-1]])
        ax_hb.set_xlim(ecg_t[0], ecg_t[-1] + pd.Timedelta(seconds=2))

    hb_tpm_txt.set_text(f"{last_tpm:.1f}")
    hb_tpm_txt.set_color(readout_color("tpm", last_tpm))

    # Mood
    mc = MOOD_COLORS.get(cur_mood, DEFAULT_MOOD_COLOR)
    mood_txt.set_text(MOOD_LABELS.get(cur_mood, cur_mood.upper()))
    mood_txt.set_color(mc)
    ax_st.set_facecolor(mc + "06")

# ── Keys ──────────────────────────────────────────────────────────────────────
def on_key(event):
    k = (event.key or "").lower()
    if k in ("q", "escape"): plt.close("all"); sys.exit(0)
    elif k == "r": do_reload()
    elif k == "f": _state["frozen"] = not _state["frozen"]
    elif k in ("+", "="): _state["window"] = min(_state["window"] + 5, 180)
    elif k in ("-", "_"):  _state["window"] = max(_state["window"] - 5, 2)

fig.canvas.mpl_connect("key_press_event", on_key)

ani = animation.FuncAnimation(fig, update, interval=REFRESH_MS,
                               blit=False, cache_frame_data=False)
plt.show()
