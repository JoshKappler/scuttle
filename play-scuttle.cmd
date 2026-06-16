@echo off
rem SCUTTLE launcher: serves the LIVE dev build (always current, never stale, no EXE re-wrapping)
rem in a dedicated-profile Chrome forced onto the discrete GPU (no cached "GTX 980" / stale-cache trap).
rem See play-scuttle.ps1 for the full why. Close the minimized "dev server" window to stop the game.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0play-scuttle.ps1"
