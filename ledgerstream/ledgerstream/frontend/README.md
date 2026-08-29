# LedgerStream Monitor UI (Node + React)

New read-only frontend layer on top of the existing Python pipeline (producer,
ledger consumer, fraud consumer, DLQ, load test). **No existing pipeline code
is touched.** The old Streamlit dashboard stays available as a fallback:

- Streamlit (legacy): http://localhost:8501
- **New monitor UI (this): http://localhost:5173**
- **New API: http://localhost:3001**

## Stack

| Part | Tech | Folder |
| --- | --- | --- |
| API | Node.js + Express + `pg` + `kafkajs` | `api/` |
| UI | React 18 + Vite (no router, no state-mgmt lib) | `frontend/` |

Data is **live** — never mocked:

- `GET /api/balances` — `accounts` table (Postgres :5433)
- `GET /api/transactions?limit=50` — `transactions_log` (most recent first)
- `GET /api/alerts` — from the Kafka `fraud-alerts` topic (read-only consumer
  in its own group, per-boot id so the full history reloads on restart)
- `GET /api/lag` — consumer lag for `ledger-consumer-group` and
  `fraud-consumer-group` on the `transactions` topic (kafkajs admin client)

## Run it

Prereqs: Docker up (`docker-compose up -d`), pipeline workers running (see the
`*.ps1` launchers in `C:\my_projects_main\LedgerStream`), API + UI below.

1. API (terminal 1):

   ```
   cd api
   npm install
   npm start
   # -> http://localhost:3001
   ```

2. UI (terminal 2):

   ```
   cd frontend
   npm install
   npm run dev
   # -> http://localhost:5173  (the /api requests are proxied to :3001)
   ```

On this machine the two are (re)started hidden via
`C:\my_projects_main\LedgerStream\api_launcher.ps1` and
`...\frontend_launcher.ps1` (logs: `api.log`, `frontend.log`).

## Ports

| Service | Port |
| --- | --- |
| API (Express) | 3001 |
| Vite dev server (UI) | 5173 |
| Postgres (Docker) | 5433 |
| Kafka broker | 9092 |
| Streamlit legacy dashboard | 8501 |

## Notes

- API is read-only: `GET` endpoints only, plus a long-lived alerts consumer
  in its own consumer group — it never produces, commits, or replays writes.
- Polls: the UI refreshes every 2.5s via `Promise.all` → one round trip.
- CORS is scoped to localhost origins; the Vite dev proxy avoids CORS entirely.