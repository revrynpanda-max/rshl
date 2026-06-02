import serial
import struct
import time
import sys

PORT = "COM6"
BAUD = 576000
SCALE = 174

# Requested range
start_hz = 95_001_000
stop_hz  = 95_136_000
points   = 50

print(f"Connecting to TinySA on {PORT} at {BAUD} baud...")
try:
    ser = serial.Serial(
        PORT,
        BAUD,
        timeout=5,
        write_timeout=5,
        dsrdtr=False,
        rtscts=False
    )
    time.sleep(0.5)
    
    # Drain any existing buffer
    if ser.in_waiting:
        ser.read(ser.in_waiting)
        
    print("Testing connection with 'version'...")
    ser.write(b"version\r")
    ver_resp = ser.read_until(b"ch> ")
    ver_str = ver_resp.decode('utf-8', errors='ignore').strip()
    if "tinySA" in ver_str:
        print(f"Connected to: {ver_str.splitlines()[0]}")
    else:
        print(f"Warning: Unexpected version response: {repr(ver_str)}")

    print(f"Initiating binary scanraw sweep from {start_hz/1e6:.6f} MHz to {stop_hz/1e6:.6f} MHz ({points} points)...")
    cmd = f"scanraw {start_hz} {stop_hz} {points} 3\r"
    ser.write(cmd.encode())
    
    # Skip command echo and wait for binary block prefix
    ser.read_until(cmd.encode().rstrip() + b'\n{')
    
    readings = []
    freq_step = (stop_hz - start_hz) / max(points - 1, 1)
    
    for i in range(points):
        raw = ser.read(3)
        if len(raw) < 3:
            print(f"Timeout reading point {i}")
            break
            
        c, data = struct.unpack('<cH', raw)
        dbm = (data / 32) - SCALE
        freq_mhz = (start_hz + i * freq_step) / 1e6
        readings.append((freq_mhz, dbm))
        
    # Read end marker
    ser.read(2)
    ser.close()
    
    if readings:
        print("\n--- SWEEP RESULTS ---")
        print(f"{'Frequency (MHz)':<20} {'dBm Level':<12} Signal Strength")
        print("-" * 50)
        # Find peak
        peak_freq, peak_dbm = max(readings, key=lambda x: x[1])
        
        for freq, dbm in readings:
            bar = "=" * int(max(0, (dbm + 120) / 2))
            marker = " <-- PEAK" if freq == peak_freq else ""
            print(f"{freq:<20.6f} {dbm:<12.2f} [{bar:<30}] {marker}")
            
        print("-" * 50)
        print(f"PEAK DETECTED: {peak_dbm:.2f} dBm at {peak_freq:.6f} MHz")
    else:
        print("No sweep readings obtained.")
        
except serial.SerialException as e:
    err = str(e)
    if "Access is denied" in err or "PermissionError" in err:
        print(f"\nERROR: Port {PORT} is BUSY.")
        print("Please close QtTinySA, WinSpectrumIII, or any other app using the TinySA and try again.")
    else:
        print(f"\nSERIAL ERROR: {e}")
except Exception as e:
    print(f"\nERROR: {e}")
