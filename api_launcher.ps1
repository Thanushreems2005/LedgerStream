# Local dev launcher for the Express API server.
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Join-Path $Root "ledgerstream\ledgerstream\api")
& node server.js *> (Join-Path $Root "api.log")
