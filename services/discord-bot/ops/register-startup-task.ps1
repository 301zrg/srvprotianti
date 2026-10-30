param(
 # PM2 owner whose profile holds the existing PM2_HOME; refuse to register under any other account.
 [string]$ExpectedProfile='C:\Users\Administrator'
)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
# The deployment layout is <root>\discord-bot\ops\this-script, matching start-pm2.ps1.
$bot=Split-Path -Parent $PSScriptRoot;$name='SRVPro-Discord'
$start=Join-Path $PSScriptRoot 'start-pm2.ps1';$snapshot=Join-Path $PSScriptRoot 'pm2-safe-snapshot.cjs'
$description='Start only the reviewed Discord bot and dedicated Clash proxy; leave online PM2 workers untouched.'
$pm2=(Get-Command pm2.cmd).Source;$pm2Home=Join-Path $env:USERPROFILE '.pm2'
if($env:USERPROFILE -ne $ExpectedProfile){throw 'Unexpected PM2 service account'}
$existing=Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction SilentlyContinue
if($existing -and ($existing.Description -ne $description -or $existing.Actions.Arguments -notmatch [regex]::Escape($start))){throw 'Unrecognized existing startup task refused'}
$raw=&$pm2 jlist;if($LASTEXITCODE -ne 0){throw 'PM2 inspection failed'}
$before=$raw|&node.exe $snapshot
if($LASTEXITCODE -ne 0){throw 'PM2 safe projection failed'}
$action=New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$start+'" -Pm2Command "'+$pm2+'" -Pm2Home "'+$pm2Home+'"') -WorkingDirectory $bot
$trigger=New-ScheduledTaskTrigger -AtStartup;$trigger.Delay='PT45S'
$principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Highest
$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
if(-not $existing){Register-ScheduledTask -TaskName $name -TaskPath '\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $description|Out-Null}
# Idempotence check: running the task now must leave every online PM2 worker untouched.
Start-ScheduledTask -TaskName $name -TaskPath '\'
$deadline=[DateTime]::UtcNow.AddSeconds(20)
do{Start-Sleep -Milliseconds 300;$info=Get-ScheduledTaskInfo -TaskName $name -TaskPath '\';$task=Get-ScheduledTask -TaskName $name -TaskPath '\'}while(($task.State -eq 'Running' -or $info.LastRunTime.Year -lt 2026) -and [DateTime]::UtcNow -lt $deadline)
if($task.State -eq 'Running' -or $info.LastTaskResult -ne 0){throw 'Startup task test failed; inspect task metadata before any retry'}
$raw=&$pm2 jlist;if($LASTEXITCODE -ne 0){throw 'PM2 inspection failed after task'}
$after=$raw|&node.exe $snapshot
if($LASTEXITCODE -ne 0 -or $before -ne $after){throw 'PM2 process metadata changed during idempotence check'}
$report=[pscustomobject]@{timestampUtc=[DateTime]::UtcNow.ToString('o');taskName=$name;state=[string]$task.State;lastTaskResult=$info.LastTaskResult;account=$task.Principal.UserId;logonType=[string]$task.Principal.LogonType;bootDelaySeconds=45;idempotentTaskRunPassed=$true;allProcessMetadataPreserved=$true;rebootTested=$false;pm2Home=$pm2Home;onlyApps=@('discord-proxy','discord-bot')}
[IO.File]::WriteAllText((Join-Path $bot 'data\boot-task-report.json'),($report|ConvertTo-Json -Depth 6),(New-Object Text.UTF8Encoding($false)))
$report|ConvertTo-Json -Depth 6 -Compress
