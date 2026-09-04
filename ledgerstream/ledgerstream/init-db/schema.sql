-- LedgerStream schema
-- accounts: current balance per account
CREATE TABLE IF NOT EXISTS accounts (
    account_id   VARCHAR(32) PRIMARY KEY,
    balance      NUMERIC(15, 2) NOT NULL CHECK (balance >= 0)
);

-- processed_events: idempotency guard. UNIQUE on event_id is what
-- makes double-processing impossible even under Kafka redelivery.
CREATE TABLE IF NOT EXISTS processed_events (
    event_id      VARCHAR(64) PRIMARY KEY,
    status        VARCHAR(16) NOT NULL,       -- 'applied' | 'failed'
    processed_at  TIMESTAMP NOT NULL DEFAULT now()
);

-- transactions_log: full audit trail, one row per attempted transfer
CREATE TABLE IF NOT EXISTS transactions_log (
    id            SERIAL PRIMARY KEY,
    event_id      VARCHAR(64) NOT NULL,
    from_account  VARCHAR(32) NOT NULL,
    to_account    VARCHAR(32) NOT NULL,
    amount        NUMERIC(15, 2) NOT NULL,
    status        VARCHAR(16) NOT NULL,        -- 'applied' | 'failed' | 'dlq'
    error_reason  TEXT,
    risk_score    NUMERIC(5, 4),
    risk_level    VARCHAR(16),
    reasons       VARCHAR(256),
    created_at    TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_txlog_from ON transactions_log(from_account);
CREATE INDEX IF NOT EXISTS idx_txlog_to ON transactions_log(to_account);
CREATE INDEX IF NOT EXISTS idx_txlog_created ON transactions_log(created_at);

-- seed accounts
INSERT INTO accounts (account_id, balance) VALUES
    ('ACC001', 50000.00),
    ('ACC002', 30000.00),
    ('ACC003', 75000.00),
    ('ACC004', 12000.00),
    ('ACC005', 90000.00),
    ('ACC006', 5000.00),
    ('ACC007', 60000.00),
    ('ACC008', 25000.00)
ON CONFLICT (account_id) DO NOTHING;
