@echo off
rem ── SCUTTLE launcher ──────────────────────────────────────────────────────
rem Double-click (or the Desktop shortcut) starts the Vite dev server and opens
rem the game in your default browser. Close this window to stop the game.
rem `%~dp0` is this script's own folder, so the shortcut keeps working even if
rem the project is moved.
title SCUTTLE
cd /d "%~dp0"

echo.
echo   Starting SCUTTLE...
echo   Folder : %~dp0
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
