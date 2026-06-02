import serial
import serial.tools.list_ports
import time
import urllib.request
import json
import sys

KAI_STORE_URL = "http://127.0.0.1:3333/api/store"
TARGET_BAUD = 115200

# Single wideband sweep so the physical screen doesn't jitter
BANDS = [
    {"name": "Full Spectrum", "start": 10000000, "stop": 5999000000}
]

# KAI RF Intelligence Database
FREQUENCY_DATABASE = [
    {"start": 10, "stop": 30, "name": "HF / Shortwave Radio"},
    {"start": 88, "stop": 108, "name": "FM Radio Broadcast"},
    {"start": 108, "stop": 137, "name": "Aircraft/Aviation Band"},
    {"start": 137, "stop": 144, "name": "Weather Satellites / Space"},
    {"start": 144, "stop": 148, "name": "2m Ham Radio"},
    {"start": 156, "stop": 162, "name": "Marine Radio"},
    {"start": 315, "stop": 316, "name": "Car Key Fob / Garage Door"},
    {"start": 433, "stop": 434, "name": "ISM Smart Home / Temp Sensors"},
    {"start": 462, "stop": 467, "name": "GMRS/FRS Walkie Talkies"},
    {"start": 698, "stop": 960, "name": "Cellular / LTE Band (Sub-1GHz)"},
    {"start": 1090, "stop": 1091, "name": "ADS-B Aircraft Transponders"},
    {"start": 1575, "stop": 1576, "name": "GPS L1 Signal"},
    {"start": 1710, "stop": 2200, "name": "Cellular 4G/5G Mid-Band"},
    {"start": 2400, "stop": 2500, "name": "Wi-Fi 2.4GHz / Bluetooth / Microwave"},
    {"start": 5725, "stop": 5875, "name": "Wi-Fi 5GHz / Drone Video"}
]

def classify_signal(freq_mhz):
    for entry in FREQUENCY_DATABASE:
        if entry["start"] <= freq_mhz <= entry["stop"]:
            return entry["name"]
    return "Unknown RF Emission"

def find_tinysa_port():
    ports = list(serial.tools.list_ports.comports())
    for p in ports:
        if "CH340" in p.description or "USB Serial" in p.description:
            return p.device
    return "COM6"

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

def send_cmd(ser, cmd):
    ser.write((cmd + "\r").encode())
    ser.readline()

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

def report_anomaly(freq_mhz, amp):
    classification = classify_signal(freq_mhz)
    print(f"\n[!] SIGNAL DETECTED: {classification} at {freq_mhz:.2f} MHz (Strength: {amp:.2f} dBm)")
    try:
        msg = f"KAI sensed an RF signal burst at {freq_mhz:.2f} MHz. Signal classification: {classification}. Energy level: {amp:.2f} dBm."
        req = urllib.request.Request(
            KAI_STORE_URL,
            data=json.dumps({"text": msg, "region": "physics", "source": "tinysa"}).encode(),
            headers={"Content-Type": "application/json"}
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception as e:
        pass

def main():
    print("="*50)
    print(" KAI RF Intelligence Link (Classified Sweep) ")
    print("="*50)
    
    port = find_tinysa_port()
    print(f"[*] Attempting to connect to TinySA on {port}...")
    
    try:
        ser = serial.Serial(port, TARGET_BAUD, timeout=2)
    except serial.SerialException as e:
        print(f"[!] Serial Error: {e}")
        print("Please ensure tinySA-App is CLOSED so KAI can access COM6.")
        sys.exit(1)
        
    print("[*] Connected successfully.")
    ser.reset_input_buffer()
    ser.reset_output_buffer()
    read_until_prompt(ser)
    send_cmd(ser, "pause")
    read_until_prompt(ser)
    
    print("[*] Commencing intelligent wideband scan...\n")
    
    while True:
        sys.stdout.write("\rScanning Environment... ")
        sys.stdout.flush()
        
        for i, band in enumerate(BANDS):
            start = band['start']
            stop = band['stop']
            points = 101
            
            send_cmd(ser, f"scan {start} {stop} {points}")
            read_until_prompt(ser)
            
            amps = fetch_data(ser, 0)
            if amps:
                peak_amp = max(amps)
                peak_idx = amps.index(peak_amp)
                freq_step = (stop - start) / max(1, len(amps)-1)
                peak_freq = start + (peak_idx * freq_step)
                
                # Report if stronger than -20.0 dBm
                if peak_amp > -20.0:
                    report_anomaly(peak_freq / 1e6, peak_amp)
            
            time.sleep(1.0)
        
        # Resume to keep the device happy
        send_cmd(ser, "resume")
        read_until_prompt(ser)
        time.sleep(1.5)
        send_cmd(ser, "pause")
        read_until_prompt(ser)

if __name__ == '__main__':
    main()
