# SRVPro Windows staged installer (routes A and B). Windows PowerShell 5.1, ASCII only.
# Usage (elevated PowerShell):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\srvpro-input\ops\install\windows\install.ps1 run
# Commands: run | status | maintenance on|off|status | verify-block <ID> | help
# Each block maps to ops/docs/windows-install.md; see MAPPING.md next to this file.
param(
  [Parameter(Position = 0)][string]$Command = 'help',
  [Parameter(Position = 1)][string]$Argument = ''
)
# Fixed on purpose: stage 10 verifies this exact file against the handover list.
$ParamsPath = 'C:\srvpro-input\install-params.json'

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:InstallLibDir = Join-Path $PSScriptRoot 'lib'

. (Join-Path $script:InstallLibDir 'common.ps1')
. (Join-Path $script:InstallLibDir 'postgres.ps1')
foreach ($stage in Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'stages') -Filter '*.ps1' | Sort-Object Name) { . $stage.FullName }

$script:RouteStages = @{
  A = @('10', '12', '21', '23', '31', '32', '34', '41', '42', '45', '51', '52', '61', 'CP1', '53a', '53b', 'CP2')
  B = @('10', '12', '21', '23', '31', '33', '34', '41', '43', '45', '51', '52', '61', 'CP1', '53a', '53b', 'CP2')
}

function Show-Help {
  Write-Host @'
SRVPro Windows installer

  run                       install or continue from the first unfinished step
  status                    show finished and pending steps
  maintenance on|off|status switch or read the game maintenance mode
  verify-block <ID>         after a manual repair, record a step whose read-only check passes
  help                      this text

Parameters come from C:\srvpro-input\install-params.json (see ops/docs/windows-install.md).
State and logs: C:\ProgramData\srvprotianti-install (administrators only).
'@
}

function Get-ParamsDigest { return (Get-FileHash -LiteralPath $ParamsPath -Algorithm SHA256).Hash }
function Get-ScriptDigest {
  $files = @(Get-ChildItem -LiteralPath $PSScriptRoot -Recurse -File | Where-Object { @('.ps1', '.cjs') -contains $_.Extension } | Sort-Object FullName)
  $lines = @($files | ForEach-Object { $_.FullName.Substring($PSScriptRoot.Length) + ' ' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash })
  $bytes = [Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '') } finally { $sha.Dispose() }
}

# No state but install targets present means an earlier run lost its record: stop.
function Assert-FreshMachine {
  $found = @(@($script:L.Root, $script:L.Private, $script:L.Svc, $script:L.Pm2Home, $script:L.Pm2Tools, $script:L.Boot, $script:L.Restores, ($script:L.Input + '\joint-batch')) | Where-Object { Test-Path -LiteralPath $_ })
  if (@(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like 'SRVPro-*' }).Count) { $found += 'SRVPro-* scheduled tasks' }
  if (Get-LocalUser -Name srvprosvc -ErrorAction SilentlyContinue) { $found += 'local user srvprosvc' }
  if (Get-Service postgresql-x64-17 -ErrorAction SilentlyContinue) { $found += 'service postgresql-x64-17' }
  if ($found.Count) { Stop-Install ('No installer state, but targets already exist: ' + ($found -join ', ') + '. Do not reuse this machine without the maintainer.') }
}

function Initialize-Run {
  Assert-ElevatedAdmin
  $script:Params = Read-InstallParams $ParamsPath
  Initialize-Layout $script:Params
  Open-InstallLock
  $script:State = Read-InstallState
  $bind = [ordered]@{ machine = $env:COMPUTERNAME; route = $script:Params.route; root = $script:L.Root; database = $script:L.Database; params = (Get-ParamsDigest); scripts = (Get-ScriptDigest) }
  if ($null -eq $script:State) {
    Assert-FreshMachine
    $script:State = [pscustomobject]@{ version = $script:InstallStateVersion; createdAt = [DateTime]::UtcNow.ToString('o'); bind = [pscustomobject]$bind; done = @(); pending = $null }
    Save-InstallState
  } else {
    foreach ($k in $bind.Keys) {
      if ($script:State.bind.$k -ne $bind[$k]) { Stop-Install ('Installer state was made with a different ' + $k + '; do not change parameters or scripts mid-install') }
    }
  }
  Write-Step ('Installer: machine=' + $env:COMPUTERNAME + ' route=' + $script:Params.route + ' root=' + $script:L.Root)
}

function Invoke-Run {
  Initialize-Run
  if (Test-BlockDone 'R12-ENV') { Update-ProcessPath }
  R10-Machine
  foreach ($stage in $script:RouteStages[$script:Params.route]) {
    if ($stage -eq '53b' -and -not (Test-BlockDone 'R53B-AFTER')) {
      $before = [DateTime]::Parse((Get-StateProperty $script:State 'bootBeforeReboot')).ToUniversalTime()
      if ((Get-BootTime) -le $before.AddSeconds(5)) {
        Write-Host ''
        Write-Host 'NEXT: restart this machine now (Start > Power > Restart).'
        Write-Host '      Leave it at the sign-in screen for at least 5 minutes, then sign in,'
        Write-Host '      open an elevated PowerShell and run this installer with "run" again.'
        return
      }
    }
    Invoke-Stage $stage
  }
  Write-Host ''
  Write-Host 'ALL STAGES PASSED. Maintenance stays ON; open the server only when you decide to.'
}

function Show-Status {
  $script:Params = Read-InstallParams $ParamsPath
  Initialize-Layout $script:Params
  $state = Read-InstallState
  if ($null -eq $state) { Write-Host 'No installer state yet.'; return }
  Write-Host ('route=' + $state.bind.route + ' root=' + $state.bind.root + ' pending=' + $state.pending)
  foreach ($stage in $script:RouteStages[$state.bind.route]) {
    foreach ($b in @($script:Blocks | Where-Object { $_.Stage -eq $stage })) {
      $mark = '      '
      if (@($state.done) -contains $b.Id) { $mark = 'done  ' } elseif ($state.pending -eq $b.Id) { $mark = 'PEND  ' }
      Write-Host ($mark + $stage.PadRight(4) + ' ' + $b.Id.PadRight(16) + ' manual ' + $b.Manual)
    }
  }
}

function Invoke-VerifyBlock([string]$Id) {
  Initialize-Run
  $b = @($script:Blocks | Where-Object { $_.Id -eq $Id })
  if ($b.Count -ne 1) { Stop-Install ('Unknown block ' + $Id) }
  if (Test-BlockDone $Id) { Write-Step ($Id + ' is already recorded'); return }
  # Only the next block of this route may be recorded, and only if it is the pending one or none is.
  $next = $null
  foreach ($stage in $script:RouteStages[$script:Params.route]) {
    foreach ($x in @($script:Blocks | Where-Object { $_.Stage -eq $stage })) {
      if (-not $next -and -not (Test-BlockDone $x.Id)) { $next = $x.Id }
    }
  }
  if ($next -ne $Id) { Stop-Install ('Only the next unfinished block of this route can be recorded: ' + $next) }
  if ($script:State.pending -and $script:State.pending -ne $Id) { Stop-Install ('Another block is pending: ' + $script:State.pending) }
  if (-not $b[0].Verify) { Stop-Install ($Id + ' has no read-only check; run "run" instead') }
  $r = Invoke-Verify $b[0]
  if ($r -ne 0) { Stop-Install ('Check for ' + $Id + ' does not pass (' + $r + ')') }
  Complete-Block $Id
  Write-Step ('Recorded ' + $Id + ' after manual repair')
}

$exitCode = 0
try {
  switch ($Command) {
    'run' { Invoke-Run }
    'status' { Show-Status }
    'maintenance' {
      if (@('on', 'off', 'status') -notcontains $Argument) { Stop-Install 'Use: maintenance on|off|status' }
      Initialize-Run
      [void](Invoke-Maintenance $Argument)
    }
    'verify-block' { Invoke-VerifyBlock $Argument }
    default { Show-Help }
  }
} catch {
  $where = ''
  if ($script:State -and (Get-StateProperty $script:State 'pending')) { $where = ' (block ' + $script:State.pending + ')' }
  if ($_.Exception.GetType().Name -eq 'InstallStop') {
    Write-Step ('FAIL' + $where + ': ' + $_.Exception.Message)
  } else {
    # Unexpected error: message and location only; no command text is echoed.
    Write-Step ('FAIL' + $where + ': ' + $_.Exception.Message + ' [' + $_.InvocationInfo.ScriptName + ':' + $_.InvocationInfo.ScriptLineNumber + ']')
  }
  $exitCode = 1
} finally {
  Clear-Secrets
  if ($script:LockStream) { $script:LockStream.Dispose() }
}
exit $exitCode
