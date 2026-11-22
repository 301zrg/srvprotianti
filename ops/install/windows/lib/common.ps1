# Shared glue for the Windows staged installer (Windows PowerShell 5.1).
# Keep this file ASCII-only: PS 5.1 misreads BOM-less UTF-8 scripts.
#
# Execution rules (design section 10):
# - Long native commands are not redirected, so PS 5.1 never wraps their stderr in
#   ErrorRecords; only $LASTEXITCODE decides. Commands whose output or stdin we need run
#   through System.Diagnostics.Process with both streams read asynchronously.
# - Secrets never enter a command line, $env:, the log, or the state file. They reach a
#   child only through that Process' own environment or stdin.
# - Every block is registered with a read-only verifier: 0 done, 10 proven not started,
#   20 partial or unknown (stop and hand over to a person).

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:InstallStateDir = 'C:\ProgramData\srvprotianti-install'
$script:InstallStateVersion = 1
$script:Blocks = New-Object System.Collections.ArrayList
$script:State = $null
$script:LogFile = $null
$script:LockStream = $null
$script:Params = $null

class InstallStop : System.Exception {
  InstallStop([string]$message) : base($message) {}
}

function Stop-Install([string]$Message) { throw [InstallStop]::new($Message) }

# ---------- console ----------
# A click inside a console window with QuickEdit on starts a selection and suspends the
# installer until Esc (found in the owner's route B walk). QuickEdit is switched off for the
# run and the previous mode restored at the end. Any failure here is ignored: no console,
# redirected input or a host without the API simply keeps its mode.
$script:SavedConsoleMode = $null
function Disable-ConsoleQuickEdit {
  try {
    if (-not ('InstallConsoleMode' -as [type])) {
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class InstallConsoleMode {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetConsoleMode(IntPtr h, out uint m);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleMode(IntPtr h, uint m);
}
'@
    }
    $h = [InstallConsoleMode]::GetStdHandle(-10)
    $mode = [uint32]0
    if (-not [InstallConsoleMode]::GetConsoleMode($h, [ref]$mode)) { return }
    # 0x40 = ENABLE_QUICK_EDIT_MODE; 0x80 = ENABLE_EXTENDED_FLAGS (needed for the change to apply).
    if ([InstallConsoleMode]::SetConsoleMode($h, (($mode -band (-bnot [uint32]0x40)) -bor [uint32]0x80))) { $script:SavedConsoleMode = $mode }
  } catch {}
}
function Restore-ConsoleQuickEdit {
  if ($null -eq $script:SavedConsoleMode) { return }
  try { [void][InstallConsoleMode]::SetConsoleMode([InstallConsoleMode]::GetStdHandle(-10), [uint32]($script:SavedConsoleMode -bor 0x80)) } catch {}
  $script:SavedConsoleMode = $null
}

# ---------- output and log ----------

function Write-InstallLog([string]$Line) {
  if ($script:LogFile) {
    $stamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    [IO.File]::AppendAllText($script:LogFile, $stamp + ' ' + $Line + "`r`n", (New-Object Text.UTF8Encoding $false))
  }
}

function Write-Step([string]$Line) {
  Write-Host $Line
  Write-InstallLog $Line
}

# ---------- identity, ACL, paths ----------

function Assert-ElevatedAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Stop-Install 'Run from an elevated PowerShell (right-click, Run as administrator)'
  }
}

function New-PrivateAcl {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
    $identity = New-Object System.Security.Principal.SecurityIdentifier($sid)
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  }
  return $acl
}

# Creates a new directory readable only by SYSTEM and Administrators. Refuses existing paths.
function New-PrivateDirectory([string]$Path) {
  if (Test-Path -LiteralPath $Path) { Stop-Install ('Already exists, inspect it first: ' + $Path) }
  New-Item -ItemType Directory -Path $Path | Out-Null
  Set-Acl -LiteralPath $Path -AclObject (New-PrivateAcl)
}

# True when the directory exists, is not a reparse point, inheritance is off and only
# SYSTEM and Administrators hold allow rules.
function Test-PrivateDirectory([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
  $acl = Get-Acl -LiteralPath $Path
  if (-not $acl.AreAccessRulesProtected) { return $false }
  foreach ($rule in $acl.Access) {
    $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($rule.AccessControlType -eq 'Allow' -and @('S-1-5-18', 'S-1-5-32-544') -notcontains $sid) { return $false }
  }
  return $true
}

function Assert-SafeInstallPath([string]$Value, [string]$Name) {
  if ($Value -notmatch '^[A-Za-z]:\\[A-Za-z0-9_-]+(\\[A-Za-z0-9_-]+)*$') {
    Stop-Install ($Name + ' must look like C:\dir\sub with only letters, digits, - and _ in each part')
  }
}

function Update-ProcessPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

# ---------- native commands ----------

# MSVCRT command-line quoting for one argument.
function ConvertTo-QuotedArgument([string]$Value) {
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $sb = New-Object Text.StringBuilder
  [void]$sb.Append('"')
  $slashes = 0
  foreach ($ch in $Value.ToCharArray()) {
    if ($ch -eq '\') { $slashes++; continue }
    if ($ch -eq '"') { [void]$sb.Append([char]92, 2 * $slashes + 1); [void]$sb.Append('"'); $slashes = 0; continue }
    if ($slashes) { [void]$sb.Append([char]92, $slashes); $slashes = 0 }
    [void]$sb.Append($ch)
  }
  if ($slashes) { [void]$sb.Append([char]92, 2 * $slashes) }
  [void]$sb.Append('"')
  return $sb.ToString()
}

function ConvertTo-CommandLine([string[]]$Arguments) {
  return (@($Arguments | ForEach-Object { ConvertTo-QuotedArgument $_ }) -join ' ')
}

# Runs a long command with inherited console streams; only the exit code decides.
function Invoke-NativeLive([string]$Exe, [string[]]$Arguments, [string]$What) {
  Write-InstallLog ('RUN ' + $What)
  & $Exe @Arguments
  $code = $LASTEXITCODE
  if ($code -ne 0) { Stop-Install ($What + ' failed with exit code ' + $code) }
}

# Runs a command with captured output. $Environment entries go only to this child.
# $Stdin is written then closed. Returns an object with Code, Out, Err.
function Invoke-NativeCapture {
  param([string]$Exe, [string[]]$Arguments = @(), [hashtable]$Environment = @{}, [string]$Stdin = $null,
        [int]$TimeoutSeconds = 600, [string]$WorkingDirectory = $null)
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe
  $psi.Arguments = ConvertTo-CommandLine $Arguments
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.RedirectStandardInput = $true
  $psi.StandardOutputEncoding = New-Object Text.UTF8Encoding $false
  $psi.StandardErrorEncoding = New-Object Text.UTF8Encoding $false
  if ($WorkingDirectory) { $psi.WorkingDirectory = $WorkingDirectory }
  # Inherited libpq settings must not decide which identity a child uses.
  foreach ($k in @('PGPASSWORD', 'PGPASSFILE', 'PGUSER', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGOPTIONS', 'PGSERVICE', 'PGSERVICEFILE', 'MAINTENANCE_PASSWORD')) {
    if (-not $Environment.ContainsKey($k)) { $psi.EnvironmentVariables.Remove($k) }
  }
  foreach ($k in $Environment.Keys) { $psi.EnvironmentVariables[$k] = [string]$Environment[$k] }
  $p = New-Object Diagnostics.Process
  $p.StartInfo = $psi
  try {
    [void]$p.Start()
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()
    if ($null -ne $Stdin) {
      $writer = New-Object IO.StreamWriter($p.StandardInput.BaseStream, (New-Object Text.UTF8Encoding $false))
      $writer.Write($Stdin)
      $writer.Flush()
      $writer.Dispose()
    } else {
      $p.StandardInput.Close()
    }
    if (-not $p.WaitForExit($TimeoutSeconds * 1000)) {
      try { $p.Kill() } catch {}
      Stop-Install ('Timed out: ' + [IO.Path]::GetFileName($Exe))
    }
    $p.WaitForExit()
    return [pscustomobject]@{ Code = $p.ExitCode; Out = $outTask.Result; Err = $errTask.Result }
  } finally {
    foreach ($k in @($Environment.Keys)) { $psi.EnvironmentVariables.Remove($k) }
    $p.Dispose()
  }
}

# ---------- secrets ----------

function ConvertFrom-SecretString([Security.SecureString]$Secure) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

# Reads an existing secret once. Returns plain text; callers clear it in finally.
function Read-Secret([string]$Prompt) {
  $value = ConvertFrom-SecretString (Read-Host $Prompt -AsSecureString)
  if (-not $value -or $value -match "[`r`n`0]") { Stop-Install ('Empty or invalid input for: ' + $Prompt) }
  return $value
}

# Reads a new secret twice. $Rule is a scriptblock returning an error text or $null.
function Read-NewSecret([string]$Prompt, [scriptblock]$Rule) {
  for ($try = 1; $try -le 3; $try++) {
    $a = ConvertFrom-SecretString (Read-Host ($Prompt + ' (new)') -AsSecureString)
    $b = ConvertFrom-SecretString (Read-Host ($Prompt + ' (again)') -AsSecureString)
    $problem = $null
    if ($a -cne $b) { $problem = 'The two entries differ' }
    elseif (-not $a -or $a -match "[`r`n`0]") { $problem = 'Empty or contains a line break' }
    elseif ($Rule) { $problem = & $Rule $a }
    $b = $null
    if (-not $problem) { return $a }
    $a = $null
    Write-Host ('  ' + $problem + '; try again (' + $try + '/3)')
  }
  Stop-Install ('No acceptable value for: ' + $Prompt)
}

function Test-PostgresPasswordRule([string]$Value) {
  if ($Value -notmatch '^[A-Za-z0-9!_-]{12,}$') { return 'Use at least 12 characters from letters, digits and ! _ -' }
  return $null
}

# Local precheck of the default Windows complexity policy; New-LocalUser stays authoritative.
function Test-WindowsPasswordRule([string]$Value, [string]$Account) {
  if ($Value.Length -lt 8) { return 'Use at least 8 characters' }
  $classes = 0
  foreach ($re in @('[A-Z]', '[a-z]', '[0-9]', '[^A-Za-z0-9]')) { if ($Value -cmatch $re) { $classes++ } }
  if ($classes -lt 3) { return 'Use at least three of: upper case, lower case, digits, symbols' }
  for ($i = 0; $i -le $Account.Length - 3; $i++) {
    if ($Value.IndexOf($Account.Substring($i, 3), [StringComparison]::OrdinalIgnoreCase) -ge 0) { return 'Must not contain parts of the account name' }
  }
  return $null
}

# ---------- checkpoints ----------

function Confirm-Checkpoint([string]$Text, [string]$Expected = 'yes') {
  Write-Host ''
  Write-Host $Text
  $answer = Read-Host ('Type ' + $Expected + ' to continue')
  if ($answer -cne $Expected) { Stop-Install 'Checkpoint not confirmed' }
  Write-InstallLog ('CHECKPOINT confirmed: ' + ($Text -split "`n")[0])
}

# ---------- state and lock ----------

function Open-InstallLock {
  if (-not (Test-Path -LiteralPath $script:InstallStateDir)) { New-PrivateDirectory $script:InstallStateDir }
  if (-not (Test-PrivateDirectory $script:InstallStateDir)) { Stop-Install ('State directory permissions changed: ' + $script:InstallStateDir) }
  foreach ($sub in @('logs', 'evidence')) {
    $p = Join-Path $script:InstallStateDir $sub
    if (-not (Test-Path -LiteralPath $p)) { New-Item -ItemType Directory -Path $p | Out-Null }
  }
  try {
    $script:LockStream = [IO.File]::Open((Join-Path $script:InstallStateDir 'lock'), 'OpenOrCreate', 'ReadWrite', 'None')
  } catch {
    Stop-Install 'Another installer run is active'
  }
  $script:LogFile = Join-Path $script:InstallStateDir ('logs\' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '.log')
}

function Read-InstallState {
  $path = Join-Path $script:InstallStateDir 'state.json'
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try { $raw = [IO.File]::ReadAllText($path) | ConvertFrom-Json } catch { Stop-Install 'state.json is unreadable; hand over to the maintainer' }
  if ($raw.version -ne $script:InstallStateVersion) { Stop-Install 'state.json has an unknown version' }
  return $raw
}

function Save-InstallState {
  $path = Join-Path $script:InstallStateDir 'state.json'
  $tmp = $path + '.tmp'
  $json = $script:State | ConvertTo-Json -Depth 8
  $fs = [IO.File]::Open($tmp, 'Create', 'Write', 'None')
  try {
    $bytes = (New-Object Text.UTF8Encoding $false).GetBytes($json)
    $fs.Write($bytes, 0, $bytes.Length)
    $fs.Flush($true)
  } finally { $fs.Dispose() }
  if (Test-Path -LiteralPath $path) { [IO.File]::Replace($tmp, $path, $path + '.bak') } else { [IO.File]::Move($tmp, $path) }
}

function Get-StateProperty($Object, [string]$Name) {
  $p = $Object.PSObject.Properties[$Name]
  if ($null -eq $p) { return $null }
  return $p.Value
}

function Set-StateProperty($Object, [string]$Name, $Value) {
  if ($Object.PSObject.Properties[$Name]) { $Object.$Name = $Value } else { $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
}

# ---------- blocks ----------

# Kind: read (verify only), idempotent (safe to repeat), first (one-shot action).
function Register-Block([string]$Id, [string]$Stage, [string]$Kind, [string]$Manual, [scriptblock]$Action, [scriptblock]$Verify) {
  if (@('read', 'idempotent', 'first') -notcontains $Kind) { throw ('Bad kind for ' + $Id) }
  [void]$script:Blocks.Add([pscustomobject]@{ Id = $Id; Stage = $Stage; Kind = $Kind; Manual = $Manual; Action = $Action; Verify = $Verify })
}

function Test-BlockDone([string]$Id) {
  return @($script:State.done) -contains $Id
}

function Complete-Block([string]$Id) {
  $script:State.done = @(@($script:State.done) + $Id)
  $script:State.pending = $null
  Save-InstallState
}

function Invoke-Verify($Block) {
  if (-not $Block.Verify) { return 20 }
  $r = & $Block.Verify
  if ($r -isnot [int] -or @(0, 10, 20) -notcontains $r) { throw ('Verifier of ' + $Block.Id + ' returned ' + $r) }
  return $r
}

function Invoke-Block($Block) {
  if (Test-BlockDone $Block.Id) { Write-Step ('SKIP ' + $Block.Id); return }
  $pending = $script:State.pending
  if ($pending -eq $Block.Id -and $Block.Kind -ne 'first') {
    Write-Step ('RETRY ' + $Block.Id + ' (safe to repeat)')
  } elseif ($pending -eq $Block.Id) {
    $r = Invoke-Verify $Block
    if ($r -eq 0) { Write-Step ('PROBE ' + $Block.Id + ': complete'); Complete-Block $Block.Id; return }
    if ($r -eq 20) { Stop-Install ('PROBE ' + $Block.Id + ': partial or unknown; inspect manually (manual ' + $Block.Manual + ')') }
    Write-Step ('PROBE ' + $Block.Id + ': not started (proven)')
  } elseif ($pending) {
    Stop-Install ('Pending block ' + $pending + ' belongs to another stage; run "install.ps1 run"')
  }
  if ($Block.Kind -eq 'first') {
    $r = Invoke-Verify $Block
    if ($r -eq 0) { Stop-Install ('Target of one-shot block ' + $Block.Id + ' already exists without a state record; inspect it') }
    if ($r -eq 20) { Stop-Install ('Target of one-shot block ' + $Block.Id + ' is partly present; inspect it') }
  }
  $script:State.pending = $Block.Id
  Save-InstallState
  Write-Step ('BEGIN ' + $Block.Id + ' (manual ' + $Block.Manual + ')')
  if ($Block.Action) { & $Block.Action }
  if ($Block.Kind -eq 'first' -or ($Block.Kind -eq 'idempotent' -and $Block.Verify)) {
    $r = Invoke-Verify $Block
    if ($r -ne 0) { Stop-Install ('Post-check failed for ' + $Block.Id) }
  }
  Complete-Block $Block.Id
  Write-Step ('DONE ' + $Block.Id)
}

function Invoke-Stage([string]$Stage) {
  $list = @($script:Blocks | Where-Object { $_.Stage -eq $Stage })
  if ($list.Count -eq 0) { throw ('No blocks for stage ' + $Stage) }
  foreach ($b in $list) { Invoke-Block $b }
  Write-Step ('PASS ' + $Stage)
}

# ---------- parameters ----------

function Read-InstallParams([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Stop-Install ('Missing parameter file: ' + $Path) }
  $p = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
  $allowed = @('expectedHost', 'route', 'labVm', 'root', 'database', 'httpPort', 'listenPorts', 'maintenanceMessage',
    'managementUsername', 'firewallRemoteAddress', 'batch', 'restoreDir')
  foreach ($prop in $p.PSObject.Properties) { if ($allowed -notcontains $prop.Name) { Stop-Install ('Unknown parameter: ' + $prop.Name) } }
  if ($null -eq $p.PSObject.Properties['root']) { $p | Add-Member -NotePropertyName root -NotePropertyValue 'C:\srvpro-lab' }
  foreach ($req in @('expectedHost', 'route', 'labVm', 'root', 'database', 'httpPort', 'listenPorts', 'maintenanceMessage')) {
    if ($null -eq $p.PSObject.Properties[$req]) { Stop-Install ('Missing parameter: ' + $req) }
  }
  if (@('A', 'B') -cnotcontains $p.route) { Stop-Install 'route must be A or B' }
  if ($p.labVm -isnot [bool]) { Stop-Install 'labVm must be true or false' }
  Assert-SafeInstallPath $p.root 'root'
  foreach ($fixed in @('C:\srvpro-input', 'C:\srvpro-private', 'C:\srvpro-restores', 'C:\srvpro-pm2', 'C:\srvpro-tools', 'C:\srvpro-service', 'C:\srvpro-bootstrap-private', 'C:\Windows', 'C:\Program Files', 'C:\ProgramData', 'C:\Users')) {
    $same = $p.root -eq $fixed
    $inside = $p.root.StartsWith($fixed + '\', [StringComparison]::OrdinalIgnoreCase)
    $contains = $fixed.StartsWith($p.root + '\', [StringComparison]::OrdinalIgnoreCase)
    if ($same -or $inside -or $contains) { Stop-Install ('root overlaps ' + $fixed) }
  }
  if ($p.root.Length -gt 60) { Stop-Install 'root is too long (keep it under 60 characters)' }
  $ports = @($p.listenPorts)
  foreach ($port in @($ports + @($p.httpPort))) { if ($port -isnot [int] -or $port -lt 1 -or $port -gt 65535) { Stop-Install 'Ports must be integers from 1 to 65535' } }
  if (@($ports | Sort-Object -Unique).Count -ne $ports.Count) { Stop-Install 'listenPorts has duplicates' }
  if ($ports -notcontains $p.httpPort) { Stop-Install 'listenPorts must include httpPort' }
  if ($p.database -notmatch '^[a-z][a-z0-9_]{0,62}$') { Stop-Install 'database name is invalid' }
  if ($p.maintenanceMessage -isnot [string] -or -not $p.maintenanceMessage -or $p.maintenanceMessage -eq 'false') { Stop-Install 'maintenanceMessage is invalid' }
  if ($p.route -eq 'A') {
    if ($p.managementUsername -notmatch '^[A-Za-z0-9_-]{1,32}$') { Stop-Install 'managementUsername is required for route A' }
  } else {
    if ($null -eq $p.PSObject.Properties['batch'] -or $null -eq $p.PSObject.Properties['restoreDir']) { Stop-Install 'route B needs batch and restoreDir' }
    if ($p.batch.zip -notmatch '^[A-Za-z0-9._-]+\.zip$' -or $p.batch.top -notmatch '^[A-Za-z0-9_-]+$') { Stop-Install 'batch.zip or batch.top is invalid' }
    Assert-SafeInstallPath $p.restoreDir 'restoreDir'
    # ops.py relies on the parent's ACL on Windows: keep restores under the private root.
    if ($p.restoreDir -notmatch '^C:\\srvpro-restores\\[A-Za-z0-9_-]+$') { Stop-Install 'restoreDir must be C:\srvpro-restores\<new name>' }
  }
  return $p
}
