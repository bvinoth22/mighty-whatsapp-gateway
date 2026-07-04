# MightyVision WhatsApp Gateway

A standalone, multi-tenant WhatsApp gateway for MightyVision. It links a
**dedicated bot number** (via an 8-digit **pairing code** — no QR scanning),
resolves a message sender's phone to a MightyVision **subscriber**, checks their
**subscription**, understands **keyword commands**, and replies with **only that
tenant's data** by calling the existing `MightyVisionWeb` API.

> This is a separate project. It does **not** modify `MightyVisionWeb` or the old
> `mighty-whatsapp-monitor`. It can run in parallel until it's proven out.

## Why this design

- **No SQLite, no session files.** The WhatsApp session is stored in **Supabase**
  (`whatsapp_sessions`), the same source of truth as the rest of the system.
- **No duplicated business logic.** All aviary operations go through the
  `MightyVisionWeb` API with an `X-User-ID` header, which already isolates data
  per tenant.
- **Swappable transport.** Baileys sits behind `IMessagingProvider`, so a
  WhatsApp Cloud API provider can be added later without touching core code.
- **Friendly onboarding.** A small web page shows the pairing code live.

## How identity & isolation work

1. A member posts in your private group, e.g. `ARR 123 details`.
2. The gateway resolves the **sender phone** → `users` row → `userId`
   (identity comes from the phone, never the message text).
3. It checks the **subscription** (`feature_subscriptions` for `whatsapp_bot`,
   falling back to `user_species_subscriptions`).
4. It calls the API scoped to that `userId` and replies with that tenant's data.

Because every query is filtered by `user_id`, one tenant can never see another's
birds.

## Commands

Every write is **confirmed** before it happens (reply `YES`/`NO`). Reversible
actions can be undone with `undo` for ~10 minutes.

| What | Say (examples) | Undo |
|---|---|---|
| Menu / help | `menu`, `help` | — |
| Bird details | `ARR 123 details`, or just `ARR 123` | — |
| Egg laid | `egg laid cage 5` | ✅ |
| Egg hatched | `cage 5 hatched` | ❌ |
| Infertile | `cage 5 infertile` | ❌ |
| Dead-in-shell | `cage 5 dead in shell` | ❌ |
| Assign ring | `ring ARR 123 cage 5` (or `ring ARR 123 COCKATIEL_7`) | ✅ |
| Record death | `ARR 123 died` | ✅ |
| Record sale | `sold ARR 123 to Ramesh 2500` | ✅ |
| Undo last | `undo` | — |

Egg/hatch/infertile/DIS act on the **oldest unresolved egg** in that cage's
active clutch. Ring assignment targets the single un-ringed living bird in the
cage (or a bird named `COCKATIEL_n`); if several are un-ringed it lists them.

## Run it

This needs **two processes**: the `MightyVisionWeb` API (data + business logic)
and this gateway (WhatsApp). Use two terminals.

**Terminal 1 — start the API (port 3001):**

```bash
cd C:\VBREME\MightyVisionWeb\server
npm install        # first time only
npm run dev        # → MightyVision API running on http://localhost:3001
```

**Terminal 2 — start the gateway (port 3000):**

```bash
cd C:\VBREME\mighty-whatsapp-gateway
npm install        # first time only
# create .env (see below) — already done if a .env exists
npm run dev        # → setup UI on http://localhost:3000
```

Then open **http://localhost:3000**, enter your dedicated bot number, and type
the 8-digit pairing code into WhatsApp on the bot phone:
**Settings → Linked Devices → Link a device → Link with phone number instead**.

Once linked, post a command in your group (e.g. `ARR 123 details`).

### `.env` for the gateway

```env
PORT=3000
PROVIDER=baileys
TARGET_GROUP_NAME=Mighty-Wing Aviaries
BOT_PHONE_NUMBER=                       # or enter it in the web UI
MIGHTY_API_URL=http://localhost:3001
SUPABASE_URL=https://iglxmfmciiwrmofiwfqc.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...           # same key as MightyVisionWeb/server/.env
STRICT_SUBSCRIPTION=false               # true = require an explicit whatsapp_bot row
```

### Modes

- **Live mode** (`SUPABASE_URL` set): resolves real tenants, checks
  subscriptions, and persists the WhatsApp session in Supabase.
- **DEV mode** (no `SUPABASE_URL`): in-memory session + a configurable dev
  tenant (`DEV_FALLBACK_USER_ID`) so you can test the flow offline.

### Build for production

```bash
npm run build && npm start
```

## Required Supabase table (live mode)

```sql
create table if not exists whatsapp_sessions (
  account_id text primary key,
  creds jsonb,
  keys jsonb,
  updated_at timestamptz default now()
);

-- Optional explicit entitlement (otherwise species subscription is used):
create table if not exists feature_subscriptions (
  user_id text references users(id) on delete cascade,
  feature varchar(40) not null,
  is_active boolean default true,
  expires_at timestamptz,
  primary key (user_id, feature)
);
```

## Status

**Phase 1 — identity & reads** ✅
- Pairing-code login + web setup page
- Phone → tenant resolution + subscription gate
- `help`/`menu` and bird **details**
- Supabase-backed session (in-memory fallback in dev)

**Phase 2 — writes with confirmation + undo** ✅
- Record **death** and **sale** (each confirmed; undoable)

**Phase 2b — breeding & ring** ✅
- **Egg laid**, **hatch**, **infertile**, **dead-in-shell**, and **ring**
  assignment (all confirmed; egg-laid and ring are undoable)

Later: free-LLM fallback for natural language, a multi-tenant account manager,
and scheduled reminders.

## Project layout

```
src/
  config/        env, logger, supabase client
  providers/     IMessagingProvider + baileys/ (provider, session store, auth state)
  core/          tenantResolver, mightyApi, keywords, intentRouter, replyFormatter
  manager/       connectionManager (wires provider <-> router)
  server/        Fastify + public/ setup page
  index.ts       entry point
```
