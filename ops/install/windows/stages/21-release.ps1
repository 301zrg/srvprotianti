# Stages 21 and 23: release verification, unpack, build and tests (manual section 2). ASCII only.
Set-StrictMode -Version 2.0

function Get-OpsPy { return ($script:L.Input + '\ops\scripts\ops.py') }
function Get-ReleaseArchive { return ($script:L.Input + '\server-release.tar.gz') }

function R21-Verify {
  Invoke-NativeLive 'python' @((Get-OpsPy), 'verify-release', '--archive', (Get-ReleaseArchive)) 'verify-release'
}

function R21-Unpack {
  if (-not (Test-Path -LiteralPath $script:L.Root)) { New-Item -ItemType Directory -Path $script:L.Root | Out-Null }
  Invoke-NativeLive 'python' @((Get-OpsPy), 'unpack-release', '--archive', (Get-ReleaseArchive), '--destination', $script:L.Release) 'unpack-release'
}
function V21-Unpack {
  if (-not (Test-Path -LiteralPath $script:L.Release)) { return 10 }
  if ((Test-Path -LiteralPath ($script:L.App + '\package.json')) -and (Test-Path -LiteralPath ($script:L.Release + '\components\engine'))) { return 0 }
  return 20
}

function R21-Resources {
  $App = $script:L.App
  if ((Test-Path "$App\ygopro") -or (Test-Path "$App\plugins\card-catalog\databases")) { Stop-Install 'Existing resource target' }
  Copy-Item -LiteralPath ($script:L.Release + '\components\engine') -Destination "$App\ygopro" -Recurse
  Copy-Item -LiteralPath ($script:L.Release + '\components\catalog') -Destination "$App\plugins\card-catalog\databases" -Recurse
}
function V21-Resources {
  $App = $script:L.App
  $e = Test-Path "$App\ygopro\ygopro.exe"
  $c = Test-Path "$App\plugins\card-catalog\databases\cards.zh.cdb"
  if (-not (Test-Path "$App\ygopro") -and -not (Test-Path "$App\plugins\card-catalog\databases")) { return 10 }
  if ($e -and $c) { return 0 }
  return 20
}

function Invoke-InApp([string]$Exe, [string[]]$Arguments, [string]$What) {
  Push-Location -LiteralPath $script:L.App
  try { Invoke-NativeLive $Exe $Arguments $What } finally { Pop-Location }
}

function R23-NpmCi { Invoke-InApp 'npm.cmd' @('ci') 'npm ci' }
function R23-Build { Invoke-InApp 'npm.cmd' @('run', 'build') 'npm run build' }
function R23-Catalog { Invoke-InApp 'python' @('ops/scripts/ops.py', 'catalog-check', '--catalog', 'plugins/card-catalog/databases', '--versions', 'ops/versions.json') 'catalog-check' }
function R23-Test { Invoke-InApp 'npm.cmd' @('test') 'npm test' }
function R23-Preflight { Invoke-InApp 'python' @('ops/scripts/ops.py', 'preflight', '--platform', 'windows', '--application', '.', '--engine', 'ygopro', '--catalog', 'plugins/card-catalog/databases', '--versions', 'ops/versions.json') 'preflight' }

Register-Block 'R21-VERIFY' '21' 'read' '2 verify-release' { R21-Verify } $null
Register-Block 'R21-UNPACK' '21' 'first' '2 unpack-release' { R21-Unpack } { V21-Unpack }
Register-Block 'R21-RESOURCES' '21' 'first' '2 copy engine and catalog' { R21-Resources } { V21-Resources }
Register-Block 'R23-NPMCI' '23' 'idempotent' '2 npm ci' { R23-NpmCi } $null
Register-Block 'R23-BUILD' '23' 'idempotent' '2 npm run build' { R23-Build } $null
Register-Block 'R23-CATALOG' '23' 'read' '2 catalog-check' { R23-Catalog } $null
Register-Block 'R23-TEST' '23' 'read' '2 npm test' { R23-Test } $null
Register-Block 'R23-PREFLIGHT' '23' 'read' '2 preflight' { R23-Preflight } $null
