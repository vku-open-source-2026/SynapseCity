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
$sketch = Join-Path $sketchDir 'CONG_NC_001_WL_esp32_water_level_jsn.ino'
if (-not (Test-Path $sketch)) {
    throw "Sketch not found at $sketch. Generate it at https://synapsecity.sbs/iot first."
}

Write-Host 'Compiling...'
& $cli compile --fqbn esp32:esp32:esp32 $sketchDir
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
& $cli upload -p $port --fqbn esp32:esp32:esp32 $sketchDir
if ($LASTEXITCODE -ne 0) { throw 'Upload failed.' }
Write-Host ''
Write-Host "Uploaded. Open the serial monitor with:" -ForegroundColor Green
Write-Host "  & '$cli' monitor -p $port -c baudrate=115200"
