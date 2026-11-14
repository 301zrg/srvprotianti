# Registers the three scheduled tasks that run srvpro-service.ps1 as the service account:
#   <taskPrefix>-Start    manual, first start (Mode Start)
#   <taskPrefix>-Save     manual, re-save the PM2 process list (Mode Save)
#   <taskPrefix>-Startup  at boot + 30 s, no logon needed (Mode Resurrect), retried 3 times
# -UpdatePassword only stores a new service-account password in the existing tasks.
# Run in an elevated administrator PowerShell. Starts nothing.
param(
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [switch]$UpdatePassword
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'srvpro-service.lib.ps1')
Assert-SrvproElevatedAdmin
$cfg = Read-SrvproServiceConfig $ConfigPath
Assert-SrvproConfigFilesExist $cfg
$user = Get-SrvproServiceUser $cfg
$sid = $user.SID.Value
$names = Get-SrvproTaskNames $cfg
$entry = Join-Path $PSScriptRoot 'srvpro-service.ps1'
Assert-SrvproSafePath $entry 'Service script path'

# The tasks run code and settings that the service account must not be able to change.
foreach ($path in @($ConfigPath, (Split-Path -Parent $ConfigPath), $PSScriptRoot, $entry,
    (Join-Path $PSScriptRoot 'srvpro-service.lib.ps1'), (Join-Path $PSScriptRoot 'pm2-dump-summary.cjs'),
    (Join-Path (Split-Path -Parent $PSScriptRoot) 'pipe-server-pid.ps1'), $cfg.nodeExe, $cfg.pm2Package)) {
  Assert-SrvproNotWritableBy $path $sid
}
if (-not ((Get-SrvproRightSids (Get-SrvproUserRightsLines) 'SeBatchLogonRight') -contains $sid)) {
  throw 'Service account lacks "Log on as a batch job"; run grant-batch-logon.ps1 first'
}
if ((Get-SrvproRightSids (Get-SrvproUserRightsLines) 'SeDenyBatchLogonRight') -contains $sid) {
  throw 'Service account is denied batch logon by policy'
}
if ($cfg.pgServiceName) {
  $svc = Get-Service -Name $cfg.pgServiceName
  if ($svc.StartType -ne 'Automatic') { throw ('PostgreSQL service ' + $cfg.pgServiceName + ' must start automatically') }
}

$existing = @($names.Start, $names.Save, $names.Startup | Where-Object { Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue })
if ($UpdatePassword) {
  if ($existing.Count -ne 3) { throw 'UpdatePassword needs all three existing tasks' }
} elseif ($existing.Count) {
  throw ('Tasks already exist: ' + ($existing -join ', ') + '. Use -UpdatePassword to change the password; do not re-register over a running service')
}

$account = $env:COMPUTERNAME + '\' + $cfg.serviceAccount
$secret = Read-Host ('Windows password of ' + $account) -AsSecureString
$password = (New-Object System.Management.Automation.PSCredential($account, $secret)).GetNetworkCredential().Password
try {
  if (-not $password) { throw 'Empty password' }
  if ($UpdatePassword) {
    foreach ($n in $names.Start, $names.Save, $names.Startup) { Set-ScheduledTask -TaskName $n -User $account -Password $password | Out-Null }
  } else {
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    function New-SrvproAction([string]$Mode) {
      New-ScheduledTaskAction -Execute $ps -WorkingDirectory $cfg.applicationDir -Argument (
        '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $entry + '" -Mode ' + $Mode + ' -ConfigPath "' + $ConfigPath + '"')
    }
    $limit = New-TimeSpan -Minutes 15
    $manual = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit $limit
    $boot = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit $limit -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $trigger.Delay = 'PT30S'
    $desc = 'SRVPro ' + $cfg.appName + ' via PM2 as ' + $account
    Register-ScheduledTask -TaskName $names.Start -Action (New-SrvproAction 'Start') -Settings $manual -User $account -Password $password -RunLevel Limited -Description $desc | Out-Null
    Register-ScheduledTask -TaskName $names.Save -Action (New-SrvproAction 'Save') -Settings $manual -User $account -Password $password -RunLevel Limited -Description $desc | Out-Null
    Register-ScheduledTask -TaskName $names.Startup -Action (New-SrvproAction 'Resurrect') -Trigger $trigger -Settings $boot -User $account -Password $password -RunLevel Limited -Description $desc | Out-Null
  }
} finally { Remove-Variable password, secret -ErrorAction SilentlyContinue }

foreach ($n in $names.Start, $names.Save, $names.Startup) {
  $t = Get-ScheduledTask -TaskName $n
  if ($t.Principal.UserId -notmatch ('(^|\\)' + [regex]::Escape($cfg.serviceAccount) + '$') -or [string]$t.Principal.RunLevel -ne 'Limited' -or [string]$t.Principal.LogonType -ne 'Password') {
    throw ('Task ' + $n + ' has an unexpected principal')
  }
  Write-Output ('task ' + $n + ' user=' + $t.Principal.UserId + ' runlevel=' + $t.Principal.RunLevel + ' logon=' + $t.Principal.LogonType)
}
Write-Output ('Done. Nothing was started. Next: check-service.ps1 -ConfigPath "' + $ConfigPath + '" -RunTask Start')
