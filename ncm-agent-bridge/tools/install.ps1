#Requires -Version 5.1
<#
.SYNOPSIS
    安装 / 打包 / 卸载 NCM Agent Bridge 插件，并准备好通信目录。

.PARAMETER Mode
    dev    —— 安装到 <BetterNCM>\plugins_dev\ncm-agent-bridge（开发模式，改文件自动重载，推荐）
    packed —— 打包成 <BetterNCM>\plugins\NCM-AgentBridge-1.0.0.plugin（正式安装）
    both   —— 两种都生成（注意：两个同名插件只会加载一个，一般不要用）

.PARAMETER Restart
    安装后重启网易云音乐，让插件加载。

.EXAMPLE
    .\install.ps1                # 安装到 plugins_dev 并创建通信目录
    .\install.ps1 -Restart       # 安装并重启网易云
    .\install.ps1 -Mode packed   # 打包成 .plugin
#>
[CmdletBinding()]
param(
    [ValidateSet('dev', 'packed', 'both')][string]$Mode = 'dev',
    [switch]$Restart,
    [switch]$Uninstall,
    [string]$BetterNcmPath = 'C:\betterncm'
)

$ErrorActionPreference = 'Stop'
$pluginSrc = Join-Path (Split-Path -Parent $PSScriptRoot) 'plugin'
if (-not (Test-Path (Join-Path $pluginSrc 'manifest.json'))) { throw "找不到插件源目录: $pluginSrc" }

$manifest = Get-Content -LiteralPath (Join-Path $pluginSrc 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$slug = $manifest.slug
$version = $manifest.version

$devDir = Join-Path $BetterNcmPath "plugins_dev\$slug"
$packDir = Join-Path $BetterNcmPath 'plugins'
$packName = "NCM-AgentBridge-$version.plugin"
$packPath = Join-Path $packDir $packName
$dataDir = Join-Path $BetterNcmPath 'AgentBridge'

function Ensure-Dir([string]$p) { if (-not (Test-Path -LiteralPath $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null } }

if ($Uninstall) {
    if (Test-Path $devDir) { Remove-Item -LiteralPath $devDir -Recurse -Force; Write-Host "已删除 $devDir" }
    if (Test-Path $packPath) { Remove-Item -LiteralPath $packPath -Force; Write-Host "已删除 $packPath" }
    Write-Host '通信目录保留：' $dataDir
    exit 0
}

Ensure-Dir $dataDir
Ensure-Dir (Join-Path $dataDir 'inbox')
Ensure-Dir (Join-Path $dataDir 'outbox')

if ($Mode -in @('dev', 'both')) {
    if (Test-Path $packPath) { Write-Host "⚠ 已存在 $packPath，若同时加载会因 slug 重复而只生效一个。" -ForegroundColor Yellow }
    Ensure-Dir $devDir
    # 注意：不要删除目录本身，否则 BetterNCM 的 watchDirectory 句柄会失效，自动重载就不工作了
    Copy-Item -Path (Join-Path $pluginSrc '*') -Destination $devDir -Recurse -Force
    Write-Host "✓ 已安装到 $devDir" -ForegroundColor Green
}

if ($Mode -in @('packed', 'both')) {
    if (Test-Path $devDir) { Write-Host "⚠ 已存在 $devDir，若同时加载会因 slug 重复而只生效一个。" -ForegroundColor Yellow }
    Ensure-Dir $packDir
    $tmp = Join-Path $env:TEMP ("ncm-agent-bridge-" + [guid]::NewGuid().ToString('N') + '.zip')
    if (Test-Path $tmp) { Remove-Item $tmp -Force }
    Compress-Archive -Path (Join-Path $pluginSrc '*') -DestinationPath $tmp -CompressionLevel Optimal
    if (Test-Path $packPath) { Remove-Item $packPath -Force }
    Move-Item -LiteralPath $tmp -Destination $packPath -Force
    Write-Host "✓ 已打包 $packPath" -ForegroundColor Green
}

Write-Host ''
Write-Host '通信目录：' $dataDir
Write-Host '  命令目录 inbox   结果目录 outbox   状态文件 status.json'
Write-Host ''
Write-Host '下一步：' -ForegroundColor Cyan
if ($Restart) {
    $exe = 'D:\Program Files\NetEase\CloudMusic\cloudmusic.exe'
    $running = Get-Process cloudmusic -ErrorAction SilentlyContinue
    if ($running) {
        Write-Host '  正在重启网易云音乐...'
        $running | Stop-Process -Force
        Start-Sleep -Seconds 2
    }
    if (-not (Test-Path $exe)) { throw "找不到网易云音乐: $exe" }
    Start-Process -FilePath $exe
    Write-Host '  已启动，等待插件加载...'
} else {
    Write-Host '  重启一次网易云音乐（或在 BetterNCM 插件管理里点「重载插件」）让插件生效，'
    Write-Host '  然后运行：  .\tools\ncm.ps1 status'
}
