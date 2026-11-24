# SPDX-License-Identifier: Apache-2.0
# Probe DTR/RTS mappings while reading the ESP32 boot-mode line.
$sequences = @(
    @{ name = 'A f/t -> t/t -> t/f'; steps = @(@($false,$true,120), @($true,$true,120), @($true,$false,120)) },
    @{ name = 'B t/f -> t/t -> f/t'; steps = @(@($true,$false,120), @($true,$true,120), @($false,$true,120)) },
    @{ name = 'C t/f -> f/f -> f/t'; steps = @(@($true,$false,120), @($false,$false,120), @($false,$true,120)) },
    @{ name = 'D f/t -> f/f -> t/f'; steps = @(@($false,$true,120), @($false,$false,120), @($true,$false,120)) },
    @{ name = 'E t/t -> f/t -> f/f'; steps = @(@($true,$true,120), @($false,$true,120), @($false,$false,120)) },
    @{ name = 'F t/t -> t/f -> f/f'; steps = @(@($true,$true,120), @($true,$false,120), @($false,$false,120)) },
    @{ name = 'G f/f -> t/f -> t/t'; steps = @(@($false,$false,120), @($true,$false,120), @($true,$true,120)) },
    @{ name = 'H f/f -> f/t -> t/t'; steps = @(@($false,$false,120), @($false,$true,120), @($true,$true,120)) },
    @{ name = 'I t/f -> f/f -> f/t -> f/f'; steps = @(@($true,$false,120), @($false,$false,120), @($false,$true,120), @($false,$false,120)) },
    @{ name = 'J f/t -> t/f -> t/t'; steps = @(@($false,$true,120), @($true,$false,120), @($true,$true,120)) }
)
foreach ($seq in $sequences) {
    try {
        $port = New-Object System.IO.Ports.SerialPort 'COM3',115200,'None',8,'One'
        $port.ReadTimeout = 1500
        $port.Open()
        $port.DtrEnable = $false
        $port.RtsEnable = $false
        Start-Sleep -Milliseconds 250
        foreach ($step in $seq.steps) {
            $port.DtrEnable = [bool]$step[0]
            $port.RtsEnable = [bool]$step[1]
            Start-Sleep -Milliseconds $step[2]
        }
        Start-Sleep -Milliseconds 500
        $text = $port.ReadExisting()
        $port.Close()
        $line = ($text -split "`n" | Select-String -Pattern 'boot:0x' | Select-Object -First 1)
        if ($line) { Write-Host "$($seq.name): $($line.Line.Trim())" } else { Write-Host "$($seq.name): (no boot line)" }
    } catch {
        Write-Host "$($seq.name): serial error $($_.Exception.Message)"
    }
    Start-Sleep -Milliseconds 500
}
