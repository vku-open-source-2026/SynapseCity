# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
# Install the Silicon Labs CP210x VCP driver. Run from an elevated PowerShell
# (right-click -> Run as Administrator), then reconnect the ESP32.
$ErrorActionPreference = 'Stop'
$inf = Join-Path $env:USERPROFILE 'Tools\drivers\CP210x\slabvcp.inf'
if (-not (Test-Path $inf)) {
    throw "Driver not found at $inf. The signed CP210x package must exist first."
}
Write-Host "Installing $inf ..."
& pnputil.exe /add-driver $inf /install
Write-Host 'Done. Reconnect the ESP32 and check Device Manager -> Ports (COM & LPT).'
