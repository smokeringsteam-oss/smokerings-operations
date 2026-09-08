@echo off
cd /d "D:\Personal GIT\SmokeRingsBBQ Automation"
echo ---- PREPARE %DATE% %TIME% ---- >> "D:\Personal GIT\SmokeRingsBBQ Automation\server\uploads\reels\scheduled-post.log"
"C:\Program Files\nodejs\node.exe" "D:\Personal GIT\SmokeRingsBBQ Automation\server\scripts\schedulePost.js" prepare reel-1788768733693-small.mp4 --caption-file "D:\Personal GIT\SmokeRingsBBQ Automation\server\uploads\reels\caption.txt" --target reel >> "D:\Personal GIT\SmokeRingsBBQ Automation\server\uploads\reels\scheduled-post.log" 2>&1
