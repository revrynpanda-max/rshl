# ============================================================================
#  Clean-Old-Projects.ps1  -  move regenerable build junk out of the old KAI
#  project folders (Kai 2.0, KAI-polyglot) so they take little space.
# ============================================================================
#  Targets ONLY disposable, regenerable build artifacts:
#     node_modules, dist, dist-portable, build, win-unpacked, .build-venv, .venv,
#     __pycache__, .pytest_cache, target, .zig-cache, obj
#  It does NOT touch any SOURCE code (.rs/.py/.go/.zig/.nim/.ts/.md), and it does
#  NOT touch current C:\KAI.
#
#  Default: MOVES the junk into C:\KAI_GARBAGE (reversible; you delete the garbage
#  folder later). Use -Delete to remove it outright instead.
#
#  Run:   .\Clean-Old-Projects.ps1            (move junk to C:\KAI_GARBAGE)
#         .\Clean-Old-Projects.ps1 -Delete    (delete junk outright)
#  v9.8.9
# ============================================================================
param([switch]$Delete)

$ErrorActionPreference = "SilentlyContinue"
$garbage   = "C:\KAI_GARBAGE"
$roots     = @("C:\Kai 2.0", "C:\KAI-polyglot")
$junkNames = @("node_modules","dist","dist-portable","build","win-unpacked",
               ".build-venv",".venv","__pycache__",".pytest_cache","target",".zig-cache","obj")

function ToGB($b) { if (-not $b) { return 0 }; return [math]::Round(($b / 1GB), 2) }
function DirBytes($p) { (Get-ChildItem -LiteralPath $p -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum }

# Find OUTERMOST junk dirs without descending into them (fast; skips million-file trees).
function Find-JunkRoots($base, $names) {
    $results = New-Object System.Collections.ArrayList
    $stack = New-Object System.Collections.Stack
    $stack.Push($base)
    while ($stack.Count -gt 0) {
        $dir = $stack.Pop()
        foreach ($sub in (Get-ChildItem -LiteralPath $dir -Directory -Force -ErrorAction SilentlyContinue)) {
            if ($names -contains $sub.Name) { [void]$results.Add($sub.FullName) }  # matched -> record, don't recurse in
            else { $stack.Push($sub.FullName) }
        }
    }
    return $results
}

Write-Host ""
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "  CLEAN-OLD-PROJECTS  -  $(if ($Delete) {'DELETE'} else {'MOVE to C:\KAI_GARBAGE'}) build junk" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "  Source code is NOT touched. Current C:\KAI is NOT touched." -ForegroundColor DarkGray

if (-not $Delete) { New-Item -ItemType Directory -Force -Path $garbage | Out-Null }
$freeBefore = (Get-PSDrive C).Free
$total = 0; $count = 0

foreach ($root in $roots) {
    if (-not (Test-Path $root)) { Write-Host "[skip] $root not found." -ForegroundColor DarkYellow; continue }
    Write-Host "Scanning $root ..." -ForegroundColor Yellow
    $junk = Find-JunkRoots $root $junkNames
    foreach ($j in $junk) {
        if (-not (Test-Path $j)) { continue }   # a parent already moved/deleted it
        $sz = DirBytes $j
        $total += $sz; $count++
        if ($Delete) {
            Remove-Item -Recurse -Force -LiteralPath $j
            Write-Host ("  deleted  {0}  ({1} GB)" -f $j, (ToGB $sz)) -ForegroundColor DarkGreen
        } else {
            $rel  = $j.Substring($root.Length).TrimStart('\') -replace '[\\/:]', '__'
            $name = (Split-Path $root -Leaf) -replace '[\\/: ]', '_'
            $dest = Join-Path $garbage ($name + "__" + $rel)
            Move-Item -Force -LiteralPath $j -Destination $dest
            Write-Host ("  moved    {0}  ({1} GB)" -f $j, (ToGB $sz)) -ForegroundColor DarkGreen
        }
    }
}

Start-Sleep -Milliseconds 500
$freeAfter = (Get-PSDrive C).Free
Write-Host ""
Write-Host ("Processed {0} junk folders, ~{1} GB." -f $count, (ToGB $total)) -ForegroundColor Green
if ($Delete) {
    Write-Host ("C: free: {0} GB -> {1} GB" -f (ToGB $freeBefore), (ToGB $freeAfter)) -ForegroundColor Green
} else {
    Write-Host ("Moved into C:\KAI_GARBAGE. Delete that folder (or run with -Delete next time) to reclaim the ~{0} GB." -f (ToGB $total)) -ForegroundColor Yellow
}
Write-Host "Your source code in Kai 2.0 / KAI-polyglot is intact (only build caches moved)." -ForegroundColor DarkGray
