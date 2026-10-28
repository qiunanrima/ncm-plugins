#Requires -Version 5.1
<#
.SYNOPSIS
    把客户端下载队列整批改成“走播放接口”下载，跑完后写标记文件。
#>
[CmdletBinding()]
param(
    [int]$Batch = 25,
    [int]$Total = 200,
    [string]$Level = 'standard',
    [string]$Marker = 'F:\1.txt'
)

$ErrorActionPreference = 'Stop'
$cli = Join-Path $PSScriptRoot 'ncmdl.ps1'
$all = New-Object System.Collections.ArrayList
$sw = [Diagnostics.Stopwatch]::StartNew()

for ($off = 0; $off -lt $Total; $off += $Batch) {
    Write-Host ("=== batch offset {0} / {1} ({2}) ===" -f $off, $Total, (Get-Date -Format 'HH:mm:ss'))
    try {
        $raw = & $cli fetch-queue -Limit $Batch -Offset $off -Level $Level -TimeoutMs 600000 -Raw | Out-String
        $r = $raw | ConvertFrom-Json
        if (-not $r.ok) { Write-Host ("  batch failed: " + $r.error.message); continue }
        $d = $r.data
        Write-Host ("  attempted={0} ok={1} skipped={2} failed={3}" -f $d.attempted, $d.ok, $d.skipped, $d.failed)
        foreach ($it in $d.items) {
            [void]$all.Add($it)
            if ($it.skipped) { Write-Host ("   - " + $it.title + "  (已存在，跳过)") }
            elseif ($it.ok) { Write-Host ("   OK " + $it.title + "  " + ('{0:N0}' -f $it.bytes) + "B") }
            else { Write-Host ("   FAIL " + $it.title + "  " + $it.error + ": " + $it.message) }
        }
    } catch {
        Write-Host ("  batch exception: " + $_.Exception.Message)
    }
}

$sw.Stop()
$ok = @($all | Where-Object { $_.ok -and -not $_.skipped }).Count
$skip = @($all | Where-Object { $_.skipped }).Count
$fail = @($all | Where-Object { -not $_.ok }).Count
Write-Host ("DONE attempted={0} ok={1} skipped={2} failed={3} elapsed={4}s" -f $all.Count, $ok, $skip, $fail, [math]::Round($sw.Elapsed.TotalSeconds))
if ($fail -gt 0) {
    Write-Host '--- failures ---'
    $all | Where-Object { -not $_.ok } | ForEach-Object { Write-Host ("   " + $_.id + "  " + $_.title + "  " + $_.error + "  " + $_.message) }
}

[System.IO.File]::WriteAllText($Marker, 'true', (New-Object System.Text.UTF8Encoding($false)))
Write-Host ("marker written: " + $Marker)
