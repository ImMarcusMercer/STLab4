@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 goto failed

where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed or is not on PATH. See README.md for prerequisites.
  goto failed
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo npm is not installed or is not on PATH. See README.md for prerequisites.
  goto failed
)

if not exist "node_modules\.bin\electron-vite.cmd" (
  echo Installing project dependencies...
  call npm.cmd ci
  if errorlevel 1 goto failed
)

if not exist ".env" goto setup_database
if not exist ".local\postgres\PG_VERSION" goto setup_database

echo Starting local database...
call npm.cmd run db:start
if errorlevel 1 goto failed
goto prepare_database

:setup_database
echo Setting up local database...
call npm.cmd run db:setup
if errorlevel 1 goto failed

:prepare_database
echo Applying database migrations...
call npm.cmd run db:migrate
if errorlevel 1 goto failed

echo Checking the owner account and role permissions...
call npm.cmd run db:seed
if errorlevel 1 goto failed

echo Starting the BCIS API and desktop app...
call npm.cmd run dev

echo.
echo BCIS has stopped. If this was unexpected, review the messages above.
echo The local database is still running.
echo To stop it later, run: npm.cmd run db:stop
pause
exit /b 0

:failed
echo.
echo BCIS could not start. Review the error above and README.md.
pause
exit /b 1
