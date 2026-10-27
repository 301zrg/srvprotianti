param([Parameter(Mandatory=$true)][string]$Batch)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (-not [IO.Path]::IsPathRooted($Batch) -or $Batch -match '["\r\n\x00]' -or $Batch.StartsWith('\\')) { throw 'batch_invalid' }
$batchPath = [IO.Path]::GetFullPath($Batch).TrimEnd('\','/')
if ([IO.Path]::GetFileName($batchPath) -notmatch '^[a-z0-9][a-z0-9-]{0,79}$') { throw 'batch_invalid' }

function Test-CoordinatorProcess($TargetPid, $StartStamp) {
    if (-not $TargetPid -or -not $StartStamp) { return $false }
    try {
        $process = Get-Process -Id ([int]$TargetPid) -ErrorAction SilentlyContinue
        if (-not $process -or $process.ProcessName -ne 'node') { return $false }
        $expected = [DateTimeOffset]::Parse([string]$StartStamp).UtcDateTime
        return [math]::Abs(($process.StartTime.ToUniversalTime() - $expected).TotalMilliseconds) -lt 100
    } catch { return $false }
}

$stateFile = Join-Path $batchPath 'state.json'
$lockFile = Join-Path ([IO.Path]::GetDirectoryName($batchPath)) 'coordinator.lock'
$stateExists = Test-Path -LiteralPath $stateFile
$lockExists = Test-Path -LiteralPath $lockFile
$state = $null
$lock = $null
if ($stateExists) { $state = [IO.File]::ReadAllText($stateFile) | ConvertFrom-Json }
if ($lockExists) { $lock = [IO.File]::ReadAllText($lockFile) | ConvertFrom-Json }
$manifestFile = Join-Path $batchPath 'manifest.json'
$manifestSha256 = $null
if (Test-Path -LiteralPath $manifestFile) { $manifestSha256 = (Get-FileHash -LiteralPath $manifestFile -Algorithm SHA256).Hash.ToLowerInvariant() }
if ($stateExists -and (-not $state.manifestSha256 -or $state.manifestSha256 -cne $manifestSha256)) { throw 'manifest_receipt_mismatch' }
@{
    stateExists = [bool]$stateExists
    state = $state
    manifestSha256 = $manifestSha256
    coordinatorRunning = (Test-CoordinatorProcess $state.coordinatorPid $state.processStartedAt)
    lockExists = [bool]$lockExists
    lockJobId = $lock.jobId
    lockCoordinatorRunning = (Test-CoordinatorProcess $lock.pid $lock.processStartedAt)
} | ConvertTo-Json -Depth 16 -Compress
