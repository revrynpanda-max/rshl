r"""
kai_plot.py — KAI v5.0 Field Metrics Visualiser
================================================
Reads  : C:\KAI\data\kai_ticks.csv  (24-column live log)
Writes : C:\KAI\data\kai_plot.png   (dark-theme, 5-panel chart)

Panels
------
1. Φg  — goal-aligned emergence (the key output)
2. ρ   — field density (fixed from 1.0 → real nnz/DIM)
3. χ   — contradiction pressure
4. V   — drive valence
5. τ_R — spiral temporal factor  (spiral_r overlaid as dotted line)

Visual features
---------------
- Mood-coloured background bands (efficient: grouped spans, not per-row)
- Vertical dashed white lines at session restarts
  (gap > 60 s between consecutive rows, or tick going backwards)
- Mood legend in panel 1
- Title annotation with session count
- Saves PNG to C:\KAI\data\kai_plot.png and opens interactively

Usage
-----
    python C:\KAI\kai_plot.py

Requirements
------------
    pip install pandas matplotlib
"""

import sys
import pandas as pd
import matplotlib
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import matplotlib.patches as mpatches
from matplotlib.lines import Line2D
import numpy as np

# ── Config ────────────────────────────────────────────────────────────────────
CSV_PATH  = r"C:\KAI\data\kai_ticks.csv"
PNG_PATH  = r"C:\KAI\data\kai_plot.png"
DPI       = 150
SESSION_GAP_SECS = 60          # seconds of wall-clock silence → new session

MOOD_COLORS = {
    "curious":    "#00cfff",
    "engaged":    "#00ff99",
    "conflicted": "#ff4466",
    "uneasy":     "#ffdd44",
    "dormant":    "#888888",
}
DEFAULT_MOOD_COLOR = "#aaaaaa"

# The five panels: (column, line_color, y-label, (ymin, ymax))
PANELS = [
    ("phi_g",   "#00cfff", "Φg  emergence",       (0.00, 0.55)),
    ("rho",     "#ff9900", "ρ   field density",   (0.00, 1.10)),
    ("chi",     "#ff4466", "χ   contradiction",   (0.00, 0.55)),
    ("valence", "#cc99ff", "V   valence",         (-0.5, 0.5 )),
    ("tau_r",   "#00ff99", "τ_R  spiral factor",  (0.45, 1.05)),
]

# ── Load & Sort ───────────────────────────────────────────────────────────────
try:
    df = pd.read_csv(CSV_PATH, parse_dates=["timestamp"])
except FileNotFoundError:
    sys.exit(f"ERROR: cannot find {CSV_PATH}\nMake sure KAI has run at least once.")

df = df.sort_values("timestamp").reset_index(drop=True)

if df.empty:
    sys.exit("ERROR: CSV is empty — run KAI for a few minutes first.")

# Ensure mood column is lowercase string
df["mood"] = df["mood"].astype(str).str.strip().str.lower()

t = df["timestamp"]

# ── Session-break detection ───────────────────────────────────────────────────
# A break occurs when wall-clock gap > SESSION_GAP_SECS OR tick decreases.
session_break_times = []
for i in range(1, len(df)):
    wall_gap  = (df.loc[i, "timestamp"] - df.loc[i-1, "timestamp"]).total_seconds()
    tick_jump = df.loc[i, "tick"] - df.loc[i-1, "tick"]
    if wall_gap > SESSION_GAP_SECS or tick_jump < -1:
        # Record the midpoint between the two rows as the break line
        mid = df.loc[i-1, "timestamp"] + pd.Timedelta(seconds=wall_gap / 2)
        session_break_times.append(mid)

n_sessions = len(session_break_times) + 1

# ── Mood background spans (efficient grouping) ────────────────────────────────
# Build a list of (start_time, end_time, mood) spans by collapsing runs of
# the same mood. Much faster than one axvspan per row.
def mood_spans(timestamps, moods):
    spans = []
    if len(timestamps) == 0:
        return spans
    cur_mood  = moods.iloc[0]
    cur_start = timestamps.iloc[0]
    for i in range(1, len(timestamps)):
        if moods.iloc[i] != cur_mood:
            spans.append((cur_start, timestamps.iloc[i], cur_mood))
            cur_mood  = moods.iloc[i]
            cur_start = timestamps.iloc[i]
    spans.append((cur_start, timestamps.iloc[-1] + pd.Timedelta(seconds=5), cur_mood))
    return spans

spans = mood_spans(t, df["mood"])

# ── Figure layout ─────────────────────────────────────────────────────────────
matplotlib.rcParams.update({
    "axes.spines.top":    False,
    "axes.spines.right":  False,
})

fig, axes = plt.subplots(
    len(PANELS), 1,
    figsize=(15, 11),
    sharex=True,
    constrained_layout=True,
    gridspec_kw={"hspace": 0.08},
)
fig.patch.set_facecolor("#0d0d0d")

for ax in axes:
    ax.set_facecolor("#111111")
    ax.tick_params(colors="#888888", labelsize=8)
    ax.yaxis.label.set_color("#cccccc")
    for spine in ax.spines.values():
        spine.set_edgecolor("#2a2a2a")
    ax.grid(axis="y", color="#1e1e1e", linewidth=0.6, zorder=0)

# ── Draw each panel ───────────────────────────────────────────────────────────
for idx, (ax, (col, line_color, ylabel, ylim)) in enumerate(zip(axes, PANELS)):

    # Mood background
    for (start, end, mood) in spans:
        c = MOOD_COLORS.get(mood, DEFAULT_MOOD_COLOR)
        ax.axvspan(start, end, alpha=0.07, color=c, linewidth=0, zorder=1)

    # Session-break lines
    for sb in session_break_times:
        ax.axvline(sb, color="#ffffff", linewidth=0.9,
                   linestyle="--", alpha=0.45, zorder=3)

    # Main metric line
    ax.plot(t, df[col], color=line_color,
            linewidth=1.3, alpha=0.92, zorder=2)

    ax.set_ylabel(ylabel, fontsize=9, labelpad=4)
    ax.set_ylim(ylim)

    # Annotate last value
    last_val = df[col].iloc[-1]
    ax.annotate(
        f"{last_val:.4f}",
        xy=(t.iloc[-1], last_val),
        xytext=(4, 0), textcoords="offset points",
        color=line_color, fontsize=7.5, va="center", alpha=0.85,
    )

# ── τ_R panel: overlay spiral_r as a dotted secondary line ───────────────────
if "spiral_r" in df.columns:
    ax5 = axes[4]
    ax5_r = ax5.twinx()
    ax5_r.set_facecolor("none")
    ax5_r.plot(t, df["spiral_r"], color="#ffff55",
               linewidth=0.9, linestyle=":", alpha=0.65, zorder=2)
    ax5_r.set_ylim(-0.05, 1.05)
    ax5_r.set_ylabel("spiral_r", fontsize=8, color="#ffff55", labelpad=2)
    ax5_r.tick_params(colors="#ffff55", labelsize=7)
    for spine in ax5_r.spines.values():
        spine.set_edgecolor("#2a2a2a")

# ── X-axis ────────────────────────────────────────────────────────────────────
axes[-1].xaxis.set_major_formatter(mdates.DateFormatter("%H:%M:%S"))
axes[-1].tick_params(axis="x", colors="#888888", rotation=25, labelsize=8)
axes[-1].set_xlabel("wall-clock time (UTC)", color="#666666", fontsize=8)

# ── Title ─────────────────────────────────────────────────────────────────────
session_label = (
    f"{n_sessions} session{'s' if n_sessions > 1 else ''}"
    + (f"  ·  {len(session_break_times)} restart{'s' if len(session_break_times)>1 else ''}"
       if session_break_times else "")
)
tick_range = f"ticks {int(df['tick'].min())}–{int(df['tick'].max())}  ·  {len(df)} rows"

axes[0].set_title(
    f"KAI v5.0 — Field Metrics Live Log\n"
    f"{tick_range}  ·  {session_label}",
    color="#00cfff", fontsize=12, pad=10, fontweight="bold",
    loc="left",
)

# ── Mood legend ───────────────────────────────────────────────────────────────
legend_handles = [
    mpatches.Patch(facecolor=c, label=m.capitalize(), alpha=0.75,
                   edgecolor="#333333")
    for m, c in MOOD_COLORS.items()
]
# Add session-break entry
if session_break_times:
    legend_handles.append(
        Line2D([0], [0], color="white", linewidth=1.2, linestyle="--",
               alpha=0.5, label="session restart")
    )

axes[0].legend(
    handles=legend_handles,
    loc="upper right", ncol=len(legend_handles),
    fontsize=7.5, facecolor="#1a1a1a",
    edgecolor="#333333", labelcolor="#cccccc",
    framealpha=0.85,
)

# ── Save & show ───────────────────────────────────────────────────────────────
fig.savefig(PNG_PATH, dpi=DPI, bbox_inches="tight", facecolor="#0d0d0d")
print(f"Saved  →  {PNG_PATH}")
plt.show()
