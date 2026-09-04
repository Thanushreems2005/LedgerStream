# Local dev launcher for the ledger consumer (the inline risk engine).
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Join-Path $Root "ledgerstream\ledgerstream\consumer")
& python -u ledger_consumer.py *> (Join-Path $Root "consumer_all.log")
