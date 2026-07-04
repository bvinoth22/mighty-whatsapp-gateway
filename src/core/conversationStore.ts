/**
 * Per-conversation dialog state for slot-filling. Each key (chat + sender) can
 * have one in-progress draft operation that collects missing details across
 * several messages, then a confirmation, then execution. Also keeps the most
 * recent completed action's undo handler.
 *
 * In-memory with TTLs — fine for a single gateway instance.
 */

export type SlotValue = string | number | boolean;

export interface Draft {
  op: string;
  slots: Record<string, SlotValue>;
  ctx: Record<string, unknown>;
  resolved: boolean;
  awaiting?: string;
  stage: 'collecting' | 'confirming';
  createdAt: number;
}

export interface ExecResult {
  message: string;
  undo?: () => Promise<string>;
}

const DRAFT_TTL_MS = 5 * 60 * 1000;
const UNDO_TTL_MS = 10 * 60 * 1000;
const REVEAL_TTL_MS = 3 * 60 * 1000;

const drafts = new Map<string, Draft>();
const undos = new Map<string, { run: () => Promise<string>; createdAt: number }>();
/** Set when the last completed action was a non-undoable clutch op. */
const lastClutchOp = new Map<string, number>();

/**
 * After a details lookup shows the *active* bird for a ring, we stash the
 * inactive (deceased / sold / adopted) matches (plus the full bird list, so
 * parents can be resolved) — the user can reply "yes" to see them.
 */
const reveals = new Map<string, { ring: string; data: unknown; createdAt: number }>();

export function getDraft(key: string): Draft | null {
  const d = drafts.get(key);
  if (!d) return null;
  if (Date.now() - d.createdAt > DRAFT_TTL_MS) {
    drafts.delete(key);
    return null;
  }
  return d;
}

export function startDraft(key: string, op: string, slots: Record<string, SlotValue>): Draft {
  const d: Draft = {
    op,
    slots,
    ctx: {},
    resolved: false,
    stage: 'collecting',
    createdAt: Date.now(),
  };
  drafts.set(key, d);
  return d;
}

export function saveDraft(key: string, d: Draft): void {
  d.createdAt = Date.now(); // refresh TTL on activity
  drafts.set(key, d);
}

export function clearDraft(key: string): boolean {
  return drafts.delete(key);
}

export function setUndo(key: string, run: () => Promise<string>): void {
  lastClutchOp.delete(key);
  undos.set(key, { run, createdAt: Date.now() });
}

export function takeUndo(key: string): (() => Promise<string>) | null {
  const u = undos.get(key);
  undos.delete(key);
  if (!u) return null;
  if (Date.now() - u.createdAt > UNDO_TTL_MS) return null;
  return u.run;
}

/** Record that a clutch start/end just completed — clears any pending undo. */
export function markLastClutchOp(key: string): void {
  undos.delete(key);
  lastClutchOp.set(key, Date.now());
}

export function hadRecentClutchOp(key: string): boolean {
  const at = lastClutchOp.get(key);
  if (!at) return false;
  if (Date.now() - at > UNDO_TTL_MS) {
    lastClutchOp.delete(key);
    return false;
  }
  return true;
}

export function setReveal<T>(key: string, ring: string, data: T): void {
  reveals.set(key, { ring, data, createdAt: Date.now() });
}

export function takeReveal<T>(key: string): { ring: string; data: T } | null {
  const r = reveals.get(key);
  reveals.delete(key);
  if (!r) return null;
  if (Date.now() - r.createdAt > REVEAL_TTL_MS) return null;
  return { ring: r.ring, data: r.data as T };
}

export function peekReveal(key: string): boolean {
  const r = reveals.get(key);
  if (!r) return false;
  if (Date.now() - r.createdAt > REVEAL_TTL_MS) {
    reveals.delete(key);
    return false;
  }
  return true;
}
