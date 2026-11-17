@echo off
setlocal
rem Double-click this file to download a private copy of your Autopilot workspace.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Export-AutopilotWorkspace.ps1" %*
echo.
pause
