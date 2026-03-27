@echo off
title Discord Music Bot
echo ========================================
echo   Avvio Discord Music Bot...
echo ========================================

cd /d "%~dp0/src"

if not exist "logs" mkdir logs

for /f "tokens=1-3 delims=/" %%a in ("%date%") do set d=%%c-%%b-%%a
set LOGFILE=logs\bot_%d%.log

echo   Log: %LOGFILE%
echo ========================================

node bot.js 2>&1 | powershell -Command "$input | Tee-Object -FilePath '%LOGFILE%' -Append"

pause