@echo off
rem SCUTTLE (in-folder launcher) - delegates to the ONE canonical launcher so double-clicking this does
rem EXACTLY what the Desktop SCUTTLE icon does: serve the LIVE dev build (current source, never stale) in
rem a dedicated-profile browser window on the discrete GPU. See play-scuttle.ps1 for the full why.
rem The old behaviour here (`git switch main` + open the DEFAULT browser) is GONE: switching branches in
rem this SHARED working dir clobbers sibling worktrees, and the default browser carries the stale-GPU
rem profile. The primary stays on main by workflow policy, not by a launcher hop.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0play-scuttle.ps1"
