$ErrorActionPreference = "Stop"
$version = "0.182.0"
$pkg = "three"
$tar = "$pkg-$version.tgz"
$url = "https://registry.npmjs.org/$pkg/-/$tar"
$projectRoot = "$PSScriptRoot\.." 
$dest = "$projectRoot\scripts\imported\three"

Write-Host "------------------------------------------------"
Write-Host "Three.js Upgrader (v$version)"
Write-Host "------------------------------------------------"

# 1. Download
Write-Host "[1/4] Downloading from NPM Registry..."
try {
    Invoke-WebRequest -Uri $url -OutFile $tar
} catch {
    Write-Error "Failed to download $url. Check connection."
    exit 1
}

# 2. Extract
Write-Host "[2/4] Extracting tarball..."
try {
    # Windows 10/11 includes 'tar.exe' by default
    tar -xf $tar
} catch {
    Write-Error "Failed to extract. Ensure 'tar' is in your PATH."
    exit 1
}

# 3. Update Core
Write-Host "[3/4] Updating files in '$dest'..."

# Core
Write-Host "  -> Updating three.module.js"
Copy-Item "package/build/three.module.js" -Destination "$dest/three.module.js" -Force

# Addons
$addons = @("renderers", "nodes", "gpgpu")
$addonDest = "$dest/addons"

foreach ($addon in $addons) {
    if (Test-Path "package/examples/jsm/$addon") {
        Write-Host "  -> Updating addon: $addon"
        # Remove old directory to ensure clean state
        if (Test-Path "$addonDest/$addon") {
            Remove-Item "$addonDest/$addon" -Recurse -Force
        }
        Copy-Item -Recurse "package/examples/jsm/$addon" -Destination "$addonDest" -Force
    } else {
        Write-Warning "  [!] Addon '$addon' not found in package!"
    }
}

# 4. Cleanup
Write-Host "[4/4] Cleaning up..."
Remove-Item $tar -Force
if (Test-Path "package") {
    Remove-Item "package" -Recurse -Force
}

Write-Host "------------------------------------------------"
Write-Host "SUCCESS: Three.js upgraded to r$version"
Write-Host "------------------------------------------------"
