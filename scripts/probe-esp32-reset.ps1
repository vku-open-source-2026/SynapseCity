# SPDX-License-Identifier: Apache-2.0
# Try common CP2102 DTR/RTS auto-reset sequences and probe the ESP32 ROM.
$et = Join-Path $env:LOCALAPPDATA 'Arduino15\packages\esp32\tools\esptool_py\5.3.1\esptool.exe'
$sequences = @(
    @{ name = 'B-esptool'; steps = @(@($false,$true,150), @($true,$false,150), @($false,$false,100)) },
    @{ name = 'A-both-then-rts'; steps = @(@($true,$true,150), @($false,$true,150), @($false,$false,100)) },
    @{ name = 'C-both-then-dtr'; steps = @(@($true,$true,150), @($true,$false,150), @($false,$false,100)) },
    @{ name = 'D-rts-then-dtr'; steps = @(@($false,$true,150), @($true,$true,150), @($true,$false,150), @($false,$false,100)) },
    @{ name = 'E-inverted-esptool'; steps = @(@($true,$false,150), @($false,$true,150), @($true,$true,100)) },
    @{ name = 'F-pulse'; steps = @(@($true,$true,100), @($false,$false,100), @($true,$true,100), @($false,$true,100), @($false,$false,100)) }
)
foreach ($sequence in $sequences) {
    Write-Host "=== $($sequence.name) ==="
    try {
        $port = New-Object System.IO.Ports.SerialPort 'COM3',115200,'None',8,'One'
        $port.Open()
        foreach ($step in $sequence.steps) {
            $port.DtrEnable = [bool]$step[0]
            $port.RtsEnable = [bool]$step[1]
            Start-Sleep -Milliseconds $step[2]
        }
        $port.Close()
    } catch {
        Write-Host "serial error: $($_.Exception.Message)"
        continue
    }
    Start-Sleep -Milliseconds 300
    $out = & $et --port COM3 --before no-reset --after no-reset chip-id 2>&1
    $text = ($out | Out-String)
    if ($text -match 'Chip is|Chip type|Detecting chip') {
        Write-Host 'SUCCESS'
        $text -split "`n" | Select-String -Pattern 'Chip|MAC|Hard resetting' | ForEach-Object { $_.Line.Trim() }
        break
    }
    Write-Host (($text -split "`n" | Select-String -Pattern 'Wrong boot|No serial|Failed to connect' | Select-Object -First 1).Line.Trim())
}
