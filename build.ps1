param(
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$Python = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) {
    Write-Host "[MusicKey] Creating build venv..."
    python -m venv .venv
}

& $Python -m pip install --upgrade pip
& $Python -m pip install -r requirements.txt pyinstaller imageio-ffmpeg
if (-not $SkipTests) {
    & $Python -m pytest tests -q
}

$Ffmpeg = & $Python -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"
if ($LASTEXITCODE -ne 0 -or -not $Ffmpeg) {
    throw "Unable to locate bundled ffmpeg"
}
New-Item -ItemType Directory -Force -Path (Join-Path $Root "build_assets") | Out-Null
Copy-Item -LiteralPath $Ffmpeg -Destination (Join-Path $Root "build_assets\ffmpeg.exe") -Force

$Common = @(
    "--noconfirm",
    "--clean",
    "--onefile",
    "--name", "MusicKey",
    "--add-data", "$Root\musickey\webui;musickey\webui",
    "--add-data", "$Root\musickey\assets;musickey\assets",
    "--add-data", "$Root\build_assets;build_assets",
    "--collect-all", "mutagen",
    "--collect-all", "Crypto",
    "--hidden-import", "werkzeug.serving"
)

Write-Host "[MusicKey] Building web one-file version..."
& $Python -m PyInstaller @Common --noconsole "$Root\run.py"
if ($LASTEXITCODE -ne 0) { throw "Web build failed" }

Write-Host "[MusicKey] Building CLI one-file version..."
& $Python -m PyInstaller @Common --console --name "MusicKey-CLI" "$Root\cli_entry.py"
if ($LASTEXITCODE -ne 0) { throw "CLI build failed" }

Write-Host ""
Write-Host "[MusicKey] Build complete:"
Get-ChildItem (Join-Path $Root "dist") | ForEach-Object { Write-Host "  $($_.FullName)" }
