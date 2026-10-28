# Scan per-song personal play counts via the song-wiki link page (eapi).
# Usage: .\tools\scan_wiki.ps1 [-Chunk 100] [-DelayMs 600] [-IdsFile tmp/wiki-ids.txt] [-Out tmp/playcounts.json]
param(
    [int]$Chunk = 100,
    [int]$DelayMs = 600,
    [string]$IdsFile = 'tmp/wiki-ids.txt',
    [string]$Out = 'tmp/playcounts.json'
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $PSScriptRoot 'ncmdl.ps1'
if (-not [IO.Path]::IsPathRooted($IdsFile)) { $IdsFile = Join-Path $root $IdsFile }
if (-not [IO.Path]::IsPathRooted($Out)) { $Out = Join-Path $root $Out }

$ids = @(Get-Content $IdsFile -Encoding UTF8 | Where-Object { $_ -match '^\d+$' })
if ($ids.Count -eq 0) { throw "no ids in $IdsFile" }

$counts = @{}
if (Test-Path $Out) {
    try {
        $prev = Get-Content $Out -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($p in $prev.counts.PSObject.Properties) { $counts[$p.Name] = $p.Value }
    } catch { }
}
$todo = @($ids | Where-Object { -not $counts.ContainsKey($_) })
Write-Host ("total=" + $ids.Count + " done=" + $counts.Count + " todo=" + $todo.Count)

$idx = 0
while ($idx -lt $todo.Count) {
    $take = [Math]::Min($Chunk, $todo.Count - $idx)
    $batch = $todo[$idx..($idx + $take - 1)]
    $idx += $take
    $text = ($batch -join ',')
    $raw = & $cli wiki-batch -Text $text -DelayMs $DelayMs -TimeoutMs 600000 -Raw 2>&1 | Out-String
    $parsed = $null
    try { $parsed = $raw | ConvertFrom-Json } catch { }
    if (-not $parsed -or -not $parsed.ok) {
        Write-Host ("batch failed at " + $idx + ": " + $raw.Substring(0, [Math]::Min(200, $raw.Length)))
        break
    }
    $okCount = 0
    foreach ($it in $parsed.data.items) {
        if (-not $it.error) {
            $counts[[string]$it.id] = @{
                playCount = $it.playCount
                durationMin = $it.durationMin
                firstListenAt = $it.firstListenAt
                text = $it.text
            }
            $okCount++
        }
    }
    $payload = @{ updatedAt = (Get-Date).ToString('o'); counts = $counts }
    $payload | ConvertTo-Json -Depth 6 -Compress | Set-Content $Out -Encoding UTF8
    Write-Host ("progress " + $idx + "/" + $todo.Count + " ok=" + $okCount + " saved=" + $counts.Count + " " + (Get-Date -Format 'HH:mm:ss'))
}

Write-Host ("DONE saved=" + $counts.Count + " -> " + $Out)
