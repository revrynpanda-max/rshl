# Pure fleet-health predicates — imported by launchers and tested in-repo.
param()

function Test-FleetEngineReady {
    try { return ((Invoke-WebRequest 'http://127.0.0.1:3334/api/session' -TimeoutSec 3 -UseBasicParsing).StatusCode -eq 200) }
    catch { return $false }
}

function Test-FleetManagerPulse {
    param(
        [string]$StatePath = 'C:\KAI\tools\oracle-discord\state\ecosystem-manager.json',
        [int]$HeartbeatMaxSec = 45
    )
    if (-not (Test-Path $StatePath)) { return $false }
    try {
        $st = Get-Content $StatePath -Raw | ConvertFrom-Json
        $mgrOk = $false
        if ($st.managerPid) {
            $mgrOk = $null -ne (Get-Process -Id $st.managerPid -ErrorAction SilentlyContinue)
        }
        $hbOk = $false
        if ($st.updatedAt) {
            $hbOk = (((Get-Date) - [datetime]$st.updatedAt).TotalSeconds -lt $HeartbeatMaxSec)
        }
        $dashOk = [bool](netstat -ano | Select-String ':3001\s.*LISTENING')
        return ($mgrOk -and $hbOk -and $dashOk)
    } catch {
        return $false
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    Export-ModuleMember -Function Test-FleetManagerPulse -ErrorAction SilentlyContinue
}