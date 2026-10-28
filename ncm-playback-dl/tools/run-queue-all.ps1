#Requires -Version 5.1
<#
.SYNOPSIS
    把客户端下载队列【全部页】逐首走播放接口下载（默认 128k），可断点续跑。

.DESCRIPTION
    下载页是分页的（每页 200 条）。本脚本逐页、页内每 50 首一批调用 ncmdl.ps1 fetch-queue，
    进度记录到 state 文件，重跑会跳过已完成的批次。
#>
[CmdletBinding()]
param(
    [string]$Level = 'standard',
    [int]$Batch = 25,
    [int]$DelayMs = 1200,
    [int]$TotalPages = 0,
    [string]$LogPath = "$PSScriptRoot\..\tmp\queue-all.log",
    [string]$StatePath = "$PSScriptRoot\..\tmp\queue-all-state.json",
    [string]$DoneFile = 'F:\queue-done.txt',
    [switch]$Restart
)

$ErrorActionPreference = 'Continue'
$cli = Join-Path $PSScriptRoot 'ncmdl.ps1'
$logFull = [System.IO.Path]::GetFullPath($LogPath)
$stateFull = [System.IO.Path]::GetFullPath($StatePath)
New-Item -ItemType Directory -Path (Split-Path $logFull) -Force | Out-Null

function Write-Log([string]$msg) {
    $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $msg
    Add-Content -Path $logFull -Value $line -Encoding UTF8
}

$doneList = @()
if ((Test-Path $stateFull) -and -not $Restart) {
    try {
        $st = Get-Content $stateFull -Raw -Encoding UTF8 | ConvertFrom-Json
        $doneList = @($st.done)
        Write-Log ("resume: {0} batches already done" -f $doneList.Count)
    } catch { Write-Log 'state parse failed, start fresh' }
}

$first = & $cli queue -Limit 1 -Page 1 -TimeoutMs 40000 -Raw | Out-String | ConvertFrom-Json
if (-not $first.ok) { Write-Log ("probe failed: " + $first.error.message); exit 1 }
$pages = if ($TotalPages -gt 0) { $TotalPages } else { [int]$first.data.pageCount }
Write-Log ("queue pages={0} level={1}" -f $pages, $Level)

$agg = [ordered]@{ ok = 0; skipped = 0; failed = 0; batches = 0; failedItems = @() }
$sw = [Diagnostics.Stopwatch]::StartNew()

for ($p = 1; $p -le $pages; $p++) {
    for ($o = 0; $o -lt 200; $o += $Batch) {
        $key = ('{0}:{1}' -f $p, $o)
        if ($doneList -contains $key) { continue }
        $t0 = Get-Date
        try {
            $raw = & $cli fetch-queue -Limit $Batch -Offset $o -Page $p -Level $Level -TimeoutMs 600000 -DelayMs $DelayMs -Raw | Out-String
            $r = $raw | ConvertFrom-Json
            if (-not $r.ok) {
                Write-Log ("page={0} off={1} BATCH-ERROR {2}" -f $p, $o, $r.error.message)
                continue
            }
            $d = $r.data
            $agg.ok += [int]$d.ok
            $agg.skipped += [int]$d.skipped
            $agg.failed += [int]$d.failed
            $agg.batches++
            foreach ($it in $d.items) {
                if (-not $it.ok) {
                    $agg.failedItems += [pscustomobject]@{ id = $it.id; title = $it.title; error = $it.error; message = $it.message }
                    Write-Log ("  FAIL " + $it.id + "  " + $it.title + "  " + $it.error)
                }
            }
            Write-Log ("page={0} off={1} attempted={2} ok={3} skip={4} fail={5} ({6:N0}s)" -f $p, $o, $d.attempted, $d.ok, $d.skipped, $d.failed, ((Get-Date) - $t0).TotalSeconds)
            $doneList += $key
            [ordered]@{ done = @($doneList); agg = $agg; updatedAt = (Get-Date).ToString('o') } | ConvertTo-Json -Depth 6 | Set-Content -Path $stateFull -Encoding UTF8
        } catch {
            Write-Log ("page={0} off={1} EXCEPTION {2}" -f $p, $o, $_.Exception.Message)
        }
    }
}

$sw.Stop()
Write-Log ("DONE pages={0} batches={1} ok={2} skipped={3} failed={4} elapsed={5:N0}s" -f $pages, $agg.batches, $agg.ok, $agg.skipped, $agg.failed, $sw.Elapsed.TotalSeconds)
$summary = [ordered]@{
    level = $Level; pages = $pages; batches = $agg.batches
    ok = $agg.ok; skipped = $agg.skipped; failed = $agg.failed
    elapsedSec = [math]::Round($sw.Elapsed.TotalSeconds)
    failedItems = @($agg.failedItems)
    finishedAt = (Get-Date).ToString('o')
}
$summary | ConvertTo-Json -Depth 6 | Set-Content -Path $DoneFile -Encoding UTF8
Write-Log ("summary written: " + $DoneFile)
