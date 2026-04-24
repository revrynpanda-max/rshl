$ErrorActionPreference = 'Stop'
$src = 'C:\KAI\kai-rust\data\kai-state.json'
$out = 'C:\KAI\kai-rust\data\cells-manifest.json'

Write-Host "Reading $src ..."
$raw = [System.IO.File]::ReadAllText($src)
Write-Host ('  size: ' + $raw.Length + ' bytes')

Write-Host "Parsing JSON ..."
$state = $raw | ConvertFrom-Json

$cells = $state.universe.cells
Write-Host ('  cells: ' + $cells.Count)

$manifest = @{
    version = 1
    source_dim = 4096
    target_dim = 16384
    exported_at = (Get-Date -Format "yyyy-MM-ddTHH:mm:ss")
    cells = @()
}

foreach ($c in $cells) {
    $manifest.cells += @{
        text       = $c.text
        region     = $c.region
        source     = $c.source
        strength   = $c.strength
        created    = $c.created
        last_fired = $c.last_fired
    }
}

Write-Host "Writing $out ..."
$json = $manifest | ConvertTo-Json -Depth 10 -Compress
[System.IO.File]::WriteAllText($out, $json)
Write-Host ('  out size: ' + $json.Length + ' bytes')
Write-Host ('  cell count: ' + $manifest.cells.Count)

# Quick sanity: count cells by source
$bySource = $manifest.cells | Group-Object -Property source | Sort-Object Count -Descending | Select-Object -First 10
Write-Host ""
Write-Host "Top source distribution:"
$bySource | Format-Table Count, Name -AutoSize
