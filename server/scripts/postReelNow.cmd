@echo off
cd /d "D:\Personal GIT\SmokeRingsBBQ Automation"
echo ---- %DATE% %TIME% ---- >> "D:\Personal GIT\SmokeRingsBBQ Automation\server\uploads\reels\scheduled-post.log"
"C:\Program Files\nodejs\node.exe" "D:\Personal GIT\SmokeRingsBBQ Automation\server\scripts\schedulePost.js" publish >> "D:\Personal GIT\SmokeRingsBBQ Automation\server\uploads\reels\scheduled-post.log" 2>&1
