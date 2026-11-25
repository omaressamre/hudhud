# Hudhud Helper uninstaller. Your downloaded videos are NOT touched.
$ErrorActionPreference = 'Continue'
$HostName = 'com.hudhud.helper'
$Dest = Join-Path $env:LOCALAPPDATA 'Hudhud'

Get-Process -Name 'hudhud-helper', 'yt-dlp', 'ffmpeg', 'deno' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($Dest, [StringComparison]::OrdinalIgnoreCase) } |
    Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 300

foreach ($root in 'HKCU:\Software\Google\Chrome\NativeMessagingHosts', 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts', 'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts', 'HKCU:\Software\Mozilla\NativeMessagingHosts') {
    $key = Join-Path $root $HostName
    if (Test-Path $key) { Remove-Item $key -Recurse -Force; Write-Host "removed $key" }
}
if (Test-Path $Dest) { Remove-Item $Dest -Recurse -Force; Write-Host "removed $Dest" }
Write-Host 'Hudhud Helper uninstalled.' -ForegroundColor Green
Write-Host 'Also remove Hudhud from chrome://extensions (or edge://extensions).'
