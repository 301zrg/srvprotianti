# Read-only health check of the PM2-managed game service, for an elevated administrator.
# Never runs the PM2 CLI (as admin it could start a second daemon) and never prints dump env.
# -RunTask Start|Save starts that scheduled task ONCE, waits until it finishes, then checks.
# Exit code: 0 all checks passed, 1 a check failed, 2 the requested task did not finish in time.
param(
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [ValidateSet('Start','Save')][string]$RunTask,
  [int]$WaitSeconds = 900
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'srvpro-service.lib.ps1')
Assert-SrvproElevatedAdmin
$cfg = Read-SrvproServiceConfig $ConfigPath
$names = Get-SrvproTaskNames $cfg
$failed = New-Object System.Collections.ArrayList
function Report([string]$Name, [bool]$Ok, [string]$Detail) {
  if (-not $Ok) { [void]$failed.Add($Name) }
  Write-Output ('CHECK ' + $Name + ' ' + $(if ($Ok) { 'PASS' } else { 'FAIL' }) + ' :: ' + $Detail)
}
function Task-Line([string]$TaskName) {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $t) { return $null }
  $i = Get-ScheduledTaskInfo -InputObject $t
  return [pscustomobject]@{Task=$t; Info=$i; Text=('state=' + $t.State + ' last=' + $i.LastTaskResult + ' lastRun=' + $i.LastRunTime.ToString('s') + ' user=' + $t.Principal.UserId + ' runlevel=' + $t.Principal.RunLevel)}
}

if ($RunTask) {
  $name = $names.$RunTask
  $before = Task-Line $name
  if (-not $before) { throw ('Task not found: ' + $name) }
  if ($before.Task.State -eq 'Running') { throw ('Task already running: ' + $name) }
  # The run is identified by the NEW service-<mode>-*.log it writes, not by LastRunTime ordering.
  $pattern = 'service-' + $RunTask.ToLowerInvariant() + '-*.log'
  $getLogs = { @(Get-ChildItem -LiteralPath $cfg.logDir -Filter $pattern -ErrorAction SilentlyContinue | ForEach-Object {
    [pscustomobject]@{Name=$_.Name; Text=[IO.File]::ReadAllText($_.FullName)} }) }
  $getTask = { $l = Task-Line $name; [pscustomobject]@{State=[string]$l.Task.State; LastTaskResult=$l.Info.LastTaskResult; LastRunTime=$l.Info.LastRunTime} }
  $logsBefore = @(& $getLogs | ForEach-Object { $_.Name })
  Write-Output ('starting ' + $name + ' once')
  Start-ScheduledTask -TaskName $name
  $run = Wait-SrvproTaskRun $getTask $getLogs $logsBefore $before.Info.LastRunTime $WaitSeconds
  Write-Output ('task ' + $name + ' ' + (Task-Line $name).Text + ' log=' + $run.Log + ' logResult=' + $run.LogResult)
  if (-not $run.Finished) {
    Write-Output ('Task did not finish within ' + $WaitSeconds + ' s; it was left as is for inspection. Do not start it again; check the newest ' + $pattern + ' in ' + $cfg.logDir)
    exit 2
  }
  $ok = (-not $run.Error -and $run.LogResult -eq 0 -and $run.TaskResult -eq 0)
  $why = if ($run.Error) { $run.Error } elseif (($run.LogResult -eq 0) -ne ($run.TaskResult -eq 0)) { 'service log and task result disagree' } else { 'log ' + $run.Log }
  Report ('task-' + $RunTask) $ok ('taskResult=' + $run.TaskResult + ' logResult=' + $run.LogResult + ' ' + $why)
}

$os = Get-CimInstance Win32_OperatingSystem
$boot = $os.LastBootUpTime.ToUniversalTime()
Write-Output ('boot=' + $boot.ToString('o') + ' uptimeSeconds=' + [int]([DateTime]::UtcNow - $boot).TotalSeconds + ' interactiveUser=' + (Get-CimInstance Win32_ComputerSystem).UserName)
foreach ($n in $names.Start, $names.Save, $names.Startup) {
  $line = Task-Line $n
  if (-not $line) { Report ('task-exists ' + $n) $false 'missing'; continue }
  $okPrincipal = ($line.Task.Principal.UserId -match ('(^|\\)' + [regex]::Escape($cfg.serviceAccount) + '$') -and [string]$line.Task.Principal.RunLevel -eq 'Limited')
  Report ('task-principal ' + $n) $okPrincipal $line.Text
  # 267011 = the task has never run; that is not a failure (e.g. Startup before the first reboot).
  if ($line.Info.LastTaskResult -ne 267011 -and $line.Task.State -ne 'Running') { Report ('task-result ' + $n) ($line.Info.LastTaskResult -eq 0) $line.Text }
}
if ($cfg.pgServiceName) {
  $pg = Get-Service -Name $cfg.pgServiceName
  Report 'postgres-service' ($pg.Status -eq 'Running' -and $pg.StartType -eq 'Automatic') ('status=' + $pg.Status + ' start=' + $pg.StartType)
}
Report 'postgres-tcp' (Test-SrvproTcp $cfg.pgHost $cfg.pgPort) ($cfg.pgHost + ':' + $cfg.pgPort)

$nodes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'")
$daemonJs = ($cfg.pm2Package + '\lib\Daemon.js').ToLowerInvariant()
$allDaemons = @($nodes | Where-Object { $_.CommandLine -and $_.CommandLine -match 'pm2[\\/]lib[\\/]Daemon\.js' })
$ownDaemons = @($allDaemons | Where-Object { $_.CommandLine.ToLowerInvariant().Contains($daemonJs) })
Report 'single-pm2-daemon' ($allDaemons.Count -eq 1 -and $ownDaemons.Count -eq 1) ('pm2 daemons on machine=' + $allDaemons.Count + ' using configured PM2=' + $ownDaemons.Count)
$state = Get-SrvproDaemonState $cfg
Report 'daemon-identity' $state.Own $state.Detail
$game = @()
if ($ownDaemons.Count -eq 1) {
  $d = $ownDaemons[0]
  $created = $d.CreationDate.ToUniversalTime()
  Write-Output ('daemon pid=' + $d.ProcessId + ' created=' + $created.ToString('o') + ' afterBoot=' + ($created -gt $boot))
  $game = @($nodes | Where-Object { $_.ParentProcessId -eq $d.ProcessId -and $_.CommandLine -match 'ProcessContainerFork\.js' })
}
$detail = ($game | ForEach-Object { 'pid=' + $_.ProcessId + ' owner=' + (Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User + ' created=' + $_.CreationDate.ToUniversalTime().ToString('o') }) -join '; '
$gameOwnerOk = ($game.Count -eq 1 -and (Invoke-CimMethod -InputObject $game[0] -MethodName GetOwner).User -eq $cfg.serviceAccount)
Report 'single-game-process' $gameOwnerOk ('count=' + $game.Count + ' ' + $detail)
$pidFiles = @(Get-ChildItem -LiteralPath ($cfg.pm2Home + '\pids') -Filter ($cfg.appName + '-*.pid') -ErrorAction SilentlyContinue)
$pidOk = ($pidFiles.Count -eq 1 -and $game.Count -eq 1 -and ([IO.File]::ReadAllText($pidFiles[0].FullName).Trim() -eq [string]$game[0].ProcessId))
Report 'pm2-app-pid-file' $pidOk ('files=' + $pidFiles.Count)

$listen = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $cfg.listenPorts -contains $_.LocalPort })
foreach ($port in $cfg.listenPorts) {
  $owners = @($listen | Where-Object { $_.LocalPort -eq $port } | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique)
  Report ('port ' + $port) ($game.Count -eq 1 -and $owners.Count -ge 1 -and @($owners | Where-Object { $_ -ne $game[0].ProcessId }).Count -eq 0) ('owners=' + ($owners -join ','))
}
try {
  $summary = Get-SrvproDumpSummary $cfg
  Assert-SrvproDumpMatches $cfg $summary
  Report 'dump' $true ('apps=' + (@($summary) | ForEach-Object { $_.name + ' ' + $_.exec_mode + ' watch=' + $_.watch }) -join '; ')
} catch { Report 'dump' $false $_.Exception.Message }

Write-Output ('FAILED=' + ($failed -join ','))
if ($failed.Count) { exit 1 }
exit 0
