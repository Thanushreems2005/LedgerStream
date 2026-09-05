import os
import psycopg2

def main():
    db_url = os.environ.get("DATABASE_URL")
    conn = psycopg2.connect(db_url)
    with conn.cursor() as cur:
        cur.execute("SELECT SUM(balance) FROM accounts;")
        row = cur.fetchone()
        total = row[0] if row is not None else None
        print(f"Total balance in production accounts: {total}")
    conn.close()

if __name__ == "__main__":
    main()
