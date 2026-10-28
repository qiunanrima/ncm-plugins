#Requires -Version 5.1
<#
.SYNOPSIS
    NCM Agent Bridge 命令行客户端 —— 操作网易云音乐。

.DESCRIPTION
    把命令写成 JSON 丢进 <BetterNCM>\AgentBridge\inbox，插件执行后把结果写到 outbox。
    本脚本负责生成命令、等待结果、格式化输出。

.EXAMPLE
    .\ncm.ps1 status
    .\ncm.ps1 pause
    .\ncm.ps1 next
    .\ncm.ps1 seek -To 90
    .\ncm.ps1 volume -To 60
    .\ncm.ps1 query -Selector "#main-player" -Raw
    .\ncm.ps1 js -Text "document.title"
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Command = 'status',
    [Parameter(Position = 1)][string]$Arg1 = '',
    [string]$Selector,
    [string]$Text,
    [int]$Index = 0,
    [double]$To = [double]::NaN,
    [string]$Id,
    [string]$Name,
    [string]$ArgsJson,
    [int]$TimeoutMs = 8000,
    [switch]$Raw,
    [switch]$Keep
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$utf8 = New-Object System.Text.UTF8Encoding($false)
$root = if ($env:NCM_AGENT_ROOT) { $env:NCM_AGENT_ROOT } else { 'C:\betterncm\AgentBridge' }
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
    $json = $obj | ConvertTo-Json -Depth 20 -Compress
    [System.IO.File]::WriteAllText($path, $json, $utf8)
}

function ConvertTo-HashtableRecursive($obj) {
    if ($null -eq $obj) { return $null }
    if ($obj -is [System.Collections.IDictionary]) { return $obj }
    if ($obj -is [string]) { return $obj }
    if ($obj -is [System.Collections.IEnumerable]) {
        $list = @()
        foreach ($i in $obj) { $list += , (ConvertTo-HashtableRecursive $i) }
        return $list
    }
    if ($obj -is [psobject]) {
        $h = @{}
        foreach ($p in $obj.PSObject.Properties) { $h[$p.Name] = ConvertTo-HashtableRecursive $p.Value }
        return $h
    }
    return $obj
}

function Show-PluginHint {
    $hello = Join-Path $root 'hello.json'
    Write-Host ''
    Write-Host '插件似乎没有在运行。请检查：' -ForegroundColor Yellow
    Write-Host '  1. 网易云音乐已启动；'
    Write-Host '  2. BetterNCM 插件列表里能看到并启用了 "NCM Agent Bridge"；'
    Write-Host '  3. 刚装好插件的话需要重启一次网易云（或点 BetterNCM → 重载插件）；'
    if (Test-Path -LiteralPath $hello) {
        $h = Read-JsonFile $hello
        Write-Host ('  最近一次插件启动：' + $h.startedAt) -ForegroundColor DarkGray
    } else {
        Write-Host ('  未找到 ' + $hello) -ForegroundColor DarkGray
    }
    $errFile = Join-Path $root 'plugin-error.json'
    if (Test-Path -LiteralPath $errFile) {
        Write-Host '插件启动报错：' -ForegroundColor Red
        Write-Host ([System.IO.File]::ReadAllText($errFile, [System.Text.Encoding]::UTF8)) -ForegroundColor Red
    }
    Write-Host ''
}

function Invoke-Bridge {
    param(
        [string]$Op,
        [hashtable]$OpArgs = @{},
        [int]$Timeout = 8000
    )
    if (-not (Test-Path -LiteralPath $inbox)) {
        New-Item -ItemType Directory -Path $inbox -Force | Out-Null
        New-Item -ItemType Directory -Path $outbox -Force | Out-Null
    }
    $suffix = -join ((1..6) | ForEach-Object { '0123456789abcdef'[(Get-Random -Maximum 16)] })
    $cmdId = '{0}-{1}' -f ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()), $suffix
    $cmd = [ordered]@{
        id        = $cmdId
        op        = $Op
        args      = $OpArgs
        ts        = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        timeoutMs = $Timeout
    }
    $cmdPath = Join-Path $inbox ($cmdId + '.json')
    Write-JsonFile $cmdPath $cmd

    $resPath = Join-Path $outbox ($cmdId + '.res.json')
    $deadline = (Get-Date).AddMilliseconds($Timeout + 4000)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $resPath) {
            $res = Read-JsonFile $resPath
            if (-not $Keep) { Remove-Item -LiteralPath $resPath -Force -ErrorAction SilentlyContinue }
            if ($null -eq $res) { Start-Sleep -Milliseconds 60; continue }
            return $res
        }
        Start-Sleep -Milliseconds 60
    }
    Remove-Item -LiteralPath $cmdPath -Force -ErrorAction SilentlyContinue
    return $null
}

function Format-Time([double]$seconds) {
    if (-not $seconds -or $seconds -lt 0) { return '0:00' }
    $s = [int][Math]::Round($seconds)
    return ('{0}:{1:00}' -f [int][Math]::Floor($s / 60), ($s % 60))
}

function Show-Status($data) {
    $track = $data.track
    $artists = ''
    if ($track -and $track.artists) { $artists = ($track.artists -join ' / ') }
    $title = if ($track -and $track.title) { $track.title } else { '(未知)' }
    $flag = if ($data.playing) { '▶ 播放中' } else { '⏸ 已暂停' }

    Write-Host ''
    Write-Host ('  ' + $flag + '   ' + $title) -ForegroundColor Cyan
    if ($artists) { Write-Host ('            ' + $artists) -ForegroundColor DarkGray }
    $dur = [double]$data.durationMs / 1000
    $pos = [double]$data.progressMs / 1000
    $line = ('    进度 ' + (Format-Time $pos) + ' / ' + (Format-Time $dur))
    if ($null -ne $data.volume) { $line += ('    音量 ' + $data.volume) }
    if ($track -and $track.id) { $line += ('    ID ' + $track.id) }
    Write-Host $line -ForegroundColor DarkGray
    if ($data.mode) { Write-Host ('    模式 ' + $data.mode) -ForegroundColor DarkGray }
    Write-Host ''
}

function Show-Result($res) {
    if ($null -eq $res) { Show-PluginHint; return }
    if (-not $res.ok) {
        $code = $res.error.code
        Write-Host ('✗ ' + $code + ': ' + $res.error.message) -ForegroundColor Red
        if ($res.error.extra) { Write-Host ($res.error.extra | ConvertTo-Json -Depth 8) -ForegroundColor DarkGray }
        return
    }
    $data = $res.data
    switch ($res.op) {
        'status' { Show-Status $data; return }
        'ping' { Write-Host ('✓ ' + ($data | ConvertTo-Json -Depth 6 -Compress)) -ForegroundColor Green; return }
        'toggle' { if ($data.playing) { Write-Host '✓ 开始播放' -ForegroundColor Green } else { Write-Host '✓ 已暂停' -ForegroundColor Green }; return }
        'play' { Write-Host '✓ 开始播放' -ForegroundColor Green; return }
        'pause' { Write-Host '✓ 已暂停' -ForegroundColor Green; return }
        'next' { Write-Host ('✓ 已切到下一首 → ' + $data.track.title) -ForegroundColor Green; return }
        'prev' { Write-Host ('✓ 已切到上一首 → ' + $data.track.title) -ForegroundColor Green; return }
        'seek' { Write-Host ('✓ 已跳到 ' + (Format-Time $data.seconds)) -ForegroundColor Green; return }
        'volume' {
            $verified = if ($data.verified) { '已回读确认' } else { '未回读确认' }
            Write-Host ('✓ 音量 → ' + $data.requested + '（' + $verified + '，当前读到 ' + $data.volume + '）') -ForegroundColor Green
            return
        }
        'playlists' {
            Write-Host ('  歌单 ' + $data.count + ' 个：') -ForegroundColor Cyan
            foreach ($p in $data.playlists) { Write-Host ('   ' + $p.id + '  ' + $p.name) }
            Write-Host ''
            return
        }
        'playlist' {
            Write-Host ('  歌单 ' + $data.playlistId + '：共 ' + $data.total + ' 行，返回 ' + $data.tracks.Count + ' 首') -ForegroundColor Cyan
            foreach ($t in $data.tracks) {
                $art = if ($t.artists) { $t.artists -join '/' } else { '' }
                $dl = if ($t.downloaded) { ' ✓已下载' } else { '' }
                Write-Host ('   ' + $t.id.PadRight(12) + ' ' + $t.duration.PadRight(6) + ' ' + $t.title + ' — ' + $art + $dl)
            }
            Write-Host ''
            return
        }
        'download' {
            if ($data.verified) { Write-Host ('✓ 下载已触发并确认：' + $data.id) -ForegroundColor Green }
            else { Write-Host ('⚠ 已点击下载按钮但未确认（' + $data.note + '）') -ForegroundColor Yellow }
            return
        }
        'downloads' {
            Write-Host ('  下载目录：' + $data.storageDir) -ForegroundColor Cyan
            Write-Host ('  任务 ' + $data.total + ' 条：')
            foreach ($t in $data.tasks) { Write-Host ('   ' + $t.id.PadRight(12) + ' [' + $t.status + '] ' + $t.title) }
            Write-Host ''
            return
        }
        'navigate' { Write-Host ('✓ 已切到 ' + $data.hash + '（歌曲行 ' + $data.rows + '）') -ForegroundColor Green; return }
        default { }
    }
    Write-Host '✓ 完成' -ForegroundColor Green
    $data | ConvertTo-Json -Depth 12
}

function New-OpArgs([hashtable]$Extra = @{}) {
    $a = @{}
    if ($Selector) { $a['selector'] = $Selector }
    if ($Text) { $a['text'] = $Text }
    if (-not [double]::IsNaN($To)) { $a['to'] = $To }
    if ($Id) { $a['id'] = $Id }
    if ($Name) { $a['name'] = $Name }
    foreach ($k in $Extra.Keys) { $a[$k] = $Extra[$k] }
    return $a
}

if ($Command -eq 'peek') {
    $st = Read-JsonFile (Join-Path $root 'status.json')
    if ($null -eq $st) { Show-PluginHint; exit 1 }
    if ($Raw) { $st | ConvertTo-Json -Depth 20 } else { Show-Status $st }
    exit 0
}

$op = $Command
$opArgs = @{}

switch ($Command.ToLowerInvariant()) {
    'status' { $op = 'status' }
    'ping' { $op = 'ping' }
    'toggle' { $op = 'toggle' }
    'play' { $op = 'play' }
    'pause' { $op = 'pause' }
    'next' { $op = 'next' }
    'prev' { $op = 'prev' }
    'seek' {
        $op = 'seek'
        if ([double]::IsNaN($To)) { $To = if ($Arg1) { [double]$Arg1 } else { 0 } }
        $opArgs = @{ seconds = $To }
    }
    'volume' {
        $op = 'volume'
        if ([double]::IsNaN($To)) { $To = if ($Arg1) { [double]$Arg1 } else { 50 } }
        $opArgs = @{ value = [int]$To }
    }
    'diagnose' { $op = 'diagnose'; $TimeoutMs = [Math]::Max($TimeoutMs, 25000) }
    'log' { $op = 'log' }
    'playlists' { $op = 'playlists'; $TimeoutMs = [Math]::Max($TimeoutMs, 12000) }
    'playlist' {
        $op = 'playlist'
        if (-not $Id) { throw 'playlist 需要 -Id <歌单ID>' }
        $opArgs = @{ id = $Id }
        if (-not [double]::IsNaN($To) -and $To -gt 0) { $opArgs['limit'] = [int]$To }
        $TimeoutMs = [Math]::Max($TimeoutMs, 30000)
    }
    'download' {
        $op = 'download'
        $opArgs = @{}
        if ($Id) { $opArgs['id'] = $Id }
        $TimeoutMs = [Math]::Max($TimeoutMs, 15000)
    }
    'downloads' {
        $op = 'downloads'
        $opArgs = @{}
        if ($Text) { $opArgs['tab'] = $Text }
        $TimeoutMs = [Math]::Max($TimeoutMs, 25000)
    }
    'navigate' {
        $op = 'navigate'
        $h = if ($Text) { $Text } elseif ($Arg1) { $Arg1 } else { throw 'navigate 需要 -Text <#/m/...>' }
        $opArgs = @{ hash = $h }
        $TimeoutMs = [Math]::Max($TimeoutMs, 15000)
    }
    'query' {
        $op = 'query'
        $lim = 20
        if (-not [double]::IsNaN($To) -and $To -gt 0) { $lim = [int]$To }
        $opArgs = New-OpArgs @{ limit = $lim }
        if (-not $opArgs['selector']) { throw 'query 需要 -Selector' }
    }
    'html' {
        $op = 'html'
        $opArgs = New-OpArgs @{}
        if (-not $opArgs['selector']) { $opArgs['selector'] = '#main-player' }
    }
    'click' {
        $op = 'click'
        $opArgs = New-OpArgs @{ index = $Index }
        if (-not $opArgs['selector']) { throw 'click 需要 -Selector' }
    }
    'type' {
        $op = 'type'
        $opArgs = New-OpArgs @{}
        if (-not $opArgs['selector']) { throw 'type 需要 -Selector' }
        if (-not $Text) { throw 'type 需要 -Text' }
    }
    'js' {
        $op = 'js'
        $code = if ($Text) { $Text } elseif ($Arg1) { $Arg1 } else { throw 'js 需要 -Text <代码>' }
        $opArgs = @{ code = $code }
    }
    'channel' {
        $op = 'channel'
        $chanArgs = @()
        if ($ArgsJson) { $chanArgs = @(ConvertTo-HashtableRecursive ($ArgsJson | ConvertFrom-Json)) }
        $chanName = if ($Name) { $Name } elseif ($Arg1) { $Arg1 } else { throw 'channel 需要 -Name <通道名>' }
        $opArgs = @{ name = $chanName; args = $chanArgs }
    }
    'raw' {
        if (-not $Arg1) { throw 'raw 需要操作名' }
        $op = $Arg1
        if ($ArgsJson) { $opArgs = ConvertTo-HashtableRecursive ($ArgsJson | ConvertFrom-Json) } else { $opArgs = New-OpArgs }
    }
    default {
        $op = $Command
        if ($ArgsJson) { $opArgs = ConvertTo-HashtableRecursive ($ArgsJson | ConvertFrom-Json) } else { $opArgs = New-OpArgs }
    }
}

$result = Invoke-Bridge -Op $op -OpArgs $opArgs -Timeout $TimeoutMs

if ($Raw) {
    if ($null -eq $result) { Show-PluginHint; exit 1 }
    $result | ConvertTo-Json -Depth 20
    exit 0
}

Show-Result $result
if ($null -eq $result) { exit 1 }
if (-not $result.ok) { exit 2 }
exit 0
