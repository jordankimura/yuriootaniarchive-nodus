@echo off
cd /d "%~dp0.."
start "" "http://127.0.0.1:5175/nodus-editor.html"
call npm run dev
pause
