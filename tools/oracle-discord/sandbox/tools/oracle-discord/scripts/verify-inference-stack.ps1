# KAI Inference Stack Verification
# Validates all active inference endpoints in the ecosystem

Write-Host "`n[KAI INFERENCE STACK VERIFICATION]" -ForegroundColor Cyan
Write-Host "=" * 60

# 1. Check Groq Cloud API
Write-Host "`n[1/4] Verifying Groq Cloud Endpoint..." -ForegroundColor Yellow
node c:/KAI/tools/oracle-discord/shared/groq-health-check.mjs
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Groq cloud endpoint failed" -ForegroundColor Red
    exit 1
}

# 2. Check Ollama Local Inference
Write-Host "`n[2/4] Checking Ollama Service..." -ForegroundColor Yellow
try {
    $ollamaHealth = Invoke-RestMethod -Uri "http://localhost:11434/api/tags" -Method GET -ErrorAction Stop
    $modelCount = $ollamaHealth.models.Count
    Write-Host "✅ Ollama responding: $modelCount models available" -ForegroundColor Green
} catch {
    Write-Host "❌ Ollama not responding on port 11434" -ForegroundColor Red
    Write-Host "   Run: ollama serve" -ForegroundColor Yellow
}

# 3. Check Oracle RSHL Server
Write-Host "`n[3/4] Checking Oracle RSHL Server..." -ForegroundColor Yellow
try {
    $rshlHealth = Invoke-RestMethod -Uri "http://localhost:3334/lattice/status" -Method GET -ErrorAction Stop
    Write-Host "✅ RSHL lattice responding" -ForegroundColor Green
    Write-Host "   Active agents: $($rshlHealth.active_agents -join ', ')" -ForegroundColor Gray
} catch {
    Write-Host "❌ RSHL server not responding on port 3334" -ForegroundColor Red
    Write-Host "   Run: cd c:/KAI && cargo run --release --bin oracle_server" -ForegroundColor Yellow
}

# 4. Check OpenJarvis Python Backend
Write-Host "`n[4/4] Checking OpenJarvis Backend..." -ForegroundColor Yellow
try {
    $jarvisHealth = Invoke-RestMethod -Uri "http://localhost:8080/health" -Method GET -ErrorAction Stop -TimeoutSec 3
    Write-Host "✅ OpenJarvis responding" -ForegroundColor Green
} catch {
    Write-Host "❌ OpenJarvis not responding on port 8080" -ForegroundColor Red
    Write-Host "   Run: cd c:/KAI/OpenJarvis-main && python -m openjarvis" -ForegroundColor Yellow
}

# 5. Port Binding Summary
Write-Host "`n[PORT BINDING SUMMARY]" -ForegroundColor Cyan
Write-Host "=" * 60
$ports = @(3334, 8080, 11434, 3410, 3400, 3420)
foreach ($port in $ports) {
    $binding = netstat -ano | Select-String ":$port.*LISTENING"
    if ($binding) {
        Write-Host "✅ Port $port LISTENING" -ForegroundColor Green
    } else {
        Write-Host "❌ Port $port NOT BOUND" -ForegroundColor Red
    }
}

Write-Host "`n[VERIFICATION COMPLETE]`n" -ForegroundColor Cyan
