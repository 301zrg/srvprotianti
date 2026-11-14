# Targeted tests for ops/scripts/windows-service (run with Windows PowerShell 5.1):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops\tests\windows-service.tests.ps1
# Uses a fake PM2 CLI and temp directories only. Never runs the real PM2 CLI, never creates or
# queries the machine-wide PM2 rpc.sock pipe (the pipe functions are replaced in this session).
$ErrorActionPreference = 'Stop'
$lib = Join-Path $PSScriptRoot '..\scripts\windows-service\srvpro-service.lib.ps1'
. $lib
$node = (Get-Command node.exe -ErrorAction Stop).Source
$root = Join-Path $env:TEMP ('srvpro-svc-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$results = New-Object System.Collections.ArrayList
$spawned = New-Object System.Collections.ArrayList

function Record([string]$Name, [bool]$Ok, [string]$Detail = '') {
  [void]$results.Add([pscustomobject]@{Test=$Name; Pass=$Ok; Detail=$Detail})
}
function Expect-Throw([string]$Name, [scriptblock]$Block, [string]$Pattern) {
  try { & $Block; Record $Name $false 'did not throw' }
  catch { $m = $_.Exception.Message; Record $Name ($m -match $Pattern) $m }
}
function Free-Port {
  $l = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0); $l.Start()
  $p = $l.LocalEndpoint.Port; $l.Stop(); return $p
}

# ---------- fixture: directories with a space, fake PM2 CLI, fake PostgreSQL listener ----------
$app = Join-Path $root 'app dir'
$pm2Home = Join-Path $root 'pm2 home'
$logs = Join-Path $root 'logs'
$pm2Bin = Join-Path $root 'tools\pm2\node_modules\pm2\bin'
foreach ($d in $app, $pm2Home, $logs, $pm2Bin) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
[IO.File]::WriteAllText((Join-Path $app 'ygopro-server.js'), '// placeholder')
$fakeCli = Join-Path $pm2Bin 'pm2'
[IO.File]::WriteAllText($fakeCli, @'
// Fake PM2 CLI. Behaviour is driven by FAKE_* environment variables.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const home = process.env.PM2_HOME, cmd = process.argv[2];
fs.appendFileSync(path.join(home, 'calls.log'), JSON.stringify(process.argv.slice(2)) + '\n');
process.stdout.write('[PM2] fake ' + cmd + '\n');
process.stderr.write('fake warning line\n');
const listen = Number(process.env.FAKE_LISTEN_PORT || 0);
if ((cmd === 'start' || cmd === 'resurrect' || cmd === 'spawn') && listen) {
  const src = 'require("net").createServer(()=>{}).listen(' + listen + ',"127.0.0.1");setTimeout(()=>process.exit(0),' + Number(process.env.FAKE_LISTEN_MS || 8000) + ')';
  const child = cp.spawn(process.execPath, ['-e', src], {detached: true, stdio: 'inherit', windowsHide: true});
  fs.writeFileSync(path.join(home, 'fake-daemon.pid'), String(child.pid));
  child.unref();
}
if (cmd === 'save' && process.env.FAKE_DUMP) fs.copyFileSync(process.env.FAKE_DUMP, path.join(home, 'dump.pm2'));
setTimeout(() => process.exit(Number(process.env.FAKE_EXIT || 0)), Number(process.env.FAKE_SLEEP_MS || 200));
'@)
$pgPort = Free-Port
$pgListener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $pgPort); $pgListener.Start()

function New-RawConfig([hashtable]$Override = @{}) {
  $raw = [ordered]@{appName='srvpro-test'; serviceAccount='srvprosvc'; applicationDir=$app; startScript='ygopro-server.js';
    nodeExe=$node; pm2Cli=$fakeCli; pm2Home=$pm2Home; logDir=$logs;
    postgres=[ordered]@{host='127.0.0.1'; port=$pgPort; waitSeconds=5}; listenPorts=@(Free-Port); listenWaitSeconds=6; cliTimeoutSeconds=20}
  foreach ($k in $Override.Keys) { $raw[$k] = $Override[$k] }
  return (($raw | ConvertTo-Json -Depth 4) | ConvertFrom-Json)
}
function Write-Dump([string]$Path, [object[]]$Apps) {
  $json = '[' + (($Apps | ForEach-Object { $_ }) -join ',') + ']'
  [IO.File]::WriteAllText($Path, $json)
}
function App-Json([string]$Name, [string]$Script, [string]$Cwd, [string]$Watch = 'false') {
  $e = { param($s) $s.Replace('\', '\\') }
  return ('{"name":"' + $Name + '","pm_exec_path":"' + (& $e $Script) + '","pm_cwd":"' + (& $e $Cwd) + '","exec_mode":"fork_mode","watch":' + $Watch +
    ',"autorestart":true,"status":"online","env":{"username":"a","USERNAME":"b","DB_PASSWORD":"TOPSECRET-123"}}')
}
function Reset-Fake { foreach ($k in 'FAKE_EXIT','FAKE_LISTEN_PORT','FAKE_LISTEN_MS','FAKE_DUMP','FAKE_SLEEP_MS') { Remove-Item ('Env:' + $k) -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath (Join-Path $pm2Home 'calls.log'), (Join-Path $pm2Home 'dump.pm2') -ErrorAction SilentlyContinue }
function Calls { $f = Join-Path $pm2Home 'calls.log'; if (Test-Path $f) { return ,@(Get-Content $f) } else { return ,@() } }
function Track-Daemon { $f = Join-Path $pm2Home 'fake-daemon.pid'; if (Test-Path $f) { [void]$spawned.Add([int](Get-Content $f)); Remove-Item $f } }
$env:PM2_HOME = $pm2Home

try {
  # ---------- A. root-cause regression: Start-Process vs Invoke-SrvproLoggedCli ----------
  $isPs51 = $PSVersionTable.PSVersion.Major -eq 5
  Reset-Fake; $env:FAKE_EXIT = '7'
  $p = Start-Process -FilePath $node -ArgumentList ('"' + $fakeCli + '" probe') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs 'sp.out') -RedirectStandardError (Join-Path $logs 'sp.err')
  $p.WaitForExit()
  if ($isPs51) { Record 'A1 PS5.1 Start-Process+redirect loses ExitCode (documents root cause)' ($null -eq $p.ExitCode) ('ExitCode=' + $p.ExitCode) }
  $code = Invoke-SrvproLoggedCli $node @($fakeCli, 'probe') (Join-Path $logs 'a2.out') (Join-Path $logs 'a2.err') $app 20000
  Record 'A2 LoggedCli returns real non-zero exit code' ($code -eq 7) ('code=' + $code)
  $env:FAKE_EXIT = '0'
  $code = Invoke-SrvproLoggedCli $node @($fakeCli, 'probe') (Join-Path $logs 'a3.out') (Join-Path $logs 'a3.err') $app 20000
  Record 'A3 LoggedCli returns 0 and writes stdout/stderr files' ($code -eq 0 -and (Get-Content (Join-Path $logs 'a3.out')) -match 'fake probe' -and (Get-Content (Join-Path $logs 'a3.err')) -match 'fake warning') ('code=' + $code)

  Reset-Fake; $env:FAKE_LISTEN_PORT = [string](Free-Port); $env:FAKE_LISTEN_MS = '4000'
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $null = Start-Process -FilePath $node -ArgumentList ('"' + $fakeCli + '" spawn') -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput (Join-Path $logs 'w.out') -RedirectStandardError (Join-Path $logs 'w.err')
  $sw.Stop(); Track-Daemon
  Record 'A4 Start-Process -Wait waits for the detached daemon tree (documents root cause)' ($sw.ElapsedMilliseconds -ge 3000) ('ms=' + $sw.ElapsedMilliseconds)
  $env:FAKE_LISTEN_PORT = [string](Free-Port); $env:FAKE_EXIT = '5'
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $code = Invoke-SrvproLoggedCli $node @($fakeCli, 'spawn') (Join-Path $logs 'a5.out') (Join-Path $logs 'a5.err') $app 20000
  $sw.Stop(); $dpid = [int](Get-Content (Join-Path $pm2Home 'fake-daemon.pid')); Track-Daemon
  $alive = [bool](Get-Process -Id $dpid -ErrorAction SilentlyContinue)
  Record 'A5 LoggedCli does not wait for a daemon that inherited stdio; keeps exit code' ($code -eq 5 -and $sw.ElapsedMilliseconds -lt 2500 -and $alive) ('code=' + $code + ' ms=' + $sw.ElapsedMilliseconds + ' daemonAlive=' + $alive)

  Reset-Fake; $env:FAKE_SLEEP_MS = '3000'
  Expect-Throw 'A6 timeout throws' { Invoke-SrvproLoggedCli $node @($fakeCli, 'probe') (Join-Path $logs 'a6.out') (Join-Path $logs 'a6.err') $app 500 } 'timed out after 500 ms'
  Reset-Fake
  foreach ($bad in @('a&b', 'a|b', 'x>y', '%PATH%', 'a"b', 'a^b', 'a!b', "a`nb", 'C:\dir\')) {
    Expect-Throw ('A7 rejects CLI token ' + ($bad -replace "`n", '\n')) { Invoke-SrvproLoggedCli $node @($fakeCli, $bad) (Join-Path $logs 'a7.out') (Join-Path $logs 'a7.err') $app 5000 } '(metacharacter|backslash)'
  }
  Record 'A7 rejected tokens never reached the CLI' ((Calls).Count -eq 0) ('calls=' + (Calls).Count)
  $code = Invoke-SrvproLoggedCli $node @($fakeCli, 'probe', (Join-Path $app 'ygopro-server.js'), '--name', 'x y') (Join-Path $logs 'a8.out') (Join-Path $logs 'a8.err') $app 5000
  $argv = (Calls)[-1] | ConvertFrom-Json
  Record 'A8 paths with spaces arrive as single arguments' ($code -eq 0 -and $argv.Count -eq 4 -and $argv[1] -eq (Join-Path $app 'ygopro-server.js') -and $argv[3] -eq 'x y') ((Calls)[-1])

  # ---------- B. configuration validation ----------
  $cfg = ConvertTo-SrvproServiceConfig (New-RawConfig)
  Record 'B1 valid config accepted; derived paths' ($cfg.scriptPath -eq (Join-Path $app 'ygopro-server.js') -and $cfg.pm2Package -eq (Split-Path -Parent $pm2Bin) -and $cfg.taskPrefix -eq 'SRVPro-srvpro-test') $cfg.scriptPath
  Assert-SrvproConfigFilesExist $cfg; Record 'B2 configured files exist check passes' $true
  $badCases = @(
    @('B3 relative path', @{applicationDir='app'}, 'absolute'),
    @('B4 metachar in path', @{logDir='C:\a&b'}, 'metacharacter'),
    @('B5 quote in path', @{pm2Home='C:\a"b'}, 'quote'),
    @('B6 trailing backslash', @{pm2Home='C:\pm2\'}, 'backslash'),
    @('B7 dot-dot segment', @{logDir='C:\a\..\b'}, 'segments'),
    @('B8 bad appName', @{appName='a b'}, 'appName'),
    @('B9 bad account', @{serviceAccount='dom\user'}, 'serviceAccount'),
    @('B10 bad start script', @{startScript='..\x.js'}, 'startScript'),
    @('B11 unknown field', @{extra=1}, 'Unknown config field: extra'),
    @('B12 port out of range', @{listenPorts=@(70000)}, 'listenPorts'),
    @('B13 no ports', @{listenPorts=@()}, 'listenPorts'),
    @('B14 non-loopback postgres', @{postgres=[ordered]@{host='10.0.0.5'; port=5432}}, 'loopback'),
    @('B15 unknown postgres field', @{postgres=[ordered]@{host='127.0.0.1'; port=5432; password='x'}}, 'postgres.password'),
    @('B16 pm2Cli not bin\pm2', @{pm2Cli=$node}, 'pm2Cli'),
    @('B17 waits exceed task limit', @{listenWaitSeconds=600; cliTimeoutSeconds=300}, 'must not exceed'),
    @('B18 non-integer wait', @{listenWaitSeconds=5.5}, 'integer'))
  foreach ($c in $badCases) { $o = $c[1]; Expect-Throw $c[0] { ConvertTo-SrvproServiceConfig (New-RawConfig $o) } $c[2] }

  # ---------- C. administrator detection (incl. UAC-filtered tokens) ----------
  Record 'C1 normal user SIDs are not admin' (-not (Test-SrvproAdministratorSid @('S-1-5-21-1-2-3-1001','S-1-5-32-545','S-1-5-11')))
  Record 'C2 local Administrators SID detected' (Test-SrvproAdministratorSid @('S-1-5-32-545','S-1-5-32-544'))
  Record 'C3 domain Admins (RID 512) detected' (Test-SrvproAdministratorSid @('S-1-5-21-11-22-33-512'))
  $tokenAdmin = Test-SrvproAdministratorSid (Get-SrvproCurrentTokenSids)
  $roleAdmin = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  $memberAdmin = [bool](@(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction SilentlyContinue | Where-Object { $_.SID -and $_.SID.Value -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }).Count)
  Record 'C4 token check agrees with Administrators membership of the current user' ($tokenAdmin -eq $memberAdmin -or -not $memberAdmin) ('tokenSidsAdmin=' + $tokenAdmin + ' isInRole=' + $roleAdmin + ' member=' + $memberAdmin)
  Expect-Throw 'C5 identity check rejects a different account' { Assert-SrvproServiceIdentity (ConvertTo-SrvproServiceConfig (New-RawConfig @{serviceAccount='nosuchsvc'})) } 'Must run as'

  # ---------- D. user-rights parsing ----------
  $lines = @('[Privilege Rights]','SeBatchLogonRight = *S-1-5-32-544,*S-1-5-21-1-2-3-1001,Administrators','SeDenyBatchLogonRight = *S-1-5-32-546')
  $sids = @(Get-SrvproRightSids $lines 'SeBatchLogonRight')
  Record 'D1 SIDs and names are resolved' ($sids.Count -eq 3 -and $sids[1] -eq 'S-1-5-21-1-2-3-1001' -and $sids[2] -eq 'S-1-5-32-544') ($sids -join ',')
  Record 'D2 missing right yields empty' (@(Get-SrvproRightSids $lines 'SeServiceLogonRight').Count -eq 0)
  Record 'D3 unresolved names are marked' (@(Get-SrvproRightSids @('SeBatchLogonRight = no-such-account-xyz') 'SeBatchLogonRight')[0] -like 'UNRESOLVED:*')
  Expect-Throw 'D4 duplicate right lines rejected' { Get-SrvproRightSids @('SeBatchLogonRight = *S-1-1-0','SeBatchLogonRight = *S-1-5-11') 'SeBatchLogonRight' } 'Duplicate'
  Record 'D5 set comparison handles empty sets' ((Test-SrvproSameSet @() @()) -and -not (Test-SrvproSameSet @() @('a')) -and (Test-SrvproSameSet @('b','a') @('a','b')))

  # ---------- E. dump.pm2 summary (duplicate-case env keys, no env output) ----------
  $dump = Join-Path $pm2Home 'dump.pm2'
  Write-Dump $dump @(App-Json 'srvpro-test' $cfg.scriptPath $app)
  $raw = & $node (Join-Path $script:SrvproLibDir 'pm2-dump-summary.cjs') $dump
  Record 'E1 helper parses env with username/USERNAME' ($LASTEXITCODE -eq 0 -and $raw -match '"name":"srvpro-test"') ($raw -join '')
  Record 'E2 helper never prints env values' (-not (($raw -join '') -match 'TOPSECRET|USERNAME|env'))
  $failedPs = $false; try { $null = [IO.File]::ReadAllText($dump) | ConvertFrom-Json } catch { $failedPs = $true }
  if ($isPs51) { Record 'E3 PS5.1 ConvertFrom-Json fails on the same dump (documents root cause)' $failedPs }
  Assert-SrvproDumpMatches $cfg (Get-SrvproDumpSummary $cfg); Record 'E4 matching dump accepted' $true
  $mm = @(
    @('E5 two apps', @((App-Json 'srvpro-test' $cfg.scriptPath $app), (App-Json 'other' $cfg.scriptPath $app)), 'exactly one'),
    @('E6 wrong name', @(App-Json 'other' $cfg.scriptPath $app), 'name mismatch'),
    @('E7 wrong script', @(App-Json 'srvpro-test' 'C:\other\x.js' $app), 'script mismatch'),
    @('E8 wrong cwd', @(App-Json 'srvpro-test' $cfg.scriptPath 'C:\other'), 'cwd mismatch'),
    @('E9 watch true', @(App-Json 'srvpro-test' $cfg.scriptPath $app 'true'), 'watch=false'))
  foreach ($c in $mm) { Write-Dump $dump $c[1]; Expect-Throw $c[0] { Assert-SrvproDumpMatches $cfg (Get-SrvproDumpSummary $cfg) } $c[2] }
  [IO.File]::WriteAllText($dump, '{not json')
  Expect-Throw 'E10 corrupt dump fails closed' { Get-SrvproDumpSummary $cfg } 'summary failed'
  Remove-Item $dump
  Expect-Throw 'E11 missing dump rejected' { Assert-SrvproDumpMatches $cfg (Get-SrvproDumpSummary $cfg) } 'not found'

  # ---------- F. mode flows with a fake daemon state (no real pipe access) ----------
  $script:FakeDaemon = [pscustomobject]@{Running=$false; Own=$false; Pid=0; Detail='fake'}
  function Get-SrvproDaemonState($Cfg) { return $script:FakeDaemon }
  function Set-Daemon([bool]$Running, [bool]$Own) { $script:FakeDaemon = [pscustomobject]@{Running=$Running; Own=$Own; Pid=0; Detail=('fake running=' + $Running + ' own=' + $Own)} }
  $good = Join-Path $root 'good-dump.json'; Write-Dump $good @(App-Json 'srvpro-test' $cfg.scriptPath $app)
  $script:SrvproLogFile = Join-Path $logs 'flow.log'

  Reset-Fake; Set-Daemon $false $false; $cfg = ConvertTo-SrvproServiceConfig (New-RawConfig)
  $env:FAKE_LISTEN_PORT = [string]$cfg.listenPorts[0]; $env:FAKE_DUMP = $good
  Invoke-SrvproServiceMode $cfg 'Start' 'f1'; Track-Daemon
  $c = Calls; $first = $c[0] | ConvertFrom-Json
  Record 'F1 Start: start (exact args) then save' ($c.Count -eq 2 -and $first[0] -eq 'start' -and $first[1] -eq $cfg.scriptPath -and $first[3] -eq 'srvpro-test' -and $first[5] -eq $app -and $c[1] -eq '["save"]') ($c -join ' | ')
  Record 'F1b Start: stdout/stderr logs per call' ((Test-Path (Join-Path $logs 'start-f1.stdout.log')) -and (Test-Path (Join-Path $logs 'save-f1.stderr.log')))
  Reset-Fake; Set-Daemon $true $true
  Expect-Throw 'F2 Start refuses when a daemon exists' { Invoke-SrvproServiceMode $cfg 'Start' 'f2' } 'already serves'
  Record 'F2b no CLI call' ((Calls).Count -eq 0)
  Reset-Fake; Set-Daemon $true $false
  Expect-Throw 'F3 Save refuses a foreign daemon' { Invoke-SrvproServiceMode $cfg 'Save' 'f3' } 'own PM2 daemon'
  Set-Daemon $false $false
  Expect-Throw 'F4 Save refuses when no daemon runs (would save an empty list)' { Invoke-SrvproServiceMode $cfg 'Save' 'f4' } 'own PM2 daemon'
  Record 'F4b no CLI call' ((Calls).Count -eq 0)
  Reset-Fake; Set-Daemon $true $true; $env:FAKE_DUMP = $good
  Invoke-SrvproServiceMode $cfg 'Save' 'f5'
  Record 'F5 Save with own daemon calls save only' (((Calls) -join '|') -eq '["save"]')
  Reset-Fake; Set-Daemon $true $true; $env:FAKE_EXIT = '3'
  Expect-Throw 'F6 Save propagates CLI exit code' { Invoke-SrvproServiceMode $cfg 'Save' 'f6' } 'exit code 3'
  Reset-Fake; Set-Daemon $false $false; Copy-Item $good (Join-Path $pm2Home 'dump.pm2'); $cfg = ConvertTo-SrvproServiceConfig (New-RawConfig); $env:FAKE_LISTEN_PORT = [string]$cfg.listenPorts[0]
  Invoke-SrvproServiceMode $cfg 'Resurrect' 'f7'; Track-Daemon
  Record 'F7 Resurrect without daemon calls resurrect and waits for ports' (((Calls) -join '|') -eq '["resurrect"]')
  Reset-Fake; Set-Daemon $true $false; Copy-Item $good (Join-Path $pm2Home 'dump.pm2')
  Expect-Throw 'F8 Resurrect refuses a foreign daemon' { Invoke-SrvproServiceMode $cfg 'Resurrect' 'f8' } 'foreign PM2 daemon'
  Reset-Fake; Set-Daemon $true $true; Copy-Item $good (Join-Path $pm2Home 'dump.pm2'); $cfg = ConvertTo-SrvproServiceConfig (New-RawConfig)
  $holder = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $cfg.listenPorts[0]); $holder.Start()
  try { Invoke-SrvproServiceMode $cfg 'Resurrect' 'f9' } finally { $holder.Stop() }
  Record 'F9 Resurrect with own daemon (task retry) skips the CLI' ((Calls).Count -eq 0)
  Reset-Fake; Set-Daemon $false $false; Write-Dump (Join-Path $pm2Home 'dump.pm2') @(App-Json 'other' $cfg.scriptPath $app)
  Expect-Throw 'F10 Resurrect refuses a mismatched dump before any CLI call' { Invoke-SrvproServiceMode $cfg 'Resurrect' 'f10' } 'name mismatch'
  Record 'F10b no CLI call' ((Calls).Count -eq 0)
  Reset-Fake; Set-Daemon $false $false; $cfg = ConvertTo-SrvproServiceConfig (New-RawConfig @{listenWaitSeconds=5})
  $sw = [Diagnostics.Stopwatch]::StartNew()
  Expect-Throw 'F11 Start fails when the application never listens (PG ready is not enough)' { Invoke-SrvproServiceMode $cfg 'Start' 'f11' } 'not listening within 5 s'
  Record 'F11b no save after a failed start' (((Calls) -join '|') -notmatch 'save') ((Calls) -join '|')
  $closed = Free-Port
  $cfg = ConvertTo-SrvproServiceConfig (New-RawConfig @{postgres=[ordered]@{host='127.0.0.1'; port=$closed; waitSeconds=5}})
  Reset-Fake
  Expect-Throw 'F12 PostgreSQL wait times out before any CLI call' { Invoke-SrvproServiceMode $cfg 'Start' 'f12' } 'not reachable within 5 s'
  Record 'F12b no CLI call' ((Calls).Count -eq 0)

  # ---------- G. entry script exit codes (identity mismatch; never reaches PM2) ----------
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  # PS 5.1 turns redirected native stderr into errors; keep this section non-terminating.
  $ErrorActionPreference = 'Continue'
  $entry = Join-Path $script:SrvproLibDir 'srvpro-service.ps1'
  $cfgFile = Join-Path $root 'service.json'
  [IO.File]::WriteAllText($cfgFile, ((New-RawConfig @{serviceAccount='nosuchsvc'}) | ConvertTo-Json -Depth 4))
  & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $entry -Mode Save -ConfigPath $cfgFile | Out-Null
  $g1 = $LASTEXITCODE
  $log = @(Get-ChildItem $logs -Filter 'service-save-*.log' | Sort-Object LastWriteTime | Select-Object -Last 1)
  $logText = if ($log.Count) { [IO.File]::ReadAllText($log[0].FullName) } else { '' }
  Record 'G1 wrong identity => exit 1 and logged reason' ($g1 -eq 1 -and $logText -match 'result=1 error=Must run as') ('exit=' + $g1)
  [IO.File]::WriteAllText($cfgFile, '{"appName":"x"}')
  & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $entry -Mode Save -ConfigPath $cfgFile 2>&1 | Out-Null
  Record 'G2 invalid config => exit 1' ($LASTEXITCODE -eq 1) ('exit=' + $LASTEXITCODE)
  & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $entry -Mode Bogus -ConfigPath $cfgFile 2>&1 | Out-Null
  Record 'G3 invalid mode => non-zero exit' ($LASTEXITCODE -ne 0) ('exit=' + $LASTEXITCODE)
  $ErrorActionPreference = 'Stop'
} catch {
  Record 'UNEXPECTED' $false ($_.Exception.Message + ' @ ' + $_.InvocationInfo.PositionMessage)
} finally {
  $pgListener.Stop()
  foreach ($d in $spawned) {
    $w = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $d)
    if ($w -and $w.CommandLine -like '*createServer*') { Stop-Process -Id $d -Force -ErrorAction SilentlyContinue }
  }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

$results | Format-Table -AutoSize -Wrap | Out-String -Width 220
$bad = @($results | Where-Object { -not $_.Pass })
Write-Output ('PSVersion=' + $PSVersionTable.PSVersion + ' total=' + $results.Count + ' failed=' + $bad.Count)
if ($bad.Count) { exit 1 }
exit 0
