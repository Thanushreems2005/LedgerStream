# Local dev launcher for the Streamlit dashboard.
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Join-Path $Root "ledgerstream\ledgerstream\dashboard")
& python -m streamlit run dashboard.py --server.headless true --server.port 8501 --browser.gatherUsageStats false *> (Join-Path $Root "dashboard.log")
