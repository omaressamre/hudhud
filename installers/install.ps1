# Hudhud Helper installer (Windows, per-user, no admin needed)
# Installs to %LOCALAPPDATA%\Hudhud and registers the native messaging host for Chrome and Edge.
#
# Downloads show live progress (size, %, speed, time left) and RESUME if interrupted:
# you can close this window at any time and run install.bat again - it continues where it stopped.
param(
    [string]$ExtensionId = 'gdcallopdofegjbibhflneideofehmpk',
    [string]$GeckoId = 'hudhud@omaressamre.github.io'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$HostName = 'com.hudhud.helper'
$Src      = $PSScriptRoot
$Dest     = Join-Path $env:LOCALAPPDATA 'Hudhud'
$Cache    = Join-Path $Dest '.downloads'
$YtUrl    = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
$FfUrl    = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'
$DenoUrl  = 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip'
$Steps    = 6
$script:StepNo = 0

function Set-Title([string]$t) { try { $Host.UI.RawUI.WindowTitle = "Hudhud install - $t" } catch {} }

function Step([string]$msg) {
    $script:StepNo++
    Write-Host ''
    Write-Host ("[{0}/{1}] {2}" -f $script:StepNo, $Steps, $msg) -ForegroundColor Cyan
    Set-Title $msg
}
function Ok([string]$msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }
function Info([string]$msg) { Write-Host "    $msg" }

function Format-Size([double]$b) {
    if ($b -ge 1GB) { return ('{0:N2} GB' -f ($b / 1GB)) }
    if ($b -ge 1MB) { return ('{0:N1} MB' -f ($b / 1MB)) }
    return ('{0:N0} KB' -f ($b / 1KB))
}

function Format-Time([double]$s) {
    if ($s -lt 0 -or [double]::IsInfinity($s) -or [double]::IsNaN($s)) { return '--:--' }
    $t = [TimeSpan]::FromSeconds([math]::Round($s))
    if ($t.TotalHours -ge 1) { return ('{0}:{1:mm}:{1:ss}' -f [int]$t.TotalHours, $t) }
    return ('{0:mm}:{0:ss}' -f $t)
}

function Show-Progress([string]$Label, [long]$Done, [long]$Total, [double]$Speed) {
    if ($Total -gt 0) {
        $pct = [math]::Min(100, [math]::Floor($Done * 100 / $Total))
        $w = 24
        $f = [int][math]::Floor($pct * $w / 100)
        $bar = '[' + ('#' * $f) + ('-' * ($w - $f)) + ']'
        $eta = if ($Speed -gt 0) { Format-Time (($Total - $Done) / $Speed) } else { '--:--' }
        $line = ('    {0} {1,3}%  {2} / {3}  {4}/s  left {5}' -f $bar, $pct, (Format-Size $Done), (Format-Size $Total), (Format-Size $Speed), $eta)
        Set-Title ("{0} {1}%" -f $Label, $pct)
    } else {
        $line = ('    {0} downloaded  {1}/s' -f (Format-Size $Done), (Format-Size $Speed))
        Set-Title ("{0} {1}" -f $Label, (Format-Size $Done))
    }
    Write-Host -NoNewline ("`r" + $line.PadRight(86))
}

# تحميل بيكمّل من مكان ما وقف (ملف .part) وبيعيد المحاولة لوحده لو النت فصل
function Get-File([string]$Url, [string]$Out, [string]$Label) {
    $part = "$Out.part"
    $attempt = 0
    while ($true) {
        $attempt++
        try {
            $have = [long]0
            if (Test-Path $part) { $have = (Get-Item $part).Length }
            $req = [Net.HttpWebRequest]::Create($Url)
            $req.UserAgent = 'Hudhud-Installer'
            $req.AllowAutoRedirect = $true
            $req.Timeout = 30000
            $req.ReadWriteTimeout = 60000
            if ($have -gt 0) { $req.AddRange([long]$have) }
            try {
                $resp = $req.GetResponse()
            } catch {
                # PowerShell بيلف الـWebException جوه MethodInvocationException
                $ex = $_.Exception
                while ($ex -and -not ($ex -is [Net.WebException])) { $ex = $ex.InnerException }
                $r = if ($ex) { $ex.Response } else { $null }
                if ($r -and [int]$r.StatusCode -eq 416 -and $have -gt 0) {
                    # الملف اتحمّل كامل قبل كده
                    $r.Close()
                    Move-Item $part $Out -Force
                    return
                }
                throw
            }
            $status = [int]$resp.StatusCode
            if ($have -gt 0 -and $status -ne 206) { $have = 0 }   # السيرفر مش بيكمّل: نبدأ من الأول
            $len = $resp.ContentLength
            $total = if ($len -gt 0) { $len + $have } else { [long]-1 }
            if ($have -gt 0) { Info ("resuming from {0}" -f (Format-Size $have)) }
            $mode = if ($have -gt 0) { [IO.FileMode]::Append } else { [IO.FileMode]::Create }
            $fs = New-Object IO.FileStream($part, $mode, [IO.FileAccess]::Write)
            $in = $resp.GetResponseStream()
            $buf = New-Object byte[] 1048576
            $done = $have
            $sw = [Diagnostics.Stopwatch]::StartNew()
            $lastMs = -1000
            $speed = 0.0
            try {
                while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
                    $fs.Write($buf, 0, $n)
                    $done += $n
                    $ms = $sw.ElapsedMilliseconds
                    if ($ms - $lastMs -ge 500) {
                        $lastMs = $ms
                        if ($ms -gt 0) { $speed = ($done - $have) * 1000.0 / $ms }
                        Show-Progress $Label $done $total $speed
                    }
                }
            } finally {
                $fs.Close()
                $in.Close()
                $resp.Close()
            }
            $ms = [math]::Max(1, $sw.ElapsedMilliseconds)
            Show-Progress $Label $done $total (($done - $have) * 1000.0 / $ms)
            Write-Host ''
            if ($total -gt 0 -and $done -lt $total) {
                throw ("connection closed early ({0} of {1})" -f (Format-Size $done), (Format-Size $total))
            }
            Move-Item $part $Out -Force
            return
        } catch {
            Write-Host ''
            if ($attempt -ge 6) { throw ("Download failed: {0}`n{1}" -f $Url, $_.Exception.Message) }
            Write-Host ("    network problem: {0}" -f $_.Exception.Message) -ForegroundColor Yellow
            Write-Host ("    retrying in 5s (attempt {0}/6) - it will continue, not restart..." -f ($attempt + 1)) -ForegroundColor Yellow
            Start-Sleep -Seconds 5
        }
    }
}

# بيطلّع ملفات معينة بس من الـzip (أسرع بكتير من Expand-Archive)
function Expand-Files([string]$Zip, [string[]]$Names) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $z = [IO.Compression.ZipFile]::OpenRead($Zip)
    try {
        foreach ($name in $Names) {
            $e = $z.Entries | Where-Object { $_.Name -ieq $name } | Select-Object -First 1
            if (-not $e) { throw "$name not found inside $(Split-Path $Zip -Leaf)" }
            Info ("extracting {0} ({1})" -f $name, (Format-Size $e.Length))
            $target = Join-Path $Dest $name
            [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $target, $true)
            Unblock-File $target -ErrorAction SilentlyContinue
        }
    } finally {
        $z.Dispose()
    }
}

function Install-FromZip([string]$Label, [string]$Url, [string]$ZipName, [string[]]$Names) {
    $zip = Join-Path $Cache $ZipName
    for ($try = 1; $try -le 2; $try++) {
        if (-not (Test-Path $zip)) { Get-File $Url $zip $Label }
        try {
            Expand-Files $zip $Names
            Remove-Item $zip -Force -ErrorAction SilentlyContinue
            return
        } catch {
            Remove-Item $zip -Force -ErrorAction SilentlyContinue
            if ($try -eq 2) { throw }
            Write-Host ("    archive looks broken ({0}), downloading again..." -f $_.Exception.Message) -ForegroundColor Yellow
        }
    }
}

# هل البرنامج ده سليم وبيشتغل؟ (ملف ناقص من تسطيب اتقطع = لأ)
function Test-Exe([string]$Path, [string]$Arg) {
    if (-not (Test-Path $Path)) { return $false }
    $ErrorActionPreference = 'Continue'
    try {
        $null = & $Path $Arg 2>&1
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

try {
    Write-Host 'Hudhud Helper - installer' -ForegroundColor White
    Write-Host "Install folder : $Dest"
    Write-Host "Extension ID   : $ExtensionId"
    Write-Host 'Tip: if you close this window, just run install.bat again - downloads resume.' -ForegroundColor DarkGray
    New-Item -ItemType Directory -Force -Path $Dest, $Cache | Out-Null

    Step 'Helper program'
    $exeSrc = Join-Path $Src 'hudhud-helper.exe'
    if (-not (Test-Path $exeSrc)) {
        $script:NoExe = $true
        throw "hudhud-helper.exe is not in this folder."
    }
    Get-Process -Name 'hudhud-helper' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 300
    $exe = Join-Path $Dest 'hudhud-helper.exe'
    Copy-Item $exeSrc $exe -Force
    Unblock-File $exe -ErrorAction SilentlyContinue
    Ok $exe

    Step 'yt-dlp (~18 MB)'
    $yt = Join-Path $Dest 'yt-dlp.exe'
    if (Test-Exe $yt '--version') {
        Info 'already installed, checking for updates...'
        $ErrorActionPreference = 'Continue'
        & $yt -U 2>&1 | ForEach-Object { Info "$_" }
        $ErrorActionPreference = 'Stop'
    } else {
        Remove-Item $yt -Force -ErrorAction SilentlyContinue
        Get-File $YtUrl $yt 'yt-dlp'
        Unblock-File $yt -ErrorAction SilentlyContinue
    }
    if (-not (Test-Exe $yt '--version')) { throw 'yt-dlp.exe does not run (antivirus?)' }
    Ok ("yt-dlp " + (& $yt --version).Trim())

    Step 'ffmpeg (one time only, the biggest download)'
    $ff = Join-Path $Dest 'ffmpeg.exe'
    if (Test-Exe $ff '-version') {
        Info 'already installed'
    } else {
        Install-FromZip 'ffmpeg' $FfUrl 'ffmpeg.zip' @('ffmpeg.exe', 'ffprobe.exe')
    }
    if (-not (Test-Exe $ff '-version')) { throw 'ffmpeg.exe does not run (antivirus?)' }
    Ok 'ffmpeg ready'

    Step 'Deno (one time only, needed by yt-dlp for YouTube)'
    $deno = Join-Path $Dest 'deno.exe'
    if (Test-Exe $deno '--version') {
        Info 'already installed'
    } else {
        Install-FromZip 'Deno' $DenoUrl 'deno.zip' @('deno.exe')
    }
    if (-not (Test-Exe $deno '--version')) { throw 'deno.exe does not run (antivirus?)' }
    $ErrorActionPreference = 'Continue'
    $denoVer = (& $deno --version 2>&1 | Select-Object -First 1)
    $ErrorActionPreference = 'Stop'
    Ok "$denoVer"

    Step 'Hudhud extension'
    $extSrc = Join-Path $Src 'extension'
    $ext = Join-Path $Dest 'extension'
    $script:FirstExt = $false
    if (Test-Path (Join-Path $extSrc 'manifest.json')) {
        $script:FirstExt = -not (Test-Path (Join-Path $ext 'hudhud-install.json'))
        $idFile = Join-Path $Dest 'install-id'
        if (-not (Test-Path $idFile) -or -not (Get-Content $idFile -Raw).Trim()) {
            [IO.File]::WriteAllText($idFile, [guid]::NewGuid().ToString('N'))
        }
        $installId = (Get-Content $idFile -Raw).Trim()
        # replace the folder's contents (keep the folder itself: Chrome may be using it)
        if (Test-Path $ext) { Get-ChildItem $ext -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue }
        New-Item -ItemType Directory -Force -Path $ext | Out-Null
        Copy-Item (Join-Path $extSrc '*') $ext -Recurse -Force
        $utf8 = New-Object Text.UTF8Encoding $false
        [IO.File]::WriteAllText((Join-Path $ext 'hudhud-install.json'), ('{"id":"' + $installId + '"}'), $utf8)
        $setupSrc = Join-Path $Src 'setup.html'
        if (Test-Path $setupSrc) {
            $html = [IO.File]::ReadAllText($setupSrc, [Text.Encoding]::UTF8).Replace('{{EXT_PATH}}', [Net.WebUtility]::HtmlEncode($ext))
            [IO.File]::WriteAllText((Join-Path $Dest 'setup.html'), $html, $utf8)
        }
        Ok $ext
    } else {
        Info 'no extension folder in this package, skipping'
    }

    Step 'Registering with Chrome, Edge, Brave and Firefox'
    $manifestPath = Join-Path $Dest "$HostName.json"
    $manifest = [ordered]@{
        name            = $HostName
        description     = 'Hudhud Helper (yt-dlp + ffmpeg)'
        path            = $exe
        type            = 'stdio'
        allowed_origins = @("chrome-extension://$ExtensionId/")
    } | ConvertTo-Json
    [IO.File]::WriteAllText($manifestPath, $manifest, (New-Object Text.UTF8Encoding $false))

    $roots = @(
        'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
        'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
        'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts'
    )
    foreach ($root in $roots) {
        $key = Join-Path $root $HostName
        New-Item -Path $key -Value $manifestPath -Force | Out-Null   # (Default) value = manifest path
        Ok $key
    }
    # Firefox: its own manifest format (allowed_extensions)
    $ffManifestPath = Join-Path $Dest "$HostName.firefox.json"
    $ffManifest = [ordered]@{
        name               = $HostName
        description        = 'Hudhud Helper (yt-dlp + ffmpeg)'
        path               = $exe
        type               = 'stdio'
        allowed_extensions = @($GeckoId)
    } | ConvertTo-Json
    [IO.File]::WriteAllText($ffManifestPath, $ffManifest, (New-Object Text.UTF8Encoding $false))
    $ffKey = Join-Path 'HKCU:\Software\Mozilla\NativeMessagingHosts' $HostName
    New-Item -Path $ffKey -Value $ffManifestPath -Force | Out-Null
    Ok $ffKey
    Remove-Item $Cache -Recurse -Force -ErrorAction SilentlyContinue

    Set-Title 'done'
    Write-Host ''
    if ($script:FirstExt) {
        Write-Host 'Done! One last step: add the extension to your browser.' -ForegroundColor Green
        Write-Host "Extension folder (copied to your clipboard): $ext" -ForegroundColor Cyan
        try { Set-Clipboard -Value $ext } catch {}
        $setup = Join-Path $Dest 'setup.html'
        if (Test-Path $setup) { Write-Host 'Opening the setup guide...'; Start-Process $setup }
    } elseif ($ext -and (Test-Path $ext)) {
        Write-Host 'Done! Hudhud was updated. Reload it from chrome://extensions or edge://extensions.' -ForegroundColor Green
    } else {
        Write-Host 'Done! Open the Hudhud popup: it should say the helper is connected.' -ForegroundColor Green
        Write-Host 'If it does not, reload the extension from chrome://extensions or edge://extensions.'
    }
    exit 0
} catch {
    Set-Title 'error'
    Write-Host ''
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    if ($script:NoExe) {
        Write-Host 'This looks like the source code, not the helper download.'
        Write-Host 'Download hudhud-vX.Y.Z-windows.zip from the Releases page, unzip it, and run install.bat from there:'
        Write-Host '  https://github.com/omaressamre/hudhud/releases/latest' -ForegroundColor Cyan
    } else {
        Write-Host 'Check your internet connection / antivirus and run install.bat again (downloads will resume).'
    }
    exit 1
}
