<#
  extract-kaiverse.ps1  -  split the KAIVERSE 3D explorer out of oracle.html
  into a standalone kaiverse.js, so future 3D work can never truncate the
  dashboard again.

  WHY: oracle.html is one ~8900-line file holding BOTH the dashboard and the
  KAIVERSE WebGL engine in a single <script>. Every edit to the 3D code has
  risked the whole dashboard. KAIVERSE's interface to the dashboard is thin:
  the dashboard calls nsActivate() and nsIngestOps(ops), and KAIVERSE reads the
  shared global `allOps`. So it can live in its own file, loaded right before
  </body> (after the main script, so shared globals exist).

  WHAT IT MOVES (marker-anchored, NOT line numbers):
    Region 1  : "/* ... 3D WebGL cosmic explorer (Three.js r128) ..."  -> the
                blank line before "LEARNING & DREAMS view: overnight pipeline"
    Region 2  : "/* ... KAIVERSE GLUE + MOBILE TOUCH ..."  -> the blank line
                before "kick off once the DOM is parsed"
  WHAT STAYS in oracle.html: everything else, incl. the _learnTf functions and
  the vitals/pipeline/dreams recovery tail and init() that sit BETWEEN the two
  KAIVERSE regions.

  SAFETY:
    * Default = DRY RUN. Writes kaiverse.js + oracle.html.NEW. Live file untouched.
    * Runs integrity checks on the rebuilt file; with -Commit it refuses to swap
      unless every check passes, and it backs up the live file first.
    * Reversible: restore the printed .bak over oracle.html to undo.

  USAGE:
    powershell -ExecutionPolicy Bypass -File C:\KAI\extract-kaiverse.ps1
    powershell -ExecutionPolicy Bypass -File C:\KAI\extract-kaiverse.ps1 -Commit
#>
param([switch]$Commit)
$ErrorActionPreference = 'Stop'

$src    = 'C:\KAI\oracle.html'
$kvOut  = 'C:\KAI\kaiverse.js'
$newOut = 'C:\KAI\oracle.html.NEW'

Write-Host "== extract-kaiverse ==" -ForegroundColor Cyan
Write-Host "Source: $src"

$raw = [System.IO.File]::ReadAllText($src)
$nl  = if ($raw -match "`r`n") { "`r`n" } else { "`n" }
$lines = $raw -split "`r?`n"
Write-Host ("Read {0} lines (newline = {1})" -f $lines.Count, $(if($nl -eq "`r`n"){'CRLF'}else{'LF'}))

function FindIdx([string]$needle) {
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i].Contains($needle)) { return $i }
  }
  return -2   # -2 so (-2 - 1) stays clearly invalid
}

# Marker-anchored region boundaries (all ASCII substrings, unique in the file)
$r1s = (FindIdx '3D WebGL cosmic explorer (Three.js r128)') - 1   # the /* banner opener line
$r1e = (FindIdx 'LEARNING & DREAMS view: overnight pipeline') - 1 # blank line ending region 1
$r2s = (FindIdx 'KAIVERSE GLUE + MOBILE TOUCH') - 1               # the /* banner opener line
$r2e = (FindIdx 'kick off once the DOM is parsed') - 1            # blank line ending region 2

Write-Host ("Region 1: lines {0}-{1}" -f ($r1s+1), ($r1e+1))
Write-Host ("Region 2: lines {0}-{1}" -f ($r2s+1), ($r2e+1))

if ($r1s -lt 0 -or $r1e -le $r1s -or $r2s -le $r1e -or $r2e -le $r2s -or $r2e -ge $lines.Count) {
  throw "Marker boundaries invalid or out of order (r1s=$r1s r1e=$r1e r2s=$r2s r2e=$r2e). Aborting - file unchanged."
}

# Build kaiverse.js
$kvHeader = @(
  '/* ============================================================================',
  '   kaiverse.js  --  KAIVERSE 3D cosmic explorer, extracted from oracle.html.',
  '   Loaded by oracle.html via <script src="kaiverse.js"> right before </body>,',
  '   AFTER the main dashboard script, so it can read shared globals (allOps, $,',
  '   esc, api, ...). Defines the thin interface the dashboard calls: nsActivate(),',
  '   nsIngestOps(ops). Region 1 = 3D engine; Region 2 = activation + touch glue.',
  '   To edit the 3D world, edit THIS file -- the dashboard cannot be truncated by it.',
  '   ============================================================================ */',
  ''
)
$region1 = $lines[$r1s..$r1e]
$region2 = $lines[$r2s..$r2e]
$kvLines = $kvHeader + $region1 + @('') + $region2
[System.IO.File]::WriteAllText($kvOut, ($kvLines -join $nl))
Write-Host ("Wrote {0} ({1} lines)" -f $kvOut, $kvLines.Count) -ForegroundColor Green

# Build new oracle.html: before R1 + between R1/R2 + after R2, with the <script> tag before </body>
$before = $lines[0..($r1s-1)]
$middle = $lines[($r1e+1)..($r2s-1)]
$after  = $lines[($r2e+1)..($lines.Count-1)]
$rebuilt = @($before) + @($middle) + @($after)

$bodyIdx = -1
for ($i = $rebuilt.Count-1; $i -ge 0; $i--) {
  if ($rebuilt[$i] -match '</body>') { $bodyIdx = $i; break }
}
if ($bodyIdx -lt 0) { throw "No </body> found in rebuilt file. Aborting." }

$scriptTag = '<script src="kaiverse.js"></script>'
$newLines = @($rebuilt[0..($bodyIdx-1)]) + @($scriptTag) + @($rebuilt[$bodyIdx..($rebuilt.Count-1)])
$newText = $newLines -join $nl
[System.IO.File]::WriteAllText($newOut, $newText)
Write-Host ("Wrote {0} ({1} lines)" -f $newOut, $newLines.Count) -ForegroundColor Green

# ---- Integrity checks ----
Write-Host "`n-- integrity checks --" -ForegroundColor Cyan
$script:ok = $true
function chk([bool]$cond, [string]$msg) {
  if ($cond) { Write-Host "  [OK]   $msg" }
  else       { Write-Host "  [FAIL] $msg" -ForegroundColor Red; $script:ok = $false }
}
$kvText = $kvLines -join $nl
chk ($newText.TrimEnd().EndsWith('</html>'))                              'oracle.html.NEW ends with </html>'
chk ($newText.Contains('</body>'))                                       'has </body>'
chk ($newText.Contains('<script src="kaiverse.js"></script>'))           'kaiverse.js script tag inserted'
chk (-not $newText.Contains('3D WebGL cosmic explorer (Three.js r128)')) 'Region 1 removed from dashboard'
chk (-not $newText.Contains('KAIVERSE GLUE + MOBILE TOUCH'))             'Region 2 removed from dashboard'
chk ($newText.Contains('LEARNING & DREAMS view: overnight pipeline'))    'dashboard recovery tail still present'
chk ($newText.Contains('function init('))                                'init() still present'
chk ($newText.Contains('renderVitalsCard'))                              'renderVitalsCard still present'
# Count only REAL opening tags (start of line, optional indent) so a literal
# "<script" inside a code comment (e.g. "truncated mid-<script>") doesn't inflate the count.
$openS  = ([regex]::Matches($newText,  '(?m)^[ \t]*<script')).Count
$closeS = ([regex]::Matches($newText, '</script>')).Count
chk ($openS -eq $closeS)                                                 "script tags balanced ($openS open / $closeS close)"
chk ($kvText.Contains('function nsIngestOps'))                           'kaiverse.js contains nsIngestOps'
chk ($kvText.Contains('kvGlueRecovery'))                                 'kaiverse.js contains glue/touch layer'
chk ($kvText.Contains('3D WebGL cosmic explorer (Three.js r128)'))       'kaiverse.js contains Region 1 engine'

if (-not $script:ok) {
  Write-Host "`nINTEGRITY CHECKS FAILED. Live oracle.html NOT touched. Review oracle.html.NEW." -ForegroundColor Red
  exit 1
}
Write-Host "`nAll integrity checks PASSED." -ForegroundColor Green

if ($Commit) {
  $ts  = Get-Date -Format 'yyyyMMdd-HHmmss'
  $bak = "$src.pre-kaiverse-extract.$ts.bak"
  Copy-Item -LiteralPath $src -Destination $bak -Force
  Move-Item -LiteralPath $newOut -Destination $src -Force
  Write-Host "`nCOMMITTED." -ForegroundColor Green
  Write-Host "  Backup : $bak"
  Write-Host "  Live   : $src  (KAIVERSE now external)"
  Write-Host "  Module : $kvOut"
  Write-Host "`nNEXT: restart the dashboard (or full fleet) so the /kaiverse.js route is live,"
  Write-Host "      then hard-refresh the dashboard (Ctrl+Shift+R)."
} else {
  Write-Host "`nDRY RUN complete - live oracle.html untouched." -ForegroundColor Yellow
  Write-Host "Wrote: $kvOut  and  $newOut"
  Write-Host "Review them, then re-run with -Commit to swap in:"
  Write-Host "  powershell -ExecutionPolicy Bypass -File C:\KAI\extract-kaiverse.ps1 -Commit"
}
