# Local dev launcher for the fraud consumer (independent monitoring group).
# Uses the same central risk thresholds from .env; no hardcoded thresholds here.
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Join-Path $Root "ledgerstream\ledgerstream\fraud")
& python -u fraud_consumer.py *> (Join-Path $Root "fraud_consumer.log")
