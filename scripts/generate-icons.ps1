param(
    [string]$MagickPath = 'magick',
    [string]$BrowserPath = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$logo = Join-Path $root 'logo.svg'
$icons = Join-Path $root 'icons'
New-Item -ItemType Directory -Path $icons -Force | Out-Null

function Convert-Image([string[]]$Arguments) {
    & $MagickPath @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'ImageMagick icon generation failed' }
}

$tempDir = Join-Path ([IO.Path]::GetTempPath()) ('bigreplay-icons-' + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $tempDir | Out-Null
try {
    # Chromium supports SVG use/clipPath semantics that ImageMagick's SVG delegates do not.
    $html = Join-Path $tempDir 'logo.html'
    $raster = Join-Path $tempDir 'logo.png'
    $source = [Net.WebUtility]::HtmlEncode(([uri]$logo).AbsoluteUri)
    [IO.File]::WriteAllText($html, "<!doctype html><style>body{margin:0}img{display:block;width:100vw;height:100vh;object-fit:contain}</style><img src=`"$source`">")
    $browser = Start-Process -FilePath $BrowserPath -ArgumentList @(
        '--headless', '--no-first-run', '--no-default-browser-check',
        '--force-device-scale-factor=1', '--window-size=2048,2048', '--hide-scrollbars',
        '--default-background-color=00000000', "--user-data-dir=`"$tempDir\profile`"",
        "--screenshot=`"$raster`"", ([uri]$html).AbsoluteUri
    ) -Wait -PassThru
    if ($browser.ExitCode -ne 0) { throw 'Chromium SVG rendering failed' }

    # Trim the browser canvas, retaining the full silhouette and both outlines.
    Convert-Image @($raster, '-trim', '+repage', $raster)
    foreach ($size in @(192, 512)) {
        $inner = [int][Math]::Round($size * 0.9)
        Convert-Image @($raster, '-resize', "${inner}x${inner}", '-background', 'none',
            '-gravity', 'center', '-extent', "${size}x${size}", '-strip',
            '-define', 'png:color-type=6', (Join-Path $icons "icon-$size.png"))
    }

    # One multi-resolution icon serves both the Windows executable and browser fallback.
    Convert-Image @((Join-Path $icons 'icon-512.png'), '-define', 'icon:png-compression-size=16',
        '-define', 'icon:auto-resize=256,128,96,64,48,40,32,24,20,16', (Join-Path $root 'favicon.ico'))

    # iOS expects an opaque touch icon; use the viewer's background rather than black.
    Convert-Image @((Join-Path $icons 'icon-512.png'), '-resize', '156x156',
        '-background', '#151a23', '-gravity', 'center', '-extent', '180x180',
        '-alpha', 'remove', '-alpha', 'off', '-strip', (Join-Path $icons 'apple-touch-icon.png'))

    # Inno Setup uses a 164:314 portrait panel. Render at 4x for high-DPI displays.
    Convert-Image @($raster, '-resize', '500x1000', '-background', '#151a23',
        '-gravity', 'center', '-extent', '656x1256', '-alpha', 'remove', '-alpha', 'off',
        '-strip', (Join-Path $icons 'installer-panel.png'))
}
finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force
}
