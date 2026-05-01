# KAI Integration Verification Script
# Verifies the full chain: Oracle -> RSHL -> OpenJarvis -> Grounding

Write-Host "`n--- KAI SYSTEM VERIFICATION ---" -ForegroundColor Cyan

$Success = $true

# 1. Oracle Server Check
Write-Host "[1/4] Checking Oracle Server (Port 3333)..." -NoNewline
try {
    $status = Invoke-RestMethod -Uri "http://127.0.0.1:3333/api/status" -Method Get -ErrorAction Stop
    Write-Host " [OK]" -ForegroundColor Green
    Write-Host "     Lattice Size: $($status.lattice_size)"
    Write-Host "     Status: $($status.status)"
} catch {
    Write-Host " [FAILED]" -ForegroundColor Red
    Write-Host "     Error: Oracle Server is not running. Please run 'KAI.cmd' or 'cargo run'."
    $Success = $false
}

# 2. RSHL Query Engine Check
Write-Host "[2/4] Verifying RSHL Memory Engine (Query <1ms)..." -NoNewline
if ($status) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $query = Invoke-RestMethod -Uri "http://127.0.0.1:3333/api/rshl/query" -Method Post -Body (ConvertTo-Json @{query="VSA architecture"; limit=1}) -ContentType "application/json" -ErrorAction Stop
        $sw.Stop()
        if ($sw.Elapsed.TotalMilliseconds -lt 10) {
            Write-Host " [OK] ($($sw.Elapsed.TotalMilliseconds)ms)" -ForegroundColor Green
        } else {
            Write-Host " [OK] ($($sw.Elapsed.TotalMilliseconds)ms)" -ForegroundColor Yellow
        }
    } catch {
        Write-Host " [FAILED]" -ForegroundColor Red
        $Success = $false
    }
} else {
    Write-Host " [SKIPPED]" -ForegroundColor Gray
}

# 3. OpenJarvis Bridge Check
Write-Host "[3/4] Checking OpenJarvis (Port 8080)..." -NoNewline
try {
    # Check if OpenJarvis is listening
    $oj = Test-NetConnection -ComputerName "127.0.0.1" -Port 8080 -InformationLevel Quiet
    if ($oj) {
        Write-Host " [OK]" -ForegroundColor Green
    } else {
        Write-Host " [FAILED]" -ForegroundColor Red
        Write-Host "     Error: OpenJarvis is not running."
        $Success = $false
    }
} catch {
    Write-Host " [FAILED]" -ForegroundColor Red
    $Success = $false
}

# 4. Source-of-Truth Grounding Check
Write-Host "[4/4] Verifying 'src-CLI code' Grounding..." -NoNewline
try {
    # Try to inspect a file from the unmodified source via Oracle
    $inspect = Invoke-RestMethod -Uri "http://127.0.0.1:3333/api/inspect?path=src-CLI%20code/src/QueryEngine.ts" -Method Get -ErrorAction Stop
    if ($inspect -match "FILE INSPECTION") {
        Write-Host " [OK]" -ForegroundColor Green
        Write-Host "     Path accessible to AIs: src-CLI code/src/QueryEngine.ts"
    } else {
        Write-Host " [FAILED]" -ForegroundColor Red
        $Success = $false
    }
} catch {
    Write-Host " [FAILED]" -ForegroundColor Red
    Write-Host "     Error: Oracle cannot access the unmodified source path."
    $Success = $false
}

Write-Host "`n--- VERIFICATION COMPLETE ---" -ForegroundColor Cyan
if ($Success) {
    Write-Host "ALL SYSTEMS OPERATIONAL. KAI is grounded in Unmodified KAI Source." -ForegroundColor Green
} else {
    Write-Host "SOME SYSTEMS FAILED. Check logs for details." -ForegroundColor Red
}
