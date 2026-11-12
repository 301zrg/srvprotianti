@echo off
setlocal
if "%~5"=="" (
  echo Usage: validate-recovery.cmd PYTHON PG_BIN NEW_WORKDIR SUFFIX LOOPBACK_PORT
  echo Uses a pre-created isolated PostgreSQL cluster. No production or PM2 changes.
  exit /b 2
)
set "PGHOST=127.0.0.1"
set "PGPORT=%~5"
set "PGOPTIONS="
"%~1" "%~dp0drill.py" --server-source "%~dp0..\.." --pg-bin "%~2" --workdir "%~3" --suffix "%~4" --confirm-isolated-cluster "127.0.0.1:%~5"
exit /b %errorlevel%
