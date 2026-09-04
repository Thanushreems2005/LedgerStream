import os
import psycopg2

def main():
    db_url = os.environ.get("DATABASE_URL")
    conn = psycopg2.connect(db_url)
    with conn.cursor() as cur:
        cur.execute("SELECT SUM(balance) FROM accounts;")
        row = cur.fetchone()
        print(f"Total balance in production accounts: {row[0]}")
    conn.close()

if __name__ == "__main__":
    main()
