[CmdletBinding()]
param(
    [string]$Workspace = ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\server-release-monitor'))),
    [switch]$Once,
    [switch]$Preflight,
    [switch]$RemotePreflight,
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$Host.UI.RawUI.WindowTitle = 'SRVPro 服务器发布监控（本机）'
$resultCode = 1
Write-Host 'SRVPro 本机发布监控：处理明确排队的后端、模板、官网与天梯助手批次。' -ForegroundColor Cyan
Write-Host '按清单执行模板重分类或公告频道维护通知；预检不会停服、改库或发消息。'
Write-Host '默认持续观察空房；请保持本窗口打开，并避免电脑休眠。'
Write-Host 'Ctrl+C 或关闭窗口只停止本机等待；已启动的服务器协调进程会独立收尾。'

try {
    $monitorArgs = @((Join-Path $PSScriptRoot 'monitor.cjs'), '--workspace', ([IO.Path]::GetFullPath($Workspace)))
    if ($Once) { $monitorArgs += '--once' }
    if ($Preflight) { $monitorArgs += '--preflight' }
    if ($RemotePreflight) { $monitorArgs += '--remote-preflight' }
    & node.exe @monitorArgs
    $resultCode = $LASTEXITCODE
    if ($resultCode -ne 0) {
        Write-Host '监控已停止，请保留回执并恢复 Codex 会话核对；不要重复点击尝试触发。' -ForegroundColor Yellow
    }
} catch {
    Write-Host ('监控未能启动：' + $_.Exception.Message) -ForegroundColor Red
} finally {
    Write-Host ('本机监控已结束。回执目录以 config.json 的 stateDir 为准：' + $Workspace) -ForegroundColor Cyan
    Write-Host '服务器协调进程的完成状态以该批次回执为准。'
    if (!$NoPause) { [void](Read-Host '按 Enter 关闭本窗口') }
}
exit $resultCode
