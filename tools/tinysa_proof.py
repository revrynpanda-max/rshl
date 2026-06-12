import serial
import time
import urllib.request
import json
import sys

KAI_STORE_URL = "http://127.0.0.1:3333/api/store"
PORT = 'COM6'
BAUD = 115200

# Read until prompt helper
def read_until_prompt(ser):
    result = ""
    line = ""
    while True:
        c = ser.read().decode('utf-8', errors='ignore')
        if not c:
            break
        if c == '\r':
            continue
        line += c
        if c == '\n':
            result += line
            line = ""
            continue
        if line.endswith('ch>'):
            break
    return result

# Send command helper
def send_cmd(ser, cmd):
    ser.write((cmd + "\r").encode())
    ser.readline()

# Fetch data helper
def fetch_data(ser, array=0):
    send_cmd(ser, f"data {array}")
    raw = read_until_prompt(ser)
    vals = []
    for line in raw.split('\n'):
        line = line.strip()
        if line and not line.endswith('ch>'):
            try:
                vals.append(float(line))
            except:
                pass
    return vals

# Frequency classifier
def classify(freq_mhz):
    if 88 <= freq_mhz <= 108:
        return "FM Radio Broadcast"
    elif 108 <= freq_mhz <= 137:
        return "Aircraft/Aviation"
    elif 144 <= freq_mhz <= 148:
        return "2m Ham Radio"
    elif 156 <= freq_mhz <= 162:
        return "Marine Radio"
    elif 2400 <= freq_mhz <= 2500:
        return "Wi-Fi 2.4GHz / Bluetooth"
    elif 5725 <= freq_mhz <= 5875:
        return "Wi-Fi 5GHz / Drone"
    else:
        return "Unknown RF Signal"

print("="*60)
print(" TINYSA -> KAI PROOF-OF-LIFE FEED")
print("="*60)
print("This script sends live RF spectrum data to KAI's memory.")
print("KAI must be running on port 3333 for this to work.")
print("="*60)
print()

# Connect to TinySA
try:
    ser = serial.Serial(PORT, BAUD, timeout=2)
except serial.SerialException as e:
    print(f"[!] Cannot open {PORT}: {e}")
    print("Make sure tinySA-App is CLOSED and the device is plugged in.")
    sys.exit(1)

ser.reset_input_buffer()
ser.reset_output_buffer()
read_until_prompt(ser)

# Scan bands
BANDS = [
    {"name": "FM Radio", "start": 88000000, "stop": 108000000},
    {"name": "Aircraft", "start": 108000000, "stop": 137000000},
    {"name": "Wi-Fi 2.4GHz", "start": 2400000000, "stop": 2500000000},
]

print("Scanning...")
for band in BANDS:
    start = band['start']
    stop = band['stop']
    name = band['name']
    
    send_cmd(ser, "pause")
    read_until_prompt(ser)
    
    send_cmd(ser, f"scan {start} {stop} 101")
    read_until_prompt(ser)
    
    amps = fetch_data(ser, 0)
    if amps:
        peak_amp = max(amps)
        peak_idx = amps.index(peak_amp)
        freq_step = (stop - start) / max(1, len(amps)-1)
        peak_freq = start + (peak_idx * freq_step)
        freq_mhz = peak_freq / 1e6
        classification = classify(freq_mhz)
        
        msg = f"RF SENSE: {classification} detected at {freq_mhz:.1f} MHz, strength {peak_amp:.1f} dBm."
        print(f"\n[DETECTED] {msg}")
        
        # Try to send to KAI
        try:
            req = urllib.request.Request(
                KAI_STORE_URL,
                data=json.dumps({
                    "text": msg,
                    "region": "physics",
                    "source": "tinysa",
                    "strength": min(1.0, (peak_amp + 100) / 80)  # Normalize to 0-1
                }).encode(),
                headers={"Content-Type": "application/json"}
            )
            resp = urllib.request.urlopen(req, timeout=5)
            print(f"[KAI]  Stored in memory lattice (HTTP {resp.status})")
        except urllib.error.URLError as e:
            print(f"[KAI]  NOT RUNNING — Could not connect to {KAI_STORE_URL}")
            print("       Start KAI with: C:\\KAI\\sovereign-start.ps1")
        except Exception as e:
            print(f"[KAI]  Error: {e}")
    
    send_cmd(ser, "resume")
    read_until_prompt(ser)
    time.sleep(0.5)

ser.close()
print("\n" + "="*60)
print("Scan complete.")
print("="*60)
