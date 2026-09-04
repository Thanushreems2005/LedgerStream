# Local dev launcher for the Vite React frontend (dev server).
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Join-Path $Root "ledgerstream\ledgerstream\frontend")
& npm run dev *> (Join-Path $Root "frontend.log")
