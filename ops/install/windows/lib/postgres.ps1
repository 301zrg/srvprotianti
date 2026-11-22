# PostgreSQL and layout helpers for the Windows staged installer. ASCII only.
Set-StrictMode -Version 2.0

$script:PgBin = 'C:\Program Files\PostgreSQL\17\bin'
$script:PgSuper = $null
$script:RuntimePassword = $null
$script:MaintenancePassword = $null

function Initialize-Layout($Params) {
  $root = $Params.root
  $script:L = [ordered]@{
    Root = $root
    Release = $root + '\release'
    App = $root + '\release\application'
    Shared = $root + '\shared'
    SharedSlash = ($root + '\shared\').Replace('\', '/')
    Input = 'C:\srvpro-input'
    Boot = 'C:\srvpro-bootstrap-private'
    Private = 'C:\srvpro-private'
    Restores = 'C:\srvpro-restores'
    Pm2Home = 'C:\srvpro-pm2'
    Pm2Tools = 'C:\srvpro-tools\pm2'
    Svc = 'C:\srvpro-service'
    SvcCfg = 'C:\srvpro-service\windows-service.json'
    PassFile = 'C:\srvpro-private\ops.pgpass'
    Database = $Params.database
  }
}

function Get-PsqlExe { return ($script:PgBin + '\psql.exe') }

function Test-SuperPassword([string]$Password) {
  $r = Invoke-NativeCapture -Exe (Get-PsqlExe) -Arguments @('-X', '-w', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-At', '-c', 'SELECT 1') -Environment @{ PGPASSWORD = $Password } -TimeoutSeconds 60
  return ($r.Code -eq 0 -and $r.Out.Trim() -eq '1')
}

# The postgres password is asked at most once per run and kept only in memory.
function Get-SuperPassword {
  if ($script:PgSuper) { return $script:PgSuper }
  for ($i = 1; $i -le 3; $i++) {
    $value = Read-Secret 'PostgreSQL postgres password (set in stage 12)'
    if (Test-SuperPassword $value) { $script:PgSuper = $value; return $value }
    $value = $null
    Write-Host '  Login failed; try again'
  }
  Stop-Install 'postgres login failed three times'
}

# Runs SQL as postgres; the SQL (which may contain new role passwords) goes through stdin.
function Invoke-SuperSql([string]$Sql, [string]$Database = 'postgres', [switch]$Quiet) {
  $r = Invoke-NativeCapture -Exe (Get-PsqlExe) -Arguments @('-X', '-w', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-U', 'postgres', '-d', $Database, '-At', '-f', '-') -Environment @{ PGPASSWORD = (Get-SuperPassword) } -Stdin $Sql -TimeoutSeconds 300
  if ($r.Code -ne 0) {
    if ($Quiet) { Stop-Install 'A PostgreSQL statement failed (details withheld: the statement holds secrets)' }
    Stop-Install ('PostgreSQL failed: ' + $r.Err.Trim())
  }
  return $r.Out.Trim()
}

function Invoke-OperatorScalar([string]$Sql, [string]$Database = 'postgres') {
  $r = Invoke-NativeCapture -Exe (Get-PsqlExe) -Arguments @('-X', '-w', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-U', 'srvpro_operator', '-d', $Database, '-At', '-c', $Sql) -Environment @{ PGPASSFILE = $script:L.PassFile } -TimeoutSeconds 120
  if ($r.Code -ne 0) { return $null }
  return $r.Out.Trim()
}

function Test-DatabaseExists([string]$Name) {
  $n = Invoke-SuperSql ("SELECT count(*) FROM pg_database WHERE datname = '" + $Name + "'")
  return ($n -eq '1')
}

function Get-RuntimePassword {
  if ($script:RuntimePassword) { return $script:RuntimePassword }
  for ($i = 1; $i -le 3; $i++) {
    $value = Read-Secret 'PostgreSQL srvpro_runtime password (set in stage 31)'
    $r = Invoke-NativeCapture -Exe (Get-PsqlExe) -Arguments @('-X', '-w', '-h', '127.0.0.1', '-U', 'srvpro_runtime', '-d', 'postgres', '-At', '-c', 'SELECT 1') -Environment @{ PGPASSWORD = $value } -TimeoutSeconds 60
    if ($r.Code -eq 0) { $script:RuntimePassword = $value; return $value }
    $value = $null
    Write-Host '  Login failed; try again'
  }
  Stop-Install 'srvpro_runtime login failed three times'
}

# Operator identity for ops.py / schema.js; no secret in $env:, only the passfile path.
function Set-OperatorEnvironment {
  $env:PGHOST = '127.0.0.1'
  $env:PGPORT = '5432'
  $env:PGUSER = 'srvpro_operator'
  $env:PGPASSFILE = $script:L.PassFile
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}

function Clear-Secrets {
  $script:PgSuper = $null
  $script:RuntimePassword = $null
  $script:MaintenancePassword = $null
}

# ---------- maintenance ----------

function Get-MaintenanceArguments([string]$Action) {
  $script = $script:L.App + '\ops\scripts\maintenance.py'
  $a = @($script, $Action, '--port', [string]$script:Params.httpPort, '--message', $script:Params.maintenanceMessage)
  if ($script:Params.route -eq 'A') { return @($a + @('--username', $script:Params.managementUsername)) }
  $evidence = Get-StateProperty $script:State 'maintenanceAccountEvidence'
  if (-not $evidence) { Stop-Install 'Maintenance account not selected yet (stage 52)' }
  return @($a + @('--admin-file', ($script:L.App + '\config\admin_user.json'), '--account-evidence', $evidence))
}

# Returns the parsed status object. Route A asks for the maintenance password; route B
# reads the restored admin_user.json inside maintenance.py and prints nothing secret.
function Invoke-Maintenance([string]$Action) {
  $envs = @{}
  if ($script:Params.route -eq 'A') {
    if (-not $script:MaintenancePassword) { $script:MaintenancePassword = Read-Secret 'Maintenance (HTTP management) password' }
    $envs.MAINTENANCE_PASSWORD = $script:MaintenancePassword
  }
  $r = Invoke-NativeCapture -Exe 'python' -Arguments (Get-MaintenanceArguments $Action) -Environment $envs -TimeoutSeconds 60
  if ($r.Code -ne 0) {
    $script:MaintenancePassword = $null
    Stop-Install ('Maintenance ' + $Action + ' failed: ' + $r.Err.Trim())
  }
  $status = $r.Out.Trim() | ConvertFrom-Json
  Write-Step ('maintenance ' + $Action + ': maintenanceEnabled=' + $status.maintenanceEnabled + ' readyToStop=' + $status.readyToStop)
  return $status
}

function Wait-ReadyToStop([int]$Seconds = 600) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  while ($true) {
    $s = Invoke-Maintenance 'status'
    if ($s.maintenanceEnabled -and $s.readyToStop) { return }
    if ([DateTime]::UtcNow -gt $deadline) { Stop-Install 'Rooms are still open; ask players to leave, then run again' }
    Write-Host '  Waiting for open rooms to finish (no one is kicked)...'
    Start-Sleep -Seconds 15
  }
}

# ---------- structured JSON edits (lib/json-edit.cjs) ----------

function Invoke-JsonEdit([string]$File, [hashtable]$Request) {
  $Request.file = $File
  $body = $Request | ConvertTo-Json -Depth 10 -Compress
  $r = Invoke-NativeCapture -Exe 'node' -Arguments @((Join-Path $script:InstallLibDir 'json-edit.cjs')) -Stdin $body -TimeoutSeconds 60
  $body = $null
  if ($r.Code -ne 0) { Stop-Install ($r.Err.Trim()) }
  return ($r.Out.Trim() | ConvertFrom-Json)
}
