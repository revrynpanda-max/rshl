"=== restart-dashboard run: $(Get-Date) ==="
"OS env CC_CONTROL_TOKEN (Machine): [" + [Environment]::GetEnvironmentVariable('CC_CONTROL_TOKEN','Machine') + "]"
"OS env CC_CONTROL_TOKEN (User): [" + [Environment]::GetEnvironmentVariable('CC_CONTROL_TOKEN','User') + "]"
"Process-level env CC_CONTROL_TOKEN: [" + $env:CC_CONTROL_TOKEN + "]"
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*command-center-server.mjs*' }
if ($procs) { $procs | ForEach-Object { "Killing dashboard PID " + $_.ProcessId; Stop-Process -Id $_.ProcessId -Force } } else { "No command-center-server.mjs process was running." }
Start-Sleep -Seconds 7
$after = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*command-center-server.mjs*' }
if ($after) { "Dashboard respawned: PID(s) " + ($after.ProcessId -join ', ') } else { "Dashboard NOT respawned (ecosystem-manager may not be running)." }
"=== done ==="
