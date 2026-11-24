# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
# Elevated helper: install the signed CP210x driver and rescan the device.
$log = Join-Path $env:TEMP 'synapse-sync\cp210x-install.log'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
"=== $(Get-Date -Format o) ===" | Out-File $log -Encoding utf8
$inf = Join-Path $env:USERPROFILE 'Tools\drivers\CP210x\slabvcp.inf'
if (-not (Test-Path $inf)) {
    "INF missing: $inf" | Out-File $log -Append -Encoding utf8
    exit 2
}
& pnputil.exe /add-driver $inf /install *>&1 | Out-File $log -Append -Encoding utf8
"ADD_DRIVER_EXIT=$LASTEXITCODE" | Out-File $log -Append -Encoding utf8
& pnputil.exe /scan-devices *>&1 | Out-File $log -Append -Encoding utf8
"SCAN_EXIT=$LASTEXITCODE" | Out-File $log -Append -Encoding utf8
Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like 'USB\VID_10C4*' } |
    Select-Object Status, Class, FriendlyName, InstanceId |
    Out-File $log -Append -Encoding utf8
Get-CimInstance Win32_SerialPort -ErrorAction SilentlyContinue |
    Select-Object DeviceID, Name |
    Out-File $log -Append -Encoding utf8
