' Phoenix Watchdog hidden launcher.
' Runs phoenix-watchdog.ps1 with NO visible window or flash.
' wscript.exe has no console of its own, and Run(..., 0, False) launches
' PowerShell hidden (0) without waiting (False) — so nothing ever appears
' on screen, fixing the "random PowerShell window opening/closing" every 5 min.
Set objShell = CreateObject("WScript.Shell")
objShell.Run "powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File ""C:\KAI\tools\oracle-discord\phoenix-watchdog.ps1""", 0, False
