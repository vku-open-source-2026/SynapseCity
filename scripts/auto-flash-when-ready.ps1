# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
# Wait for the CP210x/CH340 driver to expose a COM port, then upload the
# generated culvert sketch automatically. Intended for the one-time UAC step:
# start this hidden, approve the driver prompt, and the upload follows.
$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'synapse-sync\auto-flash.log'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
function Log([string]$message) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $message
    Add-Content -Path $log -Value $line -Encoding utf8
}
$cli = Join-Path $env:USERPROFILE 'Tools\arduino-cli\arduino-cli.exe'
$sketchDir = Join-Path $PSScriptRoot '..\firmware\CONG_NC_001_WL_esp32_water_level_jsn'
$sketch = Join-Path $sketchDir 'CONG_NC_001_WL_esp32_water_level_jsn.ino'
Log 'auto-flash watcher started'
if (-not (Test-Path $cli)) { Log "arduino-cli missing: $cli"; exit 2 }
if (-not (Test-Path $sketch)) { Log "sketch missing: $sketch"; exit 2 }

$deadline = (Get-Date).AddMinutes(45)
while ((Get-Date) -lt $deadline) {
    $ports = @()
    try {
        $raw = & $cli board list --format json 2>$null | ConvertFrom-Json
        $ports = @($raw.detected_ports | Where-Object { $_.port.address })
    } catch {
        Log "board list failed: $($_.Exception.Message)"
    }
    if ($ports.Count -gt 0) {
        $port = $ports[0].port.address
        Log "serial port detected: $port ($($ports[0].matching_boards[0].name))"
        Log 'compiling...'
        & $cli compile --fqbn esp32:esp32:esp32 $sketchDir *>> $log
        Log "compile exit=$LASTEXITCODE"
        if ($LASTEXITCODE -eq 0) {
            Log "uploading to $port ..."
            & $cli upload -p $port --fqbn esp32:esp32:esp32 $sketchDir *>> $log
            Log "upload exit=$LASTEXITCODE"
            if ($LASTEXITCODE -eq 0) {
                Log 'UPLOAD_OK'
                exit 0
            }
        }
    }
    Start-Sleep -Seconds 5
}
Log 'timeout: no COM port appeared (driver not installed?)'
exit 3
