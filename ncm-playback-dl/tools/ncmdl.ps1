#Requires -Version 5.1
<#
.SYNOPSIS
    NCM Playback DL 命令行客户端 —— 用“播放接口”下载歌曲。

.EXAMPLE
    .\ncmdl.ps1 fetch -Id 2049541052 -Level exhigh
    .\ncmdl.ps1 url   -Id 2049541052
    .\ncmdl.ps1 song  -Id 2049541052
    .\ncmdl.ps1 current -Level lossless
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Command = 'ping',
    [Parameter(Position = 1)][string]$Arg1 = '',
    [string]$Id,
    [string]$Level = 'exhigh',
    [string]$Dir,
    [string]$Text,
    [int]$Limit = 5,
    [int]$Offset = 0,
    [int]$Page = 0,
    [int]$DelayMs = 1200,
    [int]$Type = 0,
    [string]$Out,
    [string]$IdsFile,
    [int]$PlaylistLimit = 0,
    [double]$To = [double]::NaN,
    [switch]$Force,
    [int]$TimeoutMs = 240000,
    [switch]$Raw,
    [switch]$Keep
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$root = if ($env:NCM_PLAYBACK_DL_ROOT) { $env:NCM_PLAYBACK_DL_ROOT } else { 'C:\betterncm\PlaybackDL' }
$inbox = Join-Path $root 'inbox'
$outbox = Join-Path $root 'outbox'

function Read-JsonFile([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try {
        $txt = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
        if ([string]::IsNullOrWhiteSpace($txt)) { return $null }
        return $txt | ConvertFrom-Json
    } catch { return $null }
}

function Write-JsonFile([string]$path, $obj) {
    [System.IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Depth 20 -Compress), $utf8)
}

function Invoke-Bridge {
    param([string]$Op, [hashtable]$OpArgs = @{}, [int]$Timeout = 240000)
    if (-not (Test-Path $inbox)) {
        New-Item -ItemType Directory -Path $inbox -Force | Out-Null
        New-Item -ItemType Directory -Path $outbox -Force | Out-Null
    }
    $suffix = -join ((1..6) | ForEach-Object { '0123456789abcdef'[(Get-Random -Maximum 16)] })
    $cmdId = '{0}-{1}' -f ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()), $suffix
    Write-JsonFile (Join-Path $inbox ($cmdId + '.json')) ([ordered]@{
            id = $cmdId; op = $Op; args = $OpArgs; ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); timeoutMs = $Timeout
        })
    $resPath = Join-Path $outbox ($cmdId + '.res.json')
    $deadline = (Get-Date).AddMilliseconds($Timeout + 8000)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $resPath) {
            $res = Read-JsonFile $resPath
            if (-not $Keep) { Remove-Item -LiteralPath $resPath -Force -ErrorAction SilentlyContinue }
            if ($null -eq $res) { Start-Sleep -Milliseconds 80; continue }
            return $res
        }
        Start-Sleep -Milliseconds 80
    }
    return $null
}

function Show-Hint {
    Write-Host ''
    Write-Host 'PlaybackDL 插件没有响应。检查：' -ForegroundColor Yellow
    Write-Host '  1. 网易云在运行，且 BetterNCM 里能看到 "NCM Playback DL"；'
    Write-Host '  2. 新装插件需要重启一次网易云（或点重载插件）；'
    $err = Join-Path $root 'plugin-error.json'
    if (Test-Path $err) { Write-Host ([System.IO.File]::ReadAllText($err, [System.Text.Encoding]::UTF8)) -ForegroundColor Red }
    Write-Host ''
}

$op = $Command
$opArgs = @{}
switch ($Command.ToLowerInvariant()) {
    'ping' { $op = 'ping' }
    'song' { $op = 'song'; $opArgs = @{ id = $Id } }
    'url' { $op = 'url'; $opArgs = @{ id = $Id; level = $Level } }
    'fetch' { $op = 'fetch'; $opArgs = @{ id = $Id; level = $Level }; if ($Dir) { $opArgs['dir'] = $Dir } }
    'current' { $op = 'fetch_current'; $opArgs = @{ level = $Level }; if ($Dir) { $opArgs['dir'] = $Dir } }
    'queue' { $op = 'queue'; $opArgs = @{ limit = $Limit }; if ($Page -gt 0) { $opArgs['page'] = $Page } }
    'fetch-queue' {
        $op = 'fetch_queue'
        $opArgs = @{ limit = $Limit; level = $Level; offset = $Offset }; if ($Page -gt 0) { $opArgs['page'] = $Page }
        if ($Dir) { $opArgs['dir'] = $Dir }
        if ($Force) { $opArgs['force'] = $true }
        $opArgs['timeoutMs'] = 45000
        $opArgs['delayMs'] = $DelayMs
    }
    'verify-queue' {
        $op = 'verify_queue'
        $opArgs = @{ limit = $Limit; level = $Level; offset = $Offset }; if ($Page -gt 0) { $opArgs['page'] = $Page }
        if ($Dir) { $opArgs['dir'] = $Dir }
        $opArgs['timeoutMs'] = 45000
        $opArgs['delayMs'] = $DelayMs
    }
    'dump-queue' { $op = 'dump_queue'; $TimeoutMs = [Math]::Max($TimeoutMs, 240000) }
    'me' { $op = 'me' }
    'records' { $op = 'records'; $opArgs = @{ type = $Type }; $TimeoutMs = [Math]::Max($TimeoutMs, 60000) }
    'playlist-api' {
        $op = 'playlist_api'
        $opArgs = @{ id = $Id }
        if (-not [double]::IsNaN($To) -and $To -gt 0) { $opArgs['limit'] = [int]$To }
        if ($Offset -gt 0) { $opArgs['offset'] = $Offset }
        $TimeoutMs = [Math]::Max($TimeoutMs, 240000)
    }
    'wiki' {
        Write-Host ('  ' + $d.id + '  累计播放 ' + $d.playCount + ' 次' + $(if ($d.durationMin) { '，' + $d.durationMin + ' 分钟' }) + '  首听 ' + $d.firstListenISO) -ForegroundColor Cyan
        if ($d.text) { Write-Host ('  ' + $d.text) -ForegroundColor DarkGray }
    }
    'wiki_batch' {
        Write-Host ('  批量 ' + $d.count + ' 首：成功 ' + $d.ok) -ForegroundColor Cyan
        foreach ($it in $d.items) { if ($it.error) { Write-Host ('   ✗ ' + $it.id + ' ' + $it.error + ' ' + $it.message) -ForegroundColor Yellow } else { Write-Host ('   ' + $it.id.PadRight(12) + ' ' + ([string]$it.playCount).PadLeft(5) + ' 次  ' + $it.text) } }
    }
    'signals_all' {
        Write-Host ('✓ 已导出：' + $d.out) -ForegroundColor Green
        Write-Host ('  歌曲 ' + $d.songCount + ' 首 / 歌单 ' + $d.playlists + ' 个 / ' + ('{0:N0}' -f $d.bytes) + ' 字节') -ForegroundColor Cyan
        Write-Host ('  Top100 覆盖：全时段 ' + $d.topAll + ' / 本周 ' + $d.topWeek) -ForegroundColor DarkGray
    }
    'signals' {
        $op = 'signals'
        $opArgs = @{ id = $Id }
        $TimeoutMs = [Math]::Max($TimeoutMs, 300000)
    }
    'signals-all' {
        $op = 'signals_all'
        $opArgs = @{}
        if ($Out) { $opArgs['out'] = $Out }
        if ($PlaylistLimit -gt 0) { $opArgs['limit'] = $PlaylistLimit }
        $TimeoutMs = [Math]::Max($TimeoutMs, 900000)
    }
    'wiki' { $op = 'wiki'; $opArgs = @{ id = $Id }; $TimeoutMs = [Math]::Max($TimeoutMs, 60000) }
    'wiki-batch' {
        $op = 'wiki_batch'
        $idList = @()
        if ($IdsFile) { $idList = @(Get-Content $IdsFile -Encoding UTF8 | Where-Object { $_ -match '^\d+$' }) }
        elseif ($Text) { $idList = @($Text -split '[,\s]+' | Where-Object { $_ }) }
        $opArgs = @{ ids = $idList; delayMs = $DelayMs }
        $TimeoutMs = [Math]::Max($TimeoutMs, 600000)
    }
    'log' { $op = 'log' }
    'js' { $op = 'js'; $opArgs = @{ code = $(if ($Text) { $Text } else { $Arg1 }); timeoutMs = [Math]::Min($TimeoutMs, 120000) } }
    default { throw "未知命令：$Command（可用：ping/song/url/fetch/current/queue/fetch-queue/verify-queue/dump-queue/me/records/playlist-api/signals/log/js）" }
}

$result = Invoke-Bridge -Op $op -OpArgs $opArgs -Timeout $TimeoutMs
if ($null -eq $result) { Show-Hint; exit 1 }

if ($Raw) { $result | ConvertTo-Json -Depth 20; if (-not $result.ok) { exit 2 }; exit 0 }

if (-not $result.ok) {
    Write-Host ('✗ ' + $result.error.code + ': ' + $result.error.message) -ForegroundColor Red
    if ($result.error.extra) { Write-Host ($result.error.extra | ConvertTo-Json -Depth 8) -ForegroundColor DarkGray }
    exit 2
}

$d = $result.data
switch ($result.op) {
    'ping' { Write-Host ('✓ PlaybackDL ' + $d.version + '，默认目录 ' + $d.defaultDir) -ForegroundColor Green }
    'me' { Write-Host ('✓ uid=' + $d.uid + '  ' + $d.nickname + '  vip=' + $d.vipType) -ForegroundColor Green }
    'records' {
        Write-Host ('  听歌排行 type=' + $d.type + '，' + $d.count + ' 条（只给 Top100）') -ForegroundColor Cyan
        $i = 0
        foreach ($t in $d.items) { $i++; if ($i -gt 10) { break }; Write-Host ('   ' + $i.ToString().PadLeft(3) + '. ' + $t.playCount.ToString().PadLeft(5) + ' 次  ' + $t.name + ' — ' + ($t.artists -join '/')) }
        Write-Host ''
    }
    'playlist_api' {
        Write-Host ('  歌单 ' + $d.id + ' 《' + $d.name + '》 共 ' + $d.trackCount + ' 首（返回 ' + $d.returned + '）') -ForegroundColor Cyan
        foreach ($t in $d.tracks) {
            $at = if ($t.addTimeISO) { $t.addTimeISO.Substring(0, 10) } else { '---- -- --' }
            Write-Host ('   ' + $t.id.PadRight(12) + ' ' + $at + '  ' + $t.name + ' — ' + ($t.artists -join '/'))
        }
        Write-Host ''
    }
    'wiki' {
        Write-Host ('  ' + $d.id + '  累计播放 ' + $d.playCount + ' 次' + $(if ($d.durationMin) { '，' + $d.durationMin + ' 分钟' }) + '  首听 ' + $d.firstListenISO) -ForegroundColor Cyan
        if ($d.text) { Write-Host ('  ' + $d.text) -ForegroundColor DarkGray }
    }
    'wiki_batch' {
        Write-Host ('  批量 ' + $d.count + ' 首：成功 ' + $d.ok) -ForegroundColor Cyan
        foreach ($it in $d.items) { if ($it.error) { Write-Host ('   ✗ ' + $it.id + ' ' + $it.error + ' ' + $it.message) -ForegroundColor Yellow } else { Write-Host ('   ' + $it.id.PadRight(12) + ' ' + ([string]$it.playCount).PadLeft(5) + ' 次  ' + $it.text) } }
    }
    'signals_all' {
        Write-Host ('✓ 已导出：' + $d.out) -ForegroundColor Green
        Write-Host ('  歌曲 ' + $d.songCount + ' 首 / 歌单 ' + $d.playlists + ' 个 / ' + ('{0:N0}' -f $d.bytes) + ' 字节') -ForegroundColor Cyan
        Write-Host ('  Top100 覆盖：全时段 ' + $d.topAll + ' / 本周 ' + $d.topWeek) -ForegroundColor DarkGray
    }
    'signals' {
        Write-Host ('  歌单《' + $d.playlist.name + '》' + $d.playlist.trackCount + ' 首 | uid=' + $d.uid + ' | 命中全时段 Top100：' + $d.matchedInPlaylist) -ForegroundColor Cyan
        Write-Host ('  ' + $d.playlist.trackCount + ' 首里能拿到播放次数的只有 ' + $d.matchedInPlaylist + ' 首；t_i(加入时间) 全部有') -ForegroundColor DarkGray
        $i = 0
        foreach ($t in $d.tracks) { $i++; if ($i -gt 5) { break }; Write-Host ('   ' + $t.playCount.ToString().PadLeft(5) + ' 次 | ' + $(if ($t.addTimeISO) { $t.addTimeISO.Substring(0, 10) } else { '----' }) + ' | ' + $t.name) }
        Write-Host ''
    }
    'song' { Write-Host ($d.name + ' — ' + ($d.artists -join '/') + '  《' + $d.album + '》  ' + [math]::Round($d.durationMs / 1000) + 's') }
    'url' { Write-Host ('✓ ' + $d.level + ' / ' + $d.br + 'bps / ' + ('{0:N0}' -f $d.size) + 'B / ' + $d.format) -ForegroundColor Green; Write-Host ('  ' + $d.url) -ForegroundColor DarkGray }
    'fetch' {
        if ($d.skipped) {
            Write-Host ('- 文件已存在，跳过：' + $d.path + '  (' + ('{0:N0}' -f $d.bytes) + ' 字节，-Force 可覆盖)') -ForegroundColor Yellow
        } else {
            Write-Host ('✓ 已通过播放接口下载：' + ('{0:N0}' -f $d.bytes) + ' 字节  ' + $d.level + '(' + $d.br + ')  ' + $d.format) -ForegroundColor Green
        }
        Write-Host ('  文件：' + $d.path)
        if ($d.song) { Write-Host ('  歌曲：' + $d.song.name + ' — ' + ($d.song.artists -join '/')) }
        Write-Host ('  校验：' + $(if ($d.verified) { '大小一致 ✓' } else { '未确认' })) -ForegroundColor DarkGray
    }
    'fetch_current' {
        Write-Host ('✓ 已下载当前歌曲：' + $d.path) -ForegroundColor Green
    }
    'queue' {
        Write-Host ('  客户端「正在下载」队列：' + $d.total + ' 条（显示 ' + $d.tasks.Count + ' 条）') -ForegroundColor Cyan
        foreach ($t in $d.tasks) { Write-Host ('   ' + $t.id.PadRight(12) + ' [' + $t.status + '] ' + $t.title) }
        Write-Host ''
    }
    'verify_queue' {
        Write-Host ('  队列 ' + $d.queueTotal + ' 条，核对 ' + $d.checked + ' 条：已有 ' + $d.present + ' / 补下 ' + $d.downloaded + ' / 失败 ' + $d.failed) -ForegroundColor Cyan
        foreach ($t in $d.items) {
            if ($t.present) { Write-Host ('   = ' + $t.title + '  (' + ('{0:N0}' -f $t.bytes) + 'B)') -ForegroundColor DarkGray }
            elseif ($t.downloaded) { Write-Host ('   + ' + $t.title + '  → ' + $t.path + '  (' + ('{0:N0}' -f $t.bytes) + 'B)') -ForegroundColor Green }
            else { Write-Host ('   ✗ ' + $t.title + '  ' + $t.error + ': ' + $t.message) -ForegroundColor Yellow }
        }
        Write-Host ''
    }
    'fetch_queue' {
        Write-Host ('  队列共 ' + $d.queueTotal + ' 条，本次处理 ' + $d.attempted + ' 条：成功 ' + $d.ok + ' / 跳过 ' + $d.skipped + ' / 失败 ' + $d.failed) -ForegroundColor Cyan
        foreach ($t in $d.items) {
            if ($t.ok -and $t.skipped) { Write-Host ('   - ' + $t.title + '  （已存在，跳过；-Force 可覆盖）') -ForegroundColor DarkGray }
            elseif ($t.ok) { Write-Host ('   ✓ ' + $t.title + '  → ' + $t.path + '  (' + ('{0:N0}' -f $t.bytes) + 'B)') -ForegroundColor Green }
            else { Write-Host ('   ✗ ' + $t.title + '  ' + $t.error + ': ' + $t.message) -ForegroundColor Yellow }
        }
        Write-Host ''
    }
    default { $d | ConvertTo-Json -Depth 12 }
}
exit 0
