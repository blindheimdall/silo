@echo off
cd /d "%~dp0"
echo SILO - Agentic world system
echo Open http://127.0.0.1:3000 in your browser.
echo Keep this window open for agents and scheduled workflows.
echo Press Ctrl+C to stop.
node server.mjs
if errorlevel 1 pause
