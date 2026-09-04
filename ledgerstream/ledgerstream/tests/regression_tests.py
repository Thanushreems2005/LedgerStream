import sys
import os
import time
import unittest
import psycopg2
import numpy as np
import requests

# Add sibling directories to path for imports
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "consumer")))
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "fraud")))

import ledger_consumer  # type: ignore
import fraud_consumer   # type: ignore
from features import build_feature_vector as pure_build_feature_vector, FEATURE_NAMES  # type: ignore

API_BASE_URL = os.environ.get("API_BASE_URL", "http://localhost:3001/api")


def _fetch_scalar(cur, index: int = 0):
    """Fetch a single column value from the current cursor row.

    Cursor.fetchone() may return None; raise a clear assertion error in that
    case instead of failing with an opaque subscript error.
    """
    row = cur.fetchone()
    if row is None:
        raise AssertionError("expected a result row, but cursor returned None")
    return row[index]

class TestLedgerAndModelRegression(unittest.TestCase):
    def setUp(self):
        # Establish PostgreSQL database connection for testing
        self.conn = psycopg2.connect(ledger_consumer.PG_DSN)
        self.conn.autocommit = False
        
        # Insert test accounts with clean balances
        with self.conn.cursor() as cur:
            cur.execute("INSERT INTO accounts (account_id, balance) VALUES ('ACC_TEST_1', 1000.00) ON CONFLICT (account_id) DO UPDATE SET balance = 1000.00")
            cur.execute("INSERT INTO accounts (account_id, balance) VALUES ('ACC_TEST_2', 1000.00) ON CONFLICT (account_id) DO UPDATE SET balance = 1000.00")
        self.conn.commit()

    def tearDown(self):
        # Clean up database test records
        with self.conn.cursor() as cur:
            cur.execute("DELETE FROM processed_events WHERE event_id LIKE 'event_%'")
            cur.execute("DELETE FROM transactions_log WHERE event_id LIKE 'event_%'")
            cur.execute("DELETE FROM accounts WHERE account_id IN ('ACC_TEST_1', 'ACC_TEST_2')")
        self.conn.commit()
        self.conn.close()

    def create_mock_held_transaction(self, event_id, amount=100.00):
        with self.conn.cursor() as cur:
            cur.execute("DELETE FROM processed_events WHERE event_id = %s", (event_id,))
            cur.execute("DELETE FROM transactions_log WHERE event_id = %s", (event_id,))
            cur.execute("INSERT INTO processed_events (event_id, status) VALUES (%s, 'held')", (event_id,))
            cur.execute("""INSERT INTO transactions_log (event_id, from_account, to_account, amount, status)
                           VALUES (%s, 'ACC_TEST_1', 'ACC_TEST_2', %s, 'held')""", (event_id, amount))
        self.conn.commit()

    def test_test1_low_risk_applied(self):
        # TEST 1: LOW transaction -> APPROVED -> balance settles exactly once
        event = {
            "event_id": "event_test_low",
            "from_account": "ACC_TEST_1",
            "to_account": "ACC_TEST_2",
            "amount": 150.00,
            "timestamp": "2026-08-29T14:30:00Z"
        }
        status = ledger_consumer.apply_transfer(self.conn, event, "LOW", "APPROVE")
        self.assertEqual(status, "applied")
        
        # Verify balances modified
        with self.conn.cursor() as cur:
            cur.execute("SELECT balance FROM accounts WHERE account_id = 'ACC_TEST_1'")
            self.assertEqual(_fetch_scalar(cur), 850.00)
            cur.execute("SELECT balance FROM accounts WHERE account_id = 'ACC_TEST_2'")
            self.assertEqual(_fetch_scalar(cur), 1150.00)

    def test_test2_medium_risk_held(self):
        # TEST 2: MEDIUM transaction -> HELD -> balance does NOT change
        event = {
            "event_id": "event_test_med",
            "from_account": "ACC_TEST_1",
            "to_account": "ACC_TEST_2",
            "amount": 250.00,
            "timestamp": "2026-08-29T14:30:00Z"
        }
        status = ledger_consumer.apply_transfer(self.conn, event, "MEDIUM", "VERIFY")
        self.assertEqual(status, "held")
        
        # Verify balances NOT modified
        with self.conn.cursor() as cur:
            cur.execute("SELECT balance FROM accounts WHERE account_id = 'ACC_TEST_1'")
            self.assertEqual(_fetch_scalar(cur), 1000.00)
            cur.execute("SELECT balance FROM accounts WHERE account_id = 'ACC_TEST_2'")
            self.assertEqual(_fetch_scalar(cur), 1000.00)

    def test_test3_high_risk_blocked(self):
        # TEST 3: HIGH transaction -> BLOCKED -> balance does NOT change
        event = {
            "event_id": "event_test_high",
            "from_account": "ACC_TEST_1",
            "to_account": "ACC_TEST_2",
            "amount": 350.00,
            "timestamp": "2026-08-29T14:30:00Z"
        }
        status = ledger_consumer.apply_transfer(self.conn, event, "HIGH", "HOLD")
        self.assertEqual(status, "blocked")
        
        # Verify balances NOT modified
        with self.conn.cursor() as cur:
            cur.execute("SELECT balance FROM accounts WHERE account_id = 'ACC_TEST_1'")
            self.assertEqual(_fetch_scalar(cur), 1000.00)
            cur.execute("SELECT balance FROM accounts WHERE account_id = 'ACC_TEST_2'")
            self.assertEqual(_fetch_scalar(cur), 1000.00)

    def test_test4_duplicate_low(self):
        # TEST 4: Duplicate LOW event -> no double settlement
        event = {
            "event_id": "event_test_low",
            "from_account": "ACC_TEST_1",
            "to_account": "ACC_TEST_2",
            "amount": 100.00,
            "timestamp": "2026-08-29T14:30:00Z"
        }
        ledger_consumer.apply_transfer(self.conn, event, "LOW", "APPROVE")
        
        self.assertTrue(ledger_consumer.already_processed(self.conn, event["event_id"]))
        
        with self.assertRaises(psycopg2.errors.UniqueViolation):
            with self.conn.cursor() as cur:
                cur.execute("INSERT INTO processed_events (event_id, status) VALUES (%s, 'applied')", (event["event_id"],))
            self.conn.commit()
        self.conn.rollback()

    def test_test5_duplicate_medium(self):
        # TEST 5: Duplicate MEDIUM event -> no duplicate hold effect
        event = {
            "event_id": "event_test_med",
            "from_account": "ACC_TEST_1",
            "to_account": "ACC_TEST_2",
            "amount": 100.00,
            "timestamp": "2026-08-29T14:30:00Z"
        }
        ledger_consumer.apply_transfer(self.conn, event, "MEDIUM", "VERIFY")
        self.assertTrue(ledger_consumer.already_processed(self.conn, event["event_id"]))

    def test_test6_duplicate_high(self):
        # TEST 6: Duplicate HIGH event -> no duplicate block/hold effect
        event = {
            "event_id": "event_test_high",
            "from_account": "ACC_TEST_1",
            "to_account": "ACC_TEST_2",
            "amount": 100.00,
            "timestamp": "2026-08-29T14:30:00Z"
        }
        ledger_consumer.apply_transfer(self.conn, event, "HIGH", "HOLD")
        self.assertTrue(ledger_consumer.already_processed(self.conn, event["event_id"]))

    def test_test7_invalid_transaction(self):
        # TEST 7: Invalid transaction -> rollback -> DLQ behavior preserved
        bad_event = {"event_id": "event_test_dlq", "from_account": "ACC_TEST_1", "amount": 100.00}
        self.assertEqual(ledger_consumer.validate(bad_event), "missing_field:to_account")
        
        event_overdraft = {
            "event_id": "event_test_dlq",
            "from_account": "ACC_TEST_1",
            "to_account": "ACC_TEST_2",
            "amount": 5000.00,
            "timestamp": "2026-08-29T14:30:00Z"
        }
        with self.assertRaises(ValueError):
            ledger_consumer.apply_transfer(self.conn, event_overdraft, "LOW", "APPROVE")
        self.conn.rollback()
        
        with self.conn.cursor() as cur:
            cur.execute("SELECT balance FROM accounts WHERE account_id = 'ACC_TEST_1'")
            self.assertEqual(_fetch_scalar(cur), 1000.00)

    def test_test8_replay_flow(self):
        # TEST 8: Existing replay flow validation
        event = {
            "event_id": "event_test_med",
            "from_account": "ACC_TEST_1",
            "to_account": "ACC_TEST_2",
            "amount": 100.00,
            "timestamp": "2026-08-29T14:30:00Z"
        }
        ledger_consumer.apply_transfer(self.conn, event, "MEDIUM", "VERIFY")
        self.assertTrue(ledger_consumer.already_processed(self.conn, event["event_id"]))

    def test_test9_model_feature_alignment(self):
        # TEST 9: V3 model feature alignment -> six features
        # [amount, hour, velocity, log_amount, is_night, amount_ratio]
        model = ledger_consumer.load_model()
        self.assertIsNotNone(model)
        self.assertEqual(model.n_features_in_, 6)

        event = {"amount": 200.0, "timestamp": "2026-08-29T15:00:00Z"}
        # history is the account's (timestamp, amount) deque including current
        history = [(event["timestamp"], event["amount"])]
        features = ledger_consumer.build_feature_vector(event, history, 6)

        self.assertEqual(features.shape, (1, 6))
        self.assertEqual(features[0, 0], 200.0)                       # amount
        self.assertEqual(features[0, 1], 15.0)                        # hour
        self.assertEqual(features[0, 2], 1.0)                         # velocity (1 in window)
        self.assertAlmostEqual(float(features[0, 3]), np.log1p(200.0))  # log_amount
        self.assertEqual(features[0, 4], 0.0)                         # is_night (15h -> 0)
        self.assertAlmostEqual(float(features[0, 5]), 1.0)            # amount_ratio (lone -> 1.0)

    def test_risk_policy_boundaries(self):
        # Risk policy is driven purely by the model score against the configured
        # thresholds. It is independent of amount, account IDs, or timestamps.
        # LOW:  score < LOW_THRESHOLD (0.01)
        # MEDIUM: LOW_THRESHOLD <= score <= HIGH_THRESHOLD (0.10)
        # HIGH:  score > HIGH_THRESHOLD
        self.assertEqual(ledger_consumer.decide_risk(0.005), ("LOW", "APPROVE"))
        self.assertEqual(ledger_consumer.decide_risk(0.025), ("MEDIUM", "VERIFY"))
        self.assertEqual(ledger_consumer.decide_risk(0.08), ("MEDIUM", "VERIFY"))
        self.assertEqual(ledger_consumer.decide_risk(0.35), ("HIGH", "HOLD"))

        # Boundary conditions
        self.assertEqual(ledger_consumer.decide_risk(0.00), ("LOW", "APPROVE"))
        self.assertEqual(ledger_consumer.decide_risk(0.0099), ("LOW", "APPROVE"))
        self.assertEqual(ledger_consumer.decide_risk(0.0100), ("MEDIUM", "VERIFY"))
        self.assertEqual(ledger_consumer.decide_risk(0.0101), ("MEDIUM", "VERIFY"))
        self.assertEqual(ledger_consumer.decide_risk(0.1000), ("MEDIUM", "VERIFY"))
        self.assertEqual(ledger_consumer.decide_risk(0.1001), ("HIGH", "HOLD"))
        self.assertEqual(ledger_consumer.decide_risk(0.1200), ("HIGH", "HOLD"))

        # The decision is invariant to the transaction amount: a large amount
        # with a low fraud probability is LOW/APPROVE, proving the policy does
        # not confuse amount with risk.
        self.assertEqual(ledger_consumer.decide_risk(0.005), ("LOW", "APPROVE"))
        self.assertEqual(ledger_consumer.decide_risk(0.02), ("MEDIUM", "VERIFY"))

    def test_policy_invariant_to_amount(self):
        # Amount must not directly drive the decision; only the ML score does.
        # Same score -> same decision regardless of amount.
        for amount in (0.01, 80.0, 500.0, 120000.0, 250000.0):
            self.assertEqual(ledger_consumer.decide_risk(0.005), ("LOW", "APPROVE"))
            self.assertEqual(ledger_consumer.decide_risk(0.02), ("MEDIUM", "VERIFY"))
            self.assertEqual(ledger_consumer.decide_risk(0.12), ("HIGH", "HOLD"))

    def test_feature_contract_is_fixed(self):
        # The V3 feature contract (amount, hour, velocity, log_amount, is_night,
        # amount_ratio) is what the model and the inference pipeline agree on. A
        # replaced dataset may change the model's weights and probability
        # distribution, but the pipeline must still feed exactly these six
        # features in this order. This test guards the contract.
        model = ledger_consumer.load_model()
        self.assertEqual(model.n_features_in_, 6)
        for amount, hour, velocity in [
            (10.0, 3, 7),
            (999999.0, 12, 20),
        ]:
            ev = {"amount": amount, "timestamp": f"2026-08-29T{hour:02d}:00:00+00:00"}
            # Build a history whose 30-minute window contains exactly `velocity`
            # events (velocity-1 prior + current), matching training semantics.
            history = [(f"2026-08-29T{hour:02d}:{m:02d}:00+00:00", amount)
                       for m in range(velocity - 1)] + [(ev["timestamp"], amount)]
            features = ledger_consumer.build_feature_vector(ev, history, 6)
            self.assertEqual(features.shape, (1, 6))
            self.assertEqual(features[0, 0], amount)
            self.assertEqual(features[0, 1], hour)
            self.assertEqual(float(features[0, 2]), float(velocity))
            self.assertAlmostEqual(float(features[0, 3]), np.log1p(amount), places=5)
            expected_night = 1.0 if (hour < 6 or hour >= 23) else 0.0
            self.assertEqual(float(features[0, 4]), expected_night)
            self.assertAlmostEqual(float(features[0, 5]), 1.0, places=5)

    def test_v3_serve_parity_window_features(self):
        # V3 share-parity: the serve-time build_feature_vector must recreate the
        # training time-window semantics for `velocity` (30-min count, capped 20,
        # INCLUDING the current transaction) and `amount_ratio` (current / mean
        # of window amounts including current).
        # Two prior txs + current, all within 30 minutes:
        #   velocity = 3, amount_ratio = 100 / mean(100,50,100) = 1.2
        history = [
            ("2026-08-29T14:00:00+00:00", 100.0),
            ("2026-08-29T14:08:00+00:00", 50.0),
            ("2026-08-29T14:10:00+00:00", 100.0),  # current, last
        ]
        ev = {"amount": 100.0, "timestamp": history[-1][0]}
        fv = pure_build_feature_vector(ev, history)[0]
        self.assertEqual(float(fv[2]), 3.0)                         # 3 in 30-min window
        self.assertAlmostEqual(float(fv[5]), 100.0 / ((100 + 50 + 100) / 3.0), places=6)

        # A transaction older than 30 minutes is excluded from the window.
        old_history = [
            ("2026-08-29T13:00:00+00:00", 999.0),  # 70 min before current -> excluded
            ("2026-08-29T14:10:00+00:00", 200.0),  # current
        ]
        ev2 = {"amount": 200.0, "timestamp": old_history[-1][0]}
        fv2 = pure_build_feature_vector(ev2, old_history)[0]
        self.assertEqual(float(fv2[2]), 1.0)                      # only current in window
        self.assertAlmostEqual(float(fv2[5]), 1.0, places=6)      # lone amount -> ratio 1.0

        # The six feature names must match the served model width exactly.
        model = ledger_consumer.load_model()
        self.assertEqual(model.n_features_in_, len(FEATURE_NAMES))

    def test_decision_is_dataset_agnostic(self):
        # Simulates a "dataset replacement": different amounts, different hours,
        # and different velocity values must ALL route through the same generic
        # policy with no dataset-specific special-casing. The classification only
        # depends on the (simulated) model score.
        # Model A (credit-card) vs Model B (e.g. payment network) could produce
        # different probabilities; the policy maps any score deterministically.
        simulated_scores = {
            "low": 0.004,
            "mid": 0.03,
            "high": 0.98,
        }
        datasets = [
            {"amount": 15.0, "hour": 0},
            {"amount": 18000.0, "hour": 19},
            {"amount": 120000.0, "hour": 20},
            {"amount": 250000.0, "hour": 15},
            {"amount": 42.0, "hour": 23},
        ]
        for ds in datasets:
            for key in ("low", "mid", "high"):
                score = simulated_scores[key]
                level, action = ledger_consumer.decide_risk(score)
                expected = {"low": ("LOW", "APPROVE"),
                            "mid": ("MEDIUM", "VERIFY"),
                            "high": ("HIGH", "HOLD")}[key]
                self.assertEqual((level, action), expected)
                # And the outcome is identical no matter the dataset row.
                self.assertEqual(level, expected[0])

    # --- API Integration Tests ---

    def test_api_approve_flow(self):
        # Verify HELD -> APPROVED (applied) state transition and money movement
        event_id = "event_api_appr"
        self.create_mock_held_transaction(event_id, 100.00)
        
        res = requests.post(f"{API_BASE_URL}/transactions/{event_id}/approve")
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.json()["ok"])
        
        # Verify balances modified
        with self.conn.cursor() as cur:
            cur.execute("SELECT balance FROM accounts WHERE account_id = 'ACC_TEST_1'")
            self.assertEqual(float(_fetch_scalar(cur)), 900.00)
            cur.execute("SELECT balance FROM accounts WHERE account_id = 'ACC_TEST_2'")
            self.assertEqual(float(_fetch_scalar(cur)), 1100.00)

    def test_api_decline_flow(self):
        # Verify HELD -> DECLINED state transition with no money movement
        event_id = "event_api_decl"
        self.create_mock_held_transaction(event_id, 100.00)
        
        res = requests.post(f"{API_BASE_URL}/transactions/{event_id}/decline")
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.json()["ok"])
        
        # Verify balances NOT modified
        with self.conn.cursor() as cur:
            cur.execute("SELECT balance FROM accounts WHERE account_id = 'ACC_TEST_1'")
            self.assertEqual(float(_fetch_scalar(cur)), 1000.00)
            cur.execute("SELECT balance FROM accounts WHERE account_id = 'ACC_TEST_2'")
            self.assertEqual(float(_fetch_scalar(cur)), 1000.00)

    def test_api_double_approval(self):
        # Verify that approving twice fails and does not double-debit
        event_id = "event_api_double_appr"
        self.create_mock_held_transaction(event_id, 100.00)
        
        # First request succeeds
        res1 = requests.post(f"{API_BASE_URL}/transactions/{event_id}/approve")
        self.assertEqual(res1.status_code, 200)
        
        # Second request fails (400 Bad Request)
        res2 = requests.post(f"{API_BASE_URL}/transactions/{event_id}/approve")
        self.assertEqual(res2.status_code, 400)
        self.assertFalse(res2.json()["ok"])
        
        # Verify balances modified ONLY once
        with self.conn.cursor() as cur:
            cur.execute("SELECT balance FROM accounts WHERE account_id = 'ACC_TEST_1'")
            self.assertEqual(float(_fetch_scalar(cur)), 900.00)

    def test_api_double_decline(self):
        # Verify that declining twice fails
        event_id = "event_api_double_decl"
        self.create_mock_held_transaction(event_id, 100.00)
        
        res1 = requests.post(f"{API_BASE_URL}/transactions/{event_id}/decline")
        self.assertEqual(res1.status_code, 200)
        
        res2 = requests.post(f"{API_BASE_URL}/transactions/{event_id}/decline")
        self.assertEqual(res2.status_code, 400)
        self.assertFalse(res2.json()["ok"])

    def test_api_approve_after_decline(self):
        # Verify that approving after a decline is blocked
        event_id = "event_api_appr_after_decl"
        self.create_mock_held_transaction(event_id, 100.00)
        
        res1 = requests.post(f"{API_BASE_URL}/transactions/{event_id}/decline")
        self.assertEqual(res1.status_code, 200)
        
        res2 = requests.post(f"{API_BASE_URL}/transactions/{event_id}/approve")
        self.assertEqual(res2.status_code, 400)
        self.assertFalse(res2.json()["ok"])
        
        # Verify balances remained intact
        with self.conn.cursor() as cur:
            cur.execute("SELECT balance FROM accounts WHERE account_id = 'ACC_TEST_1'")
            self.assertEqual(float(_fetch_scalar(cur)), 1000.00)

    def test_api_decline_after_approval(self):
        # Verify that declining after an approval is blocked
        event_id = "event_api_decl_after_appr"
        self.create_mock_held_transaction(event_id, 100.00)
        
        res1 = requests.post(f"{API_BASE_URL}/transactions/{event_id}/approve")
        self.assertEqual(res1.status_code, 200)
        
        res2 = requests.post(f"{API_BASE_URL}/transactions/{event_id}/decline")
        self.assertEqual(res2.status_code, 400)
        self.assertFalse(res2.json()["ok"])
        
        # Verify balances debited only once
        with self.conn.cursor() as cur:
            cur.execute("SELECT balance FROM accounts WHERE account_id = 'ACC_TEST_1'")
            self.assertEqual(float(_fetch_scalar(cur)), 900.00)

    def test_api_approve_blocked_rejection(self):
        # 10. blocked -> approve rejection
        event_id = "event_api_appr_block"
        with self.conn.cursor() as cur:
            cur.execute("INSERT INTO processed_events (event_id, status) VALUES (%s, 'blocked')", (event_id,))
            cur.execute("INSERT INTO transactions_log (event_id, from_account, to_account, amount, status) VALUES (%s, 'ACC_TEST_1', 'ACC_TEST_2', 100.0, 'blocked')", (event_id,))
        self.conn.commit()
        
        res = requests.post(f"{API_BASE_URL}/transactions/{event_id}/approve")
        self.assertEqual(res.status_code, 400)
        self.assertFalse(res.json()["ok"])
        self.assertIn("blocked", res.json()["error"].lower())

    def test_api_decline_blocked_rejection(self):
        # 11. blocked -> decline rejection
        event_id = "event_api_decl_block"
        with self.conn.cursor() as cur:
            cur.execute("INSERT INTO processed_events (event_id, status) VALUES (%s, 'blocked')", (event_id,))
            cur.execute("INSERT INTO transactions_log (event_id, from_account, to_account, amount, status) VALUES (%s, 'ACC_TEST_1', 'ACC_TEST_2', 100.0, 'blocked')", (event_id,))
        self.conn.commit()
        
        res = requests.post(f"{API_BASE_URL}/transactions/{event_id}/decline")
        self.assertEqual(res.status_code, 400)
        self.assertFalse(res.json()["ok"])
        self.assertIn("blocked", res.json()["error"].lower())

    def test_api_malformed_input(self):
        # 23. API malformed input
        res = requests.post(f"{API_BASE_URL}/transactions/invalid;sql_inject/approve")
        self.assertEqual(res.status_code, 400)
        self.assertFalse(res.json()["ok"])
        self.assertIn("malformed", res.json()["error"].lower())

    def test_api_unknown_transaction(self):
        # 24. unknown transaction API request
        res = requests.post(f"{API_BASE_URL}/transactions/non_existent_tx_123/approve")
        self.assertEqual(res.status_code, 400)
        self.assertFalse(res.json()["ok"])
        self.assertIn("not found", res.json()["error"].lower())

    def test_api_insufficient_balance(self):
        # 19. insufficient balance / 25. database rollback behavior
        event_id = "event_api_insuf"
        # Create a held transaction of amount $2000 (which exceeds the $1000 limit)
        self.create_mock_held_transaction(event_id, 2000.00)
        
        res = requests.post(f"{API_BASE_URL}/transactions/{event_id}/approve")
        self.assertEqual(res.status_code, 400)
        self.assertFalse(res.json()["ok"])
        self.assertIn("insufficient balance", res.json()["error"].lower())
        
        # Verify balances were rolled back and accounts remain at 1000.00
        with self.conn.cursor() as cur:
            cur.execute("SELECT balance FROM accounts WHERE account_id = 'ACC_TEST_1'")
            self.assertEqual(float(_fetch_scalar(cur)), 1000.00)
            cur.execute("SELECT balance FROM accounts WHERE account_id = 'ACC_TEST_2'")
            self.assertEqual(float(_fetch_scalar(cur)), 1000.00)

    def test_unknown_account_rejection(self):
        # 18. unknown account rejection
        event = {
            "event_id": "event_unknown_acct",
            "from_account": "NON_EXISTENT_ACC",
            "to_account": "ACC_TEST_2",
            "amount": 100.00,
            "timestamp": "2026-08-29T14:30:00Z"
        }
        with self.assertRaises(Exception):
            ledger_consumer.apply_transfer(self.conn, event, "LOW", "APPROVE")

    def test_api_decline_applied_rejection(self):
        # 7. applied -> decline rejection
        event_id = "event_api_decl_appr"
        self.create_mock_held_transaction(event_id, 100.00)
        
        # Approve first
        res1 = requests.post(f"{API_BASE_URL}/transactions/{event_id}/approve")
        self.assertEqual(res1.status_code, 200)
        
        # Try to decline
        res2 = requests.post(f"{API_BASE_URL}/transactions/{event_id}/decline")
        self.assertEqual(res2.status_code, 400)
        self.assertFalse(res2.json()["ok"])
        self.assertIn("approved", res2.json()["error"].lower())

    def test_concurrent_approve_decline(self):
        # 14. concurrent approve/decline
        import threading
        event_id = "event_api_concur"
        self.create_mock_held_transaction(event_id, 100.00)
        
        results = []
        def run_approve():
            res = requests.post(f"{API_BASE_URL}/transactions/{event_id}/approve")
            results.append(res)
        def run_decline():
            res = requests.post(f"{API_BASE_URL}/transactions/{event_id}/decline")
            results.append(res)
        
        t1 = threading.Thread(target=run_approve)
        t2 = threading.Thread(target=run_decline)
        t1.start()
        t2.start()
        t1.join()
        t2.join()
        
        # Exactly one must succeed (status 200) and the other must fail (status 400)
        statuses = [r.status_code for r in results]
        self.assertIn(200, statuses)
        self.assertIn(400, statuses)

    def test_api_health_check(self):
        # Health & sanity configuration checks
        res = requests.get(f"{API_BASE_URL}/health")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["status"], "ok")

    def _sum_balance(self):
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT COALESCE(SUM(balance), 0) FROM accounts "
                "WHERE account_id IN ('ACC_TEST_1', 'ACC_TEST_2')"
            )
            return float(_fetch_scalar(cur))

    def test_balance_conservation_for_blocked_held(self):
        # Phase 11G: blocked/held must move zero money, so total system balance
        # must be conserved after those decisions.
        before_system = self._sum_balance()
        for event_id, level, action in (
            ("event_consv_med", "MEDIUM", "VERIFY"),
            ("event_consv_high", "HIGH", "HOLD"),
        ):
            event = {
                "event_id": event_id,
                "from_account": "ACC_TEST_1",
                "to_account": "ACC_TEST_2",
                "amount": 150.00,
                "timestamp": "2026-08-29T14:30:00Z",
            }
            ledger_consumer.apply_transfer(self.conn, event, level, action)
        self.assertEqual(self._sum_balance(), before_system)

    def test_blocked_value_matches_db_sum(self):
        # Phase 11G: "Total Value Blocked" must match the DB aggregate exactly
        # when the transactions list is complete (within the API limit), and the
        # backend aggregate must remain authoritative regardless.
        res = requests.get(f"{API_BASE_URL}/transactions?limit=200")
        self.assertEqual(res.status_code, 200)
        transactions = res.json()["transactions"]
        rows = [t for t in transactions if t.get("status") == "blocked"]
        list_sum = sum(float(t["amount"]) for t in rows)

        with self.conn.cursor() as cur:
            cur.execute("SELECT COALESCE(SUM(amount), 0) FROM transactions_log WHERE status = 'blocked'")
            db_sum = float(_fetch_scalar(cur))

        self.assertLessEqual(list_sum, db_sum + 0.001)
        # The API page is capped at `limit` (MAX_LIMIT = 200) rows. Exact
        # equality with the DB aggregate is only guaranteed when the returned
        # transaction list is truly complete, i.e. the total page size is below
        # the limit so no blocking row could have been truncated out.
        if len(transactions) < 200:
            self.assertAlmostEqual(list_sum, db_sum, places=2)

    def test_api_stats_expose_blocked_aggregate(self):
        # Phase 11G: /api/stats must expose the blocked count and blocked value
        # derived from PostgreSQL, matching the live DB exactly.
        res = requests.get(f"{API_BASE_URL}/stats")
        self.assertEqual(res.status_code, 200)
        payload = res.json()
        self.assertIn("blockedCount", payload)
        self.assertIn("blockedValue", payload)

        with self.conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM transactions_log WHERE status = 'blocked'")
            db_count = _fetch_scalar(cur)
            cur.execute("SELECT COALESCE(SUM(amount), 0) FROM transactions_log WHERE status = 'blocked'")
            db_value = float(_fetch_scalar(cur))

        self.assertEqual(payload["blockedCount"], db_count)
        self.assertAlmostEqual(payload["blockedValue"], db_value, places=2)
        self.assertGreaterEqual(payload["blockedValue"], 0)

    def test_seed_demo_amount_within_sender_balance(self):
        # Phase 11G: demo generation must never publish an amount above the
        # sender's available balance. Integration test (requires running API +
        # consumers): snapshots balances, seeds a few events, then verifies every
        # newly logged demo transaction against the sender's pre-seed balance.
        with self.conn.cursor() as cur:
            cur.execute("SELECT account_id, balance FROM accounts")
            balances = {r[0]: float(r[1]) for r in cur.fetchall()}
            cur.execute("SELECT COALESCE(MAX(id), 0) FROM transactions_log")
            before_max_id = _fetch_scalar(cur)

        res = requests.post(f"{API_BASE_URL}/admin/seed-demo", json={"count": 5})
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.json().get("ok"))
        self.assertGreaterEqual(res.json()["count"], 1)

        # Poll until the new demo events are consumed and logged.
        deadline = time.time() + 40
        created = []
        while time.time() < deadline:
            with self.conn.cursor() as cur:
                cur.execute(
                    "SELECT event_id, from_account, amount, status "
                    "FROM transactions_log WHERE id > %s AND event_id LIKE 'demo-%%'",
                    (before_max_id,),
                )
                created = cur.fetchall()
            if created:
                break
            time.sleep(2)

        self.assertTrue(created, "No demo events logged within 40s; check API/Kafka/consumers")

        try:
            for event_id, from_account, amount, status in created:
                self.assertGreater(float(amount), 0, f"{event_id} amount must be positive")
                self.assertIn(from_account, balances, f"{event_id} sender must be a real account")
                self.assertLessEqual(
                    float(amount),
                    balances[from_account],
                    f"{event_id} amount {amount} exceeds sender {from_account} "
                    f"balance {balances[from_account]} (status={status})",
                )
        finally:
            ids = [r[0] for r in created]
            if ids:
                with self.conn.cursor() as cur:
                    cur.execute("DELETE FROM transactions_log WHERE event_id = ANY(%s)", (ids,))
                    cur.execute("DELETE FROM processed_events WHERE event_id = ANY(%s)", (ids,))
                self.conn.commit()

if __name__ == '__main__':
    unittest.main()


