# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
# The CP2102 on this board only wires EN/RTS, not GPIO0/DTR, so auto-reset
# cannot enter download mode. Hold BOOT, tap RST/EN, release BOOT; this loop
# attempts the real write (not a probe) so the first connection uploads.
$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'synapse-sync\bootloader-flash.log'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
function Log([string]$m) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding utf8 }
$esptool = Join-Path $env:LOCALAPPDATA 'Arduino15\packages\esp32\tools\esptool_py\5.3.1\esptool.exe'
$build = Join-Path $PSScriptRoot '..\firmware\build'
$bootloader = Join-Path $build 'CONG_NC_001_WL_esp32_water_level_jsn.ino.bootloader.bin'
$partitions = Join-Path $build 'CONG_NC_001_WL_esp32_water_level_jsn.ino.partitions.bin'
$app = Join-Path $build 'CONG_NC_001_WL_esp32_water_level_jsn.ino.bin'
$bootapp = Join-Path $env:LOCALAPPDATA 'Arduino15\packages\esp32\hardware\esp32\4.0.0\tools\partitions\boot_app0.bin'
foreach ($file in @($esptool,$bootloader,$partitions,$app,$bootapp)) {
    if (-not (Test-Path $file)) { Log "missing: $file"; exit 2 }
}
Log 'bootloader write loop started; waiting for BOOT+RST'
$deadline = (Get-Date).AddMinutes(30)
$attempt = 0
while ((Get-Date) -lt $deadline) {
    $attempt += 1
    Log "write attempt $attempt"
    $out = & $esptool --port COM3 --connect-attempts 1 --before no-reset --after hard-reset write-flash -z `
        --flash-mode keep --flash-freq keep --flash-size keep `
        0x1000 $bootloader 0x8000 $partitions 0xe000 $bootapp 0x10000 $app 2>&1 | Out-String
    $code = $LASTEXITCODE
    if ($out -match 'Chip is') {
        Log (($out -split "`n" | Select-String -Pattern 'Chip is|Wrote |Hash of data verified|Hard resetting' | ForEach-Object { $_.Line.Trim() }) -join ' | ')
    }
    Log "write exit=$code"
    if ($code -eq 0) { Log 'UPLOAD_OK'; exit 0 }
    Start-Sleep -Seconds 2
}
Log 'UPLOAD_TIMEOUT'
exit 3
