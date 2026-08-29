@echo off
REM Scheduled-task wrapper for the AI SEO sweep (see runAiSeoSweep.js).
REM
REM Exists so Task Scheduler points at one path instead of a long quoted
REM command line: schtasks mangles nested quotes, and the project path has a
REM space in it. Also fixes the working directory, which a scheduled task does
REM not inherit -- without the cd, .env and the knowledge-base CSVs are not
REM found.
REM
REM Register it (weekly, Monday 6am):
REM   schtasks /create /tn "SmokeRings AI SEO sweep" /sc weekly /d MON /st 06:00 /tr "%~f0"
REM Run it once by hand:            schtasks /run /tn "SmokeRings AI SEO sweep"
REM Check when it last ran and why: schtasks /query /tn "SmokeRings AI SEO sweep" /v /fo list
REM Remove it:                      schtasks /delete /tn "SmokeRings AI SEO sweep" /f

REM The script's output has em-dashes and ellipses in it; without UTF-8 the
REM redirected log fills up with mojibake.
chcp 65001 >nul

cd /d "%~dp0..\.."
if not exist "server\logs" mkdir "server\logs"

echo. >> "server\logs\aiseo-sweep.log"
echo ===== sweep started %DATE% %TIME% ===== >> "server\logs\aiseo-sweep.log"
call npm run --silent aiseo:sweep >> "server\logs\aiseo-sweep.log" 2>&1
echo ===== exit code %ERRORLEVEL% ===== >> "server\logs\aiseo-sweep.log"

exit /b %ERRORLEVEL%
