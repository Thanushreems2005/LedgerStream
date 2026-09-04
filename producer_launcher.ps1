param(
    [string]$Rate,        # optional fixed seconds between events
    [int]$Count,          # optional number of events, then stop
    [double]$InjectBad = 0.0  # fraction of events to deliberately malform (DLQ testing)
)

# Consolidated producer launcher. Resolves paths relative to this script so it
# works from anywhere.
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Join-Path $Root "ledgerstream\ledgerstream\producer")

$args = @()
if ($Rate) { $args += "--rate $Rate" }
if ($Count -gt 0) { $args += "--count $Count" }
if ($InjectBad -gt 0) { $args += "--inject-bad $InjectBad" }

Write-Host "[producer] python -u producer.py $args"
& python -u producer.py $args *> (Join-Path $Root "producer.log")
