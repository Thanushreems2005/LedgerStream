Set-Location 'C:\my_projects_main\LedgerStream\ledgerstream\ledgerstream\producer'; & python -u producer.py --rate 0.01 --count 1000 *> 'C:\my_projects_main\LedgerStream\producer_burst.log'
