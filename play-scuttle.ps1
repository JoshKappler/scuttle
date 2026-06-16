# SCUTTLE — play the LIVE dev build on the correct GPU. (Desktop-icon launcher.)
#
# WHY this exists (the recurring "stale game" trap, root-caused 2026-06-16):
#   • The desktop EXE is a FROZEN snapshot — stale until re-wrapped with `npm run dist`. Relaunching
#     the dev server / hard-refreshing a browser does NOTHING to it, because the EXE is a separate
#     delivery path. That is the circle we kept running in.
#   • A long-lived DAILY browser profile caches a degraded GPU state — the bogus "GTX 980" + ~20 fps,
#     when the real card is an RTX 5080 (a freshly-launched profile on the same PC reports the 5080 and
#     runs ~180 fps).
# This launcher serves the live Vite dev server (ALWAYS current source — no build step, never stale)
# in a DEDICATED-profile Chrome, so the GPU process is fresh (the real discrete GPU) and nothing caches.
$ErrorActionPreference = 'SilentlyContinue'
$root = $PSScriptRoot
Set-Location $root

# 1) Ensure the Vite dev server (current source) is up on 5173. Run it from THIS folder so 5173 serves
#    the main working tree (strictPort = always 5173, fails loudly rather than serving a stale port).
if (-not (Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue)) {
  Write-Host 'SCUTTLE: starting the dev server on http://localhost:5173 ...'
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'npm run dev' -WorkingDirectory $root -WindowStyle Minimized
} else {
  Write-Host 'SCUTTLE: dev server already running on 5173 (reusing it).'
}

# 2) Wait until it actually serves a page.
$ok = $false
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  try { Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:5173' -TimeoutSec 2 | Out-Null; $ok = $true; break }
  catch { Start-Sleep -Milliseconds 400 }
}
if (-not $ok) {
  Write-Host 'SCUTTLE: the dev server did not come up. Open a terminal here and run "npm run dev" to see the error.'
  Start-Sleep 8; exit 1
}

# 3) Launch a DEDICATED-profile Chrome (fresh GPU state = the real discrete GPU, never the cached
#    degraded one; isolated cache = never stale) in app mode, forcing the high-performance GPU
#    (same switches the EXE used). Falls back to Edge if Chrome is absent.
$browser = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) {
  $browser = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $browser) { Write-Host 'SCUTTLE: no Chrome or Edge found.'; Start-Sleep 8; exit 1 }

$profileDir = Join-Path $env:LOCALAPPDATA 'scuttle-play-profile'
$browserArgs = @(
  '--app=http://localhost:5173',
  "--user-data-dir=$profileDir",
  '--force_high_performance_gpu', # pick the dGPU on hybrid rigs (mirrors the EXE)
  '--ignore-gpu-blocklist',       # don't shove a brand-new card to software
  '--new-window'
)
Start-Process -FilePath $browser -ArgumentList $browserArgs
Write-Host "SCUTTLE: launched the live build in a fresh-profile window ($([System.IO.Path]::GetFileName($browser)))."
