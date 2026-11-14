# Shared functions for the Windows service launcher (Windows PowerShell 5.1).
# Keep this file ASCII-only: PS 5.1 misreads BOM-less UTF-8 scripts.
#
# Why the CLI is started this way (verified on Windows Server 2022, PS 5.1.20348):
# - Start-Process -PassThru with -RedirectStandardOutput/-RedirectStandardError returns a
#   Process object whose ExitCode is $null after exit, so success and failure look the same.
# - Start-Process -Wait waits for the whole process tree, including the detached PM2 daemon.
# Process.Start keeps the process handle (reliable ExitCode); cmd.exe performs file
# redirection, so no pipe can be held open by the daemon, and WaitForExit waits for
# cmd.exe (= the PM2 CLI) only.

Set-StrictMode -Version 2.0

$script:SrvproCmdMeta = '["&|<>^%!`\r\n\x00]'
$script:SrvproAdminSid = 'S-1-5-32-544'
$script:SrvproLibDir = $PSScriptRoot

function Assert-SrvproSafeText([string]$Value, [string]$Name) {
  if ([string]::IsNullOrEmpty($Value)) { throw ($Name + ' is empty') }
  if ($Value -match $script:SrvproCmdMeta) { throw ($Name + ' contains a quote, newline or cmd metacharacter') }
}

function Assert-SrvproSafePath([string]$Value, [string]$Name) {
  Assert-SrvproSafeText $Value $Name
  if ($Value -notmatch '^[A-Za-z]:\\') { throw ($Name + ' must be an absolute local path like C:\dir') }
  if ($Value.EndsWith('\')) { throw ($Name + ' must not end with a backslash') }
  if ($Value -match '\\\.\.?(\\|$)') { throw ($Name + ' must not contain . or .. segments') }
}

function Get-SrvproProperty($Object, [string]$Name, [bool]$Required = $true) {
  $p = $Object.PSObject.Properties[$Name]
  if ($null -eq $p -or $null -eq $p.Value) {
    if ($Required) { throw ('Missing config field: ' + $Name) }
    return $null
  }
  return $p.Value
}

function Get-SrvproInt($Object, [string]$Name, [int]$Min, [int]$Max, $Default) {
  $v = Get-SrvproProperty $Object $Name ($null -eq $Default)
  if ($null -eq $v) { return [int]$Default }
  if (-not ($v -is [int] -or $v -is [long]) -or $v -lt $Min -or $v -gt $Max) {
    throw ($Name + ' must be an integer from ' + $Min + ' to ' + $Max)
  }
  return [int]$v
}

# Validates the parsed JSON and returns a normalized object. Throws on any problem.
function ConvertTo-SrvproServiceConfig($Raw) {
  $known = @('appName','serviceAccount','applicationDir','startScript','nodeExe','pm2Cli','pm2Home',
    'logDir','postgres','listenPorts','listenWaitSeconds','cliTimeoutSeconds','taskPrefix')
  foreach ($p in $Raw.PSObject.Properties) { if ($known -notcontains $p.Name) { throw ('Unknown config field: ' + $p.Name) } }
  $cfg = [ordered]@{}
  $cfg.appName = [string](Get-SrvproProperty $Raw 'appName')
  if ($cfg.appName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw 'appName must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' }
  $cfg.serviceAccount = [string](Get-SrvproProperty $Raw 'serviceAccount')
  if ($cfg.serviceAccount -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$') { throw 'serviceAccount must be a local user name (letters, digits, . _ -; max 20)' }
  $prefix = Get-SrvproProperty $Raw 'taskPrefix' $false
  if ($null -eq $prefix) { $prefix = 'SRVPro-' + $cfg.appName }
  if ([string]$prefix -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw 'taskPrefix must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' }
  $cfg.taskPrefix = [string]$prefix
  foreach ($name in 'applicationDir','nodeExe','pm2Cli','pm2Home','logDir') {
    $cfg[$name] = [string](Get-SrvproProperty $Raw $name)
    Assert-SrvproSafePath $cfg[$name] $name
  }
  $cfg.startScript = [string](Get-SrvproProperty $Raw 'startScript')
  if ($cfg.startScript -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.js$') { throw 'startScript must be a .js file name inside applicationDir' }
  $pg = Get-SrvproProperty $Raw 'postgres'
  foreach ($p in $pg.PSObject.Properties) { if (@('host','port','waitSeconds','serviceName') -notcontains $p.Name) { throw ('Unknown config field: postgres.' + $p.Name) } }
  $cfg.pgHost = [string](Get-SrvproProperty $pg 'host')
  if ($cfg.pgHost -notmatch '^(127\.0\.0\.1|::1|localhost)$') { throw 'postgres.host must be a loopback address' }
  $cfg.pgPort = Get-SrvproInt $pg 'port' 1 65535 $null
  $cfg.pgWaitSeconds = Get-SrvproInt $pg 'waitSeconds' 5 600 180
  $svcName = Get-SrvproProperty $pg 'serviceName' $false
  if ($null -ne $svcName -and [string]$svcName -notmatch '^[A-Za-z0-9._-]{1,64}$') { throw 'postgres.serviceName is invalid' }
  $cfg.pgServiceName = $svcName
  $ports = @(Get-SrvproProperty $Raw 'listenPorts')
  if ($ports.Count -lt 1 -or $ports.Count -gt 8) { throw 'listenPorts must list 1 to 8 ports' }
  foreach ($port in $ports) { if (-not ($port -is [int] -or $port -is [long]) -or $port -lt 1 -or $port -gt 65535) { throw 'listenPorts must be integers from 1 to 65535' } }
  $cfg.listenPorts = [int[]]$ports
  $cfg.listenWaitSeconds = Get-SrvproInt $Raw 'listenWaitSeconds' 5 600 180
  $cfg.cliTimeoutSeconds = Get-SrvproInt $Raw 'cliTimeoutSeconds' 10 600 180
  if (($cfg.pgWaitSeconds + $cfg.listenWaitSeconds + 2 * $cfg.cliTimeoutSeconds) -gt 840) {
    throw 'postgres.waitSeconds + listenWaitSeconds + 2*cliTimeoutSeconds must not exceed 840 (task limit is 15 minutes)'
  }
  $cfg.scriptPath = $cfg.applicationDir + '\' + $cfg.startScript
  $cfg.pm2Package = Split-Path -Parent (Split-Path -Parent $cfg.pm2Cli)
  if ((Split-Path -Leaf (Split-Path -Parent $cfg.pm2Cli)) -ne 'bin' -or (Split-Path -Leaf $cfg.pm2Cli) -ne 'pm2') { throw 'pm2Cli must point to ...\node_modules\pm2\bin\pm2' }
  return [pscustomobject]$cfg
}

function Read-SrvproServiceConfig([string]$Path) {
  Assert-SrvproSafePath $Path 'ConfigPath'
  $text = [IO.File]::ReadAllText($Path)
  return ConvertTo-SrvproServiceConfig ($text | ConvertFrom-Json)
}

function Assert-SrvproConfigFilesExist($Cfg) {
  foreach ($name in 'applicationDir','pm2Home','logDir') {
    if (-not (Test-Path -LiteralPath $Cfg.$name -PathType Container)) { throw ($name + ' directory not found: ' + $Cfg.$name) }
  }
  foreach ($name in 'nodeExe','pm2Cli','scriptPath') {
    if (-not (Test-Path -LiteralPath $Cfg.$name -PathType Leaf)) { throw ($name + ' file not found: ' + $Cfg.$name) }
  }
}

# True when the SID set contains local Administrators or a domain Admins group (RID 512),
# including deny-only SIDs of a UAC-filtered token: such an account is still an administrator.
function Test-SrvproAdministratorSid([string[]]$Sids) {
  foreach ($s in $Sids) {
    if ($s -eq $script:SrvproAdminSid -or $s -match '^S-1-5-21-\d+-\d+-\d+-512$') { return $true }
  }
  return $false
}

function Get-SrvproCurrentTokenSids {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $sids = @($id.User.Value)
  $sids += @($id.Groups | ForEach-Object { $_.Value })
  $sids += @($id.Claims | Where-Object { $_.Type -like '*/denyonlysid' -or $_.Type -like '*/groupsid' } | ForEach-Object { $_.Value })
  return $sids
}

function Assert-SrvproServiceIdentity($Cfg) {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $expected = $env:COMPUTERNAME + '\' + $Cfg.serviceAccount
  if ($id.Name -ne $expected) { throw ('Must run as ' + $expected + ', not ' + $id.Name) }
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or (Test-SrvproAdministratorSid (Get-SrvproCurrentTokenSids))) {
    throw 'Service account must not be an administrator'
  }
}

function Test-SrvproTcp([string]$TargetHost, [int]$Port, [int]$TimeoutMs = 1000) {
  $targets = @($TargetHost)
  if ($TargetHost -eq 'localhost' -or $TargetHost -eq '127.0.0.1') { $targets = @('127.0.0.1','::1') }
  foreach ($t in $targets) {
    $c = New-Object Net.Sockets.TcpClient($(if ($t -eq '::1') { [Net.Sockets.AddressFamily]::InterNetworkV6 } else { [Net.Sockets.AddressFamily]::InterNetwork }))
    try {
      $ar = $c.BeginConnect($t, $Port, $null, $null)
      if ($ar.AsyncWaitHandle.WaitOne($TimeoutMs) -and $c.Connected) { $c.EndConnect($ar); return $true }
    } catch {} finally { $c.Close() }
  }
  return $false
}

# Polls until every port accepts a TCP connection or the deadline passes. Returns the missing ports.
function Wait-SrvproPorts([string]$TargetHost, [int[]]$Ports, [int]$TimeoutSeconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ($true) {
    $missing = @($Ports | Where-Object { -not (Test-SrvproTcp $TargetHost $_) })
    if ($missing.Count -eq 0 -or [DateTime]::UtcNow -ge $deadline) { return ,$missing }
    Start-Sleep -Seconds 2
  }
}

# Runs Exe with argument tokens under cmd.exe file redirection and returns the real exit code.
# Every token is validated; tokens are always double-quoted, so spaces in paths are safe.
function Invoke-SrvproLoggedCli([string]$Exe, [string[]]$Tokens, [string]$StdoutPath, [string]$StderrPath,
    [string]$WorkingDirectory, [int]$TimeoutMs) {
  Assert-SrvproSafePath $Exe 'Exe'
  Assert-SrvproSafePath $StdoutPath 'StdoutPath'
  Assert-SrvproSafePath $StderrPath 'StderrPath'
  Assert-SrvproSafePath $WorkingDirectory 'WorkingDirectory'
  $parts = @('"' + $Exe + '"')
  foreach ($t in $Tokens) {
    Assert-SrvproSafeText $t 'CLI argument'
    if ($t.EndsWith('\')) { throw 'CLI argument must not end with a backslash' }
    $parts += ('"' + $t + '"')
  }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
  $psi.Arguments = '/d /s /c "' + ($parts -join ' ') + ' 1>"' + $StdoutPath + '" 2>"' + $StderrPath + '""'
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  try {
    if (-not $p.WaitForExit($TimeoutMs)) { throw ('CLI timed out after ' + $TimeoutMs + ' ms; cmd pid ' + $p.Id + ' left for inspection') }
    $code = $p.ExitCode
  } finally { $p.Dispose() }
  if ($null -eq $code) { throw 'CLI exit code unavailable' }
  return [int]$code
}

$script:SrvproLogFile = $null
function Write-SrvproLog([string]$Message) {
  $line = [DateTime]::UtcNow.ToString('o') + ' ' + $Message
  if ($script:SrvproLogFile) {
    # FileShare ReadWrite: a concurrent reader (check-service.ps1) must not make the append fail.
    $bytes = (New-Object Text.UTF8Encoding $false).GetBytes($line + "`r`n")
    $attempt = 0
    while ($true) {
      try {
        $fs = [IO.File]::Open($script:SrvproLogFile, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
        try { $fs.Write($bytes, 0, $bytes.Length) } finally { $fs.Dispose() }
        break
      } catch [IO.IOException] {
        $attempt++
        if ($attempt -gt 5) { throw }
        Start-Sleep -Milliseconds 100
      }
    }
  }
  Write-Host $line
}

# Reads a text file that another process may be writing or deleting. Returns '' when the file
# is missing or cannot be opened right now.
function Read-SrvproSharedText([string]$Path) {
  try {
    $fs = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]'ReadWrite, Delete'))
  } catch [IO.IOException] { return '' }
  try {
    $reader = New-Object IO.StreamReader($fs, (New-Object Text.UTF8Encoding $false), $true)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
  } finally { $fs.Dispose() }
}

function Invoke-SrvproPm2($Cfg, [string[]]$Tokens, [string]$Label, [string]$Stamp) {
  $out = $Cfg.logDir + '\' + $Label + '-' + $Stamp + '.stdout.log'
  $err = $Cfg.logDir + '\' + $Label + '-' + $Stamp + '.stderr.log'
  $code = Invoke-SrvproLoggedCli $Cfg.nodeExe (@($Cfg.pm2Cli) + $Tokens) $out $err $Cfg.applicationDir ($Cfg.cliTimeoutSeconds * 1000)
  Write-SrvproLog ('pm2 ' + $Label + ' exit=' + $code + ' stdout=' + $out)
  if ($code -ne 0) { throw ('pm2 ' + $Label + ' failed with exit code ' + $code + '; see ' + $err) }
}

# Whitelisted summary of dump.pm2 via node (PS 5.1 ConvertFrom-Json rejects env keys that
# differ only by case, e.g. username/USERNAME). Never returns environment values.
function Get-SrvproDumpSummary($Cfg) {
  $dump = $Cfg.pm2Home + '\dump.pm2'
  if (-not (Test-Path -LiteralPath $dump -PathType Leaf)) { return $null }
  $helper = Join-Path $script:SrvproLibDir 'pm2-dump-summary.cjs'
  $json = & $Cfg.nodeExe $helper $dump
  if ($LASTEXITCODE -ne 0) { throw ('dump.pm2 summary failed with exit code ' + $LASTEXITCODE) }
  return @(($json -join '') | ConvertFrom-Json)
}

function Assert-SrvproDumpMatches($Cfg, $Summary) {
  if ($null -eq $Summary) { throw 'dump.pm2 not found; run the Start task first' }
  $apps = @($Summary | Where-Object { $null -ne $_ })
  if ($apps.Count -ne 1) { throw ('dump.pm2 must contain exactly one application, found ' + $apps.Count) }
  $a = $apps[0]
  if ($a.name -ne $Cfg.appName) { throw ('dump.pm2 application name mismatch: ' + $a.name) }
  if ($a.script -ne $Cfg.scriptPath) { throw ('dump.pm2 script mismatch: ' + $a.script) }
  if ($a.cwd -ne $Cfg.applicationDir) { throw ('dump.pm2 cwd mismatch: ' + $a.cwd) }
  if ($a.exec_mode -ne 'fork_mode' -or $a.watch -ne $false) { throw 'dump.pm2 must use fork_mode with watch=false' }
}

# PM2 on Windows uses machine-wide named pipes; PM2_HOME does not isolate them.
function Test-SrvproPm2Pipe { return (@([IO.Directory]::GetFiles('\\.\pipe\')) -contains '\\.\pipe\rpc.sock') }

function Get-SrvproPipeServerPid {
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $tool = Join-Path (Split-Path -Parent $script:SrvproLibDir) 'pipe-server-pid.ps1'
  $out = & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $tool -PipeName rpc.sock
  if ($LASTEXITCODE -ne 0) { throw 'Cannot identify the PM2 rpc.sock server process' }
  return [int](($out -join '').Trim())
}

# Describes the PM2 daemon currently serving rpc.sock. Own=$true only when the pipe server
# is our pm2.pid, a node.exe running this PM2 package's Daemon.js as the service account.
function Get-SrvproDaemonState($Cfg) {
  if (-not (Test-SrvproPm2Pipe)) { return [pscustomobject]@{Running=$false; Own=$false; Pid=0; Detail='no rpc.sock pipe'} }
  $serverPid = Get-SrvproPipeServerPid
  $pidFile = $Cfg.pm2Home + '\pm2.pid'
  $filePid = if (Test-Path -LiteralPath $pidFile) { ([IO.File]::ReadAllText($pidFile)).Trim() } else { '' }
  $proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $serverPid)
  $owner = if ($proc) { (Invoke-CimMethod -InputObject $proc -MethodName GetOwner).User } else { '' }
  $daemonJs = $Cfg.pm2Package + '\lib\Daemon.js'
  $own = ($proc -and $proc.Name -eq 'node.exe' -and [string]$serverPid -eq $filePid -and $owner -eq $Cfg.serviceAccount -and
    $proc.CommandLine -and $proc.CommandLine.ToLowerInvariant().Contains($daemonJs.ToLowerInvariant()))
  return [pscustomobject]@{Running=$true; Own=[bool]$own; Pid=$serverPid; Detail=('pipePid=' + $serverPid + ' pm2.pid=' + $filePid + ' owner=' + $owner)}
}

function Wait-SrvproPostgres($Cfg) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Cfg.pgWaitSeconds)
  while (-not (Test-SrvproTcp $Cfg.pgHost $Cfg.pgPort)) {
    if ([DateTime]::UtcNow -ge $deadline) { throw ('PostgreSQL ' + $Cfg.pgHost + ':' + $Cfg.pgPort + ' not reachable within ' + $Cfg.pgWaitSeconds + ' s') }
    Start-Sleep -Seconds 2
  }
  Write-SrvproLog ('postgres reachable ' + $Cfg.pgHost + ':' + $Cfg.pgPort)
}

function Wait-SrvproApplication($Cfg, [string]$OnFailure = '') {
  $missing = Wait-SrvproPorts '127.0.0.1' $Cfg.listenPorts $Cfg.listenWaitSeconds
  if ($missing.Count) { throw ('Application ports not listening within ' + $Cfg.listenWaitSeconds + ' s: ' + ($missing -join ',') + $OnFailure) }
  Write-SrvproLog ('application listening on ' + ($Cfg.listenPorts -join ','))
}

# Applications of the running daemon via direct read-only RPC (pm2-apps-readonly.cjs). The PM2
# CLI is never used for this: even "pm2 jlist" starts a new daemon when none answers.
function Get-SrvproLiveApps($Cfg, [int]$DaemonPid, [string]$Stamp = '') {
  $helper = Join-Path $script:SrvproLibDir 'pm2-apps-readonly.cjs'
  if (-not $Stamp) { $Stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') }
  $out = $Cfg.logDir + '\liveapps-' + $Stamp + '.stdout.log'
  $err = $Cfg.logDir + '\liveapps-' + $Stamp + '.stderr.log'
  $code = Invoke-SrvproLoggedCli $Cfg.nodeExe @($helper, $Cfg.pm2Cli, $Cfg.pm2Home, [string]$DaemonPid) $out $err $Cfg.applicationDir 60000
  if ($code -ne 0) {
    $first = ''
    $errText = Read-SrvproSharedText $err
    if ($errText) { $first = ($errText -split "`r?`n")[0].Trim() }
    throw ('Read-only PM2 query failed with exit code ' + $code + ': ' + $first + '; see ' + $err)
  }
  $json = Read-SrvproSharedText $out
  return @($json | ConvertFrom-Json)
}

function Assert-SrvproLiveAppsMatch($Cfg, $Apps) {
  $apps = @($Apps | Where-Object { $null -ne $_ })
  if ($apps.Count -ne 1) { throw ('PM2 must manage exactly one application, found ' + $apps.Count) }
  $a = $apps[0]
  if ($a.name -ne $Cfg.appName) { throw ('PM2 application name mismatch: ' + $a.name) }
  if ($a.script -ne $Cfg.scriptPath) { throw ('PM2 application script mismatch: ' + $a.script) }
  if ($a.cwd -ne $Cfg.applicationDir) { throw ('PM2 application cwd mismatch: ' + $a.cwd) }
  if ($a.exec_mode -ne 'fork_mode' -or $a.watch -ne $false) { throw 'PM2 application must use fork_mode with watch=false' }
  if ($a.status -ne 'online') { throw ('PM2 application status is ' + $a.status + ', not online') }
}

# pm2 save overwrites dump.pm2 with whatever the daemon holds. So: verify the live list first,
# keep a copy of the previous dump, and put it back if the new dump does not match.
function Save-SrvproProcessList($Cfg, [string]$Stamp) {
  $state = Get-SrvproDaemonState $Cfg
  if (-not $state.Own) { throw ('Save requires the running own PM2 daemon: ' + $state.Detail) }
  try { Assert-SrvproLiveAppsMatch $Cfg (Get-SrvproLiveApps $Cfg $state.Pid) }
  catch { throw ($_.Exception.Message + '; pm2 save not run, dump.pm2 unchanged') }
  $dump = $Cfg.pm2Home + '\dump.pm2'
  $backup = $null
  if (Test-Path -LiteralPath $dump -PathType Leaf) {
    $backup = $Cfg.pm2Home + '\dump.pm2.before-save-' + $Stamp
    [IO.File]::Copy($dump, $backup, $false)
    Write-SrvproLog ('previous dump.pm2 copied to ' + $backup)
  }
  try {
    Invoke-SrvproPm2 $Cfg @('save') 'save' $Stamp
    # pm2 save spawns a new (empty) daemon when ours stopped answering; detect that.
    $after = Get-SrvproDaemonState $Cfg
    if (-not $after.Own -or $after.Pid -ne $state.Pid) {
      throw ('PM2 daemon changed during save (was pid ' + $state.Pid + ', now ' + $after.Detail + '); pm2 save may have started a new empty daemon')
    }
    Assert-SrvproLiveAppsMatch $Cfg (Get-SrvproLiveApps $Cfg $after.Pid)
    Assert-SrvproDumpMatches $Cfg (Get-SrvproDumpSummary $Cfg)
  } catch {
    $why = $_.Exception.Message
    if ($backup) {
      [IO.File]::Copy($backup, $dump, $true)
      throw ($why + '; previous dump.pm2 restored from ' + $backup)
    }
    if (Test-Path -LiteralPath $dump) {
      $rejected = $Cfg.pm2Home + '\dump.pm2.rejected-' + $Stamp
      [IO.File]::Move($dump, $rejected)
      throw ($why + '; there was no previous dump.pm2, the new one was moved to ' + $rejected)
    }
    throw $why
  }
  Write-SrvproLog 'dump.pm2 saved and verified'
}

# Start: first start. Refused when a foreign daemon runs or a dump.pm2 already exists. When our
# own daemon already runs but no dump.pm2 exists, a previous Start did not finish: resume it
# (no second pm2 start), wait for the ports and save.
# Save: verified re-save of the running own daemon (see Save-SrvproProcessList).
# Resurrect: boot recovery from dump.pm2; if our daemon already runs (task retry), only waits for ports.
function Invoke-SrvproServiceMode($Cfg, [string]$Mode, [string]$Stamp) {
  Wait-SrvproPostgres $Cfg
  $state = Get-SrvproDaemonState $Cfg
  Write-SrvproLog ('daemon running=' + $state.Running + ' own=' + $state.Own + ' ' + $state.Detail)
  $hasDump = Test-Path -LiteralPath ($Cfg.pm2Home + '\dump.pm2') -PathType Leaf
  switch ($Mode) {
    'Start' {
      if ($state.Running -and -not $state.Own) { throw ('A foreign PM2 daemon serves rpc.sock: ' + $state.Detail + '; Start refused') }
      if ($hasDump) { throw 'dump.pm2 already exists, so the first start is complete: use the Save task to re-save, or the Startup task to recover' }
      if ($state.Own) {
        Write-SrvproLog 'resuming an unfinished Start: own daemon runs and no dump.pm2 exists; pm2 start skipped'
        Assert-SrvproLiveAppsMatch $Cfg (Get-SrvproLiveApps $Cfg $state.Pid)
      } else {
        Invoke-SrvproPm2 $Cfg @('start', $Cfg.scriptPath, '--name', $Cfg.appName, '--cwd', $Cfg.applicationDir, '--time') 'start' $Stamp
      }
      Wait-SrvproApplication $Cfg ('. The PM2 daemon and application were left running and nothing was saved. Fix or wait, then run the Start task again: it resumes without a second pm2 start (windows-install.md 5.7)')
      Save-SrvproProcessList $Cfg $Stamp
    }
    'Save' { Save-SrvproProcessList $Cfg $Stamp }
    'Resurrect' {
      Assert-SrvproDumpMatches $Cfg (Get-SrvproDumpSummary $Cfg)
      if ($state.Running -and -not $state.Own) { throw ('A foreign PM2 daemon serves rpc.sock: ' + $state.Detail) }
      if ($state.Own) { Write-SrvproLog 'own daemon already running; resurrect skipped' }
      else { Invoke-SrvproPm2 $Cfg @('resurrect') 'resurrect' $Stamp }
      Wait-SrvproApplication $Cfg
    }
    default { throw ('Unknown mode: ' + $Mode) }
  }
}

# Waits for ONE scheduled-task run started by the caller, without trusting LastRunTime ordering
# (it was observed ~15 s off on the test VM and can move with clock changes). A run is finished
# when a NEW service-<mode>-*.log (absent from $LogsBefore) ends with result=0/1 and the task is no
# longer Running. If the task ran (seen Running, or LastRunTime changed) and stopped without
# writing a log, or with a new log that has no result line, the run counts as finished (with an
# error) after $GraceSeconds. The deadline uses a monotonic
# stopwatch. $GetTask returns {State; LastTaskResult; LastRunTime}; $GetLogs returns {Name; Text}.
function Wait-SrvproTaskRun([scriptblock]$GetTask, [scriptblock]$GetLogs, [string[]]$LogsBefore, $LastRunBefore,
    [int]$TimeoutSeconds, [int]$GraceSeconds = 15, [int]$PollMilliseconds = 1000) {
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $sawRunning = $false; $stoppedAt = $null; $log = $null; $logResult = $null; $task = $null
  while ($clock.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
    $task = & $GetTask
    if ($task.State -eq 'Running') { $sawRunning = $true; $stoppedAt = $null }
    if (-not $log) {
      $new = @(& $GetLogs | Where-Object { $LogsBefore -notcontains $_.Name } | Sort-Object Name)
      if ($new.Count -gt 1) { return [pscustomobject]@{Finished=$true; Error=('more than one new service log: ' + (($new | ForEach-Object { $_.Name }) -join ', ')); Task=$task} }
      if ($new.Count -eq 1) { $log = $new[0].Name }
    }
    if ($log) {
      $text = [string](@(& $GetLogs | Where-Object { $_.Name -eq $log })[0].Text)
      $m = [regex]::Match($text, '(?m) result=([01])(\s|$)')
      if ($m.Success) { $logResult = [int]$m.Groups[1].Value }
    }
    $ran = $sawRunning -or ($null -ne $LastRunBefore -and $task.LastRunTime -ne $LastRunBefore)
    if ($task.State -ne 'Running') {
      if ($null -ne $logResult -and $task.LastTaskResult -ne 267009) {
        return [pscustomobject]@{Finished=$true; Error=$null; Log=$log; LogResult=$logResult; TaskResult=$task.LastTaskResult; Task=$task}
      }
      if ($ran -and ($null -eq $log -or $null -eq $logResult)) {
        if ($null -eq $stoppedAt) { $stoppedAt = $clock.Elapsed.TotalSeconds }
        elseif ($clock.Elapsed.TotalSeconds - $stoppedAt -ge $GraceSeconds) {
          if ($null -eq $log) {
            return [pscustomobject]@{Finished=$true; Error='task ended without writing a service log (config or identity failure before logging)'; Log=$null; LogResult=$null; TaskResult=$task.LastTaskResult; Task=$task}
          }
          return [pscustomobject]@{Finished=$true; Error='service log has no result line (the run was interrupted)'; Log=$log; LogResult=$null; TaskResult=$task.LastTaskResult; Task=$task}
        }
      }
    }
    Start-Sleep -Milliseconds $PollMilliseconds
  }
  return [pscustomobject]@{Finished=$false; Error='timeout'; Log=$log; LogResult=$logResult; TaskResult=$(if ($task) { $task.LastTaskResult } else { $null }); Task=$task}
}

# ---- Admin-side helpers (register-tasks.ps1, grant-batch-logon.ps1, check-service.ps1) ----

# Returns the SIDs listed for one user right in a secedit /export USER_RIGHTS file.
# secedit writes '*S-1-...' for SIDs but plain account names for some entries; names are translated.
function Get-SrvproRightSids([string[]]$Lines, [string]$Right) {
  $line = @($Lines | Where-Object { $_ -match ('^' + [regex]::Escape($Right) + '\s*=') })
  if ($line.Count -gt 1) { throw ('Duplicate ' + $Right + ' lines') }
  if ($line.Count -eq 0) { return @() }
  $result = @()
  foreach ($entry in (($line[0] -split '=', 2)[1].Trim() -split ',')) {
    $e = $entry.Trim()
    if (-not $e) { continue }
    if ($e.StartsWith('*')) { $result += $e.Substring(1) }
    else {
      try { $result += (New-Object Security.Principal.NTAccount($e)).Translate([Security.Principal.SecurityIdentifier]).Value }
      catch { $result += ('UNRESOLVED:' + $e) }
    }
  }
  return $result
}

function Test-SrvproSameSet([string[]]$A, [string[]]$B) {
  $x = (@($A | Where-Object { $_ } | Sort-Object -Unique) -join '|')
  $y = (@($B | Where-Object { $_ } | Sort-Object -Unique) -join '|')
  return ($x -eq $y)
}

function Get-SrvproUserRightsLines {
  $tmp = Join-Path $env:TEMP ('srvpro-rights-' + [guid]::NewGuid().ToString('N') + '.inf')
  try {
    & (Join-Path $env:SystemRoot 'System32\secedit.exe') /export /areas USER_RIGHTS /cfg $tmp /quiet | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'secedit export failed' }
    return [IO.File]::ReadAllLines($tmp)
  } finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}

function Assert-SrvproElevatedAdmin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this in an elevated administrator PowerShell' }
}

function Get-SrvproServiceUser($Cfg) {
  $u = Get-LocalUser -Name $Cfg.serviceAccount -ErrorAction SilentlyContinue
  if (-not $u) { throw ('Local user not found: ' + $Cfg.serviceAccount) }
  if (-not $u.Enabled) { throw ('Local user is disabled: ' + $Cfg.serviceAccount) }
  $admins = @(Get-LocalGroupMember -SID $script:SrvproAdminSid | ForEach-Object { if ($_.SID) { $_.SID.Value } })
  if ($admins -contains $u.SID.Value) { throw 'Service account is a member of Administrators; use a normal user' }
  return $u
}

# Fails when the service account (or Users/Everyone/Authenticated Users/Interactive) can modify Path.
function Assert-SrvproNotWritableBy([string]$Path, [string]$ServiceSid) {
  $write = [Security.AccessControl.FileSystemRights]'WriteData, AppendData, WriteExtendedAttributes, WriteAttributes, Delete, ChangePermissions, TakeOwnership'
  $watch = @($ServiceSid, 'S-1-5-32-545', 'S-1-1-0', 'S-1-5-11', 'S-1-5-4')
  foreach ($rule in (Get-Acl -LiteralPath $Path).Access) {
    if ($rule.AccessControlType -ne 'Allow') { continue }
    try { $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { continue }
    $generic = ([int64]$rule.FileSystemRights -band 0x50000000) -ne 0   # GENERIC_ALL / GENERIC_WRITE
    if ($watch -contains $sid -and (($rule.FileSystemRights -band $write) -or $generic)) {
      throw ($Path + ' is writable by ' + $rule.IdentityReference.Value + '; the service account must only read it')
    }
  }
}

function Get-SrvproTaskNames($Cfg) {
  return [pscustomobject]@{Start=($Cfg.taskPrefix + '-Start'); Save=($Cfg.taskPrefix + '-Save'); Startup=($Cfg.taskPrefix + '-Startup')}
}
