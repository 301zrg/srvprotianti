param([Parameter(Mandatory=$true)][string]$Batch)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (-not [IO.Path]::IsPathRooted($Batch) -or $Batch -match '["\r\n\x00]' -or $Batch.StartsWith('\\')) { throw 'batch_invalid' }
$batchPath = [IO.Path]::GetFullPath($Batch).TrimEnd('\','/')
if ([IO.Path]::GetFileName($batchPath) -notmatch '^[a-z0-9][a-z0-9-]{0,79}$') { throw 'batch_invalid' }
$stateFile = Join-Path $batchPath 'state.json'
$lockFile = Join-Path ([IO.Path]::GetDirectoryName($batchPath)) 'coordinator.lock'
if (Test-Path -LiteralPath $lockFile) { throw 'global_lock_exists' }
if (Test-Path -LiteralPath $stateFile) {
    $state = [IO.File]::ReadAllText($stateFile) | ConvertFrom-Json
    if ($state.stage -ne 'FINISHED' -or $state.outcome -ne 'WAITING') { throw 'batch_already_attempted' }
    if (-not $state.coordinatorPid -or -not $state.processStartedAt) { throw 'prior_identity_invalid' }
    $process = Get-Process -Id ([int]$state.coordinatorPid) -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -eq 'node') {
        $difference = [math]::Abs(($process.StartTime.ToUniversalTime() - ([DateTimeOffset]::Parse($state.processStartedAt).UtcDateTime)).TotalMilliseconds)
        if ($difference -lt 100) { throw 'prior_coordinator_running' }
    }
}
$coordinator = Join-Path $batchPath 'server-coordinator.cjs'
if (-not (Test-Path -LiteralPath $coordinator)) { throw 'coordinator_missing' }
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
if ($nodePath -match '["\r\n\x00]') { throw 'node_path_invalid' }

# WMI breakaway survives the Windows OpenSSH job and registers no service/task.
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0;CreateFlags=[uint32]0x01000000}
$commandLine = '"' + $nodePath + '" "' + $coordinator + '" --batch "' + $batchPath + '"'
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$commandLine;CurrentDirectory=$batchPath;ProcessStartupInformation=$startup}
if ($result.ReturnValue -ne 0) { throw 'independent_launch_failed' }

# An uncertain trigger is reconciled by reads only; never launch a second copy.
$receiptReady = $false
$receipt = $null
$deadline = [DateTime]::UtcNow.AddSeconds(8)
while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $stateFile) {
        $candidate = [IO.File]::ReadAllText($stateFile) | ConvertFrom-Json
        if ($candidate.coordinatorPid -eq $result.ProcessId -and $candidate.startedAt -and $candidate.processStartedAt) {
            $receiptReady = $true
            $receipt = $candidate
            break
        }
    }
    Start-Sleep -Milliseconds 100
}
@{launched=$true;coordinatorPid=$result.ProcessId;stateFile=$stateFile;launcher='WMI_BREAKAWAY';receiptReady=$receiptReady;startedAt=$receipt.startedAt;processStartedAt=$receipt.processStartedAt} | ConvertTo-Json -Compress
