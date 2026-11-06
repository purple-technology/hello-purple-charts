@echo off
rem Starts the local chart server (127.0.0.1 only) and opens it in your browser.
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo The Python environment is missing. See BUILD_NOTES.md, "How to set it up again".
  exit /b 1
)
if not exist "node_modules\lightweight-charts" (
  echo The chart library is missing. Run: npm install
  exit /b 1
)
".venv\Scripts\python.exe" server.py %*
