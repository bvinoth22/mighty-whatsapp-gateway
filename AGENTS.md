# AGENTS.md

## Cursor Cloud specific instructions

MightyVision WhatsApp Gateway — standalone Node/TypeScript service (ESM). One service only.

### Commands (see `package.json`)
- `npm run dev` — `tsx watch src/index.ts` (development server, hot reload).
- `npm run typecheck` — `tsc --noEmit`. There is **no ESLint**; treat `typecheck` as the lint/type gate.
- `npm run build` / `npm start` — production `tsc` build then `node dist/index.js`.

### Running it / DEV mode (important)
- When `SUPABASE_URL` is blank the gateway boots in **DEV mode**: in-memory session and a fallback tenant (`DEV_FALLBACK_USER_ID`, default `U_1`). No `.env` and no network are required just to boot; a `.env` is only needed for live Supabase/real tenants.
- HTTP server (Fastify) listens on `PORT` (default 3000): setup UI at `/`, connection state at `GET /api/status`.
- On boot the Baileys provider goes to `pairing` state and serves a QR (visible in `/api/status` / setup UI). **Fully linking WhatsApp needs a real bot phone** (pairing code or QR scan), which is not available in the cloud VM — this is expected; the service still runs.

### External dependency (not in this repo)
- Read/write bird commands call the **MightyVisionWeb API** at `MIGHTY_API_URL` (default `http://localhost:3001`), a **separate repository** not present here. Without it, data commands (`details`, `breeding`, `report`, ring lookups, etc.) return a graceful "something went wrong" reply.
- `menu` / `help` work fully offline (pure reply formatting) and are the easiest way to smoke-test core keyword routing.

### Smoke test without WhatsApp
Core routing (`src/core/intentRouter.ts` `routeMessage`) is a plain async function taking an `InboundMessage`. In DEV mode you can import and call it directly (e.g. via a throwaway `tsx` script) to exercise keyword detection + reply formatting without a linked phone or the external API.
