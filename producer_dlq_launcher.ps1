Set-Location "C:\my_projects_main\LedgerStream\ledgerstream\ledgerstream\producer"
& python -u producer.py --inject-bad 0.1 *> "C:\my_projects_main\LedgerStream\producer_dlq.log"