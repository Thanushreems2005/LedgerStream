Set-Location "C:\my_projects_main\LedgerStream\ledgerstream\ledgerstream\producer"
& python -u producer.py --inject-bad 0.05 *> "C:\my_projects_main\LedgerStream\producer_all.log"