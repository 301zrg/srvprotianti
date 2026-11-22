# Stages 31-34: private directory, roles, database, init or restore, runtime check (manual section 3). ASCII only.
Set-StrictMode -Version 2.0

$script:RoleSql = @'
CREATE ROLE srvpro_schema NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE srvpro_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE srvpro_operator LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT srvpro_schema TO srvpro_operator;
'@

function Get-SchemaJs { return ($script:L.App + '\plugins\postgres-compat\deployment\schema.js') }

# ---- 31 ----
function R31-Private {
  New-PrivateDirectory $script:L.Private
  New-Item -ItemType Directory -Path ($script:L.Private + '\reports') | Out-Null
}
function V31-Private {
  if (-not (Test-Path -LiteralPath $script:L.Private)) { return 10 }
  if ((Test-PrivateDirectory $script:L.Private) -and (Test-Path -LiteralPath ($script:L.Private + '\reports'))) { return 0 }
  return 20
}

function R31-Roles { [void](Invoke-SuperSql $script:RoleSql) }
function V31-Roles {
  $n = Invoke-SuperSql "SELECT count(*) FROM pg_roles WHERE rolname IN ('srvpro_schema','srvpro_runtime','srvpro_operator')"
  if ($n -eq '0') { return 10 }
  if ($n -ne '3') { return 20 }
  $ok = Invoke-SuperSql "SELECT count(*) FROM pg_roles WHERE rolname IN ('srvpro_schema','srvpro_runtime','srvpro_operator') AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND rolcanlogin=(rolname<>'srvpro_schema')"
  $member = Invoke-SuperSql "SELECT pg_has_role('srvpro_operator','srvpro_schema','MEMBER') AND (SELECT rolinherit FROM pg_roles WHERE rolname='srvpro_operator')"
  if ($ok -eq '3' -and $member -eq 't') { return 0 }
  return 20
}

function ConvertTo-SqlLiteral([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }

# Replaces the interactive \password steps; repeating it only sets the same roles again.
function R31-Passwords {
  $runtime = Read-NewSecret 'PostgreSQL srvpro_runtime password' $null
  $operator = Read-NewSecret 'PostgreSQL srvpro_operator password' $null
  try {
    $sql = "SET standard_conforming_strings = on;`nALTER ROLE srvpro_runtime PASSWORD " + (ConvertTo-SqlLiteral $runtime) + ";`nALTER ROLE srvpro_operator PASSWORD " + (ConvertTo-SqlLiteral $operator) + ";`n"
    [void](Invoke-SuperSql $sql -Quiet)
    $sql = $null
    if (Test-Path -LiteralPath $script:L.PassFile) { Remove-Item -LiteralPath $script:L.PassFile -Force }
    $escaped = $operator.Replace('\', '\\').Replace(':', '\:')
    $file = New-Object IO.FileStream($script:L.PassFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    try {
      $bytes = [Text.Encoding]::UTF8.GetBytes('127.0.0.1:5432:*:srvpro_operator:' + $escaped + "`r`n")
      $file.Write($bytes, 0, $bytes.Length)
    } finally { $file.Dispose() }
    $script:RuntimePassword = $runtime
  } finally {
    $operator = $null; $escaped = $null; $bytes = $null; $runtime = $null
  }
}
function V31-Passwords {
  if (-not (Test-Path -LiteralPath $script:L.PassFile)) { return 10 }
  if ($null -eq (Invoke-OperatorScalar 'SELECT 1')) { return 20 }
  return 0
}

function R31-Contract {
  Set-OperatorEnvironment
  Push-Location -LiteralPath $script:L.App
  try { Invoke-NativeLive 'node' @('plugins/postgres-compat/deployment/schema.js', 'check-contract') 'schema check-contract' } finally { Pop-Location }
}

# ---- 32 (route A) ----
function R32-CreateDb {
  $db = $script:L.Database
  [void](Invoke-SuperSql ('CREATE DATABASE ' + $db + " OWNER srvpro_schema TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER libc LC_COLLATE 'C' LC_CTYPE 'C';"))
}
function V32-CreateDb {
  $db = $script:L.Database
  if (-not (Test-DatabaseExists $db)) { return 10 }
  $owner = Invoke-SuperSql ("SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='" + $db + "'")
  if ($owner -eq 'srvpro_schema') { return 0 }
  return 20
}

# Runs in its own connection to the new database, so a failed \connect can never leave
# these statements in the postgres database.
function R32-Grants {
  $db = $script:L.Database
  $sql = "ALTER SCHEMA public OWNER TO srvpro_schema;`nREVOKE CREATE ON SCHEMA public FROM PUBLIC;`nGRANT CONNECT ON DATABASE " + $db + " TO srvpro_runtime;`nGRANT CONNECT ON DATABASE " + $db + " TO srvpro_operator;`n"
  [void](Invoke-SuperSql $sql $db)
}
function V32-Grants {
  $db = $script:L.Database
  $r = Invoke-SuperSql "SELECT current_database()||'|'||pg_get_userbyid(nspowner)||'|'||has_schema_privilege('public','public','CREATE')::text||'|'||has_database_privilege('srvpro_runtime',current_database(),'CONNECT')::text||'|'||has_database_privilege('srvpro_operator',current_database(),'CONNECT')::text FROM pg_namespace WHERE nspname='public'" $db
  if ($r -eq ($db + '|srvpro_schema|false|true|true')) { return 0 }
  return 20
}

function Get-PublicTableCount {
  return Invoke-OperatorScalar "SELECT count(*) FROM pg_tables WHERE schemaname='public'" $script:L.Database
}

function R32-Init {
  Set-OperatorEnvironment
  $env:PGOPTIONS = '-c role=srvpro_schema'
  Push-Location -LiteralPath $script:L.App
  try {
    Invoke-NativeLive 'node' @('plugins/postgres-compat/deployment/schema.js', 'init', '--database', $script:L.Database, '--runtime-role', 'srvpro_runtime', '--confirm-empty', $script:L.Database, '--report', ($script:L.Private + '\reports\schema-init.json')) 'schema init'
  } finally { Pop-Location; Remove-Item Env:PGOPTIONS -ErrorAction SilentlyContinue }
}
function V32-Init {
  $n = Get-PublicTableCount
  if ($n -eq '0') { return 10 }
  $report = $script:L.Private + '\reports\schema-init.json'
  if ($n -eq '20' -and (Test-Path -LiteralPath $report) -and (([IO.File]::ReadAllText($report) | ConvertFrom-Json).ok -eq $true)) { return 0 }
  return 20
}

# ---- 34 ----
function R34-Runtime {
  $pw = Get-RuntimePassword
  Push-Location -LiteralPath $script:L.App
  try {
    $r = Invoke-NativeCapture -Exe 'node' -Arguments @('plugins/postgres-compat/deployment/schema.js', 'verify', '--database', $script:L.Database, '--runtime-role', 'srvpro_runtime', '--report', ($script:L.Private + '\reports\schema-runtime.json')) -Environment @{ PGHOST = '127.0.0.1'; PGPORT = '5432'; PGUSER = 'srvpro_runtime'; PGPASSWORD = $pw; PGPASSFILE = 'NUL' } -WorkingDirectory $script:L.App -TimeoutSeconds 300
  } finally { Pop-Location; $pw = $null }
  Write-InstallLog $r.Out
  if ($r.Code -ne 0) { Stop-Install ('Runtime schema verification failed: ' + $r.Err.Trim()) }
  $report = [IO.File]::ReadAllText($script:L.Private + '\reports\schema-runtime.json') | ConvertFrom-Json
  if ($report.ok -ne $true) { Stop-Install 'schema-runtime.json is not ok:true' }
  if (@($report.warnings).Count -gt 0) { Write-Step ('WARN runtime verification warnings: ' + (@($report.warnings) -join '; ')) }
}

Register-Block 'R31-PRIVATE' '31' 'first' '3 private directory' { R31-Private } { V31-Private }
Register-Block 'R31-ROLES' '31' 'first' '3 roles SQL' { R31-Roles } { V31-Roles }
Register-Block 'R31-PASSWORDS' '31' 'first' '3 \password and passfile' { R31-Passwords } { V31-Passwords }
Register-Block 'R31-CONTRACT' '31' 'read' '3 check-contract' { R31-Contract } $null
Register-Block 'R32-CREATEDB' '32' 'first' '3 CREATE DATABASE' { R32-CreateDb } { V32-CreateDb }
Register-Block 'R32-GRANTS' '32' 'idempotent' '3 schema owner and grants' { R32-Grants } { V32-Grants }
Register-Block 'R32-INIT' '32' 'first' '3 A init' { R32-Init } { V32-Init }
Register-Block 'R34-RUNTIME' '34' 'read' '3 runtime verify' { R34-Runtime } $null
