@echo off
rem ── SCUTTLE launcher ──────────────────────────────────────────────────────
rem Double-click (or the Desktop shortcut) starts the Vite dev server and opens
rem the game in your default browser. Close this window to stop the game.
rem `%~dp0` is this script's own folder, so the shortcut keeps working even if
rem the project is moved.
title SCUTTLE
cd /d "%~dp0"

rem ── This (primary) folder is LOCKED to main, so the desktop shortcut always runs main. ──────
rem If a stray checkout left it on another branch, hop back to main before launching.
rem No-op when already on main; fails quietly if there are local edits or git is unavailable.
set "SC_BRANCH="
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "SC_BRANCH=%%b"
if /I not "%SC_BRANCH%"=="main" (
  echo   Note: folder was on "%SC_BRANCH%" - switching to main ^(primary is locked to main^)...
  git switch main 2>nul || git checkout main 2>nul
)

echo.
echo   Starting SCUTTLE...
echo   Folder : %~dp0
echo   Branch : main   (primary is locked to main)
echo   URL    : http://localhost:5173   (always this port - strictPort)
echo   A browser tab will open automatically once the server is ready.
echo   Keep this window open while you play; close it to stop the game.
echo   If it says "Port 5173 is in use", close the other SCUTTLE window first.
echo.

call npm run dev -- --open

rem If the server exits (e.g. a crash or port in use), hold the window open so
rem the error stays readable instead of the window vanishing.
echo.
echo   SCUTTLE server stopped.
pause
