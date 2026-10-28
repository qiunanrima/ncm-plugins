#Requires -Version 5.1
<#
.SYNOPSIS
    用真实鼠标点击网易云里的元素（当合成事件不生效时，比如需要 :hover 的下载按钮 / 音量条）。

.DESCRIPTION
    BetterNCM 插件通过 ncm.ps1 提供元素的视口坐标，本脚本用 SetCursorPos + mouse_event
    在真实光标位置点击。先做一次坐标标定（客户端坐标 -> 屏幕坐标），再移动/点击，最后把光标移回原处。

.EXAMPLE
    .\realclick.ps1 -Selector ".itm[data-res-id='77448'] [class*='offline-']" -HoverSelector ".itm[data-res-id='77448']"
    .\realclick.ps1 -Selector "#main-player .prg-spk .wrap" -RatioY 0.4 -HoverSelector "#main-player .spk" -DragTo
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Selector,
    [string]$HoverSelector,
    [int]$Index = 0,
    [double]$RatioX = 0.5,
    [double]$RatioY = 0.5,
    [switch]$DragTo,
    [int]$HoverMs = 500,
    [int]$WaitMs = 600,
    [switch]$NoRestore
)

$ErrorActionPreference = 'Stop'
$ncm = Join-Path $PSScriptRoot 'ncm.ps1'
if (-not (Test-Path $ncm)) { throw "找不到 ncm.ps1" }

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AgentMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
"@

# 真实鼠标点击必须点在网易云窗口上，所以先把它带到前台
$ncmProc = Get-Process cloudmusic -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($ncmProc) {
    [void][AgentMouse]::ShowWindow($ncmProc.MainWindowHandle, 9)
    [void][AgentMouse]::SetForegroundWindow($ncmProc.MainWindowHandle)
    Start-Sleep -Milliseconds 450
}

function Call-Ncm {
    param([string]$Cmd, [string]$Sel, [int]$Idx = 0)
    $out = & $ncm $Cmd -Selector $Sel -Index $Idx -Raw 2>$null
    if (-not $out) { return $null }
    return ($out | Out-String | ConvertFrom-Json)
}

function Get-Rect {
    param([string]$Sel, [int]$Idx = 0)
    $r = Call-Ncm -Cmd 'query' -Sel $Sel -Idx $Idx
    if ($null -eq $r -or -not $r.ok) { throw "找不到元素: $Sel" }
    if ($r.data.elements.Count -le $Idx) { throw "元素数量不足: $Sel" }
    return $r.data.elements[$Idx].rect
}

function Move-To([int]$x, [int]$y) {
    [void][AgentMouse]::SetCursorPos($x, $y)
}

function Click-At([int]$x, [int]$y) {
    [void][AgentMouse]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 130
    [AgentMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 90
    [AgentMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

# ---- 标定：客户端坐标 -> 屏幕坐标 ----
$probe = '(function(){if(!window.__agentMM){window.__agentMM=[];document.addEventListener("mousemove",function(e){window.__agentMM.push({cx:e.clientX,cy:e.clientY,sx:e.screenX,sy:e.screenY});if(window.__agentMM.length>10)window.__agentMM.shift();},true);}window.__agentMM=[];return true;})()'
$null = & $ncm js -Text $probe -Raw 2>$null

$orig = New-Object AgentMouse+POINT
[void][AgentMouse]::GetCursorPos([ref]$orig)

# 这两个点在已经前置的网易云窗口里
Move-To 520 420; Start-Sleep -Milliseconds 300
Move-To 900 700; Start-Sleep -Milliseconds 300
$samples = (& $ncm js -Text 'JSON.stringify(window.__agentMM||[])' -Raw 2>$null | Out-String | ConvertFrom-Json)
$pts = @()
if ($samples -and $samples.ok) { $pts = $samples.data.value | ConvertFrom-Json }
if ($pts.Count -lt 2) { throw "坐标标定失败：页面没有收到真实 mousemove（pts=$($pts.Count)）；请保持网易云窗口在最前" }

$a = $pts[0]; $b = $pts[$pts.Count - 1]
$ax = if ($b.cx -ne $a.cx) { ($b.sx - $a.sx) / ($b.cx - $a.cx) } else { 1 }
$bx = $a.sx - $ax * $a.cx
$ay = if ($b.cy -ne $a.cy) { ($b.sy - $a.sy) / ($b.cy - $a.cy) } else { 1 }
$by = $a.sy - $ay * $a.cy

function Client-ToScreen([double]$cx, [double]$cy) {
    return @([int]($ax * $cx + $bx), [int]($ay * $cy + $by))
}

# ---- 可选：先悬停，让 :hover 生效 ----
if ($HoverSelector) {
    $hr = Get-Rect -Sel $HoverSelector -Idx $Index
    $hp = Client-ToScreen ($hr.x + $hr.w / 2) ($hr.y + $hr.h / 2)
    Move-To $hp[0] $hp[1]
    Start-Sleep -Milliseconds $HoverMs
}

$rect = Get-Rect -Sel $Selector -Idx $Index
$cx = $rect.x + $rect.w * $RatioX
$cy = $rect.y + $rect.h * $RatioY
$sp = Client-ToScreen $cx $cy
Write-Host ("目标 {0} 视口=({1},{2}) 屏幕=({3},{4})" -f $Selector, [int]$cx, [int]$cy, $sp[0], $sp[1])

if ($DragTo) {
    [void][AgentMouse]::SetCursorPos($sp[0], $sp[1])
    Start-Sleep -Milliseconds 120
    [AgentMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 150
    [AgentMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
} else {
    Click-At $sp[0] $sp[1]
}

Start-Sleep -Milliseconds $WaitMs
if (-not $NoRestore) { Move-To $orig.X $orig.Y }
Write-Host '完成' -ForegroundColor Green
