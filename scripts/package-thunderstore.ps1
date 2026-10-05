<#
.SYNOPSIS
    Builds the Thunderstore package for Big Replay: the launcher plugin plus the
    standalone Big Replay payload.

.DESCRIPTION
    Thunderstore requires manifest.json, icon.png (exactly 256x256) and README.md at the
    root of the zip, with the payload laid out as it lands in the profile. Our layout:

        manifest.json                          <- Thunderstore manifest
        icon.png
        README.md
        CHANGELOG.md
        BepInEx/plugins/BigWalk.ReplayLauncher.dll
        BigReplay/BigReplay.exe                <- standalone app, still a separate process
        BigReplay/manifest.json                <- game-offsets manifest the app reads

    Note the deliberate nesting: the app's own manifest.json must NOT sit at the zip root,
    because that name is reserved for Thunderstore's package metadata.

    Upload the resulting zip at https://thunderstore.io/c/big-walk/create/ (team: <Author>).
    Thunderstore never accepts a repeated version_number - bump <Version> in
    src/BigReplay.Desktop/BigReplay.Desktop.csproj for every upload.
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$Author = 'iameli',
    [string]$PackageName = 'Big_Replay',
    [string]$WebsiteUrl = 'https://github.com/iameli/big-replay',
    [string]$Description = 'Auto-starts the standalone Big Replay recorder next to a modded Big Walk launch (read-only; not for validated runs).',
    [string]$Dependency = 'BepInEx-BepInExPack_IL2CPP-6.0.755',
    [string]$DesktopPayload = 'dist/BigReplay',
    [string]$PluginDll = '..\big-walk-speedrun-tools\mods\BigWalk.ReplayLauncher\bin\Release\BigWalk.ReplayLauncher.dll',
    [string]$PluginProject = '..\big-walk-speedrun-tools\mods\BigWalk.ReplayLauncher\BigWalk.ReplayLauncher.csproj',
    [string]$Profile = "$env:APPDATA\r2modmanPlus-local\BigWalk\profiles\Default",
    [string]$OutputDir = 'dist'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
Add-Type -AssemblyName System.Drawing

function Resolve-RepoPath([string]$path) {
    if ([IO.Path]::IsPathRooted($path)) { return $path }
    return [IO.Path]::GetFullPath((Join-Path $root $path))
}

# ---- version: single source of truth is the Desktop csproj -------------------------------
if (-not $Version) {
    $csproj = Join-Path $root 'src\BigReplay.Desktop\BigReplay.Desktop.csproj'
    [xml]$xml = Get-Content $csproj
    $Version = ($xml.Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1) -as [string]
    if (-not $Version) { throw "No <Version> in $csproj; pass -Version explicitly." }
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Version must be Major.Minor.Patch (got '$Version')."
}
if ($PackageName -notmatch '^[A-Za-z0-9_]+$') {
    throw "Package name may only contain letters, digits and underscores (got '$PackageName')."
}
if ($Description.Length -gt 250) {
    throw "Description must be 250 characters or fewer (got $($Description.Length))."
}

# ---- inputs -------------------------------------------------------------------------------
$desktopPayload = Resolve-RepoPath $DesktopPayload
$exe = Join-Path $desktopPayload 'BigReplay.exe'
$gameManifest = Join-Path $desktopPayload 'manifest.json'
foreach ($required in @($exe, $gameManifest)) {
    if (-not (Test-Path $required)) {
        throw "Missing $required - publish the desktop app first: dotnet publish src/BigReplay.Desktop -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=None -o $DesktopPayload"
    }
}

$pluginDll = Resolve-RepoPath $PluginDll
if (-not (Test-Path $pluginDll)) {
    $pluginProject = Resolve-RepoPath $PluginProject
    Write-Host "Launcher plugin not built yet; building it against $Profile ..."
    & dotnet build $pluginProject -c Release -v m "/p:GamePath=$Profile"
    if ($LASTEXITCODE -ne 0) { throw 'Launcher plugin build failed.' }
}
if (-not (Test-Path $pluginDll)) { throw "Launcher plugin DLL still missing: $pluginDll" }

$icon = Join-Path $root 'icons\icon-256.png'
if (-not (Test-Path $icon)) {
    # Self-heal from the 512px asset so packaging never depends on a specific image toolchain.
    $source = Join-Path $root 'icons\icon-512.png'
    if (-not (Test-Path $source)) { throw "Need icons\icon-256.png or icons\icon-512.png to build the package icon." }
    $src = [System.Drawing.Image]::FromFile($source)
    try {
        $bmp = New-Object System.Drawing.Bitmap 256, 256
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.DrawImage($src, 0, 0, 256, 256)
        $g.Dispose()
        $bmp.Save($icon, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
    } finally {
        $src.Dispose()
    }
    Write-Host "Generated $icon from icon-512.png"
}
$iconImage = [System.Drawing.Image]::FromFile($icon)
try {
    if ($iconImage.Width -ne 256 -or $iconImage.Height -ne 256) {
        throw "icon.png must be exactly 256x256 (got $($iconImage.Width)x$($iconImage.Height))."
    }
} finally {
    $iconImage.Dispose()
}

$readme = Join-Path $root 'installer\thunderstore\README.md'
$changelog = Join-Path $root 'installer\thunderstore\CHANGELOG.md'
foreach ($asset in @($readme, $changelog)) {
    if (-not (Test-Path $asset)) { throw "Missing package asset: $asset" }
}

# ---- stage --------------------------------------------------------------------------------
$output = Resolve-RepoPath $OutputDir
$stage = Join-Path $output 'thunderstore\stage'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $stage 'BepInEx\plugins') | Out-Null
New-Item -ItemType Directory -Force (Join-Path $stage 'BigReplay') | Out-Null

[ordered]@{
    name           = $PackageName
    version_number = $Version
    website_url    = $WebsiteUrl
    description    = $Description
    dependencies   = @($Dependency)
} | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $stage 'manifest.json') -Encoding UTF8

Copy-Item $icon (Join-Path $stage 'icon.png') -Force
Copy-Item $readme (Join-Path $stage 'README.md') -Force
Copy-Item $changelog (Join-Path $stage 'CHANGELOG.md') -Force
Copy-Item $pluginDll (Join-Path $stage 'BepInEx\plugins\') -Force
Copy-Item (Join-Path $desktopPayload '*') (Join-Path $stage 'BigReplay\') -Recurse -Force

# ---- zip (contents at the root, never wrapped in a folder) --------------------------------
$zip = Join-Path $output "$Author-$PackageName-$Version.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal

# ---- report -------------------------------------------------------------------------------
$sizeMb = [Math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host ''
Write-Host "Thunderstore package ready: $zip ($sizeMb MB)"
Write-Host ''
Write-Host 'Layout:'
Get-ChildItem $stage -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($stage.Length + 1)
    Write-Host ("  {0,-52} {1,10:N0} bytes" -f $relative, $_.Length)
}
Write-Host ''
Write-Host "Upload: https://thunderstore.io/c/big-walk/create/  (team: $Author, version $Version)"
Write-Host 'Remember: Thunderstore rejects a version_number it has already seen - bump <Version> first.'