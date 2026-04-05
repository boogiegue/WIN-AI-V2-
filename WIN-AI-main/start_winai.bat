@echo off
cd /d "C:\Users\User2\Desktop\NBA AI Model\winai"
echo Running fetch_stats.py...
python fetch_stats.py
echo.
echo Starting WIN AI server...
node server.js