@echo off
cd /d C:\Users\lenovo\WBS

start cmd /k npm run dev
timeout /t 3 > nul

start http://localhost:5173/