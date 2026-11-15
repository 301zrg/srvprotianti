# Scheduled-task entry point. Runs as the non-administrator service account, never as admin.
#   -Mode Start      first start on a machine without a PM2 daemon, then pm2 save
#   -Mode Save       re-save the process list of the running own daemon
#   -Mode Stop       stop the application, keep the daemon for offline backup
#   -Mode Resurrect  boot recovery from dump.pm2 (Startup task)
# Exit code 0 only when the mode completed and the application ports accept connections
# (Save: dump verified; Stop: application stopped and ports closed).
param(
  [Parameter(Mandatory = $true)][ValidateSet('Start','Save','Resurrect','Stop')][string]$Mode,
  [Parameter(Mandatory = $true)][string]$ConfigPath
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'srvpro-service.lib.ps1')

$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
try {
  $cfg = Read-SrvproServiceConfig $ConfigPath
  Assert-SrvproConfigFilesExist $cfg
  $script:SrvproLogFile = $cfg.logDir + '\service-' + $Mode.ToLowerInvariant() + '-' + $stamp + '.log'
  Write-SrvproLog ('mode=' + $Mode + ' user=' + [Security.Principal.WindowsIdentity]::GetCurrent().Name + ' app=' + $cfg.appName)
  Assert-SrvproServiceIdentity $cfg
  $env:PM2_HOME = $cfg.pm2Home
  $env:PYTHONUTF8 = '1'
  $env:PATH = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  # The game reads its database settings from its own config; inherited libpq variables must not leak in.
  foreach ($key in @('PGPASSWORD','PGPASSFILE','PGUSER','PGHOST','PGPORT','PGOPTIONS','PGDATABASE','PGSERVICE')) {
    [Environment]::SetEnvironmentVariable($key, $null, 'Process')
  }
  Set-Location -LiteralPath $cfg.applicationDir
  Invoke-SrvproServiceMode $cfg $Mode $stamp
  Write-SrvproLog 'result=0'
  exit 0
} catch {
  $message = $_.Exception.Message
  try { Write-SrvproLog ('result=1 error=' + $message) } catch { [Console]::Error.WriteLine($message) }
  exit 1
}
