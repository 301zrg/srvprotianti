# Unit tests for the Windows installer glue. Windows PowerShell 5.1, no Pester needed.
# Run: powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops\install\windows\tests\run-tests.ps1
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$script:InstallLibDir = Join-Path $root 'lib'
. (Join-Path $script:InstallLibDir 'common.ps1')
. (Join-Path $script:InstallLibDir 'postgres.ps1')

$script:Failures = 0
$script:Count = 0
function Assert-True([bool]$Condition, [string]$Name) {
  $script:Count++
  if ($Condition) { Write-Host ('ok   ' + $Name) } else { Write-Host ('FAIL ' + $Name); $script:Failures++ }
}
function Assert-Throws([scriptblock]$Block, [string]$Pattern, [string]$Name) {
  $script:Count++
  try { & $Block; Write-Host ('FAIL ' + $Name + ' (no error)'); $script:Failures++ }
  catch {
    if ($_.Exception.Message -match $Pattern) { Write-Host ('ok   ' + $Name) }
    else { Write-Host ('FAIL ' + $Name + ' (' + $_.Exception.Message + ')'); $script:Failures++ }
  }
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('srvpro-install-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  # ASCII-only scripts (PS 5.1 misreads BOM-less UTF-8).
  foreach ($f in Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object { @('.ps1', '.cjs') -contains $_.Extension }) {
    $bytes = [IO.File]::ReadAllBytes($f.FullName)
    Assert-True (-not ($bytes | Where-Object { $_ -gt 127 })) ('ascii ' + $f.Name)
  }

  # Command-line quoting round-trips through a real child process.
  $sample = @('plain', 'with space', 'q"uote', 'trail\', 'C:\Program Files\x\', '', 'a\\"b')
  $py = (Get-Command python -ErrorAction SilentlyContinue)
  if ($py) {
    $r = Invoke-NativeCapture -Exe $py.Source -Arguments (@('-c', 'import sys,json;print(json.dumps(sys.argv[1:]))') + $sample)
    $back = $r.Out.Trim() | ConvertFrom-Json
    Assert-True ((@($back) -join '|') -ceq ($sample -join '|')) 'quoting round-trip'
    $r = Invoke-NativeCapture -Exe $py.Source -Arguments @('-c', 'import os,sys;print(os.environ.get("T_SECRET"));print(sys.stdin.read())') -Environment @{ T_SECRET = 'child-only' } -Stdin 'in'
    Assert-True ($r.Out -match 'child-only' -and $r.Out -match 'in') 'child environment and stdin'
    Assert-True (-not (Test-Path Env:T_SECRET)) 'secret not in parent environment'
  } else { Write-Host 'skip quoting tests: python not found' }

  # Password rules.
  Assert-True ($null -ne (Test-PostgresPasswordRule 'short')) 'pg rule rejects short'
  Assert-True ($null -ne (Test-PostgresPasswordRule 'abcdefghijk$m')) 'pg rule rejects other symbols'
  Assert-True ($null -eq (Test-PostgresPasswordRule 'abcDEF123_-!x')) 'pg rule accepts allowed set'
  Assert-True ($null -ne (Test-WindowsPasswordRule 'alllowercase1' 'srvprosvc')) 'win rule needs three classes'
  Assert-True ($null -ne (Test-WindowsPasswordRule 'Xsvc9pass!' 'srvprosvc')) 'win rule rejects account fragment'
  Assert-True ($null -eq (Test-WindowsPasswordRule 'Lab_Walk2026' 'srvprosvc')) 'win rule accepts'

  # Install paths.
  Assert-Throws { Assert-SafeInstallPath 'C:\srvpro lab' 'root' } 'root must look like' 'path rejects space'
  Assert-Throws { Assert-SafeInstallPath 'C:\srvpro-lab\' 'root' } 'root must look like' 'path rejects trailing slash'
  Assert-Throws { Assert-SafeInstallPath 'C:\a\..\b' 'root' } 'root must look like' 'path rejects dot segments'
  $nonAscii = 'C:\' + [char]0x670D + [char]0x52A1
  Assert-Throws { Assert-SafeInstallPath $nonAscii 'root' } 'root must look like' 'path rejects non-ASCII'
  Assert-SafeInstallPath 'D:\games\srvpro_1' 'root'
  Assert-True $true 'path accepts D:\games\srvpro_1'

  # Parameters.
  $pfile = Join-Path $tmp 'params.json'
  $good = @{ expectedHost = 'HOST'; route = 'A'; labVm = $true; root = 'C:\srvpro-lab'; database = 'srvpro_1103'; httpPort = 7922; listenPorts = @(7911, 7922, 7977); maintenanceMessage = 'm'; managementUsername = 'maintenance' }
  [IO.File]::WriteAllText($pfile, ($good | ConvertTo-Json))
  Assert-True ((Read-InstallParams $pfile).route -eq 'A') 'params A accepted'
  $bad = $good.Clone(); $bad.extra = 1
  [IO.File]::WriteAllText($pfile, ($bad | ConvertTo-Json))
  Assert-Throws { Read-InstallParams $pfile } 'Unknown parameter' 'params rejects unknown key'
  $bad = $good.Clone(); $bad.route = 'B'
  [IO.File]::WriteAllText($pfile, ($bad | ConvertTo-Json))
  Assert-Throws { Read-InstallParams $pfile } 'route B needs' 'params B needs batch'
  $bad = $good.Clone(); $bad.maintenanceMessage = 'false'
  [IO.File]::WriteAllText($pfile, ($bad | ConvertTo-Json))
  Assert-Throws { Read-InstallParams $pfile } 'maintenanceMessage' 'params rejects false message'

  # json-edit keeps other fields, never prints passwords, and hides parse snippets.
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) {
    $cfg = Join-Path $tmp 'adapter.json'
    [IO.File]::WriteAllText($cfg, '{"enabled":true,"connection":{"database":"srvpro_1103","password":"","username":"srvpro_runtime"},"note":"C:/srvpro-lab/shared/replays/"}')
    $r = Invoke-JsonEdit $cfg @{ set = @(@{ path = @('connection', 'password'); value = 'p"w\s:x' }); replacePrefix = @{ from = 'C:/srvpro-lab/shared/'; to = 'D:/games/s/shared/' }; show = @(@('connection', 'password'), @('note')) }
    $saved = [IO.File]::ReadAllText($cfg) | ConvertFrom-Json
    Assert-True ($saved.connection.password -ceq 'p"w\s:x') 'json-edit sets value exactly'
    Assert-True ($saved.connection.username -eq 'srvpro_runtime' -and $saved.enabled -eq $true) 'json-edit keeps other fields'
    Assert-True ($saved.note -eq 'D:/games/s/shared/replays/') 'json-edit rewrites prefix'
    Assert-True ($r.show.'connection.password' -eq '<set>') 'json-edit masks password'
    [IO.File]::WriteAllText($cfg, '{"connection":{"password":"leak-me" BROKEN')
    $out = Invoke-NativeCapture -Exe $node.Source -Arguments @((Join-Path $script:InstallLibDir 'json-edit.cjs')) -Stdin ('{"file":' + ($cfg | ConvertTo-Json) + ',"show":[["x"]]}')
    Assert-True ($out.Code -ne 0 -and ($out.Out + $out.Err) -notmatch 'leak-me') 'json-edit parse error hides content'
    Assert-Throws { Invoke-JsonEdit (Join-Path $tmp 'adapter.json') @{ set = @(@{ path = @('nope', 'x'); value = 1 }) } } 'not valid JSON|Field not present' 'json-edit refuses missing field'
  } else { Write-Host 'skip json-edit tests: node not found' }

  # Block state machine with a private test state directory.
  $script:InstallStateDir = Join-Path $tmp 'state'
  New-Item -ItemType Directory -Path $script:InstallStateDir | Out-Null
  $script:State = [pscustomobject]@{ version = 1; done = @(); pending = $null }
  $script:Blocks.Clear()
  $script:Marker = Join-Path $tmp 'marker'
  $script:Runs = 0
  Register-Block 'T-FIRST' 'T' 'first' 'test' { $script:Runs++; [IO.File]::WriteAllText($script:Marker, 'x') } { if (Test-Path -LiteralPath $script:Marker) { 0 } else { 10 } }
  Register-Block 'T-READ' 'T' 'read' 'test' { $script:Runs++ } $null
  Invoke-Stage 'T'
  Assert-True ($script:Runs -eq 2 -and (Test-BlockDone 'T-FIRST') -and (Test-BlockDone 'T-READ')) 'stage runs blocks once'
  Invoke-Stage 'T'
  Assert-True ($script:Runs -eq 2) 'finished blocks are skipped'
  $saved = [IO.File]::ReadAllText((Join-Path $script:InstallStateDir 'state.json')) | ConvertFrom-Json
  Assert-True (@($saved.done).Count -eq 2 -and $null -eq $saved.pending) 'state persisted'

  # A one-shot block whose target already exists without a record must stop.
  $script:State = [pscustomobject]@{ version = 1; done = @(); pending = $null }
  Assert-Throws { Invoke-Block ($script:Blocks[0]) } 'already exists without a state record' 'first block refuses unrecorded target'

  # Pending one-shot block: proven complete is recorded, partial stops.
  $script:State = [pscustomobject]@{ version = 1; done = @(); pending = 'T-FIRST' }
  Invoke-Block ($script:Blocks[0])
  Assert-True ((Test-BlockDone 'T-FIRST') -and $script:Runs -eq 2) 'pending block verified as complete'
  $script:Blocks.Clear()
  Register-Block 'T-PART' 'T' 'first' 'test' { } { 20 }
  $script:State = [pscustomobject]@{ version = 1; done = @(); pending = 'T-PART' }
  Assert-Throws { Invoke-Block ($script:Blocks[0]) } 'partial or unknown' 'pending partial block stops'

  # Failing action leaves the block pending, not done.
  $script:Blocks.Clear()
  Register-Block 'T-FAIL' 'T' 'first' 'test' { Stop-Install 'boom' } { 10 }
  $script:State = [pscustomobject]@{ version = 1; done = @(); pending = $null }
  Assert-Throws { Invoke-Block ($script:Blocks[0]) } 'boom' 'failing action raises'
  Assert-True ($script:State.pending -eq 'T-FAIL' -and -not (Test-BlockDone 'T-FAIL')) 'failed block stays pending'
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host ([string]$script:Count + ' checks, ' + $script:Failures + ' failed')
if ($script:Failures) { exit 1 }
exit 0
