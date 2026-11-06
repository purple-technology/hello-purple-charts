@echo off
rem Runs all tests: read-only guard, privacy, drawing storage (Python)
rem and indicators + drawing geometry (JavaScript, via Node.js).
cd /d "%~dp0"
".venv\Scripts\python.exe" -m unittest discover -s tests -t . -v
if errorlevel 1 exit /b 1
node --test "tests/js/*.test.js"
