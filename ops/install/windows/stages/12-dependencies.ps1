# Stage 12: installers for Node, Python, Git and PostgreSQL (manual section 1). ASCII only.
Set-StrictMode -Version 2.0

$script:Installers = [ordered]@{
  Node = 'node-v24.15.0-x64.msi'
  Python = 'python-3.14.10-amd64.exe'
  Git = 'Git-2.56.1-64-bit.exe'
  PostgreSQL = 'postgresql-17.12-1-windows-x64.exe'
}

function Invoke-Installer([string]$Exe, [string]$Arguments, [string]$Name) {
  $p = Start-Process -FilePath $Exe -ArgumentList $Arguments -WindowStyle Hidden -Wait -PassThru
  if ($p.ExitCode -ne 0) { Stop-Install ($Name + ' installer exit ' + $p.ExitCode) }
  Write-Step ($Name + ' installed')
}

function R12-Bootdir { New-PrivateDirectory $script:L.Boot }
function V12-Bootdir {
  if (-not (Test-Path -LiteralPath $script:L.Boot)) { return 10 }
  if (Test-PrivateDirectory $script:L.Boot) { return 0 }
  return 20
}

function R12-Signatures {
  foreach ($f in $script:Installers.Values) {
    $path = $script:L.Input + '\' + $f
    if (-not (Test-Path -LiteralPath $path)) { Stop-Install ('Missing installer: ' + $f) }
    if ((Get-AuthenticodeSignature -LiteralPath $path).Status -ne 'Valid') { Stop-Install ('Invalid signature: ' + $f) }
  }
}

function R12-Node {
  Invoke-Installer "$env:WINDIR\System32\msiexec.exe" ('/i ' + $script:L.Input + '\' + $script:Installers.Node + ' /qn /norestart /l*v ' + $script:L.Boot + '\node-install.log') 'Node'
}
function V12-Node {
  $exe = 'C:\Program Files\nodejs\node.exe'
  if (-not (Test-Path -LiteralPath $exe)) { return 10 }
  if ((Get-Item -LiteralPath $exe).VersionInfo.ProductVersion -match '^24\.15\.0') { return 0 }
  return 20
}

function R12-Python {
  Invoke-Installer ($script:L.Input + '\' + $script:Installers.Python) ('/quiet InstallAllUsers=1 PrependPath=1 Include_test=0 Include_doc=0 TargetDir=C:\Python314 /log ' + $script:L.Boot + '\python-install.log') 'Python'
}
function V12-Python {
  if (-not (Test-Path -LiteralPath 'C:\Python314')) { return 10 }
  if (Test-Path -LiteralPath 'C:\Python314\python.exe') { return 0 }
  return 20
}

function R12-Git {
  Invoke-Installer ($script:L.Input + '\' + $script:Installers.Git) ('/VERYSILENT /NORESTART /SP- /LOG=' + $script:L.Boot + '\git-install.log') 'Git'
}
function V12-Git {
  if (-not (Test-Path -LiteralPath 'C:\Program Files\Git')) { return 10 }
  if (Test-Path -LiteralPath 'C:\Program Files\Git\cmd\git.exe') { return 0 }
  return 20
}

# The password only exists in memory and in the bootstrap option file for the installer run.
function R12-Postgres {
  $password = Read-NewSecret 'PostgreSQL postgres password' { param($v) Test-PostgresPasswordRule $v }
  $optionFile = $script:L.Boot + '\pg-options.txt'
  try {
    $options = @('mode=unattended', 'unattendedmodeui=none', 'prefix=C:\Program Files\PostgreSQL\17',
      'datadir=C:\Program Files\PostgreSQL\17\data', 'serverport=5432', 'servicename=postgresql-x64-17',
      'enable-components=server,commandlinetools', 'disable-components=pgAdmin,stackbuilder',
      'locale=C', ('superpassword=' + $password), 'debuglevel=0')
    [IO.File]::WriteAllLines($optionFile, $options, (New-Object Text.UTF8Encoding $false))
    Invoke-Installer ($script:L.Input + '\' + $script:Installers.PostgreSQL) ('--optionfile ' + $optionFile) 'PostgreSQL'
    $script:PgSuper = $password
  } finally {
    Remove-Item -LiteralPath $optionFile -Force -ErrorAction SilentlyContinue
    $password = $null
    $options = $null
  }
}
function V12-Postgres {
  $svc = Get-Service postgresql-x64-17 -ErrorAction SilentlyContinue
  if (-not $svc -and -not (Test-Path -LiteralPath 'C:\Program Files\PostgreSQL\17')) { return 10 }
  if ($svc -and (Test-Path -LiteralPath ($script:PgBin + '\psql.exe'))) { return 0 }
  return 20
}

function R12-Environment {
  Update-ProcessPath
  $node = (& node --version); if ($LASTEXITCODE -ne 0) { Stop-Install 'node --version failed' }
  $python = (& python --version); if ($LASTEXITCODE -ne 0) { Stop-Install 'python --version failed' }
  $lfs = (& git lfs version); if ($LASTEXITCODE -ne 0 -or $lfs -notmatch '^git-lfs/') { Stop-Install 'Git LFS is missing' }
  $psql = (& (Get-PsqlExe) --version); if ($LASTEXITCODE -ne 0) { Stop-Install 'psql --version failed' }
  Write-Step ('node ' + $node + '; ' + $python + '; ' + $lfs + '; ' + $psql)
  if ($node -notmatch '^v24\.') { Stop-Install 'Node 24 is required' }
  if ($python -notmatch '^Python 3\.(1[2-9]|[2-9][0-9])') { Stop-Install 'Python 3.12+ is required' }
  if ($psql -notmatch '\) 17\.') { Stop-Install 'PostgreSQL 17 client is required' }
  $svc = Get-Service postgresql-x64-17
  if ($svc.Status -ne 'Running') { Stop-Install 'postgresql-x64-17 is not running' }
  if ($svc.StartType -ne 'Automatic') { Stop-Install 'postgresql-x64-17 must start automatically' }
  if (-not (Test-SuperPassword (Get-SuperPassword))) { Stop-Install 'postgres login failed' }
}

Register-Block 'R12-BOOTDIR' '12' 'first' '1 install block (bootstrap dir)' { R12-Bootdir } { V12-Bootdir }
Register-Block 'R12-SIGNATURES' '12' 'read' '1 install block (signatures)' { R12-Signatures } $null
Register-Block 'R12-NODE' '12' 'first' '1 install block (Node)' { R12-Node } { V12-Node }
Register-Block 'R12-PYTHON' '12' 'first' '1 install block (Python)' { R12-Python } { V12-Python }
Register-Block 'R12-GIT' '12' 'first' '1 install block (Git)' { R12-Git } { V12-Git }
Register-Block 'R12-POSTGRES' '12' 'first' '1 install block (PostgreSQL)' { R12-Postgres } { V12-Postgres }
Register-Block 'R12-ENV' '12' 'read' '1 check block' { R12-Environment } $null
