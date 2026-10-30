param(
 [Parameter(Mandatory=$true)][string]$Pm2Command,
 [Parameter(Mandatory=$true)][string]$Pm2Home
)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$bot=Split-Path -Parent $PSScriptRoot;$root=Split-Path -Parent $bot
$ecosystem=Join-Path $root 'ecosystem.discord.config.js'
if(-not (Test-Path -LiteralPath $ecosystem) -or -not (Test-Path -LiteralPath $Pm2Command)){throw 'Missing reviewed PM2 deployment'}
[IO.Directory]::CreateDirectory((Join-Path $bot 'logs'))|Out-Null
$env:PM2_HOME=$Pm2Home
$env:PATH='C:\Program Files\nodejs;'+$env:PATH
$node=(Get-Command node.exe).Source
foreach($name in @('discord-proxy','discord-bot')){
 $raw=&$Pm2Command jlist
 if($LASTEXITCODE -ne 0){throw 'PM2 inspection failed'}
 $safe=$raw|&$node (Join-Path $PSScriptRoot 'pm2-state.cjs')
 if($LASTEXITCODE -ne 0){throw 'PM2 metadata projection failed'}
 # Windows PowerShell 5.1 emits a JSON array as one pipeline item; assign it
 # before filtering so a nested array cannot hide already-running workers.
 $apps=ConvertFrom-Json -InputObject ($safe -join "`n")
 $app=@($apps|Where-Object name -eq $name)
 $expected=if($name -eq 'discord-proxy'){Join-Path $root 'discord-proxy\clash-win64.exe'}else{Join-Path $bot 'src\index.mjs'}
 if($app.Count -gt 1 -or ($app.Count -eq 1 -and [IO.Path]::GetFullPath($app[0].script) -ne [IO.Path]::GetFullPath($expected))){throw 'Existing PM2 name belongs to another deployment'}
 # A startup task may run after another PM2 boot mechanism: leave online workers alone.
 if($app.Count -eq 1 -and $app[0].status -eq 'online'){continue}
 $output=&$Pm2Command start $ecosystem --only $name 2>&1;$code=$LASTEXITCODE
 [IO.File]::AppendAllText((Join-Path $bot 'logs\pm2-startup.log'),([DateTime]::UtcNow.ToString('o')+"`n"+($output -join "`n")+"`n"))
 if($code -ne 0){throw 'Discord deployment startup failed; protected log retained'}
}
