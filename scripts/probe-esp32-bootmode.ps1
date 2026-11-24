# SPDX-License-Identifier: Apache-2.0
# Print the ESP32 boot-mode line for several DTR/RTS sequences.
$sequences = @(
    @{ name = '1 baseline'; steps = @(@($false,$true,100), @($false,$false,100)) },
    @{ name = '2 both-then-rts'; steps = @(@($true,$true,100), @($false,$true,100), @($false,$false,100)) },
    @{ name = '3 dtr-then-rts'; steps = @(@($true,$false,100), @($false,$true,100), @($false,$false,100)) },
    @{ name = '4 both-dtr-rts'; steps = @(@($true,$true,100), @($true,$false,100), @($false,$true,100), @($false,$false,100)) },
    @{ name = '5 both-rts-rts'; steps = @(@($true,$true,100), @($false,$true,100), @($false,$false,100)) },
    @{ name = '6 rts-both-rts'; steps = @(@($false,$true,100), @($true,$true,100), @($false,$false,100)) },
    @{ name = '7 pulse'; steps = @(@($false,$true,100), @($true,$false,100), @($true,$true,100), @($false,$false,100)) },
    @{ name = '8 dtr-idle-rts'; steps = @(@($true,$false,100), @($false,$false,100), @($false,$true,100), @($false,$false,100)) }
)
foreach ($sequence in $sequences) {
    try {
        $port = New-Object System.IO.Ports.SerialPort 'COM3',115200,'None',8,'One'
        $port.ReadTimeout = 1500
        $port.Open()
        $port.DtrEnable = $false
        $port.RtsEnable = $false
        Start-Sleep -Milliseconds 300
        foreach ($step in $sequence.steps) {
            $port.DtrEnable = [bool]$step[0]
            $port.RtsEnable = [bool]$step[1]
            Start-Sleep -Milliseconds $step[2]
        }
        Start-Sleep -Milliseconds 500
        $text = $port.ReadExisting()
        $port.Close()
        $line = ($text -split "`n" | Select-String -Pattern 'boot:0x' | Select-Object -First 1)
        if ($line) { Write-Host "$($sequence.name): $($line.Line.Trim())" }
        else { Write-Host "$($sequence.name): (no boot line) $($text.Length) bytes" }
    } catch {
        Write-Host "$($sequence.name): serial error $($_.Exception.Message)"
    }
    Start-Sleep -Milliseconds 500
}
