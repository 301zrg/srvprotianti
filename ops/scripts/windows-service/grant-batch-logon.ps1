# Grants ONLY "Log on as a batch job" (SeBatchLogonRight) to the service account, so the
# scheduled tasks can run while nobody is logged on. Run once in an elevated administrator
# PowerShell. All other user rights are verified unchanged. Evidence goes to a new directory.
param(
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [Parameter(Mandatory = $true)][string]$EvidenceDir
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'srvpro-service.lib.ps1')
Assert-SrvproElevatedAdmin
$cfg = Read-SrvproServiceConfig $ConfigPath
$user = Get-SrvproServiceUser $cfg
$sid = $user.SID.Value
Assert-SrvproSafePath $EvidenceDir 'EvidenceDir'
if (Test-Path -LiteralPath $EvidenceDir) { throw 'EvidenceDir already exists; choose a new directory' }
New-Item -ItemType Directory -Path $EvidenceDir | Out-Null

$secedit = Join-Path $env:SystemRoot 'System32\secedit.exe'
$before = Join-Path $EvidenceDir 'rights-before.inf'
& $secedit /export /cfg $before /areas USER_RIGHTS /quiet | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Policy export failed' }
$lines = [IO.File]::ReadAllLines($before)
if ((Get-SrvproRightSids $lines 'SeDenyBatchLogonRight') -contains $sid) { throw 'The account is in "Deny log on as a batch job"; review that policy first' }
$current = @(Get-SrvproRightSids $lines 'SeBatchLogonRight')
if ($current | Where-Object { $_ -like 'UNRESOLVED:*' }) { throw 'Existing batch logon entries could not be resolved; review manually' }
if ($current -contains $sid) { Write-Output 'Already granted; nothing changed'; return }

$entries = @($current | ForEach-Object { '*' + $_ }) + @('*' + $sid)
$policy = @('[Unicode]','Unicode=yes','[Version]','signature="$CHICAGO$"','Revision=1','[Privilege Rights]',
  ('SeBatchLogonRight = ' + ($entries -join ','))) -join "`r`n"
$inf = Join-Path $EvidenceDir 'batch-grant.inf'
[IO.File]::WriteAllText($inf, $policy, [Text.Encoding]::Unicode)
& $secedit /configure /db (Join-Path $EvidenceDir 'batch-grant.sdb') /cfg $inf /areas USER_RIGHTS /log (Join-Path $EvidenceDir 'batch-grant.log') /quiet | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Batch logon grant failed; see batch-grant.log' }

$afterFile = Join-Path $EvidenceDir 'rights-after.inf'
& $secedit /export /cfg $afterFile /areas USER_RIGHTS /quiet | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Policy re-export failed' }
$after = [IO.File]::ReadAllLines($afterFile)
$expected = @($current + $sid | Sort-Object -Unique)
$actual = @(Get-SrvproRightSids $after 'SeBatchLogonRight' | Sort-Object -Unique)
if (-not (Test-SrvproSameSet $expected $actual)) { throw 'Batch logon membership differs from the expected set' }
foreach ($line in @($lines + $after | Where-Object { $_ -match '^Se\w+\s*=' } | ForEach-Object { ($_ -split '=', 2)[0].Trim() } | Sort-Object -Unique)) {
  if ($line -eq 'SeBatchLogonRight') { continue }
  if (-not (Test-SrvproSameSet (Get-SrvproRightSids $lines $line) (Get-SrvproRightSids $after $line))) { throw ('Unexpected change to user right ' + $line) }
}
Write-Output ('Granted SeBatchLogonRight to ' + $cfg.serviceAccount + '; other user rights unchanged. Evidence: ' + $EvidenceDir)
