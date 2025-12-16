$ErrorActionPreference = "Stop"
$version = "0.182.0"
$pkg = "three"
$tar = "$pkg-$version.tgz"
$url = "https://registry.npmjs.org/$pkg/-/$tar"

Write-Host "Downloading $tar..."
if (-not (Test-Path $tar)) {
    Invoke-WebRequest -Uri $url -OutFile $tar
}

Write-Host "Extracting..."
if (-path "package") { Remove-Item "package" -Recurse -Force }
tar -xf $tar

Write-Host "Searching for WebGPURenderer.js..."
Get-ChildItem -Path "package" -Recurse -Filter "WebGPURenderer.js" | Select-Object FullName

Write-Host "Searching for Nodes.js..."
Get-ChildItem -Path "package" -Recurse -Filter "Nodes.js" | Select-Object FullName

Write-Host "Listing examples/jsm folders..."
Get-ChildItem -Path "package/examples/jsm" -Directory | Select-Object Name
