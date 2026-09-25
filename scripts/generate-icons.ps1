param([string]$MagickPath = 'magick')

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$logo = Join-Path $root 'logo.svg'
$icons = Join-Path $root 'icons'
New-Item -ItemType Directory -Path $icons -Force | Out-Null

function Convert-Image([string[]]$Arguments) {
    & $MagickPath @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'ImageMagick icon generation failed' }
}

# Preserve the portrait artwork on a transparent square, with a small safety margin.
foreach ($size in @(192, 512)) {
    $inner = [int][Math]::Round($size * 0.9)
    Convert-Image @('-background', 'none', '-density', '384', $logo,
        '-resize', "${inner}x${inner}", '-gravity', 'center', '-extent', "${size}x${size}",
        '-strip', '-define', 'png:color-type=6', (Join-Path $icons "icon-$size.png"))
}

# One multi-resolution icon serves both the Windows executable and browser fallback.
Convert-Image @((Join-Path $icons 'icon-512.png'), '-define', 'icon:png-compression-size=16',
    '-define', 'icon:auto-resize=256,128,96,64,48,40,32,24,20,16', (Join-Path $root 'favicon.ico'))

# iOS expects an opaque touch icon; use the viewer's background rather than black.
Convert-Image @((Join-Path $icons 'icon-512.png'), '-resize', '156x156',
    '-background', '#151a23', '-gravity', 'center', '-extent', '180x180',
    '-alpha', 'remove', '-alpha', 'off', '-strip', (Join-Path $icons 'apple-touch-icon.png'))

# Inno Setup uses a 164:314 portrait panel. Render at 4x for high-DPI displays.
Convert-Image @('-background', 'none', '-density', '384', $logo, '-resize', '500x1000',
    '-background', '#151a23', '-gravity', 'center', '-extent', '656x1256',
    '-alpha', 'remove', '-alpha', 'off', '-strip', (Join-Path $icons 'installer-panel.png'))
