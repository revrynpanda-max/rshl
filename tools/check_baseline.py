import json

with open('C:/KAI/data/anomalies/baseline.json', 'r') as f:
    baseline = json.load(f)

# Show top 15 strongest signals
sorted_baseline = sorted(baseline.values(), key=lambda x: x['mean_dbm'], reverse=True)
print('Top 15 baseline signals:')
for s in sorted_baseline[:15]:
    print(f'  {s["frequency_mhz"]:8.1f} MHz: {s["mean_dbm"]:6.1f} dBm (±{s["std_dbm"]:4.1f}) [{s["classification"]}]')

print(f'\nTotal baseline signals: {len(baseline)}')
