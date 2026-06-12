import time
import serial
from tinysa_discord_bridge import (
    read_until_prompt, send_cmd, fetch_data,
    classify_signal, estimate_distance_miles,
    build_discord_embed, build_kai_message,
    log_sweep, init_sweep_csv, store_in_kai_memory,
    post_discord_embed, post_discord_message
)

PORT = 'COM6'
BAUD = 115200

print('=== Testing TinySA Discord Bridge ===')
print('Connecting to TinySA...')

ser = serial.Serial(PORT, BAUD, timeout=2)
ser.reset_input_buffer()
ser.reset_output_buffer()
read_until_prompt(ser)

print('Connected. Running test sweep...')

csv_path = init_sweep_csv()

# Test single band: FM broadcast
band = {"name": "FM Broadcast", "start": 88000000, "stop": 108000000, "priority": 1}
start = band["start"]
stop = band["stop"]
points = 101

send_cmd(ser, "pause")
read_until_prompt(ser)

send_cmd(ser, f"scan {start} {stop} {points}")
read_until_prompt(ser)

amps = fetch_data(ser, 0)

send_cmd(ser, "resume")
read_until_prompt(ser)

ser.close()

if not amps:
    print('No data received from TinySA.')
    exit(1)

# Build signal list
freq_step = (stop - start) / max(1, len(amps) - 1)
signals = []
for i, amp in enumerate(amps):
    freq = start + (i * freq_step)
    if amp > -80:
        signals.append({
            "freq": freq / 1e6,
            "amp": amp,
            "idx": i
        })

peak_amp = max(amps)
peak_idx = amps.index(peak_amp)
peak_freq = start + (peak_idx * freq_step)

print(f'\nPeak: {peak_freq/1e6:.2f} MHz at {peak_amp:.1f} dBm')
print(f'Signals > -80dBm: {len(signals)}')

# Test Discord embed
embed = build_discord_embed(band, peak_freq, peak_amp, signals)
print(f'\nDiscord embed built: {embed["title"].encode("ascii", "replace").decode("ascii")}')
print(f'Fields: {len(embed["fields"])}')
print(f'Color: {embed["color"]}')

# Test KAI message
kai_msg = build_kai_message(band, peak_freq, peak_amp, signals)
print(f'\nKAI message: {kai_msg[:80]}...')

# Test CSV log
log_sweep(csv_path, band, peak_freq, peak_amp, signals)
print(f'\nCSV logged: {csv_path}')

# Test KAI memory store (will fail if KAI not running)
print('\nAttempting KAI memory store...')
result = store_in_kai_memory(kai_msg, "physics", "tinysa", 0.5)
print(f'KAI store result: {result}')

# Test Discord post (will fail if no token)
print('\nAttempting Discord post...')
import os
token = os.environ.get("ORACLE_DISCORD_TOKEN_KAI")
if token:
    result = post_discord_embed("1513582425446289658", embed, token)
    print(f'Discord embed result: {result}')
else:
    print('No Discord token found. Set ORACLE_DISCORD_TOKEN_KAI env var.')

print('\n=== Test Complete ===')
print('The bridge is ready. Start KAI with: .\\run-oracle-discord.ps1')
