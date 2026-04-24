# kai-bench.ps1
# Measures end-to-end latency for KAI v5.4 IPC server commands.

$kaiExe = ".\kai-rust\target\release\kai.exe"
if (-not (Test-Path $kaiExe)) {
    Write-Error "Could not find kai.exe at $kaiExe. Run 'cargo build --release' first."
    exit 1
}

Write-Host "`n╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   KAI v5.4 IPC Performance Benchmark                         ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan

# ── PING TEST ──────────────────────────────────────────────────────────────────
$start = Get-Date
$pingRaw = '{"cmd":"ping"}' | & $kaiExe --server
$end = Get-Date
$latency = ($end - $start).TotalMilliseconds
Write-Host "PING Latency: " -NoNewline
Write-Host "$([math]::Round($latency, 2)) ms" -ForegroundColor Green
Write-Host "Response: $pingRaw" -ForegroundColor Gray

# ── QUERY LATENCY (COGNITIVE RESONANCE) ───────────────────────────────────────
Write-Host "`nMeasuring Query Latency (10-run average)..."
$times = @()
for ($i = 0; $i -lt 10; $i++) {
    $t = Measure-Command {
        '{"cmd":"query","text":"quantum physics consciousness","n":5}' | & $kaiExe --server | Out-Null
    }
    $times += $t.TotalMilliseconds
}
$avg = ($times | Measure-Object -Average).Average
Write-Host "AVG Query Latency: " -NoNewline
Write-Host "$([math]::Round($avg, 2)) ms" -ForegroundColor Green

# ── MEMORY STORE LATENCY (HEBBIAN INTAKE) ────────────────────────────────────
Write-Host "`nMeasuring Store Latency..."
$tStore = Measure-Command {
    '{"cmd":"store","text":"The speed of light is 299792458 m/s","region":"reasoning","strength":1.5}' | & $kaiExe --server | Out-Null
}
Write-Host "Store Latency: " -NoNewline
Write-Host "$([math]::Round($tStore.TotalMilliseconds, 2)) ms" -ForegroundColor Green

# ── STATUS CHECK ──────────────────────────────────────────────────────────────
$status = '{"cmd":"status"}' | & $kaiExe --server
Write-Host "`nSystem Status:" -ForegroundColor Yellow
Write-Host $status -ForegroundColor Gray

Write-Host "`nBenchmark Complete." -ForegroundColor Cyan
