"""Quick TinySA COM6 diagnostic"""
import serial
import time

PORT = "COM6"
BAUD = 115200

print(f"Opening {PORT}...")
try:
    ser = serial.Serial(PORT, BAUD, timeout=2, write_timeout=2)
    print(f"Port open: {ser.is_open}")
    time.sleep(0.5)

    # Try sending a simple newline
    print("Sending newline...")
    ser.write(b'\r\n')
    time.sleep(0.5)
    data = ser.read(256)
    print(f"Got back {len(data)} bytes: {repr(data)}")

    # Try version command
    print("Sending 'version' command...")
    ser.write(b'version\r\n')
    time.sleep(1.0)
    data = ser.read(256)
    print(f"Got back {len(data)} bytes: {repr(data)}")

    ser.close()
    print("Done.")
except Exception as e:
    print(f"ERROR: {e}")
