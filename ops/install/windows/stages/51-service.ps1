# Stages 51-61 and the client checkpoints: service tasks, first start, maintenance, reboot proof,
# firewall (manual sections 5 and 6). ASCII only.
Set-StrictMode -Version 2.0

function Get-ServiceScript([string]$Name) { return ($script:L.App + '\ops\scripts\windows-service\' + $Name) }

function Invoke-ServiceScriptLive([string]$Name, [string[]]$Arguments, [string]$What) {
  Invoke-NativeLive 'powershell.exe' (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Get-ServiceScript $Name)) + $Arguments) $What
}

function Invoke-CheckService([string[]]$Extra = @()) {
  $r = Invoke-NativeCapture -Exe 'powershell.exe' -Arguments (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Get-ServiceScript 'check-service.ps1'), '-ConfigPath', $script:L.SvcCfg) + $Extra) -TimeoutSeconds 1200
  Write-InstallLog $r.Out
  return $r
}

# ---- 51 ----
function R51-ServiceConfig {
  $svc = $script:L.Svc
  if (Test-Path -LiteralPath $svc) { Stop-Install ($svc + ' already exists; inspect it first') }
  New-Item -ItemType Directory -Path $svc | Out-Null
  $svcSid = (Get-LocalUser -Name srvprosvc).SID.Value
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($entry in @(@('S-1-5-18', 'FullControl'), @('S-1-5-32-544', 'FullControl'), @($svcSid, 'ReadAndExecute'))) {
    $identity = New-Object System.Security.Principal.SecurityIdentifier($entry[0])
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($identity, $entry[1], 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  }
  Set-Acl -LiteralPath $svc -AclObject $acl
  Copy-Item -LiteralPath ($script:L.App + '\ops\templates\windows-service.example.json') -Destination $script:L.SvcCfg
  $request = @{ set = @(@{ path = @('listenPorts'); value = @($script:Params.listenPorts | ForEach-Object { [int]$_ }) }) }
  if ($script:L.Root -ne 'C:\srvpro-lab') { $request.replacePrefix = @{ from = 'C:\srvpro-lab\'; to = ($script:L.Root + '\') } }
  [void](Invoke-JsonEdit $script:L.SvcCfg $request)
}
function V51-ServiceConfig {
  if (-not (Test-Path -LiteralPath $script:L.Svc)) { return 10 }
  if (-not (Test-Path -LiteralPath $script:L.SvcCfg)) { return 20 }
  $check = 'Set-StrictMode -Version 2.0; . ''' + (Get-ServiceScript 'srvpro-service.lib.ps1') + '''; $c = Read-SrvproServiceConfig ''' + $script:L.SvcCfg + '''; Assert-SrvproConfigFilesExist $c; $c.applicationDir'
  $r = Invoke-NativeCapture -Exe 'powershell.exe' -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $check) -TimeoutSeconds 60
  if ($r.Code -eq 0 -and $r.Out.Trim() -eq $script:L.App) { return 0 }
  Write-InstallLog $r.Err
  return 20
}

function R51-BatchLogon {
  $evidence = $script:L.Private + '\reports\batch-logon-' + (Get-Date -Format yyyyMMddHHmmss)
  Invoke-ServiceScriptLive 'grant-batch-logon.ps1' @('-ConfigPath', $script:L.SvcCfg, '-EvidenceDir', $evidence) 'grant-batch-logon'
}

function Get-TaskCount {
  return @(Get-ScheduledTask -TaskName 'SRVPro-Lab-*' -ErrorAction SilentlyContinue).Count
}

function R51-Tasks {
  for ($try = 1; $try -le 3; $try++) {
    Write-Host 'Enter the srvprosvc Windows password (set in stage 41).'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Get-ServiceScript 'register-tasks.ps1') -ConfigPath $script:L.SvcCfg
    if ($LASTEXITCODE -eq 0) { return }
    if ((Get-TaskCount) -ne 0) { Stop-Install 'Task registration failed part way; see manual 5.3 cleanup' }
    Write-Host ('  Registration failed before any task was created (usually a wrong password); try again (' + $try + '/3)')
  }
  Stop-Install 'Task registration failed three times'
}
function V51-Tasks {
  $n = Get-TaskCount
  if ($n -eq 0) { return 10 }
  if ($n -eq 4) { return 0 }
  return 20
}

function R51-Start {
  $r = Invoke-CheckService @('-RunTask', 'Start')
  Write-Host $r.Out
  if ($r.Code -eq 2) { Stop-Install 'Start did not finish in time; do not start it again, read the newest service-start-*.log (manual 5.7)' }
  if ($r.Code -ne 0 -or $r.Out -notmatch '(?m)^FAILED=\s*$') { Stop-Install 'First start checks failed; see output above and manual 5.7' }
}
function V51-Start {
  $dump = $script:L.Pm2Home + '\dump.pm2'
  $pipe = [IO.Directory]::GetFiles('\\.\pipe\') -contains '\\.\pipe\rpc.sock'
  if (-not (Test-Path -LiteralPath $dump) -and -not $pipe) { return 10 }
  if (Test-Path -LiteralPath $dump) { return 0 }
  return 20
}

# ---- 52 ----
function R52-Maintenance {
  if ($script:Params.route -eq 'B') {
    $r = Invoke-NativeCapture -Exe 'python' -Arguments @(($script:L.App + '\ops\scripts\maintenance.py'), 'select', '--admin-file', ($script:L.App + '\config\admin_user.json')) -TimeoutSeconds 60
    if ($r.Code -ne 0) { Stop-Install 'No enabled restored account with stop permission' }
    Set-StateProperty $script:State 'maintenanceAccountEvidence' $r.Out.Trim()
    Save-InstallState
  }
  $s = Invoke-Maintenance 'status'
  if (-not $s.maintenanceEnabled) { Stop-Install 'Maintenance is expected to be on after the first start' }
}

# ---- 61 ----
function R61-Firewall {
  $ports = @($script:Params.listenPorts | ForEach-Object { [string]$_ })
  $ruleArgs = @{ DisplayName = 'SRVPro game ports'; Direction = 'Inbound'; Protocol = 'TCP'; LocalPort = $ports; Action = 'Allow'; Profile = 'Any' }
  $remote = Get-StateProperty $script:Params 'firewallRemoteAddress'
  if ($remote) { $ruleArgs.RemoteAddress = @($remote) }
  elseif (-not $script:Params.labVm) { Stop-Install 'A real server needs firewallRemoteAddress; 7922/7977 must not be open to everyone' }
  New-NetFirewallRule @ruleArgs | Out-Null
}
function V61-Firewall {
  $rule = Get-NetFirewallRule -DisplayName 'SRVPro game ports' -ErrorAction SilentlyContinue
  if (-not $rule) { return 10 }
  if (@($rule).Count -eq 1 -and $rule.Enabled -eq 'True' -and $rule.Action -eq 'Allow') { return 0 }
  return 20
}

# ---- client checkpoints ----
function Invoke-ClientRound([string]$Name, [string]$Checklist) {
  [void](Invoke-Maintenance 'off')
  Write-Host ''
  Write-Host ('Maintenance is OFF. ' + $Name + ':')
  Write-Host $Checklist
  $answer = Read-Host 'When every item passed type PASS; type FAIL to stop'
  $who = Read-Host 'Who checked (name)'
  Write-InstallLog ('CLIENT ' + $Name + ' result=' + $answer + ' by=' + $who)
  Set-StateProperty $script:State ('client-' + $Name) ([pscustomobject]@{ result = $answer; by = $who; at = [DateTime]::UtcNow.ToString('o') })
  Save-InstallState
  [void](Invoke-Maintenance 'on')
  if ($answer -cne 'PASS') { Stop-Install ($Name + ' did not pass; maintenance is back on') }
  Wait-ReadyToStop
}

function R-ClientRound1 {
  Invoke-ClientRound 'round1' @'
  - register a new account (nickname user$password)
  - one full normal duel
  - TT: three games with side decking; the ladder points change only once
  - reconnect a dropped client during a duel; spectate with a third client
  - download a new replay from the website and play it in a client
  - website usage/deck pages in zh, ja, en, ko
'@
}
function R-ClientRound2 {
  Invoke-ClientRound 'round2' @'
  - register another new account and play one TT match after the reboot
  - the new account and the new replay appear on the website
'@
}

# ---- 53 reboot proof ----
function Get-BootTime { return (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime() }

function R53-BeforeReboot {
  $auto = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -ErrorAction SilentlyContinue).AutoAdminLogon
  if ($auto -eq '1') { Stop-Install 'Automatic logon is enabled; the unattended start cannot be proven' }
  [void](Invoke-Maintenance 'on')
  Wait-ReadyToStop
  $r = Invoke-CheckService
  if ($r.Code -ne 0) { Stop-Install 'Service checks fail before the reboot' }
  Set-StateProperty $script:State 'bootBeforeReboot' (Get-BootTime).ToString('o')
  Save-InstallState
}

function Get-FirstInteractiveLogon([DateTime]$Boot) {
  $times = @(Get-CimInstance Win32_LogonSession | Where-Object { @(2, 10, 11) -contains $_.LogonType } |
    ForEach-Object { $_.StartTime.ToUniversalTime() } | Where-Object { $_ -gt $Boot } | Sort-Object)
  if ($times.Count -eq 0) { return $null }
  return $times[0]
}

function Get-Field([string]$Text, [string]$Pattern) {
  $m = [regex]::Match($Text, $Pattern)
  if (-not $m.Success) { return $null }
  return $m.Groups[1].Value
}

function Test-AfterReboot {
  $boot = Get-BootTime
  $before = [DateTime]::Parse((Get-StateProperty $script:State 'bootBeforeReboot')).ToUniversalTime()
  if ($boot -le $before.AddSeconds(5)) { Stop-Install 'The machine has not been restarted since the pre-reboot check' }
  $logon = Get-FirstInteractiveLogon $boot
  if (-not $logon) { Stop-Install 'No interactive logon found after boot' }
  if (($logon - $boot).TotalMinutes -lt 5) { Stop-Install ('First logon came ' + [int]($logon - $boot).TotalSeconds + ' s after boot; wait at least 5 minutes before logging on (reboot again)') }
  $r = Invoke-CheckService
  Write-Host $r.Out
  if ($r.Code -ne 0 -or $r.Out -notmatch '(?m)^FAILED=\s*$') { Stop-Install 'check-service reports failures after the reboot' }
  if ($r.Out -notmatch 'CHECK task-result \S+-Startup PASS') { Stop-Install 'Startup task result is not PASS' }
  if ($r.Out -notmatch 'afterBoot=True') { Stop-Install 'The PM2 daemon did not start after this boot' }
  $daemon = Get-Field $r.Out 'daemon pid=(\d+)'
  $game = Get-Field $r.Out 'single-game-process PASS :: count=1 pid=(\d+)'
  foreach ($procId in @($daemon, $game)) {
    if (-not $procId) { Stop-Install 'Could not read the daemon or game PID' }
    $created = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $procId)).CreationDate.ToUniversalTime()
    if ($created -ge $logon) { Stop-Install ('Process ' + $procId + ' started after the first logon') }
  }
  $log = Get-ChildItem -LiteralPath ($script:L.Shared + '\logs') -Filter 'service-resurrect-*.log' | Sort-Object LastWriteTime | Select-Object -Last 1
  if (-not $log -or $log.LastWriteTimeUtc -lt $boot) { Stop-Install 'No resurrect log from this boot' }
  $tail = @(Get-Content -LiteralPath $log.FullName -Tail 1)
  if ($tail[0] -notmatch 'result=0$') { Stop-Install ('Resurrect log does not end with result=0: ' + $log.Name) }
  $err = Get-ChildItem -LiteralPath ($script:L.Shared + '\logs') -Filter 'resurrect-*.stderr.log' | Sort-Object LastWriteTime | Select-Object -Last 1
  if ($err -and $err.Length -gt 0) { Stop-Install ('Resurrect stderr is not empty: ' + $err.Name) }
  $s = Invoke-Maintenance 'status'
  if (-not $s.maintenanceEnabled) { Stop-Install 'Maintenance is not on after the reboot' }
  return @($daemon, $game)
}

function R53-AfterReboot {
  $first = Test-AfterReboot
  Write-Host 'Waiting 60 s to confirm the processes stay up...'
  Start-Sleep -Seconds 60
  $second = Test-AfterReboot
  if ($first[0] -ne $second[0] -or $first[1] -ne $second[1]) { Stop-Install 'Daemon or game PID changed within 60 s' }
  Set-StateProperty $script:State ('rebootProof-' + (Get-BootTime).ToString('yyyyMMddTHHmmss')) ([pscustomobject]@{ daemon = $first[0]; game = $first[1] })
  Save-InstallState
}

Register-Block 'R51-SVCCFG' '51' 'first' '5.1 service configuration' { R51-ServiceConfig } { V51-ServiceConfig }
Register-Block 'R51-BATCHLOGON' '51' 'idempotent' '5.2 batch logon right' { R51-BatchLogon } $null
Register-Block 'R51-TASKS' '51' 'first' '5.3 register tasks' { R51-Tasks } { V51-Tasks }
Register-Block 'R51-START' '51' 'first' '5.4 first start' { R51-Start } { V51-Start }
Register-Block 'R52-MAINT' '52' 'read' '5.6 maintenance switch' { R52-Maintenance } $null
Register-Block 'R61-FIREWALL' '61' 'first' '6 firewall rule' { R61-Firewall } { V61-Firewall }
Register-Block 'CP1-CLIENT' 'CP1' 'read' '6 client acceptance round 1' { R-ClientRound1 } $null
Register-Block 'R53A-BEFORE' '53a' 'read' '5.6 before reboot' { R53-BeforeReboot } $null
Register-Block 'R53B-AFTER' '53b' 'read' '5.6 after reboot' { R53-AfterReboot } $null
Register-Block 'CP2-CLIENT' 'CP2' 'read' '6 client acceptance after reboot' { R-ClientRound2 } $null
