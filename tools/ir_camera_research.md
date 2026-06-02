# IR Camera Research for KAI Sensory Link

When connecting an Infrared (Thermal) Camera to Windows, there are three primary ways to feed the thermal data into KAI's Python bridge, depending on the camera's hardware protocol.

## 1. UVC Webcams (Generic / Budget Thermal Cameras)
Many modern USB thermal cameras (like Topdon or generic Chinese models) show up in Windows Device Manager simply as a "USB Video Device" (UVC). They output a pre-color-mapped video stream.
**Python Approach:** Use `OpenCV`.
```python
import cv2
import numpy as np

# Usually index 0 is your laptop webcam, index 1 is the USB IR camera
cap = cv2.VideoCapture(1, cv2.CAP_DSHOW)
ret, frame = cap.read()
# The frame is just an RGB image showing the heat map.
# You can analyze pixel brightness/color to detect hot anomalies!
```

## 2. Seek Thermal Cameras (Compact / CompactPro)
Seek cameras do not mount as standard webcams. They require custom USB bulk transfer drivers.
**Python Approach:** You must use `libseek-thermal` or the community wrapper. You will likely need to install a WinUSB driver using `Zadig` first to replace the default driver.
```python
# pip install seekcamera-python
from seekcamera import SeekCameraManager, SeekCameraManagerEvent
```

## 3. FLIR Lepton / FLIR ONE
If it's a FLIR camera, it might use the Spinnaker SDK or act as a PureThermal UVC device.
**Python Approach:** If it's a PureThermal board, it streams 16-bit raw temperature data (Radiometry) via UVC!
```python
# Install libuvc for Python, or use OpenCV with a specific 16-bit format flag
cap = cv2.VideoCapture(1, cv2.CAP_DSHOW)
cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"Y16 "))
cap.set(cv2.CAP_PROP_CONVERT_RGB, False)
ret, frame = cap.read()
# 'frame' now contains direct temperature values in Kelvin * 100
```

## How to integrate with KAI:
Once we know exactly what brand of IR camera you have, we can:
1. Capture frames every 5 seconds.
2. Calculate the maximum temperature pixel in the frame.
3. If it exceeds a certain threshold (e.g., something very hot like a human body or an electrical short), POST an anomaly to `http://127.0.0.1:3333/api/store` so KAI can "see" the heat in his physical environment.

*Note: Please tell me the brand/model of the IR Camera when you wake up so we can pick the exact right script.*
