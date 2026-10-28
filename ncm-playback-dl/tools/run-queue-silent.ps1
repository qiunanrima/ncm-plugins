#Requires -Version 5.1
<#
.SYNOPSIS
    静默模式：先把下载队列所有页的歌曲 ID 抓下来，然后只走播放接口下载，不再动界面。

.DESCRIPTION
    1) 只翻一次页，收集队列全部歌曲 ID → tmp\queue-ids.json
    2) 之后逐首调用 ncmdl.ps1 fetch（只调 API + 写文件，不翻页、不切 tab）
    3) 低并发：每首之间 DelayMs 间隔；断点续跑（state 里记录已处理 ID）
    4) 结束时写 F:\queue-all-done.txt，并弹窗提示
#>
[CmdletBinding()]
param(
    [string]$Level = 'standard',
    [int]$DelayMs = 2000,
    [int]$MaxSongs = 0,
    [string]$IdFile = "$PSScriptRoot\..\tmp\queue-ids.json",
    [string]$LogPath = "$PSScriptRoot\..\tmp\queue-silent.log",
    [string]$StatePath = "$PSScriptRoot\..\tmp\queue-silent-state.json",
    [string]$DoneFile = 'F:\queue-all-done.txt',
    [switch]$Restart
)

$ErrorActionPreference = 'Continue'
$cli = Join-Path $PSScriptRoot 'ncmdl.ps1'
$logFull = [System.IO.Path]::GetFullPath($LogPath)
$stateFull = [System.IO.Path]::GetFullPath($StatePath)
$idFull = [System.IO.Path]::GetFullPath($IdFile)
New-Item -ItemType Directory -Path (Split-Path $logFull) -Force | Out-Null

function Write-Log([string]$msg) {
    $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $msg
    Add-Content -Path $logFull -Value $line -Encoding UTF8
}

Write-Log ("=== start level={0} delay={1}ms ===" -f $Level, $DelayMs)

# ---------- 1) 抓队列 ID ----------
$ids = @()
if ((Test-Path $idFull) -and -not $Restart) {
    try { $ids = @(Get-Content $idFull -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { $ids = @() }
    if ($ids.Count) { Write-Log ("ids loaded: {0}" -f $ids.Count) }
}
if (-not $ids.Count) {
    $first = & $cli queue -Limit 1 -Page 1 -TimeoutMs 60000 -Raw | Out-String | ConvertFrom-Json
    if (-not $first.ok) { Write-Log ("probe failed: " + $first.error.message); exit 1 }
    $pages = [int]$first.data.pageCount
    Write-Log ("queue pages={0}" -f $pages)
    $tmp = New-Object System.Collections.ArrayList
    for ($p = 1; $p -le $pages; $p++) {
        $r = & $cli queue -Limit 200 -Page $p -TimeoutMs 60000 -Raw | Out-String | ConvertFrom-Json
        if ($r.ok) {
            foreach ($t in $r.data.tasks) { [void]$tmp.Add([string]$t.id) }
            Write-Log ("  page {0}: +{1} ids" -f $p, $r.data.tasks.Count)
        } else {
            Write-Log ("  page {0}: ERR {1}" -f $p, $r.error.message)
        }
        Start-Sleep -Milliseconds 700
    }
    $ids = @($tmp | Select-Object -Unique)
    $ids | ConvertTo-Json | Set-Content -Path $idFull -Encoding UTF8
    Write-Log ("ids saved: {0} -> {1}" -f $ids.Count, $idFull)
}
if (-not $ids.Count) { Write-Log 'no ids, abort'; exit 1 }

# ---------- 2) 逐首下载 ----------
$doneIds = @{}
if ((Test-Path $stateFull) -and -not $Restart) {
    try {
        $st = Get-Content $stateFull -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($d in @($st.done)) { $doneIds[[string]$d] = 1 }
        Write-Log ("resume: {0} ids done" -f $doneIds.Count)
    } catch { Write-Log 'state parse failed' }
}

$ok = 0; $skip = 0; $fail = 0
$failed = New-Object System.Collections.ArrayList
$n = 0; $total = $ids.Count
$sw = [Diagnostics.Stopwatch]::StartNew()

foreach ($id in $ids) {
    $n++
    if ($MaxSongs -gt 0 -and $n -gt $MaxSongs) { break }
    if ($doneIds.ContainsKey([string]$id)) { continue }
    try {
        $raw = & $cli fetch -Id $id -Level $Level -TimeoutMs 120000 -Raw | Out-String
        $r = $raw | ConvertFrom-Json
        if ($null -eq $r) {
            $fail++; [void]$failed.Add([pscustomobject]@{ id = $id; error = 'NO_RESPONSE' }); Write-Log ("{0}/{1} {2} NO_RESPONSE" -f $n, $total, $id)
        } elseif (-not $r.ok) {
            $fail++; [void]$failed.Add([pscustomobject]@{ id = $id; error = $r.error.code; message = $r.error.message })
            Write-Log ("{0}/{1} {2} FAIL {3}" -f $n, $total, $id, $r.error.code)
        } elseif ($r.data.skipped) {
            $skip++
            Write-Log ("{0}/{1} {2} skip ({3:N0}B)" -f $n, $total, $id, $r.data.bytes)
        } else {
            $ok++
            Write-Log ("{0}/{1} {2} OK {3:N0}B {4}" -f $n, $total, $id, $r.data.bytes, $r.data.path)
        }
    } catch {
        $fail++; [void]$failed.Add([pscustomobject]@{ id = $id; error = 'EXCEPTION'; message = $_.Exception.Message })
        Write-Log ("{0}/{1} {2} EXCEPTION {3}" -f $n, $total, $id, $_.Exception.Message)
    }
    $doneIds[[string]$id] = 1
    if ($n % 10 -eq 0) {
        [ordered]@{ done = @($doneIds.Keys); ok = $ok; skip = $skip; fail = $fail; updatedAt = (Get-Date).ToString('o') } |
            ConvertTo-Json -Depth 5 | Set-Content -Path $stateFull -Encoding UTF8
        $rate = $n / [Math]::Max(1, $sw.Elapsed.TotalMinutes)
        Write-Log ("-- progress {0}/{1} ok={2} skip={3} fail={4} {5:N1}首/分 剩余≈{6:N0}分" -f $n, $total, $ok, $skip, $fail, $rate, (($total - $n) / [Math]::Max(0.1, $rate)))
    }
    Start-Sleep -Milliseconds $DelayMs
}

$sw.Stop()
[ordered]@{ done = @($doneIds.Keys); ok = $ok; skip = $skip; fail = $fail; updatedAt = (Get-Date).ToString('o') } |
    ConvertTo-Json -Depth 5 | Set-Content -Path $stateFull -Encoding UTF8

$summary = [ordered]@{
    level = $Level
    ids = $total
    ok = $ok
    skipped = $skip
    failed = $fail
    elapsedMin = [math]::Round($sw.Elapsed.TotalMinutes, 1)
    failedItems = @($failed)
    finishedAt = (Get-Date).ToString('o')
}
$summary | ConvertTo-Json -Depth 6 | Set-Content -Path $DoneFile -Encoding UTF8
Write-Log ("=== DONE ids={0} ok={1} skip={2} fail={3} elapsed={4:N1}min ===" -f $total, $ok, $skip, $fail, $sw.Elapsed.TotalMinutes)
Write-Log ("summary: " + $DoneFile)

try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        ("网易云队列下载完成`n`n成功 {0} / 已存在 {1} / 失败 {2}`n耗时 {3} 分钟`n`n明细：{4}" -f $ok, $skip, $fail, [math]::Round($sw.Elapsed.TotalMinutes), $LogPath),
        'PlaybackDL 下载完成', 'OK', 'Information') | Out-Null
} catch { }
