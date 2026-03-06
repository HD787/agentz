# Agentz Express + OpenAI + Prisma (Postgres)

## Setup
1. Create `.env` from `.env.example`.
2. Install dependencies: `npm install`.
3. Generate Prisma client: `npm run prisma:generate`.
4. Run migrations: `npm run prisma:migrate`.

## Run
- Dev: `npm run dev`
- Build: `npm run build`
- Start: `npm start`

## API
- `GET /health`
- `GET /healthz`
- `GET /agentz/health`
- `GET /agentz/healthz`
- `POST /agent`

Example request:
```bash
curl -X POST http://localhost:3000/agent \
  -H 'Content-Type: application/json' \
  -d '{"input":"Summarize the project plan."}'
```
