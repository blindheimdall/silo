@echo off
rem Installs SILO for this Windows user, without administrator rights. See installer\install.ps1 for options.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\install.ps1" %*
if errorlevel 1 pause
