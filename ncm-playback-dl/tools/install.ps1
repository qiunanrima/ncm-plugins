#Requires -Version 5.1
<#
.SYNOPSIS
    安装 NCM Playback DL 插件（下载走播放接口）。

.EXAMPLE
    .\install.ps1 -Restart
#>
[CmdletBinding()]
param(
    [switch]$Restart,
    [string]$BetterNcmPath = 'C:\betterncm',
    [string]$CloudMusicExe = 'D:\Program Files\NetEase\CloudMusic\cloudmusic.exe'
)

$ErrorActionPreference = 'Stop'
$pluginSrc = Join-Path (Split-Path -Parent $PSScriptRoot) 'plugin'
if (-not (Test-Path (Join-Path $pluginSrc 'manifest.json'))) { throw "找不到插件源目录: $pluginSrc" }
$manifest = Get-Content (Join-Path $pluginSrc 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$devDir = Join-Path $BetterNcmPath ("plugins_dev\" + $manifest.slug)
$dataDir = Join-Path $BetterNcmPath 'PlaybackDL'

if (-not (Test-Path $devDir)) { New-Item -ItemType Directory -Path $devDir -Force | Out-Null }
Copy-Item -Path (Join-Path $pluginSrc '*') -Destination $devDir -Recurse -Force
foreach ($d in @($dataDir, (Join-Path $dataDir 'inbox'), (Join-Path $dataDir 'outbox'))) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
Write-Host "✓ 已安装到 $devDir" -ForegroundColor Green
Write-Host "  数据目录：$dataDir"

if ($Restart) {
    $p = Get-Process cloudmusic -ErrorAction SilentlyContinue
    if ($p) { $p | Stop-Process -Force; Start-Sleep -Seconds 2 }
    if (-not (Test-Path $CloudMusicExe)) { throw "找不到网易云: $CloudMusicExe" }
    Start-Process -FilePath $CloudMusicExe
    Write-Host '  已重启网易云，等待插件加载…' -ForegroundColor Yellow
} else {
    Write-Host '下一步：重启网易云（或 BetterNCM → 重载插件）后再运行 tools\ncmdl.ps1 fetch -Id <id>'
}
