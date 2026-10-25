@echo off
rem Wi-Fi link for the Model Viewer phone app: serves the app and everything in "exports".
cd /d "%~dp0"
python tools\serve.py
pause
