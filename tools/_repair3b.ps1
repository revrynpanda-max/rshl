$path = 'C:\KAI\kai-rust\src\core\universe.rs'
$raw = [System.IO.File]::ReadAllText($path)
$orig_len = $raw.Length

# Section with warm_continuation_fuzzy uses LF only.
$old1 = "        let input_vec = SparseVec::encode(input_text).permute(1);`n        let stamp = current_tick.max(1);`n"
if (-not $raw.Contains($old1)) { Write-Host 'anchor 1 not found'; exit 1 }
$new1 = "        let input_vec = SparseVec::encode(input_text).permute(1);`n        let _ = current_tick;`n"
$raw = $raw.Replace($old1, $new1)
Write-Host 'anchor 1 replaced'

$old2 = "            cell.last_fired = stamp;`n            hits += 1;`n"
if (-not $raw.Contains($old2)) { Write-Host 'anchor 2 not found'; exit 2 }
$new2 = "            // Do NOT touch cell.last_fired from the warm path.`n            // Recency should only activate from live firings.`n            hits += 1;`n"
$raw = $raw.Replace($old2, $new2)
Write-Host 'anchor 2 replaced'

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
