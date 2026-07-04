---
name: mighty-whatsapp-gateway
description: >-
  Develop and extend the MightyVision WhatsApp gateway (Baileys + Supabase +
  MightyVisionWeb API). Use when working in mighty-whatsapp-gateway, WhatsApp
  bot keywords, pairing code, tenant isolation, conversational ops, clutch
  start/end, daily alerts, bird search/cards, ring assignment, or deploying
  the gateway. Repo: github.com/bvinoth22/mighty-whatsapp-gateway.
---

# MightyVision WhatsApp Gateway

Standalone Node/TypeScript service. **Repo:** `github.com/bvinoth22/mighty-whatsapp-gateway` (sibling to MightyVisionWeb / MightyVisionWPF under `C:\VBREME`).

## Architecture

```
WhatsApp group → BaileysProvider → intentRouter → mightyApi (X-User-ID) → MightyVisionWeb
                      ↑
              Supabase (whatsapp_sessions, users, feature_subscriptions)
```

- **No SQLite.** Session in Supabase; business logic only in MightyVisionWeb API.
- **Tenant isolation:** sender phone → `users.userId` → every API call uses `X-User-ID`.
- **Scope:** replies only in `TARGET_GROUP_NAME` / `TARGET_GROUP_JID` (strict — no DMs).
- **Pairing:** 8-digit code via setup UI (`src/server/public/index.html`), not QR.

## Key files

| Area | Path |
|------|------|
| Entry | `src/index.ts` |
| Routing | `src/core/intentRouter.ts` |
| Keywords / intents | `src/core/keywords.ts` |
| Write ops (slot engine) | `src/core/operations.ts` |
| Start clutch (state machine) | `src/core/startClutchFlow.ts` |
| Replies / menu / cards | `src/core/replyFormatter.ts` |
| API client | `src/core/mightyApi.ts` |
| Mutation search | `src/core/mutations.ts` |
| Draft + undo store | `src/core/conversationStore.ts` |
| Daily alerts | `src/alerts/dailyAlerts.ts`, `scheduler.ts` |
| Baileys | `src/providers/baileys/` |
| Env | `src/config/env.ts`, `.env.example` |

## Dev commands

```bash
npm install
npm run dev          # tsx watch
npm run typecheck
npm run build && npm start
```

Requires MightyVisionWeb API at `MIGHTY_API_URL` (default `http://localhost:3001`).

## Intent routing

1. In-progress **start clutch** flow (`startClutchFlow.ts`) — checked first.
2. In-progress **draft** (slot-filling op in `operations.ts`).
3. **Reveal** follow-up (`yes` to show inactive birds after ring/search).
4. Fresh intent from `keywords.ts` → `OPS[...]` or read handlers.

Adding a keyword: edit `INTENTS` in `keywords.ts` (order matters — specific before generic).

## Two dialog patterns

**Generic ops** (`OpSpec` in `operations.ts`): `parseInitial` → `resolve` → slots → confirm → execute. Supports `SlotDef.repeat` (used by end-clutch egg resolution).

**Start clutch** (`startClutchFlow.ts`): dedicated state machine — male/female search by ring or nickname, per-bird confirm, cage check (no active clutch in cage), existing-pair move, start date, final confirm. Uses `readyForBreeding` + gender validation from API.

**End clutch** stays in `operations.ts` (`endClutchOp`).

## Undo rules

- Reversible ops register `undo` in `ExecResult` (~10 min TTL).
- **Start/end clutch:** undo blocked at runtime (`clutchUndoBlocked()`); `markLastClutchOp()` clears pending undo after completion.
- Menu does **not** mention clutch undo — runtime only.

## Domain rules (do not regress)

### Bird presence
- **Active/present:** `isAlive !== false && !isSold`. Re-entered (`isReturned`) birds are **present** (data model: returned ⟹ not sold).
- Status icons: dead 💀, sold 💰, re-entered 🔄 (before gender in parent lines).

### Details / search
- Alive birds first, age ascending; offer `yes` to reveal sold/dead/adopted.
- Ring lookup prefers alive over inactive when ring reused.
- **Mutation search (strict):** no `/` or `split` keyword → all tokens are **visuals only**. Splits only when explicitly after `/` or `split`. AND logic within each group.

### Ring assignment
- Eligible: present, no ring yet, under ~2 months (`isRingeable`).
- Flow: pick chick → ring number → gender → color → confirm.
- `ring AMWA 123` pre-fills ring number; still picks chick.

### Start clutch eligibility
- `readyForBreeding` from MightyVisionWeb (11mo min, cooldowns, not already in breeding).
- Gender must match slot (Male/Female); unknown gender blocked with hint.
- Target cage must have no active clutch; duplicate pair → offer move.

### Daily alerts (`dailyAlerts.ts`)
- Cron: `ALERT_TIME` in `ALERT_TZ` (default 06:00 Asia/Kolkata).
- Header: `🚨 Daily Alert`. Chick maturity threshold: 45 days.
- Skip Australian-exclusive mutations for ring reminders.

### UX conventions
- Success ✅, errors ❌.
- Dotted separators between list items (`┈┈┈`).
- Ring number **bold**; mutations _italic_; gender icons only (no text).
- Help menu order: details → ring → gender → death → breeding pairs → clutch → eggs → report → undo.
- Example ring prefix: **AMWA** (not ARR).

## Adding a new write operation

1. Add intent + keywords in `keywords.ts`.
2. Define `OpSpec` in `operations.ts`; register in `OPS`.
3. Add API method in `mightyApi.ts` if missing.
4. Add confirm/success strings in `replyFormatter.ts`.
5. Update help menu examples.
6. Run `npm run typecheck`.

For multi-step flows that need async search or branching (like start clutch), use a dedicated module + TTL map instead of forcing `OpSpec`.

## Related repos

- **MightyVisionWeb** — API + Supabase data; fix tenant bugs there, not duplicated in gateway.
- **mighty-whatsapp-monitor** — legacy; do not extend.
- **VBREME** — parent folder; subprojects have separate git remotes.

## Deployment note

Gateway must run 24/7 for alerts and WhatsApp connectivity (Docker/VM). Local `tsx watch` is dev only.
