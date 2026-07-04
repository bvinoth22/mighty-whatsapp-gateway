import type { InboundMessage } from '../providers/IMessagingProvider.js';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { resolveTenant } from './tenantResolver.js';
import { getCockatiels, getBreedingPairs, getSales } from './mightyApi.js';
import { detectIntent, extractRingNumber, ringDigits, extractSearchTerm } from './keywords.js';
import { mutationCodeMap, parseMutationQuery, birdMatchesMutation } from './mutations.js';
import { OPS } from './operations.js';
import { beginStartClutch, continueStartClutch, hasStartClutch } from './startClutchFlow.js';
import { buildDailyDigest } from '../alerts/dailyAlerts.js';
import {
  getDraft,
  startDraft,
  saveDraft,
  clearDraft,
  setUndo,
  takeUndo,
  markLastClutchOp,
  hadRecentClutchOp,
  setReveal,
  takeReveal,
  peekReveal,
  type Draft,
} from './conversationStore.js';
import type { BirdVM } from './mightyApi.js';
import * as reply from './replyFormatter.js';

type RevealData =
  | { kind: 'ring'; others: BirdVM[]; ctx: reply.CardContext }
  | { kind: 'search'; title: string; others: BirdVM[] };

/** Appended to every question so the user always knows how to bail out. */
const CANCEL_HINT = '\n\n_Or reply *cancel* / *stop* to abort._';
const withCancel = (question: string): string => `${question}${CANCEL_HINT}`;

/**
 * Conversational dialog engine.
 *
 * Identity: sender phone → tenant (never message content). Then either continue
 * an in-progress draft (slot-filling for an operation) or start a new one. Every
 * operation collects its required details across turns, shows a confirmation,
 * and only writes on YES — always scoped to that tenant's data.
 */
export async function routeMessage(msg: InboundMessage): Promise<string | null> {
  if (msg.fromMe && !env.allowSelfMessages) return null;

  const tenant = await resolveTenant(msg.senderPhone);
  if (!tenant) {
    logger.info({ phone: msg.senderPhone }, 'Unknown sender — ignored');
    return null;
  }
  if (!tenant.subscriptionActive) return reply.subscriptionInactive(tenant.displayName);

  const key = `${msg.chatId}|${msg.senderPhone}`;
  const userId = tenant.userId;
  const intent = detectIntent(msg.text);
  const draft = getDraft(key);
  logger.info(
    { userId, intent, hasDraft: Boolean(draft), stage: draft?.stage, awaiting: draft?.awaiting },
    'routing',
  );

  // ── Continue an in-progress start-clutch flow (its own state machine) ──
  if (hasStartClutch(key)) return continueStartClutch(key, userId, msg.text, intent);

  // ── Mid-conversation ──
  if (draft) {
    // Clutch close cannot be cancelled via undo — only NO / cancel / stop.
    if (intent === 'undo' && draft.op === 'end_clutch') {
      return reply.clutchUndoBlocked(true);
    }
    if (intent === 'confirm_no' || intent === 'undo') {
      clearDraft(key);
      return reply.cancelled();
    }
    if (draft.stage === 'confirming') {
      if (intent === 'confirm_yes') return executeDraft(key, draft, userId);
      // Let a fresh operation command replace the current one.
      if (OPS[intent]) {
        clearDraft(key);
        return startOp(key, intent, userId, msg.text);
      }
      return `Please reply *YES* to confirm or *NO* to cancel.\n\n${OPS[draft.op].confirm(draft)}`;
    }
    // collecting → treat the message as the answer to the awaited slot
    return handleAnswer(key, draft, userId, msg.text);
  }

  // ── Follow-up: reveal deceased/sold/adopted birds for the last ring shown ──
  // Only a plain "yes" reveals them; any other message cancels the offer and is
  // processed normally (checked for other keywords below).
  if (peekReveal(key)) {
    if (intent === 'confirm_yes') {
      const rv = takeReveal<RevealData>(key);
      if (rv?.data.kind === 'ring') {
        return reply.otherBirds(rv.ring, rv.data.others, rv.data.ctx);
      }
      if (rv?.data.kind === 'search') {
        return reply.otherSearchResults(rv.data.title, rv.data.others);
      }
    } else {
      takeReveal(key); // discard the pending offer, then fall through
    }
  }

  // ── Fresh message ──
  if (intent === 'start_clutch') return beginStartClutch(key);
  if (OPS[intent]) return startOp(key, intent, userId, msg.text);

  switch (intent) {
    case 'help':
      return reply.help(tenant.displayName);
    case 'undo':
      return runUndo(key);
    case 'confirm_yes':
    case 'confirm_no':
      return reply.nothingToConfirm();
    case 'breeding':
      return handleBreedingList(userId);
    case 'report':
      return buildDailyDigest(userId);
    case 'details':
      return handleSearch(key, userId, msg.text);
    default:
      if (extractRingNumber(msg.text)) return handleRingLookup(key, userId, msg.text);
      return reply.unknown(tenant.displayName);
  }
}


// ── Draft lifecycle ────────────────────────────────────────────

async function startOp(key: string, op: string, userId: string, text: string): Promise<string> {
  const slots = OPS[op].parseInitial(text);
  const draft = startDraft(key, op, slots);
  return advance(key, draft, userId);
}

async function handleAnswer(key: string, draft: Draft, userId: string, text: string): Promise<string> {
  const op = OPS[draft.op];
  const slot = op.slots.find((s) => s.name === draft.awaiting);
  if (!slot) return advance(key, draft, userId);

  const val = slot.parse(text, draft);
  if (val === null || val === undefined || val === '') {
    return withCancel(`🤔 I couldn't read that. ${slot.ask(draft)}`);
  }
  draft.slots[slot.name] = val;
  const wasAnchor = slot.name === op.anchor;
  // Repeating slot (e.g. resolve each egg): keep asking until it says it's done.
  if (slot.repeat && slot.repeat(draft)) {
    delete draft.slots[slot.name];
    saveDraft(key, draft);
    return advance(key, draft, userId);
  }
  draft.awaiting = undefined;
  if (wasAnchor) draft.resolved = false; // re-resolve context with the new anchor
  saveDraft(key, draft);
  return advance(key, draft, userId);
}

/** Fill/ask the next needed slot, or move to confirmation. */
async function advance(key: string, draft: Draft, userId: string): Promise<string> {
  const op = OPS[draft.op];

  // 1) Anchor must be known before we can resolve context.
  if (draft.slots[op.anchor] === undefined) {
    const anchorSlot = op.slots.find((s) => s.name === op.anchor)!;
    draft.awaiting = op.anchor;
    draft.stage = 'collecting';
    saveDraft(key, draft);
    return withCancel(anchorSlot.ask(draft));
  }

  // 2) Resolve context (find pair/bird/parents/egg). Abort with a message on error.
  if (!draft.resolved) {
    const err = await op.resolve(userId, draft);
    if (err) {
      clearDraft(key);
      return err;
    }
    draft.resolved = true;
    saveDraft(key, draft);
  }

  // 3) Ask for the next missing required slot (apply defaults to optionals).
  for (const s of op.slots) {
    if (s.name === op.anchor) continue;
    if (draft.slots[s.name] === undefined) {
      if (s.optional) {
        if (s.default) draft.slots[s.name] = s.default(draft);
        continue;
      }
      draft.awaiting = s.name;
      draft.stage = 'collecting';
      saveDraft(key, draft);
      return withCancel(s.ask(draft));
    }
  }

  // 4) All set → confirm.
  draft.awaiting = undefined;
  draft.stage = 'confirming';
  saveDraft(key, draft);
  return op.confirm(draft);
}

async function executeDraft(key: string, draft: Draft, userId: string): Promise<string> {
  const op = OPS[draft.op];
  try {
    const result = await op.execute(userId, draft);
    if (result.undo) setUndo(key, result.undo);
    else if (draft.op === 'end_clutch') markLastClutchOp(key);
    clearDraft(key);
    return result.message;
  } catch (err: any) {
    logger.error({ err: err.message, op: draft.op }, 'operation execute failed');
    clearDraft(key);
    return reply.actionFailed();
  }
}

async function runUndo(key: string): Promise<string> {
  const undo = takeUndo(key);
  if (!undo) {
    if (hadRecentClutchOp(key)) return reply.clutchUndoBlocked();
    return reply.nothingToUndo();
  }
  try {
    return reply.undone(await undo());
  } catch (err: any) {
    logger.error({ err: err.message }, 'undo failed');
    return reply.actionFailed();
  }
}

// ── Reads ──────────────────────────────────────────────────────

async function handleBreedingList(userId: string): Promise<string> {
  try {
    const [pairs, birds] = await Promise.all([
      getBreedingPairs(userId),
      getCockatiels(userId),
    ]);
    return reply.breedingList(pairs, birds);
  } catch {
    return reply.actionFailed();
  }
}

/**
 * "details" search dispatcher. A ring number → full card (with priority/reveal).
 * Otherwise a mutation query ("pf pied/rs") or a nickname → a matches list.
 */
async function handleSearch(key: string, userId: string, text: string): Promise<string> {
  if (extractRingNumber(text)) return handleRingLookup(key, userId, text);

  const term = extractSearchTerm(text);
  if (!term) return reply.askForRing();

  let birds: BirdVM[];
  try {
    birds = await getCockatiels(userId);
  } catch {
    return reply.actionFailed();
  }

  // Mutation query if any token resolves to a known genetic code.
  const q = parseMutationQuery(term, await mutationCodeMap(userId));
  if (q.visuals.length || q.splits.length) {
    const matches = birds.filter((b) => birdMatchesMutation(b, q));
    return matches.length
      ? handleSearchList(key, `Mutation "${term}"`, matches)
      : reply.noMatches(term);
  }

  // Otherwise a nickname substring search.
  const needle = term.toLowerCase();
  const matches = birds.filter((b) => (b.nickName ?? '').toLowerCase().includes(needle));
  return matches.length
    ? handleSearchList(key, `Name "${term}"`, matches)
    : reply.noMatches(term);
}

/** Alive-only search list, youngest first, with optional reveal for inactive birds. */
function handleSearchList(key: string, title: string, matches: BirdVM[]): string {
  const active = matches.filter(reply.isActiveBird);
  const inactive = matches.filter((b) => !reply.isActiveBird(b));

  if (active.length === 0 && inactive.length > 0) {
    setReveal(key, title, { kind: 'search', title, others: inactive });
    return reply.noLivingMatches(title, inactive.length);
  }

  if (inactive.length) {
    setReveal(key, title, { kind: 'search', title, others: inactive });
  }

  return reply.birdList(title, active, inactive.length ? { inactiveCount: inactive.length } : undefined);
}

/** Builds the sold/breeding/parent context for the given birds (extra calls only as needed). */
async function buildCardContext(
  userId: string,
  shown: BirdVM[],
  all: BirdVM[],
): Promise<reply.CardContext> {
  const ctx: reply.CardContext = { all };
  try {
    ctx.pairs = await getBreedingPairs(userId);
  } catch {
    /* breeding info is best-effort */
  }
  if (shown.some((b) => b.isSold)) {
    try {
      ctx.sales = await getSales(userId);
    } catch {
      /* sold info is best-effort */
    }
  }
  return ctx;
}

async function handleRingLookup(key: string, userId: string, text: string): Promise<string> {
  const ring = extractRingNumber(text);
  if (!ring) return reply.askForRing();
  let birds: BirdVM[];
  try {
    birds = await getCockatiels(userId);
  } catch {
    return reply.actionFailed();
  }

  const target = ringDigits(ring);
  const matches = birds.filter((b) => ringDigits(b.ringNumber) === target);

  if (matches.length === 0) {
    const suggestions = birds
      .filter((b) => {
        const dd = ringDigits(b.ringNumber);
        return dd && (dd.startsWith(target.slice(0, 2)) || target.startsWith(dd.slice(0, 2)));
      })
      .map((b) => b.ringNumber!)
      .filter(Boolean)
      .slice(0, 3);
    return reply.notFound(ring, suggestions);
  }

  // Alive & still-owned birds always take priority over deceased/sold/adopted.
  const active = matches.filter(reply.isActiveBird);
  const inactive = matches.filter((b) => !reply.isActiveBird(b));

  // No living/owned bird → don't show sold/adopted/dead up top; offer them below.
  if (active.length === 0) {
    const ctx = await buildCardContext(userId, inactive, birds);
    setReveal(key, ring, { kind: 'ring', others: inactive, ctx });
    return reply.noLivingBird(ring, inactive.length);
  }

  // More than one living bird shares the ring (data mistake) → show them all.
  if (active.length > 1) {
    const ctx = await buildCardContext(userId, active, birds);
    if (inactive.length) setReveal(key, ring, { kind: 'ring', others: inactive, ctx });
    let out = reply.multipleActive(ring, active, ctx);
    if (inactive.length) out += reply.alsoInactiveHint(inactive.length);
    return out;
  }

  // Normal case: one active bird. Offer to reveal inactive ones with the same ring.
  const ctx = await buildCardContext(userId, [active[0], ...inactive], birds);
  let out = reply.birdCard(active[0], ctx);
  if (inactive.length) {
    setReveal(key, ring, { kind: 'ring', others: inactive, ctx });
    out += reply.alsoInactiveHint(inactive.length);
  }
  return out;
}
