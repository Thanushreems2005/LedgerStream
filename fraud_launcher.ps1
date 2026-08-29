Set-Location "C:\my_projects_main\LedgerStream\ledgerstream\ledgerstream\fraud"
& python -u fraud_consumer.py --threshold 0.96 *> "C:\my_projects_main\LedgerStream\fraud_consumer.log"