# Route B only: joint batch, restore (manual 3 B) and path mapping plus connection (manual 4 B). ASCII only.
Set-StrictMode -Version 2.0

function Get-BatchDir { return ($script:L.Input + '\joint-batch') }
function Get-RestoreRuntime { return ($script:Params.restoreDir + '\runtime') }

# ---- 33 ----
function R33-Restores { New-PrivateDirectory $script:L.Restores }
function V33-Restores {
  if (-not (Test-Path -LiteralPath $script:L.Restores)) { return 10 }
  if (Test-PrivateDirectory $script:L.Restores) { return 0 }
  return 20
}

# The ZIP itself was verified with the handover list in stage 10.
function R33-Batch {
  $zip = $script:L.Input + '\' + $script:Params.batch.zip
  $top = $script:Params.batch.top
  if (Test-Path -LiteralPath (Get-BatchDir)) { Stop-Install 'Batch target already exists' }
  if (Test-Path -LiteralPath ($script:L.Input + '\' + $top)) { Stop-Install 'Extraction target already exists' }
  Expand-Archive -LiteralPath $zip -DestinationPath $script:L.Input
  if ($top -ne 'joint-batch') { Rename-Item -LiteralPath ($script:L.Input + '\' + $top) -NewName 'joint-batch' }
}
function V33-Batch {
  $dir = Get-BatchDir
  $topDir = $script:L.Input + '\' + $script:Params.batch.top
  if (-not (Test-Path -LiteralPath $dir) -and -not (Test-Path -LiteralPath $topDir)) { return 10 }
  if (Test-Path -LiteralPath ($dir + '\manifest.json') -PathType Leaf) { return 0 }
  return 20
}

function R33-Verify {
  Set-OperatorEnvironment
  Invoke-NativeLive 'python' @((Get-OpsPy), 'verify', '--batch', (Get-BatchDir)) 'batch verify'
}

# Matches the source locale recorded in the batch; an unknown locale stops (manual 3).
function R33-CreateDb {
  $m = [IO.File]::ReadAllText((Get-BatchDir) + '\manifest.json') | ConvertFrom-Json
  $src = $m.sourceDatabase
  if ($src.database -eq $script:L.Database) { Stop-Install 'Use a restore database name different from the source name' }
  foreach ($v in @($src.collate, $src.ctype)) { if ($v -notmatch '^[A-Za-z0-9 ()._-]+$') { Stop-Install 'Unexpected locale text in the batch manifest' } }
  Write-Step ('Source database locale: collate=' + $src.collate + ' ctype=' + $src.ctype + ' encoding=' + $src.encoding)
  [void](Invoke-SuperSql ('CREATE DATABASE ' + $script:L.Database + " OWNER srvpro_schema TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER libc LC_COLLATE " + (ConvertTo-SqlLiteral $src.collate) + ' LC_CTYPE ' + (ConvertTo-SqlLiteral $src.ctype) + ';'))
}
function V33-CreateDb { return (V32-CreateDb) }

function Get-DefenderPaths { return @((Get-BatchDir), $script:L.Restores) }

function Test-DefenderAvailable {
  if (-not (Get-Command Get-MpPreference -ErrorAction SilentlyContinue)) { return $false }
  $svc = Get-Service WinDefend -ErrorAction SilentlyContinue
  return ($svc -and $svc.Status -eq 'Running')
}

function R33-Restore {
  Set-OperatorEnvironment
  $paths = Get-DefenderPaths
  $defender = Test-DefenderAvailable
  if ($defender) {
    Write-Step ('Defender exclusions BEFORE: ' + ((Get-MpPreference).ExclusionPath -join ';'))
    Add-MpPreference -ExclusionPath $paths
  }
  try {
    Invoke-NativeLive 'python' @((Get-OpsPy), 'restore', '--batch', (Get-BatchDir), '--destination', $script:Params.restoreDir,
      '--database', $script:L.Database, '--confirm-new-database', $script:L.Database, '--owner-role', 'srvpro_schema',
      '--runtime-role', 'srvpro_runtime', '--schema-tool', (Get-SchemaJs), '--pg-bin', $script:PgBin) 'restore'
  } finally {
    if ($defender) {
      Remove-MpPreference -ExclusionPath $paths
      Write-Step ('Defender exclusions AFTER: ' + ((Get-MpPreference).ExclusionPath -join ';'))
    }
  }
}
function V33-Restore {
  $result = $script:Params.restoreDir + '\restore-result.json'
  if (-not (Test-Path -LiteralPath $script:Params.restoreDir)) {
    if ((Get-PublicTableCount) -eq '0') { return 10 }
    return 20
  }
  if ((Test-Path -LiteralPath $result) -and (([IO.File]::ReadAllText($result) | ConvertFrom-Json).complete -eq $true)) { return 0 }
  return 20
}

# ---- 43 ----
function Get-MapRows {
  $App = $script:L.App
  $rows = @(
    @('recordings', ($script:L.Shared + '\replays')),
    @('host-config', "$App\config"),
    @('tournament-decks', ($script:L.Shared + '\tournament-decks')),
    @('tournament-logs', ($script:L.Shared + '\tournament-logs')),
    @('deck-logs', ($script:L.Shared + '\deck_log'))
  )
  if (Test-Path -LiteralPath ((Get-RestoreRuntime) + '\adapter-config')) { $rows += , @('adapter-config', "$App\plugins\postgres-compat") }
  return $rows
}

function R43-Map {
  $known = @('recordings', 'host-config', 'adapter-config', 'tournament-decks', 'tournament-logs', 'deck-logs', 'service-config')
  $map = [IO.File]::ReadAllText($script:Params.restoreDir + '\restore-map.json') | ConvertFrom-Json
  foreach ($item in @($map)) { if ($known -notcontains $item.id) { Stop-Install ('Unknown restored component: ' + $item.id + '; map it by hand (manual 4 B)') } }
  $copies = @()
  foreach ($row in Get-MapRows) {
    $source = Join-Path (Get-RestoreRuntime) $row[0]
    if (-not (Test-Path -LiteralPath $source -PathType Container)) { Stop-Install ('Missing component: ' + $source) }
    foreach ($file in Get-ChildItem -LiteralPath $source -Recurse -File -Force) {
      $relative = $file.FullName.Substring($source.Length).TrimStart('\')
      $target = Join-Path $row[1] $relative
      if (Test-Path -LiteralPath $target) { Stop-Install ('Target already exists: ' + $target) }
      $copies += @{ Source = $file.FullName; Target = $target }
    }
  }
  foreach ($copy in $copies) {
    $parent = Split-Path -Parent $copy.Target
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
    Copy-Item -LiteralPath $copy.Source -Destination $copy.Target
  }
  Write-Step ('Copied ' + $copies.Count + ' restored file(s)')
}
function V43-Map {
  if (-not (Test-Path -LiteralPath (Get-HostConfigPath))) {
    $any = @(Get-ChildItem -LiteralPath ($script:L.Shared + '\replays') -File -ErrorAction SilentlyContinue).Count
    if ($any -eq 0) { return 10 }
    return 20
  }
  foreach ($row in Get-MapRows) {
    $source = Join-Path (Get-RestoreRuntime) $row[0]
    foreach ($file in Get-ChildItem -LiteralPath $source -Recurse -File -Force) {
      $target = Join-Path $row[1] $file.FullName.Substring($source.Length).TrimStart('\')
      if (-not (Test-Path -LiteralPath $target)) { return 20 }
    }
  }
  return 0
}

# Exactly one place may hold the active connection (manual 4 B): the host modules.mysql.db or
# the enabled adapter. The database name and runtime password change there only.
function Get-ConnectionMode {
  $h = Invoke-JsonEdit (Get-HostConfigPath) @{ show = @(@('modules', 'mysql', 'enabled'), @('modules', 'mysql', 'db', 'type')) }
  $hostOn = ($h.show.'modules.mysql.enabled' -eq $true -and $h.show.'modules.mysql.db.type' -eq 'postgres')
  $adapterOn = $false
  if (Test-Path -LiteralPath (Get-AdapterConfigPath)) {
    $a = Invoke-JsonEdit (Get-AdapterConfigPath) @{ show = @(@('enabled')) }
    $adapterOn = ($a.show.enabled -eq $true)
  }
  # With the adapter enabled the host writes modules.mysql.enabled back to true; the adapter wins.
  if ($adapterOn) { return 'adapter' }
  if ($hostOn) { return 'host' }
  Stop-Install 'No active PostgreSQL connection found in the restored configuration'
}

function R43-Connection {
  $mode = Get-ConnectionMode
  Write-Step ('Active connection: ' + $mode)
  $pw = Get-RuntimePassword
  try {
    if ($mode -eq 'adapter') {
      [void](Invoke-JsonEdit (Get-AdapterConfigPath) @{ set = @(@{ path = @('connection', 'database'); value = $script:L.Database }, @{ path = @('connection', 'password'); value = $pw }) })
    } else {
      [void](Invoke-JsonEdit (Get-HostConfigPath) @{ set = @(@{ path = @('modules', 'mysql', 'db', 'database'); value = $script:L.Database }, @{ path = @('modules', 'mysql', 'db', 'password'); value = $pw }) })
    }
  } finally { $pw = $null }
  if ($script:L.Root -ne 'C:\srvpro-lab') {
    $r = Invoke-JsonEdit (Get-HostConfigPath) @{ replacePrefix = @{ from = 'C:/srvpro-lab/shared/'; to = $script:L.SharedSlash } }
    Write-Step ('Rewrote ' + $r.changedStrings + ' shared path(s) for root ' + $script:L.Root)
  }
}

Register-Block 'R33-RESTORES' '33' 'first' '3 B private restore parent' { R33-Restores } { V33-Restores }
Register-Block 'R33-BATCH' '33' 'first' '3 B batch ZIP' { R33-Batch } { V33-Batch }
Register-Block 'R33-CREATEDB' '33' 'first' '3 B new restore database' { R33-CreateDb } { V33-CreateDb }
Register-Block 'R33-GRANTS' '33' 'idempotent' '3 schema owner and grants' { R32-Grants } { V32-Grants }
Register-Block 'R33-VERIFY' '33' 'read' '3 B ops.py verify' { R33-Verify } $null
Register-Block 'R33-RESTORE' '33' 'first' '3 B ops.py restore' { R33-Restore } { V33-Restore }
Register-Block 'R43-MAP' '43' 'first' '4 B path map copy' { R43-Map } { V43-Map }
Register-Block 'R43-CONNECTION' '43' 'idempotent' '4 B active connection' { R43-Connection } $null
Register-Block 'R43-REVIEW' '43' 'read' '4 B configuration review' { R42-Review } $null
