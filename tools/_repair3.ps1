$path = 'C:\KAI\kai-rust\src\core\universe.rs'
$raw = [System.IO.File]::ReadAllText($path)
$orig_len = $raw.Length

if ($raw.Contains("`r`n")) { $eol = "`r`n" } else { $eol = "`n" }

# --- replace 1: strip stamp declaration from warm_continuation_fuzzy ---
$old = @'
        let input_vec = SparseVec::encode(input_text).permute(1);
        let stamp = current_tick.max(1);
'@
$old = ($old -replace "`r`n", "`n") -replace "`n", $eol
if (-not $raw.Contains($old)) { Write-Host "anchor 1 not found"; exit 1 }

$new = @'
        let input_vec = SparseVec::encode(input_text).permute(1);
        let _ = current_tick;
'@
$new = ($new -replace "`r`n", "`n") -replace "`n", $eol
$raw = $raw.Replace($old, $new)
Write-Host 'stamp decl replaced'

# --- replace 2: remove cell.last_fired assignment ---
$old2 = @'
            cell.last_fired = stamp;
            hits += 1;
'@
$old2 = ($old2 -replace "`r`n", "`n") -replace "`n", $eol
if (-not $raw.Contains($old2)) { Write-Host "anchor 2 not found"; exit 2 }

$new2 = @'
            // Do NOT touch cell.last_fired from the warm path.
            // Recency should only activate from live firings.
            hits += 1;
'@
$new2 = ($new2 -replace "`r`n", "`n") -replace "`n", $eol
$raw = $raw.Replace($old2, $new2)
Write-Host 'last_fired assign removed'

$tmp = "$path.newpatched"
[System.IO.File]::WriteAllText($tmp, $raw)

$attempts = 0
while ($attempts -lt 20) {
    try {
        $bak = "$path.pre_repair3.bak"
        if (Test-Path $bak) { Remove-Item $bak -Force }
        Move-Item -Path $path -Destination $bak -Force -ErrorAction Stop
        Move-Item -Path $tmp -Destination $path -Force -ErrorAction Stop
        $newlen = (Get-Item $path).Length
        Write-Host ('swap OK ' + $newlen + ' bytes, was ' + $orig_len)
        break
    } catch {
        $attempts++
        Start-Sleep -Milliseconds 500
        if ($attempts -ge 20) { Write-Host 'swap failed'; exit 3 }
    }
}
