# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
# Compile and upload the generated culvert sketch to the attached ESP32.
# The sketch is intentionally outside git because it contains the WiFi password.
$ErrorActionPreference = 'Stop'
$cli = Join-Path $env:USERPROFILE 'Tools\arduino-cli\arduino-cli.exe'
if (-not (Test-Path $cli)) {
    throw "arduino-cli not found at $cli. Run the toolchain setup first."
}
$sketchDir = Join-Path $PSScriptRoot '..\firmware\CONG_NC_001_WL_esp32_water_level_jsn'
$buildDir = Join-Path $PSScriptRoot '..\firmware\build'
$sketch = Join-Path $sketchDir 'CONG_NC_001_WL_esp32_water_level_jsn.ino'
if (-not (Test-Path $sketch)) {
    throw "Sketch not found at $sketch. Generate it at https://synapsecity.sbs/iot first."
}

Write-Host 'Compiling...'
New-Item -ItemType Directory -Force $buildDir | Out-Null
& $cli compile --fqbn esp32:esp32:esp32 --output-dir $buildDir $sketchDir
if ($LASTEXITCODE -ne 0) { throw 'Compile failed.' }

$ports = & $cli board list --format json | ConvertFrom-Json
$candidates = @($ports.detected_ports | Where-Object { $_.port.address })
if ($candidates.Count -eq 0) {
    Write-Host ''
    Write-Host 'No serial board detected.' -ForegroundColor Yellow
    Write-Host 'If the CP2102 shows an error in Device Manager, install the driver:'
    Write-Host '  powershell -ExecutionPolicy Bypass -File .\scripts\install-cp210x.ps1'
    Write-Host 'Then reconnect the ESP32 and run this script again.'
    exit 2
}
$port = $candidates[0].port.address
Write-Host "Uploading to $port ..."
& $cli upload -p $port --fqbn esp32:esp32:esp32 $buildDir
if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host 'Auto-reset did not enter download mode (this board does not wire DTR to GPIO0).' -ForegroundColor Yellow
    Write-Host 'Hold the BOOT button, tap RST/EN once, then release BOOT while the watcher runs.'
    & (Join-Path $PSScriptRoot 'flash-when-bootloader.ps1')
    exit $LASTEXITCODE
}
Write-Host ''
Write-Host "Uploaded. Open the serial monitor with:" -ForegroundColor Green
Write-Host "  & '$cli' monitor -p $port -c baudrate=115200"
