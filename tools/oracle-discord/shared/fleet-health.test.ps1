$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\fleet-health.ps1"

$tmp = Join-Path $env:TEMP "kai-fleet-health-test-$PID.json"
@{
    managerPid = $PID
    updatedAt  = (Get-Date).ToString('o')
    children   = @()
} | ConvertTo-Json | Set-Content $tmp -Encoding utf8

$full = Test-FleetManagerPulse -StatePath $tmp -HeartbeatMaxSec 45
$st = Get-Content $tmp -Raw | ConvertFrom-Json
$mgrOk = $null -ne (Get-Process -Id $st.managerPid -ErrorAction SilentlyContinue)
$hbOk = (((Get-Date) - [datetime]$st.updatedAt).TotalSeconds -lt 45)
Remove-Item $tmp -Force -ErrorAction SilentlyContinue

if (-not ($mgrOk -and $hbOk)) {
    Write-Error "FAIL fleet-health: mgrOk=$mgrOk hbOk=$hbOk"
    exit 1
}

if ($full) {
    Write-Host "PASS fleet-health full pulse"
} else {
    Write-Host "PASS fleet-health mgr+heartbeat"
}
exit 0