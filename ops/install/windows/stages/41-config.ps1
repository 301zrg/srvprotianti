# Stages 41, 42 and 45: service account, route A configuration, permissions, PM2 (manual section 4). ASCII only.
Set-StrictMode -Version 2.0

function Get-ServiceUser { return (Get-LocalUser -Name srvprosvc -ErrorAction SilentlyContinue) }

function R41-Account {
  for ($try = 1; $try -le 3; $try++) {
    $plain = Read-NewSecret 'Windows password for srvprosvc' { param($v) Test-WindowsPasswordRule $v 'srvprosvc' }
    $secure = ConvertTo-SecureString $plain -AsPlainText -Force
    $plain = $null
    try {
      $user = New-LocalUser -Name srvprosvc -Password $secure -Description 'SRVPro service'
      Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $user
      Write-Step 'srvprosvc created; keep this password for stage 51 (task registration)'
      return
    } catch [Microsoft.PowerShell.Commands.InvalidPasswordException] {
      Write-Host ('  Windows rejected the password (length, complexity or history); try again (' + $try + '/3)')
    } finally { $secure = $null }
  }
  Stop-Install 'srvprosvc password was rejected three times'
}
function V41-Account {
  $u = Get-ServiceUser
  if (-not $u) { return 10 }
  $admins = @(Get-LocalGroupMember -SID 'S-1-5-32-544' | ForEach-Object { $_.SID.Value })
  $users = @(Get-LocalGroupMember -SID 'S-1-5-32-545' | ForEach-Object { $_.SID.Value })
  if ($u.Enabled -and $admins -notcontains $u.SID.Value -and $users -contains $u.SID.Value) { return 0 }
  return 20
}

function Get-SharedDirs { return @('logs', 'replays', 'tournament-decks', 'tournament-logs', 'deck_log') }

function R41-Dirs {
  foreach ($path in @($script:L.Pm2Home, $script:L.Pm2Tools, $script:L.Shared)) {
    if (Test-Path -LiteralPath $path) { Stop-Install ('Target already exists: ' + $path) }
    New-Item -ItemType Directory -Path $path | Out-Null
  }
  foreach ($name in Get-SharedDirs) { New-Item -ItemType Directory -Path ($script:L.Shared + '\' + $name) | Out-Null }
}
function V41-Dirs {
  $all = @($script:L.Pm2Home, $script:L.Pm2Tools, $script:L.Shared) + @(Get-SharedDirs | ForEach-Object { $script:L.Shared + '\' + $_ })
  $present = @($all | Where-Object { Test-Path -LiteralPath $_ -PathType Container })
  if ($present.Count -eq 0) { return 10 }
  if ($present.Count -eq $all.Count) { return 0 }
  return 20
}

# ---- 42 (route A) ----
function Get-HostConfigPath { return ($script:L.App + '\config\config.json') }
function Get-AdapterConfigPath { return ($script:L.App + '\plugins\postgres-compat\config.json') }

function R42-Config {
  $App = $script:L.App
  foreach ($p in @((Get-HostConfigPath), (Get-AdapterConfigPath))) { if (Test-Path -LiteralPath $p) { Stop-Install ('Config already exists: ' + $p) } }
  if (-not (Test-Path -LiteralPath "$App\config")) { New-Item -ItemType Directory -Path "$App\config" | Out-Null }
  Copy-Item -LiteralPath ($script:L.Input + '\windows.server.config.json') -Destination (Get-HostConfigPath)
  Copy-Item -LiteralPath "$App\ops\templates\postgres-compat.config.example.json" -Destination (Get-AdapterConfigPath)
  if ($script:L.Root -ne 'C:\srvpro-lab') {
    $r = Invoke-JsonEdit (Get-HostConfigPath) @{ replacePrefix = @{ from = 'C:/srvpro-lab/shared/'; to = $script:L.SharedSlash } }
    Write-Step ('Rewrote ' + $r.changedStrings + ' shared path(s) for root ' + $script:L.Root)
  }
  $set = @(@{ path = @('connection', 'password'); value = (Get-RuntimePassword) })
  if ($script:L.Database -ne 'srvpro_1103') { $set += @{ path = @('connection', 'database'); value = $script:L.Database } }
  [void](Invoke-JsonEdit (Get-AdapterConfigPath) @{ set = $set })
  $set = $null
}
function V42-Config {
  $h = Test-Path -LiteralPath (Get-HostConfigPath)
  $a = Test-Path -LiteralPath (Get-AdapterConfigPath)
  if (-not $h -and -not $a) { return 10 }
  if (-not ($h -and $a)) { return 20 }
  $r = Invoke-JsonEdit (Get-AdapterConfigPath) @{ show = @(@('enabled'), @('synchronize'), @('connection', 'database'), @('connection', 'username'), @('connection', 'password')) }
  $s = $r.show
  if ($s.enabled -eq $true -and $s.synchronize -eq $false -and $s.'connection.database' -eq $script:L.Database -and $s.'connection.username' -eq 'srvpro_runtime' -and $s.'connection.password' -eq '<set>') { return 0 }
  return 20
}

# Fallback configuration check (design section 9.1): show the switches for a person to compare.
function R42-Review {
  $paths = @(@('port'), @('version'), @('alternative_versions'), @('modules', 'stop'), @('modules', 'welcome'), @('modules', 'trusted_proxies'),
    @('modules', 'mysql', 'enabled'), @('modules', 'side_timeout'), @('modules', 'tournament_mode', 'enabled'),
    @('modules', 'tournament_mode', 'deck_path'), @('modules', 'tournament_mode', 'replay_path'), @('modules', 'tournament_mode', 'log_save_path'),
    @('modules', 'deck_log', 'enabled'), @('modules', 'deck_log', 'local'), @('modules', 'http', 'port'), @('modules', 'http', 'show_ip'),
    @('modules', 'http', 'show_info'), @('modules', 'neos', 'enabled'), @('modules', 'neos', 'port'), @('modules', 'neos', 'trusted_proxy_header'),
    @('modules', 'random_duel', 'enabled'), @('modules', 'reconnect', 'enabled'), @('modules', 'heartbeat_detection', 'enabled'),
    @('hostinfo', 'lflist'), @('hostinfo', 'rule'), @('hostinfo', 'mode'), @('hostinfo', 'duel_rule'), @('hostinfo', 'start_lp'), @('hostinfo', 'time_limit'))
  $r = Invoke-JsonEdit (Get-HostConfigPath) @{ show = $paths }
  $lines = @($r.show.PSObject.Properties | ForEach-Object { '  ' + $_.Name + ' = ' + ($_.Value | ConvertTo-Json -Compress) })
  Confirm-Checkpoint ("Main configuration (fields not listed fall back to defaults). Compare with the parameter page:`n" + ($lines -join "`n"))
  if ($r.show.'modules.tournament_mode.enabled' -ne $true) { Stop-Install 'tournament_mode must stay enabled: it saves replay files and lets players reconnect by account' }
}

function R42-Admin {
  $target = $script:L.App + '\config\admin_user.json'
  if (Test-Path -LiteralPath $target) { Stop-Install 'Admin configuration already exists' }
  $password = Read-NewSecret 'Maintenance (HTTP management) password' $null
  try {
    $user = $script:Params.managementUsername
    $payload = @{ file = './config/admin_user.json'; permission_examples = @{}; users = @{ $user = @{ password = $password; enabled = $true; permissions = @{ stop = $true } } } }
    [IO.File]::WriteAllText($target, ($payload | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding $false))
    $script:MaintenancePassword = $password
  } finally { $password = $null; $payload = $null }
}
function V42-Admin {
  $target = $script:L.App + '\config\admin_user.json'
  if (-not (Test-Path -LiteralPath $target)) { return 10 }
  $r = Invoke-JsonEdit $target @{ show = @(@('users', $script:Params.managementUsername, 'enabled'), @('users', $script:Params.managementUsername, 'password'), @('users', $script:Params.managementUsername, 'permissions', 'stop')) }
  $p = 'users.' + $script:Params.managementUsername
  if ($r.show.($p + '.enabled') -eq $true -and $r.show.($p + '.password') -eq '<set>' -and $r.show.($p + '.permissions.stop') -eq $true) { return 0 }
  return 20
}

# ---- 45 ----
function Set-LabDirectoryAcl([string]$Path, [string]$ServiceRights) {
  $svcSid = (Get-ServiceUser).SID.Value
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($entry in @(@('S-1-5-18', 'FullControl'), @('S-1-5-32-544', 'FullControl'), @($svcSid, $ServiceRights))) {
    $identity = New-Object System.Security.Principal.SecurityIdentifier($entry[0])
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, $entry[1], 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function R45-Acl {
  $App = $script:L.App
  Set-LabDirectoryAcl $App 'ReadAndExecute'
  Set-LabDirectoryAcl $script:L.Pm2Tools 'ReadAndExecute'
  Set-LabDirectoryAcl $script:L.Pm2Home 'Modify'
  Set-LabDirectoryAcl $script:L.Shared 'Modify'
  Set-LabDirectoryAcl "$App\config" 'Modify'
  if (-not (Test-Path -LiteralPath "$App\logs")) { New-Item -ItemType Directory -Path "$App\logs" | Out-Null }
  Set-LabDirectoryAcl "$App\logs" 'Modify'
  Set-LabDirectoryAcl "$App\plugins\postgres-compat" 'ReadAndExecute'
  if (-not (Test-Path -LiteralPath "$App\ygopro\replay")) { New-Item -ItemType Directory -Path "$App\ygopro\replay" | Out-Null }
  Set-LabDirectoryAcl "$App\ygopro\replay" 'Modify'
}

function R45-Pm2 {
  Copy-Item -LiteralPath ($script:L.Input + '\pm2-lock\package.json'), ($script:L.Input + '\pm2-lock\package-lock.json') -Destination $script:L.Pm2Tools
  Invoke-NativeLive 'npm.cmd' @('ci', '--prefix', $script:L.Pm2Tools) 'PM2 npm ci'
}
function V45-Pm2 {
  $pkg = $script:L.Pm2Tools + '\node_modules\pm2\package.json'
  if (-not (Test-Path -LiteralPath ($script:L.Pm2Tools + '\package.json')) -and -not (Test-Path -LiteralPath ($script:L.Pm2Tools + '\node_modules'))) { return 10 }
  if ((Test-Path -LiteralPath $pkg) -and (([IO.File]::ReadAllText($pkg) | ConvertFrom-Json).version -eq '6.0.14')) { return 0 }
  return 20
}

Register-Block 'R41-ACCOUNT' '41' 'first' '4 service account' { R41-Account } { V41-Account }
Register-Block 'R41-DIRS' '41' 'first' '4 PM2 and shared directories' { R41-Dirs } { V41-Dirs }
Register-Block 'R42-CONFIG' '42' 'first' '4 copy templates, adapter password' { R42-Config } { V42-Config }
Register-Block 'R42-REVIEW' '42' 'read' '4 parameter page check' { R42-Review } $null
Register-Block 'R42-ADMIN' '42' 'first' '4 maintenance account' { R42-Admin } { V42-Admin }
Register-Block 'R45-ACL' '45' 'idempotent' '4 permissions block' { R45-Acl } $null
Register-Block 'R45-PM2' '45' 'first' '4 fixed PM2 install' { R45-Pm2 } { V45-Pm2 }
