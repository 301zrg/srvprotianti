# Stage 10: machine identity and handover verification (manual section 1). ASCII only.
Set-StrictMode -Version 2.0

function Test-ExistingPm2 {
  $existing = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'pm2|Daemon.js' }
  if ($existing) { return $true }
  return ([IO.Directory]::GetFiles('\\.\pipe\') -contains '\\.\pipe\rpc.sock')
}

# Manual 1, environment check block (machine part). Runs again on every stage-10 entry.
function R10-Machine {
  if ($env:COMPUTERNAME -ne $script:Params.expectedHost) { Stop-Install ('This machine is ' + $env:COMPUTERNAME + ', parameters expect ' + $script:Params.expectedHost) }
  $model = (Get-CimInstance Win32_ComputerSystem).Model
  if ($script:Params.labVm -and $model -notmatch 'Virtual|VMware|KVM') { Stop-Install ('labVm=true but this is not a VM (' + $model + ')') }
  if (-not $script:Params.labVm) {
    Confirm-Checkpoint ('labVm=false: this run installs on a real server (' + $env:COMPUTERNAME + ', ' + $model + ').') 'REAL SERVER'
  }
  $first = -not (Test-BlockDone 'R51-START')
  if ($first -and (Test-ExistingPm2)) { Stop-Install 'A PM2 daemon or its pipe already exists on this machine; do not install here' }
}

# Manual 1, handover check block. The list's own size and SHA come from an independent channel.
function R10-Handover {
  $list = $script:L.Input + '\handover-sha256.txt'
  if (-not (Test-Path -LiteralPath $list -PathType Leaf)) { Stop-Install ('Missing ' + $list) }
  $item = Get-Item -LiteralPath $list
  $sha = (Get-FileHash -LiteralPath $list -Algorithm SHA256).Hash
  Write-Host ('handover-sha256.txt: bytes=' + $item.Length + ' sha256=' + $sha)
  $expected = Read-Host 'Paste the handover list SHA-256 you received separately'
  if ($expected.Trim().ToUpperInvariant() -ne $sha) { Stop-Install 'The handover list does not match the value you received; stop' }
  $seen = @{}
  $bad = 0
  foreach ($line in Get-Content -LiteralPath $list -Encoding UTF8) {
    if ($line -match '^\s*(#|$)') { continue }
    $f = $line -split "`t"
    if ($f.Count -ne 3) { Stop-Install ('Malformed handover line: ' + $line) }
    $rel = $f[0]
    if ($rel -match '^[\\/]|:|(^|[\\/])\.\.?([\\/]|$)') { Stop-Install ('Handover path not allowed: ' + $rel) }
    if ($seen.ContainsKey($rel.ToLowerInvariant())) { Stop-Install ('Duplicate handover path: ' + $rel) }
    $seen[$rel.ToLowerInvariant()] = $true
    $path = Join-Path $script:L.Input $rel
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Write-Step ('MISSING   ' + $rel); $bad++; continue }
    $fi = Get-Item -LiteralPath $path -Force
    if ($fi.Attributes -band [IO.FileAttributes]::ReparsePoint) { Stop-Install ('Handover file is a link: ' + $rel) }
    $h = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    if ($fi.Length -eq [int64]$f[1] -and $h -eq $f[2].ToUpperInvariant()) { Write-Step ('OK        ' + $rel) } else { Write-Step ('MISMATCH  ' + $rel); $bad++ }
  }
  foreach ($must in @('server-release.tar.gz', 'server-release.tar.gz.manifest.json', 'ops-input.zip', 'install-params.json',
      'pm2-lock\package.json', 'pm2-lock\package-lock.json', 'node-v24.15.0-x64.msi', 'python-3.14.10-amd64.exe',
      'Git-2.56.1-64-bit.exe', 'postgresql-17.12-1-windows-x64.exe')) {
    if (-not $seen.ContainsKey($must.ToLowerInvariant())) { Stop-Install ('Handover list lacks ' + $must) }
  }
  if ($script:Params.route -eq 'A' -and -not $seen.ContainsKey('windows.server.config.json')) { Stop-Install 'Route A handover lacks windows.server.config.json' }
  if ($script:Params.route -eq 'B' -and -not $seen.ContainsKey($script:Params.batch.zip.ToLowerInvariant())) { Stop-Install 'Route B handover lacks the joint batch ZIP' }
  if ($bad) { Stop-Install ([string]$bad + ' file(s) missing or different; get them again') }
  Set-StateProperty $script:State 'handoverSha256' $sha
  Save-InstallState
}

function R10-Confirm {
  $p = $script:Params
  $text = "Install parameters:`n  machine=" + $p.expectedHost + ' route=' + $p.route + ' root=' + $p.root + "`n  database=" + $p.database +
    ' httpPort=' + $p.httpPort + ' listenPorts=' + (@($p.listenPorts) -join ',') + "`n  maintenance message: " + $p.maintenanceMessage
  Confirm-Checkpoint $text
}

Register-Block 'R10-MACHINE' '10' 'read' '1 check block' { R10-Machine } $null
Register-Block 'R10-HANDOVER' '10' 'read' '1 handover check' { R10-Handover } $null
Register-Block 'R10-CONFIRM' '10' 'read' '1 parameter page' { R10-Confirm } $null
