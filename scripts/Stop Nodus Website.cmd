@echo off
powershell.exe -NoProfile -File "%~dp0Stop Nodus Website.ps1"
if errorlevel 1 pause
