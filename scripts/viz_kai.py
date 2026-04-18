import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from datetime import datetime
import os

# Configuration
LOG_FILE = r'C:\KAI\data\kai_ticks.csv'
OUTPUT_DIR = r'C:\KAI\data\plots'
DOWNSAMPLE_PERIOD = '30s' # Resample to 30 second averages

def plot_kai_metrics():
    if not os.path.exists(LOG_FILE):
        print(f"Error: Log file not found at {LOG_FILE}")
        return

    # 1. Load data
    print(f"Loading {LOG_FILE}...")
    df = pd.read_csv(LOG_FILE)
    
    # 2. Parse timestamps
    df['timestamp'] = pd.to_datetime(df['timestamp'])
    df.set_index('timestamp', inplace=True)
    
    # 3. Downsample to 30s averages to reduce noise
    print(f"Downsampling to {DOWNSAMPLE_PERIOD}...")
    df_resampled = df.resample(DOWNSAMPLE_PERIOD).mean()
    
    # 4. Filter for specific metrics
    metrics = [
        ('phi_g', 'Emergence (Φg)', '#00ffcc'), 
        ('momentum', 'Momentum (M)', '#ff3366'),
        ('stability', 'Stability (s)', '#ffcc00'),
        ('rho', 'Density (ρ)', '#9933ff'),
        ('novelty', 'Novelty (q)', '#3399ff')
    ]
    
    # Check if all metrics exist in the CSV
    metrics = [(m, label, color) for m, label, color in metrics if m in df_resampled.columns]
    
    # 5. Plotting
    num_plots = len(metrics)
    fig, axes = plt.subplots(num_plots, 1, figsize=(14, 2 * num_plots), sharex=True)
    if num_plots == 1: axes = [axes]
    
    plt.style.use('dark_background')
    fig.patch.set_facecolor('#0f0f12')
    
    for i, (col, label, color) in enumerate(metrics):
        ax = axes[i]
        ax.set_facecolor('#1a1a1f')
        ax.plot(df_resampled.index, df_resampled[col], color=color, linewidth=1.5, alpha=0.9)
        ax.set_ylabel(label, fontsize=10, fontweight='bold', color=color)
        ax.grid(True, which='both', linestyle='--', linewidth=0.5, alpha=0.3)
        ax.tick_params(axis='y', labelsize=8)
        
        # Add Version Lines (Template)
        # To add a version boundary, add the timestamp here:
        # versions = [pd.Timestamp('2026-04-18 01:00:00')]
        # for v in versions:
        #     ax.axvline(v, color='red', linestyle='--', linewidth=1, alpha=0.6)

    # Specific formatting for X axis
    axes[-1].xaxis.set_major_formatter(mdates.DateFormatter('%H:%M:%S'))
    axes[-1].set_xlabel('Time (UTC)', fontsize=10)
    
    plt.tight_layout()
    plt.subplots_adjust(hspace=0.1)
    
    # 6. Save or Display
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)
        
    out_file = os.path.join(OUTPUT_DIR, f'kai_metrics_{datetime.now().strftime("%Y%m%d_%H%M")}.png')
    plt.savefig(out_file, dpi=300, bbox_inches='tight', facecolor=fig.get_facecolor())
    print(f"Plot saved to: {out_file}")
    
    # Note: If running on a local desktop, you can also use plt.show()
    # plt.show()

if __name__ == "__main__":
    plot_kai_metrics()
