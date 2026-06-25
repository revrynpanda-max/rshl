<#
  stop-inspectors.ps1 — stop the background processes that constantly INSPECT/PROFILE
  KAI and brute-force the box, WITHOUT touching the core system.

  STOPS:   kai_supervisor.py (the RAM-recycler that force-kills kai.exe),
           the RAM watcher (kai-ram-watch logger), kai_healthcheck.py,
           diagnose_bitnet*.py, inspect_gguf/inspect_metadata one-offs.
  LEAVES RUNNING:  kai.exe (the engine), node (the bots), ollama (local model server),
           the Command Center dashboard.

  Usage:   powershell -ExecutionPolicy Bypass -File C:\KAI\stop-inspectors.ps1
  Re-arm:  these only respawn on the next boot if you run Start-KAI.ps1 WITHOUT
           -NoSupervisor. To keep the supervisor off, boot with:
               .\Start-KAI.ps1 -NoSupervisor
#>
$ErrorActionPreference = 'SilentlyContinue'

# Command-line fragments that identify an INSPECTOR process (not the core system).
$patterns = @(
  'kai_supervisor',
  'kai-ram-watch','ram-watch','ram_watch','kai-ram',
  'kai_healthcheck',
  'diagnose_bitnet','diagnose_bitnet_ingest',
  'inspect_gguf','inspect_metadata'
)

Write-Host "== stop-inspectors ==" -ForegroundColor Cyan
Write-Host "Scanning for KAI inspector/profiler processes..."

$all = Get-CimInstance Win32_Process
$hits = $all | Where-Object {
  $cl = $_.CommandLine
  if (-not $cl) { return $false }
  # never, ever target the engine / model server themselves
  if ($_.Name -match '^(kai|ollama)\.exe$') { return $false }
  $matched = $false
  foreach ($p in $patterns) { if ($cl -like "*$p*") { $matched = $true; break } }
  $matched
}

if (-not $hits) {
  Write-Host "No inspector processes are running. Nothing to stop." -ForegroundColor Green
  return
}

$stopped = 0
foreach ($h in $hits) {
  $short = ($h.CommandLine -replace '\s+', ' ').Trim()
  if ($short.Length -gt 96) { $short = $short.Substring(0, 96) + '...' }
  Write-Host ("  STOP  PID {0,-6}  {1,-14}  {2}" -f $h.ProcessId, $h.Name, $short) -ForegroundColor Yellow
  Stop-Process -Id $h.ProcessId -Force -ErrorAction SilentlyContinue
  if (-not (Get-Process -Id $h.ProcessId -ErrorAction SilentlyContinue)) { $stopped++ }
}

Write-Host ""
Write-Host ("Stopped {0} inspector process(es)." -f $stopped) -ForegroundColor Green
Write-Host "Left running: kai.exe (engine), node (bots), ollama, dashboard." -ForegroundColor Green
Write-Host "Heads-up: with the supervisor stopped, nothing will auto-restart the engine if it" -ForegroundColor DarkGray
Write-Host "          truly dies until you reboot the stack. Boot with -NoSupervisor to keep it off." -ForegroundColor DarkGray
