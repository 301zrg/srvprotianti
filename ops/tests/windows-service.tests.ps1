# Targeted tests for ops/scripts/windows-service (run with Windows PowerShell 5.1):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops\tests\windows-service.tests.ps1
# Uses a fake PM2 CLI and temp directories only. Never runs the real PM2 CLI, never creates or
# queries the machine-wide PM2 rpc.sock pipe (the pipe functions are replaced in this session).
# -ScriptsDir lets the same tests run against another copy of the scripts (e.g. an older commit)
# to show which regressions fail there.
param([string]$ScriptsDir = (Join-Path $PSScriptRoot '..\scripts\windows-service'))
$ErrorActionPreference = 'Stop'
$ScriptsDir = (Resolve-Path -LiteralPath $ScriptsDir).Path
$lib = Join-Path $ScriptsDir 'srvpro-service.lib.ps1'
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
if (cmd === 'start' || cmd === 'resurrect') fs.writeFileSync(path.join(home, 'fake-own'), '1');
const listen = Number(process.env.FAKE_LISTEN_PORT || 0);
if ((cmd === 'start' || cmd === 'resurrect' || cmd === 'spawn') && listen) {
  const src = 'require("net").createServer(()=>{}).listen(' + listen + ',"127.0.0.1");setTimeout(()=>process.exit(0),' + Number(process.env.FAKE_LISTEN_MS || 8000) + ')';
  const child = cp.spawn(process.execPath, ['-e', src], {detached: true, stdio: 'inherit', windowsHide: true});
  fs.writeFileSync(path.join(home, 'fake-daemon.pid'), String(child.pid));
  child.unref();
}
if (cmd === 'save' && process.env.FAKE_DUMP) fs.copyFileSync(process.env.FAKE_DUMP, path.join(home, 'dump.pm2'));
// PM2 6 "pm2 save" against a freshly spawned empty daemon: writes [] only when no dump exists.
if (cmd === 'save' && process.env.FAKE_SAVE_EMPTY && !fs.existsSync(path.join(home, 'dump.pm2'))) fs.writeFileSync(path.join(home, 'dump.pm2'), '[]');
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
function Reset-Fake { foreach ($k in 'FAKE_EXIT','FAKE_LISTEN_PORT','FAKE_LISTEN_MS','FAKE_DUMP','FAKE_SLEEP_MS','FAKE_SAVE_EMPTY') { Remove-Item ('Env:' + $k) -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath (Join-Path $pm2Home 'calls.log'), (Join-Path $pm2Home 'dump.pm2'), (Join-Path $pm2Home 'fake-own') -ErrorAction SilentlyContinue
  Get-ChildItem -LiteralPath $pm2Home -Filter 'dump.pm2.*' | Remove-Item -Force }
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

  # ---------- P. the REAL Get-SrvproDaemonState (pipe functions and CIM replaced; F overrides it later) ----------
  # The pipe functions stay replaced for the rest of the run: nothing here may touch \\.\pipe\rpc.sock.
  function Test-SrvproPm2Pipe { return $script:DsPipe }
  function Get-SrvproPipeServerPid { return 5151 }
  function Mock-DsCim { [CmdletBinding()] param([Parameter(Position = 0)]$ClassName, $Filter) $script:DsProc }
  function Mock-DsInvoke { [CmdletBinding()] param($InputObject, $MethodName) [pscustomobject]@{User=$script:DsOwner} }
  $pidFile = Join-Path $pm2Home 'pm2.pid'
  $daemonJsPath = $cfg.pm2Package + '\lib\Daemon.js'
  function Ds-Set([bool]$Pipe = $true, [string]$FilePid = '5151', [string]$Owner = 'srvprosvc', [string]$ProcName = 'node.exe', $CommandLine = ('"node.exe" "' + $daemonJsPath + '"'), [switch]$NoProc) {
    $script:DsPipe = $Pipe; $script:DsOwner = $Owner
    $script:DsProc = $(if ($NoProc) { $null } else { [pscustomobject]@{Name=$ProcName; ProcessId=5151; CommandLine=$CommandLine} })
    if ($FilePid) { [IO.File]::WriteAllText($pidFile, $FilePid + "`n") } else { Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue }
  }
  Set-Alias -Name 'Get-CimInstance' -Value 'Mock-DsCim' -Scope Script
  Set-Alias -Name 'Invoke-CimMethod' -Value 'Mock-DsInvoke' -Scope Script
  try {
    Ds-Set -Pipe $false; $s = Get-SrvproDaemonState $cfg
    Record 'P1 no rpc.sock pipe: not running' (-not $s.Running -and -not $s.Own) $s.Detail
    Ds-Set; $s = Get-SrvproDaemonState $cfg
    Record 'P2 node.exe, pid = pm2.pid, service account, configured Daemon.js: own' ($s.Running -and $s.Own -and $s.Pid -eq 5151) $s.Detail
    $dsCases = @(
      @('P3 pm2.pid differs', @{FilePid='6000'}),
      @('P4 pm2.pid missing', @{FilePid=''}),
      @('P5 owner differs', @{Owner='someoneelse'}),
      @('P6 process is not node.exe', @{ProcName='powershell.exe'}),
      @('P7 another PM2 install Daemon.js', @{CommandLine='"node.exe" "C:\other\node_modules\pm2\lib\Daemon.js"'}),
      @('P8 CommandLine unavailable', @{CommandLine=$null}),
      @('P9 pipe server process not found', @{NoProc=$true}))
    foreach ($c in $dsCases) {
      $o = $c[1]; Ds-Set @o; $s = Get-SrvproDaemonState $cfg
      Record ($c[0] + ': running but not own') ($s.Running -and -not $s.Own) $s.Detail
    }
  } finally {
    Remove-Item -LiteralPath 'Alias:Get-CimInstance', 'Alias:Invoke-CimMethod' -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
  }

  # ---------- Q. Assert-SrvproNotWritableBy against real ACLs under the temp root ----------
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $svcSidReal = 'S-1-5-32-546'   # Guests: resolvable, not in the base ACL; stands in for the service account
  function New-AclItem([string]$Name, [object[]]$Extra, [switch]$File) {
    $p = Join-Path $root ('acl-' + $Name)
    if ($File) { [IO.File]::WriteAllText($p, 'x'); $acl = New-Object Security.AccessControl.FileSecurity; $inh = [Security.AccessControl.InheritanceFlags]::None }
    else { New-Item -ItemType Directory -Path $p | Out-Null; $acl = New-Object Security.AccessControl.DirectorySecurity; $inh = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' }
    $acl.SetAccessRuleProtection($true, $false)
    # The current user keeps full control so the temp root can be deleted afterwards.
    foreach ($e in (@(@('S-1-5-18','FullControl'), @('S-1-5-32-544','FullControl'), @($me,'FullControl')) + $Extra)) {
      $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($e[0])),
        [Security.AccessControl.FileSystemRights]$e[1], $inh, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)))
    }
    (Get-Item -LiteralPath $p).SetAccessControl($acl)
    return $p
  }
  $p = New-AclItem 'base' @()
  try { Assert-SrvproNotWritableBy $p $svcSidReal; Record 'Q1 only SYSTEM/Administrators/owner can write: accepted' $true } catch { Record 'Q1 only SYSTEM/Administrators/owner can write: accepted' $false $_.Exception.Message }
  $p = New-AclItem 'users' @(,@('S-1-5-32-545','Modify'))
  Expect-Throw 'Q2 Users granted Modify: rejected' { Assert-SrvproNotWritableBy $p $svcSidReal } 'is writable by'
  $p = New-AclItem 'everyone' @(,@('S-1-1-0','Write'))
  Expect-Throw 'Q3 Everyone granted Write: rejected' { Assert-SrvproNotWritableBy $p $svcSidReal } 'is writable by'
  $p = New-AclItem 'svc-read' @(,@($svcSidReal,'ReadAndExecute'))
  try { Assert-SrvproNotWritableBy $p $svcSidReal; Record 'Q4 service SID with ReadAndExecute only: accepted' $true } catch { Record 'Q4 service SID with ReadAndExecute only: accepted' $false $_.Exception.Message }
  $p = New-AclItem 'svc-modify' @(,@($svcSidReal,'Modify'))
  Expect-Throw 'Q5 service SID granted Modify: rejected' { Assert-SrvproNotWritableBy $p $svcSidReal } 'is writable by'
  $p = New-AclItem 'file-users.txt' @(,@('S-1-5-32-545','Modify')) -File
  Expect-Throw 'Q6 file with Users Modify: rejected' { Assert-SrvproNotWritableBy $p $svcSidReal } 'is writable by'

  # ---------- L. log sharing and the read-only query's diagnostics ----------
  $lf = Join-Path $logs 'share-test.log'
  $script:SrvproLogFile = $lf
  $h = [IO.File]::Open($lf, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try { Write-SrvproLog 'L1 line'; $ok = $true; $why = '' } catch { $ok = $false; $why = $_.Exception.Message } finally { $h.Dispose() }
  Record 'L1 Write-SrvproLog appends while a sharing reader holds the file' ($ok -and (Read-SrvproSharedText $lf) -match 'L1 line') $why
  # A reader that does NOT share write blocks the append; it is released after ~250 ms in another runspace.
  $ready = New-Object Threading.ManualResetEvent($false)
  $ps2 = [powershell]::Create().AddScript({ param($Path, $Ready)
    $b = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    [void]$Ready.Set(); Start-Sleep -Milliseconds 250; $b.Dispose() }).AddArgument($lf).AddArgument($ready)
  $async = $ps2.BeginInvoke()
  try {
    [void]$ready.WaitOne(10000)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try { Write-SrvproLog 'L2 line'; $ok = $true; $why = '' } catch { $ok = $false; $why = $_.Exception.Message }
    $sw.Stop()
  } finally { [void]$ps2.EndInvoke($async); $ps2.Dispose() }
  Record 'L2 Write-SrvproLog retries until a blocking reader is released' ($ok -and $sw.ElapsedMilliseconds -ge 100 -and (Read-SrvproSharedText $lf) -match 'L2 line') ('ms=' + $sw.ElapsedMilliseconds + ' ' + $why)
  $h = [IO.File]::Open($lf, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try { Write-SrvproLog 'L3 line'; $ok = $false; $why = 'did not throw' } catch { $ok = $true; $why = $_.Exception.GetType().Name + ': ' + $_.Exception.Message } finally { $h.Dispose() }
  $sw.Stop()
  Record 'L3 Write-SrvproLog gives up after the retries when the blocker stays' ($ok -and $sw.ElapsedMilliseconds -ge 400) ('ms=' + $sw.ElapsedMilliseconds + ' ' + $why)
  $script:SrvproLogFile = $null
  $h = [IO.File]::Open($lf, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try { $t = Read-SrvproSharedText $lf } finally { $h.Dispose() }
  Record 'L4 Read-SrvproSharedText reads while a writer holds the file (FileShare Read)' ($t -match 'L1 line') ('len=' + $t.Length)
  Record 'L5 Read-SrvproSharedText returns empty for a missing file' ((Read-SrvproSharedText (Join-Path $logs 'no-such.log')) -eq '')
  # Real Get-SrvproLiveApps, failure path only: pid 0 fails the helper's argument check before any
  # pipe access (pm2-apps-readonly.cjs validates argv before calling the query).
  Expect-Throw 'L6 read-only query failure reports exit code, first stderr line and the stderr file' { Get-SrvproLiveApps $cfg 0 'l6' } ('exit code 2: pm2-apps-readonly: usage.*; see ' + [regex]::Escape((Join-Path $logs 'liveapps-l6.stderr.log')))

  # ---------- F. mode flows with a fake daemon state (no real pipe access) ----------
  # Daemon state: 'none' | 'foreign' | 'own' | 'auto' (auto = own once the fake CLI ran start/resurrect).
  $script:FakeMode = 'none'
  function Get-SrvproDaemonState($Cfg) {
    $m = $script:FakeMode
    if ($m -eq 'auto') { $m = $(if (Test-Path (Join-Path $pm2Home 'fake-own')) { 'own' } else { 'none' }) }
    # swap = own pid 4242 until pm2 save ran, then another own-looking daemon (pm2 save spawned a new one).
    if ($m -eq 'swap') { if ((Calls) -contains '["save"]') { return [pscustomobject]@{Running=$true; Own=$true; Pid=4343; Detail='fake swapped pid 4343'} } else { $m = 'own' } }
    return [pscustomobject]@{Running=($m -ne 'none'); Own=($m -eq 'own'); Pid=4242; Detail=('fake ' + $m)}
  }
  function Set-Daemon([string]$Mode) { $script:FakeMode = $Mode }
  function Live-App([string]$Status = 'online', [string]$Name = 'srvpro-test', [string]$Script = (Join-Path $app 'ygopro-server.js')) {
    [pscustomobject]@{name=$Name; script=$Script; cwd=$app; exec_mode='fork_mode'; watch=$false; status=$Status; pid=1}
  }
  $script:FakeLive = @(Live-App)
  $script:LiveQueries = 0
  function Get-SrvproLiveApps($Cfg, [int]$DaemonPid) { $script:LiveQueries++; return $script:FakeLive }
  function Hash([string]$Path) { if (Test-Path -LiteralPath $Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash } else { 'absent' } }
  $good = Join-Path $root 'good-dump.json'; Write-Dump $good @(App-Json 'srvpro-test' $cfg.scriptPath $app)
  $bad2 = Join-Path $root 'bad-dump.json'; Write-Dump $bad2 @((App-Json 'srvpro-test' $cfg.scriptPath $app), (App-Json 'stray' $cfg.scriptPath $app))
  $dumpPath = Join-Path $pm2Home 'dump.pm2'
  $script:SrvproLogFile = Join-Path $logs 'flow.log'

  Reset-Fake; Set-Daemon 'auto'; $cfg = ConvertTo-SrvproServiceConfig (New-RawConfig)
  $env:FAKE_LISTEN_PORT = [string]$cfg.listenPorts[0]; $env:FAKE_DUMP = $good
  Invoke-SrvproServiceMode $cfg 'Start' 'f1'; Track-Daemon
  $c = Calls; $first = $c[0] | ConvertFrom-Json
  Record 'F1 Start: start (exact args) then save' ($c.Count -eq 2 -and $first[0] -eq 'start' -and $first[1] -eq $cfg.scriptPath -and $first[3] -eq 'srvpro-test' -and $first[5] -eq $app -and $c[1] -eq '["save"]') ($c -join ' | ')
  Record 'F1b Start: stdout/stderr logs per call' ((Test-Path (Join-Path $logs 'start-f1.stdout.log')) -and (Test-Path (Join-Path $logs 'save-f1.stderr.log')))
  Reset-Fake; Set-Daemon 'foreign'
  Expect-Throw 'F2 Start refuses a foreign daemon' { Invoke-SrvproServiceMode $cfg 'Start' 'f2' } 'foreign PM2 daemon'
  Record 'F2b no CLI call' ((Calls).Count -eq 0)
  Reset-Fake; Set-Daemon 'own'; Copy-Item $good $dumpPath
  Expect-Throw 'F2c Start refuses when dump.pm2 exists (first start complete)' { Invoke-SrvproServiceMode $cfg 'Start' 'f2c' } 'already exists'
  Reset-Fake; Set-Daemon 'none'; Copy-Item $good $dumpPath
  Expect-Throw 'F2d Start refuses with dump.pm2 and no daemon (use Startup)' { Invoke-SrvproServiceMode $cfg 'Start' 'f2d' } 'already exists'
  Record 'F2e no CLI call' ((Calls).Count -eq 0)
  Reset-Fake; Set-Daemon 'foreign'
  Expect-Throw 'F3 Save refuses a foreign daemon' { Invoke-SrvproServiceMode $cfg 'Save' 'f3' } 'own PM2 daemon'
  Set-Daemon 'none'
  Expect-Throw 'F4 Save refuses when no daemon runs (would save an empty list)' { Invoke-SrvproServiceMode $cfg 'Save' 'f4' } 'own PM2 daemon'
  Record 'F4b no CLI call' ((Calls).Count -eq 0)
  Reset-Fake; Set-Daemon 'own'; Copy-Item $good $dumpPath; $env:FAKE_DUMP = $good; $script:FakeLive = @(Live-App)
  Invoke-SrvproServiceMode $cfg 'Save' 'f5'
  Record 'F5 Save with own daemon: one save, previous dump kept as backup' (((Calls) -join '|') -eq '["save"]' -and (Hash ($dumpPath + '.before-save-f5')) -eq (Hash $good)) ((Calls) -join '|')
  Reset-Fake; Set-Daemon 'own'; Copy-Item $good $dumpPath; $env:FAKE_EXIT = '3'
  Expect-Throw 'F6 Save propagates CLI exit code and restores the dump' { Invoke-SrvproServiceMode $cfg 'Save' 'f6' } 'exit code 3.*restored'
  Reset-Fake; Set-Daemon 'none'; Copy-Item $good $dumpPath; $cfg = ConvertTo-SrvproServiceConfig (New-RawConfig); $env:FAKE_LISTEN_PORT = [string]$cfg.listenPorts[0]
  Invoke-SrvproServiceMode $cfg 'Resurrect' 'f7'; Track-Daemon
  Record 'F7 Resurrect without daemon calls resurrect and waits for ports' (((Calls) -join '|') -eq '["resurrect"]')
  Reset-Fake; Set-Daemon 'foreign'; Copy-Item $good $dumpPath
  Expect-Throw 'F8 Resurrect refuses a foreign daemon' { Invoke-SrvproServiceMode $cfg 'Resurrect' 'f8' } 'foreign PM2 daemon'
  Reset-Fake; Set-Daemon 'own'; Copy-Item $good $dumpPath; $cfg = ConvertTo-SrvproServiceConfig (New-RawConfig)
  $holder = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $cfg.listenPorts[0]); $holder.Start()
  try { Invoke-SrvproServiceMode $cfg 'Resurrect' 'f9' } finally { $holder.Stop() }
  Record 'F9 Resurrect with own daemon (task retry) skips the CLI' ((Calls).Count -eq 0)
  Reset-Fake; Set-Daemon 'none'; Write-Dump $dumpPath @(App-Json 'other' $cfg.scriptPath $app)
  Expect-Throw 'F10 Resurrect refuses a mismatched dump before any CLI call' { Invoke-SrvproServiceMode $cfg 'Resurrect' 'f10' } 'name mismatch'
  Record 'F10b no CLI call' ((Calls).Count -eq 0)

  # Finding 4: Start created the daemon but the application did not listen in time.
  Reset-Fake; Set-Daemon 'auto'; $cfg = ConvertTo-SrvproServiceConfig (New-RawConfig @{listenWaitSeconds=5})
  Expect-Throw 'F11 Start fails when the application never listens (PG ready is not enough)' { Invoke-SrvproServiceMode $cfg 'Start' 'f11' } 'not listening within 5 s.*left running.*run the Start task again'
  Record 'F11b no save after a failed start; nothing written to dump.pm2' (((Calls) -join '|') -notmatch 'save' -and -not (Test-Path $dumpPath)) ((Calls) -join '|')
  # The daemon from F11 is still "running" (fake-own exists): a second Start must resume, not refuse.
  Remove-Item -LiteralPath (Join-Path $pm2Home 'calls.log'); $env:FAKE_DUMP = $good; $script:FakeLive = @(Live-App)
  $holder = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $cfg.listenPorts[0]); $holder.Start()
  try { Invoke-SrvproServiceMode $cfg 'Start' 'f11c' } catch { Record 'F11c Start resumes an unfinished Start' $false $_.Exception.Message } finally { $holder.Stop() }
  Record 'F11c Start resumes an unfinished Start: no second pm2 start, then save' (((Calls) -join '|') -eq '["save"]' -and (Hash $dumpPath) -eq (Hash $good)) ((Calls) -join '|')
  Reset-Fake; Set-Daemon 'own'; $script:FakeLive = @(Live-App 'errored')
  Expect-Throw 'F11d resume refuses when the live app is not online' { Invoke-SrvproServiceMode $cfg 'Start' 'f11d' } 'status is errored'
  Record 'F11e no CLI call' ((Calls).Count -eq 0)
  $script:FakeLive = @(Live-App)
  $closed = Free-Port
  $cfg = ConvertTo-SrvproServiceConfig (New-RawConfig @{postgres=[ordered]@{host='127.0.0.1'; port=$closed; waitSeconds=5}})
  Reset-Fake; Set-Daemon 'none'
  Expect-Throw 'F12 PostgreSQL wait times out before any CLI call' { Invoke-SrvproServiceMode $cfg 'Start' 'f12' } 'not reachable within 5 s'
  Record 'F12b no CLI call' ((Calls).Count -eq 0)

  # ---------- H. Finding 2: Save must not overwrite a good dump.pm2 ----------
  $cfg = ConvertTo-SrvproServiceConfig (New-RawConfig)
  $liveCases = @(
    @('H1 two live apps', @((Live-App), (Live-App 'online' 'stray')), 'exactly one application'),
    @('H2 live app stopped', @(Live-App 'stopped'), 'status is stopped'),
    @('H3 live app with wrong script', @(Live-App 'online' 'srvpro-test' 'C:\other\x.js'), 'script mismatch'),
    @('H4 no live apps', @(), 'exactly one application'))
  foreach ($h in $liveCases) {
    Reset-Fake; Set-Daemon 'own'; Copy-Item $good $dumpPath; $env:FAKE_DUMP = $bad2; $script:FakeLive = $h[1]
    Expect-Throw ($h[0] + ': refused before pm2 save') { Invoke-SrvproServiceMode $cfg 'Save' $h[0].Substring(0, 2) } ($h[2] + '.*pm2 save not run')
    Record ($h[0] + ': no CLI call, dump.pm2 unchanged') ((Calls).Count -eq 0 -and (Hash $dumpPath) -eq (Hash $good)) ('calls=' + (Calls).Count)
  }
  Reset-Fake; Set-Daemon 'own'; Copy-Item $good $dumpPath; $env:FAKE_DUMP = $bad2; $script:FakeLive = @(Live-App)
  Expect-Throw 'H5 dump written by pm2 save does not match: previous dump restored' { Invoke-SrvproServiceMode $cfg 'Save' 'h5' } 'exactly one application.*restored'
  Record 'H5b dump.pm2 equals the previous good dump; backup kept' ((Hash $dumpPath) -eq (Hash $good) -and (Hash ($dumpPath + '.before-save-h5')) -eq (Hash $good))
  Reset-Fake; Set-Daemon 'own'; $env:FAKE_DUMP = $bad2
  Expect-Throw 'H6 bad first dump with no previous dump is moved aside' { Invoke-SrvproServiceMode $cfg 'Save' 'h6' } 'moved to'
  Record 'H6b no dump.pm2 left; rejected copy kept' (-not (Test-Path $dumpPath) -and (Test-Path ($dumpPath + '.rejected-h6')))
  # pm2 save found no daemon answering and spawned a new empty one (PM2 6: "skipping save", exit 0).
  Reset-Fake; Set-Daemon 'swap'; Copy-Item $good $dumpPath; $script:FakeLive = @(Live-App)
  Expect-Throw 'H7 daemon pid changes during save: refused, previous dump restored' { Invoke-SrvproServiceMode $cfg 'Save' 'h7' } 'daemon changed during save.*was pid 4242.*restored'
  Record 'H7b dump.pm2 equals the previous good dump' ((Hash $dumpPath) -eq (Hash $good)) ((Calls) -join '|')
  Reset-Fake; Set-Daemon 'swap'; $env:FAKE_SAVE_EMPTY = '1'
  Expect-Throw 'H8 daemon changes during the first save that wrote []: refused, new dump moved aside' { Invoke-SrvproServiceMode $cfg 'Save' 'h8' } 'daemon changed during save.*moved to'
  Record 'H8b no dump.pm2 left' (-not (Test-Path $dumpPath) -and (Test-Path ($dumpPath + '.rejected-h8')))
  Set-Daemon 'own'; $script:FakeLive = @(Live-App)

  # ---------- I. Finding 3: task completion without trusting LastRunTime ----------
  if (-not (Get-Command Wait-SrvproTaskRun -ErrorAction SilentlyContinue)) { Record 'I0 Wait-SrvproTaskRun exists' $false 'missing in these scripts' } else {
    $t0 = [DateTime]'2026-11-14T22:15:00'
    function Seq([object[]]$Steps) { $script:SeqSteps = $Steps; $script:SeqIndex = 0 }
    $getTask = { $s = $script:SeqSteps[[Math]::Min($script:SeqIndex, $script:SeqSteps.Count - 1)]; $script:SeqIndex++
      [pscustomobject]@{State=$s[0]; LastTaskResult=$s[1]; LastRunTime=$s[2]} }
    $script:SeqLogs = @()
    $getLogs = { $i = $script:SeqIndex; @($script:SeqLogs | Where-Object { $_.From -le $i } | ForEach-Object { [pscustomobject]@{Name=$_.Name; Text=$_.Text} }) }
    function Logs([object[]]$Items) { $script:SeqLogs = @($Items | ForEach-Object { [pscustomobject]@{Name=$_[0]; Text=$_[1]; From=$_[2]} }) }
    $old = @('service-start-old.log')
    function Run-Wait([int]$Timeout = 5) { Wait-SrvproTaskRun $getTask $getLogs $old $t0 $Timeout 1 50 }

    Seq @(@('Ready',0,$t0), @('Running',267009,$t0.AddSeconds(15)), @('Running',267009,$t0.AddSeconds(15)), @('Ready',0,$t0.AddSeconds(15)))
    Logs @(,@('service-start-new.log',('a mode=Start' + "`r`n" + 'b result=0'),3))
    $r = Run-Wait; Record 'I1 normal run: Running then Ready with log result=0' ($r.Finished -and -not $r.Error -and $r.LogResult -eq 0 -and $r.TaskResult -eq 0) ($r | ConvertTo-Json -Compress -Depth 1)
    Seq @(,@('Ready',0,$t0.AddHours(-1)))
    Logs @(,@('service-start-new.log',"z result=0",1))
    $r = Run-Wait; Record 'I2 LastRunTime moved backwards (clock change) and Running never seen' ($r.Finished -and $r.LogResult -eq 0 -and $r.TaskResult -eq 0) ($r | ConvertTo-Json -Compress -Depth 1)
    # old loop condition: keep waiting while (State -eq Running -or LastRunTime -le before)
    $oldRuleWouldWait = ('Ready' -eq 'Running' -or $t0.AddHours(-1) -le $t0)
    Record 'I2b the old LastRunTime rule would have kept waiting (documents the finding)' $oldRuleWouldWait
    Seq @(,@('Ready',0,$t0))
    Logs @(,@('service-start-new.log',"z result=0",1))
    $r = Run-Wait; Record 'I3 same LastRunTime (same second) and Running never seen' ($r.Finished -and $r.LogResult -eq 0) ($r | ConvertTo-Json -Compress -Depth 1)
    Seq @(@('Running',267009,$t0), @('Ready',267009,$t0), @('Ready',267009,$t0), @('Ready',0,$t0))
    Logs @(,@('service-start-new.log',"z result=0",1))
    $r = Run-Wait; Record 'I4 waits until LastTaskResult leaves 267009 (result lag)' ($r.Finished -and $r.TaskResult -eq 0) ($r | ConvertTo-Json -Compress -Depth 1)
    Seq @(@('Running',267009,$t0.AddSeconds(3)), @('Ready',1,$t0.AddSeconds(3)))
    Logs @()
    $r = Run-Wait; Record 'I5 task ended without a service log: finished with error after grace' ($r.Finished -and $r.Error -match 'without writing' -and $r.TaskResult -eq 1) ($r | ConvertTo-Json -Compress -Depth 1)
    Seq @(,@('Ready',0,$t0)); Logs @()
    $sw = [Diagnostics.Stopwatch]::StartNew(); $r = Run-Wait 2; $sw.Stop()
    Record 'I6 nothing happens: bounded timeout, not finished' (-not $r.Finished -and $sw.Elapsed.TotalSeconds -lt 4) ('s=' + [int]$sw.Elapsed.TotalSeconds)
    Seq @(@('Running',267009,$t0), @('Ready',1,$t0))
    Logs @(,@('service-start-new.log',"z result=1 error=boom",1))
    $r = Run-Wait; Record 'I7 failed run: log result=1, task result 1' ($r.Finished -and $r.LogResult -eq 1 -and $r.TaskResult -eq 1)
    Seq @(,@('Ready',0,$t0))
    Logs @(@('service-start-a.log',"result=0",1), @('service-start-b.log',"result=0",1))
    $r = Run-Wait; Record 'I8 two new logs are rejected as ambiguous' ($r.Finished -and $r.Error -match 'more than one')
    Seq @(@('Running',267009,$t0), @('Running',267009,$t0), @('Ready',0,$t0))
    Logs @(,@('service-start-new.log',"z result=0",0))
    $r = Run-Wait; Record 'I9 log result present while still Running: waits for Ready' ($r.Finished -and $script:SeqIndex -ge 3)
    Seq @(@('Running',267009,$t0), @('Ready',1,$t0))
    Logs @(,@('service-start-new.log',"z mode=Start",1))
    $sw = [Diagnostics.Stopwatch]::StartNew(); $r = Run-Wait 8; $sw.Stop()
    Record 'I10 task ended, new log without result line: finished with error after grace, not timeout' ($r.Finished -and $r.Error -match 'no result line' -and $r.Log -eq 'service-start-new.log' -and $r.TaskResult -eq 1 -and $sw.Elapsed.TotalSeconds -lt 5) ('s=' + [int]$sw.Elapsed.TotalSeconds + ' ' + ($r | ConvertTo-Json -Compress -Depth 1))
  }

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

  # ---------- J. register-tasks.ps1 itself, with system cmdlets replaced by aliases ----------
  # Aliases take precedence over functions and cmdlets, so the real script (which dot-sources the
  # library) calls these mocks. Nothing is registered with the real Task Scheduler.
  $jCfg = Join-Path $root 'j-service.json'
  [IO.File]::WriteAllText($jCfg, ((New-RawConfig @{taskPrefix='T-x'; postgres=[ordered]@{host='127.0.0.1'; port=$pgPort; serviceName='pgsvc'}}) | ConvertTo-Json -Depth 4))
  $svcSidFake = 'S-1-5-21-9-9-9-1001'
  # Mock state lives in uniquely named hashtables: inside the real scripts a script-scope variable would mean THEIR scope.
  $TestJ = @{Store=@{}; Registered=(New-Object System.Collections.ArrayList); SetCalls=(New-Object System.Collections.ArrayList); Rights=@('SeBatchLogonRight = *' + $svcSidFake)}
  function New-FakeTask([string]$Name) { [pscustomobject]@{TaskName=$Name; State='Ready'; Principal=[pscustomobject]@{UserId=($env:COMPUTERNAME + '\srvprosvc'); RunLevel='Limited'; LogonType='Password'}} }
  function Mock-Noop { }
  function Mock-ServiceUser($Cfg) { [pscustomobject]@{SID=[pscustomobject]@{Value=$svcSidFake}} }
  function Mock-Rights { $TestJ.Rights }
  function Mock-GetService { [CmdletBinding()] param([string]$Name) [pscustomobject]@{Name=$Name; StartType='Automatic'; Status='Running'} }
  function Mock-ReadHost { [CmdletBinding()] param([string]$Prompt, [switch]$AsSecureString) ConvertTo-SecureString 'not-a-real-password' -AsPlainText -Force }
  function Mock-GetTask { [CmdletBinding()] param([string]$TaskName) if ($TestJ.Store.ContainsKey($TaskName)) { $TestJ.Store[$TaskName] } else { Write-Error ('No task ' + $TaskName) } }
  function Mock-Register { [CmdletBinding()] param($TaskName, $Action, $Trigger, $Settings, $User, $Password, $RunLevel, $Description)
    [void]$TestJ.Registered.Add([pscustomobject]@{Name=$TaskName; Args=$Action.Arguments; Trigger=$Trigger; Settings=$Settings; User=$User; HasPassword=[bool]$Password; RunLevel=$RunLevel})
    $t = New-FakeTask $TaskName; $t.Principal.UserId = $User; $t.Principal.RunLevel = $RunLevel; $TestJ.Store[$TaskName] = $t }
  function Mock-Set { [CmdletBinding()] param($TaskName, $User, $Password) [void]$TestJ.SetCalls.Add($TaskName) }
  $jAliases = @{'Assert-SrvproElevatedAdmin'='Mock-Noop'; 'Get-SrvproServiceUser'='Mock-ServiceUser'; 'Assert-SrvproNotWritableBy'='Mock-Noop';
    'Get-SrvproUserRightsLines'='Mock-Rights'; 'Get-Service'='Mock-GetService'; 'Read-Host'='Mock-ReadHost'; 'Get-ScheduledTask'='Mock-GetTask';
    'Register-ScheduledTask'='Mock-Register'; 'Set-ScheduledTask'='Mock-Set'}
  foreach ($k in $jAliases.Keys) { Set-Alias -Name $k -Value $jAliases[$k] -Scope Script }
  $regScript = Join-Path $ScriptsDir 'register-tasks.ps1'
  function Run-Register([string[]]$Existing, [switch]$Update) {
    $TestJ.Store = @{}; foreach ($n in $Existing) { $TestJ.Store[$n] = New-FakeTask $n }
    $TestJ.Registered.Clear(); $TestJ.SetCalls.Clear()
    try {
      if ($Update) { $o = & $regScript -ConfigPath $jCfg -UpdatePassword } else { $o = & $regScript -ConfigPath $jCfg }
      return 'ok ' + ($o -join ' | ')
    } catch { return 'threw: ' + $_.Exception.Message }
  }
  try {
    $r = Run-Register @()
    $byName = @{}; foreach ($x in $TestJ.Registered) { $byName[$x.Name] = $x }
    Record 'J1 none exist: all three registered' ($r -like 'ok*' -and $TestJ.Registered.Count -eq 3 -and $byName.ContainsKey('T-x-Start') -and $byName.ContainsKey('T-x-Save') -and $byName.ContainsKey('T-x-Startup')) $r
    $okArgs = $true
    foreach ($m in @(@('T-x-Start','Start'), @('T-x-Save','Save'), @('T-x-Startup','Resurrect'))) {
      $x = $byName[$m[0]]
      if (-not $x -or $x.Args -notmatch ('-File "' + [regex]::Escape((Join-Path $ScriptsDir 'srvpro-service.ps1')) + '" -Mode ' + $m[1] + ' -ConfigPath "' + [regex]::Escape($jCfg) + '"$') -or $x.RunLevel -ne 'Limited' -or -not $x.HasPassword -or $x.User -ne ($env:COMPUTERNAME + '\srvprosvc')) { $okArgs = $false }
    }
    Record 'J1b each task: quoted script/config paths, its own mode, Limited, service account' $okArgs (($TestJ.Registered | ForEach-Object { $_.Args }) -join ' || ')
    $st = $byName['T-x-Startup']; $sv = $byName['T-x-Save']
    Record 'J1c only Startup has the boot trigger (+30 s) and 3 retries; manual tasks never retry' ($st.Trigger.Delay -eq 'PT30S' -and $st.Settings.RestartCount -eq 3 -and $null -eq $sv.Trigger -and $sv.Settings.RestartCount -eq 0) ('startupDelay=' + $st.Trigger.Delay + ' startupRestart=' + $st.Settings.RestartCount + ' saveRestart=' + $sv.Settings.RestartCount)
    Record 'J1d nothing started' ($r -match 'Nothing was started')
    $r = Run-Register @('T-x-Save')
    Record 'J2 partial (only Save exists): refused, names exactly the existing task, nothing registered' ($r -match 'Tasks already exist: T-x-Save\.' -and $TestJ.Registered.Count -eq 0) $r
    $r = Run-Register @('T-x-Start','T-x-Startup')
    Record 'J2b partial (Start, Startup): refused listing both' ($r -match 'Tasks already exist: T-x-Start, T-x-Startup\.' -and $TestJ.Registered.Count -eq 0) $r
    $r = Run-Register @('T-x-Start','T-x-Save','T-x-Startup')
    Record 'J3 all exist: refused, nothing registered' ($r -match 'Tasks already exist: T-x-Start, T-x-Save, T-x-Startup' -and $TestJ.Registered.Count -eq 0) $r
    $r = Run-Register @('T-x-Start','T-x-Save','T-x-Startup') -Update
    Record 'J4 all exist + UpdatePassword: three password updates, no registration' ($r -like 'ok*' -and $TestJ.SetCalls.Count -eq 3 -and $TestJ.Registered.Count -eq 0) $r
    $r = Run-Register @() -Update
    Record 'J5 none exist + UpdatePassword: refused' ($r -match 'needs all three' -and $TestJ.SetCalls.Count -eq 0) $r
    $r = Run-Register @('T-x-Save') -Update
    Record 'J5b partial + UpdatePassword: refused' ($r -match 'needs all three' -and $TestJ.SetCalls.Count -eq 0) $r
    $TestJ.Rights = @('SeBatchLogonRight = *S-1-5-32-544')
    $r = Run-Register @()
    Record 'J6 missing batch logon right: refused before registration' ($r -match 'lacks' -and $TestJ.Registered.Count -eq 0) $r
    $TestJ.Rights = @(('SeBatchLogonRight = *' + $svcSidFake), ('SeDenyBatchLogonRight = *' + $svcSidFake))
    $r = Run-Register @()
    Record 'J7 denied batch logon: refused' ($r -match 'denied' -and $TestJ.Registered.Count -eq 0) $r
  } finally {
    foreach ($k in $jAliases.Keys) { Remove-Item -LiteralPath ('Alias:' + $k) -Force -ErrorAction SilentlyContinue }
  }

  # ---------- K. check-service.ps1 -RunTask itself, with Task Scheduler mocked ----------
  $kCfg = Join-Path $root 'k-service.json'
  [IO.File]::WriteAllText($kCfg, ((New-RawConfig @{taskPrefix='K-x'}) | ConvertTo-Json -Depth 4))
  $kStart = 'K-x-Start'
  # Run = the task started by -RunTask (writes LogPrefix<N>.log); with AllTasks the other two exist idle
  # with IdleResult as their last result.
  $TestK = @{Mode='ok'; Started=$false; Polls=0; Written=$false; N=0; Run=$kStart; LogPrefix='service-start-k'; AllTasks=$false; IdleResult=@{}}
  $kT0 = [DateTime]'2026-11-14T22:15:15'
  function Mock-KGetTask { [CmdletBinding()] param([string]$TaskName)
    $k = $TestK
    if ($TaskName -ne $k.Run) {
      if (-not $k.AllTasks -or @('K-x-Start','K-x-Save','K-x-Startup') -notcontains $TaskName) { Write-Error ('No task ' + $TaskName); return }
      $idle = $(if ($k.IdleResult.ContainsKey($TaskName)) { $k.IdleResult[$TaskName] } else { 0 })
      return [pscustomobject]@{TaskName=$TaskName; State='Ready'; Principal=[pscustomobject]@{UserId=($env:COMPUTERNAME + '\srvprosvc'); RunLevel='Limited'; LogonType='Password'};
        InfoObj=[pscustomobject]@{LastTaskResult=$idle; LastRunTime=$kT0; NextRunTime=$null}}
    }
    $state = 'Ready'; $result = 0; $last = $kT0
    if ($k.Started -and $k.Mode -ne 'never') {
      $k.Polls++
      if ($k.Polls -le 2) { $state = 'Running'; $result = 267009 }
      else {
        if (-not $k.Written) {
          $logResult = $(if ($k.Mode -eq 'fail') { 1 } else { 0 })
          [IO.File]::WriteAllText((Join-Path $logs ($k.LogPrefix + $k.N + '.log')), ('t mode=Start' + "`r`n" + 't result=' + $logResult))
          $k.Written = $true
        }
        $result = $(if ($k.Mode -eq 'ok') { 0 } else { 1 })
        $last = $kT0.AddHours(-1)   # clock moved backwards: the old rule would never see this run
      }
    }
    [pscustomobject]@{TaskName=$TaskName; State=$state; Principal=[pscustomobject]@{UserId=($env:COMPUTERNAME + '\srvprosvc'); RunLevel='Limited'; LogonType='Password'};
      InfoObj=[pscustomobject]@{LastTaskResult=$result; LastRunTime=$last; NextRunTime=$null}}
  }
  function Mock-KInfo { [CmdletBinding()] param($InputObject, [string]$TaskName) $InputObject.InfoObj }
  function Mock-KStart { [CmdletBinding()] param([string]$TaskName) $TestK.Started = $true; $TestK.StartedName = $TaskName }
  function Mock-KDaemon($Cfg) { [pscustomobject]@{Running=$false; Own=$false; Pid=0; Detail='mocked: no pipe access in tests'} }
  $kAliases = @{'Assert-SrvproElevatedAdmin'='Mock-Noop'; 'Get-ScheduledTask'='Mock-KGetTask'; 'Get-ScheduledTaskInfo'='Mock-KInfo';
    'Start-ScheduledTask'='Mock-KStart'; 'Get-SrvproDaemonState'='Mock-KDaemon'}
  foreach ($k in $kAliases.Keys) { Set-Alias -Name $k -Value $kAliases[$k] -Scope Script }
  $chk = Join-Path $ScriptsDir 'check-service.ps1'
  function Run-Check([string]$Mode, [int]$Wait = 20, [string]$RunTask = 'Start') {
    $TestK.Mode = $Mode; $TestK.Started = $false; $TestK.StartedName = $null; $TestK.Polls = 0; $TestK.Written = $false; $TestK.N++
    $global:LASTEXITCODE = 0
    try { $o = (& $chk -ConfigPath $kCfg -RunTask $RunTask -WaitSeconds $Wait) -join "`n" } catch { $o = 'threw: ' + $_.Exception.Message }
    return [pscustomobject]@{Out=$o; Exit=$LASTEXITCODE}
  }
  try {
    $sw = [Diagnostics.Stopwatch]::StartNew(); $r = Run-Check 'ok'; $sw.Stop()
    Record 'K1 run finishes with skewed LastRunTime: task PASS from log + result' ($r.Out -match 'CHECK task-Start PASS' -and $sw.Elapsed.TotalSeconds -lt 15) ('s=' + [int]$sw.Elapsed.TotalSeconds + ' ' + (($r.Out -split "`n") | Where-Object { $_ -match 'task' }) -join ' / ')
    $r = Run-Check 'fail'
    Record 'K2 log result=1 and task result 1: task FAIL' ($r.Out -match 'CHECK task-Start FAIL' -and $r.Exit -eq 1) ((($r.Out -split "`n") | Where-Object { $_ -match 'task-Start' }) -join ' / ')
    $r = Run-Check 'disagree'
    Record 'K3 log result=0 but task result 1: FAIL as inconsistent' ($r.Out -match 'CHECK task-Start FAIL.*disagree') ((($r.Out -split "`n") | Where-Object { $_ -match 'task-Start' }) -join ' / ')
    $sw = [Diagnostics.Stopwatch]::StartNew(); $r = Run-Check 'never' 3; $sw.Stop()
    Record 'K4 task never runs: bounded wait, exit 2, no task verdict' ($r.Exit -eq 2 -and $r.Out -notmatch 'CHECK task-Start' -and $sw.Elapsed.TotalSeconds -lt 10) ('exit=' + $r.Exit + ' s=' + [int]$sw.Elapsed.TotalSeconds)
    # -RunTask Startup; all three tasks exist and an old Start run failed (LastTaskResult=1).
    $TestK.Run = 'K-x-Startup'; $TestK.LogPrefix = 'service-resurrect-k'; $TestK.AllTasks = $true; $TestK.IdleResult = @{'K-x-Start'=1}
    $r = Run-Check 'ok' 20 'Startup'
    $kLines = (($r.Out -split "`n") | Where-Object { $_ -match 'task' }) -join ' / '
    Record 'K5 -RunTask Startup starts K-x-Startup once and matches service-resurrect-*.log: PASS' ($TestK.StartedName -eq 'K-x-Startup' -and $r.Out -match 'CHECK task-Startup PASS' -and $r.Out -match ('log=service-resurrect-k' + $TestK.N + '\.log')) $kLines
    Record 'K6 an old failed Start run is INFO only, never a task-result FAIL; Startup result still checked' ($r.Out -notmatch 'CHECK task-result K-x-Start ' -and $r.Out -match 'INFO task-last-result K-x-Start ::' -and $r.Out -match 'CHECK task-result K-x-Startup PASS') $kLines
  } finally {
    foreach ($k in $kAliases.Keys) { Remove-Item -LiteralPath ('Alias:' + $k) -Force -ErrorAction SilentlyContinue }
  }
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
