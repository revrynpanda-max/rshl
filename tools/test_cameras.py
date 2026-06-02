import cv2
import time
import os

print("Testing available cameras [0, 1, 4]...")

for idx in [0, 1, 4]:
    print(f"\n--- Testing Camera {idx} ---")
    cap = cv2.VideoCapture(idx, cv2.CAP_DSHOW)
    if not cap.isOpened():
        print(f"Failed to open camera {idx}")
        continue
    
    # Let it warm up
    time.sleep(1)
    ret, frame = cap.read()
    
    if ret:
        print(f"Camera {idx}: Successfully read frame.")
        print(f"Shape: {frame.shape}, Dtype: {frame.dtype}")
        
        # Save the frame to scratch
        filename = f"C:\\KAI\\scratch\\camera_{idx}_frame.jpg"
        cv2.imwrite(filename, frame)
        print(f"Saved test frame to {filename}")
    else:
        print(f"Camera {idx}: Failed to read frame.")
        
    cap.release()
