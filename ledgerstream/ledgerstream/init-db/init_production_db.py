import os
import psycopg2
import sys

def main():
    # Railway Postgres DSN is provided via DATABASE_URL
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("Error: DATABASE_URL environment variable is not set.")
        sys.exit(1)

    print("Connecting to production database...")
    try:
        conn = psycopg2.connect(db_url)
        conn.autocommit = True
    except Exception as e:
        print(f"Failed to connect to database: {e}")
        sys.exit(1)

    schema_path = os.path.join(os.path.dirname(__file__), "schema.sql")
    if not os.path.exists(schema_path):
        print(f"Error: schema.sql not found at {schema_path}")
        sys.exit(1)

    print(f"Reading schema from {schema_path}...")
    with open(schema_path, "r") as f:
        schema_sql = f.read()

    print("Executing schema...")
    try:
        with conn.cursor() as cur:
            cur.execute(schema_sql)
        print("Database schema initialized and seeded successfully!")
    except Exception as e:
        print(f"Failed to execute schema: {e}")
        sys.exit(1)
    finally:
        conn.close()

if __name__ == "__main__":
    main()
