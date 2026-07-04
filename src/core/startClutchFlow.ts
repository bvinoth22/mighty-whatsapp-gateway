/**
 * Start-clutch conversation flow.
 *
 * Richer than the generic slot engine allows: it searches birds by ring/nickname,
 * validates gender + breeding readiness (as MightyVisionWeb does), confirms each
 * parent, checks the target cage is free, offers to move an existing pair, and
 * finally starts the clutch. Kept as its own small state machine (with a TTL) so
 * the multi-confirm / branching logic stays readable.
 */
import type { IntentName } from './keywords.js';
import { ringDigits, extractRingNumber, extractCage } from './keywords.js';
import { parseFlexibleDate, toDDMMYYYY, todayDDMMYYYY } from './dates.js';
import {
  getCockatiels,
  getBreedingPairs,
  createPair,
  updatePairCage,
  startClutch,
  setClutchStartDate,
  type BirdVM,
} from './mightyApi.js';
import { logger } from '../config/logger.js';
import { clutchUndoBlocked } from './replyFormatter.js';
import { markLastClutchOp } from './conversationStore.js';

const LINE = '━━━━━━━━━━━━━━━━━━';
const TTL_MS = 5 * 60 * 1000;

type Step =
  | 'male_term'
  | 'male_pick'
  | 'male_confirm'
  | 'female_term'
  | 'female_pick'
  | 'female_confirm'
  | 'cage'
  | 'move_confirm'
  | 'start_date'
  | 'final_confirm';

interface State {
  step: Step;
  maleId?: string;
  femaleId?: string;
  candidates?: string[]; // birdIds shown in the current pick list
  pendingId?: string; // bird awaiting a yes/no confirm
  cage?: string;
  existingPairId?: string;
  existingPairCage?: string;
  needMove?: boolean;
  startDate?: string;
  createdAt: number;
}

const flows = new Map<string, State>();

export function hasStartClutch(key: string): boolean {
  const s = flows.get(key);
  if (!s) return false;
  if (Date.now() - s.createdAt > TTL_MS) {
    flows.delete(key);
    return false;
  }
  return true;
}

function save(key: string, s: State): void {
  s.createdAt = Date.now();
  flows.set(key, s);
}

const CANCEL_HINT = '\n\n_Or reply *cancel* / *stop* to abort._';
const withCancel = (q: string) => `${q}${CANCEL_HINT}`;

// ── display helpers ────────────────────────────────────────────

function genderIcon(g: string | null | undefined): string {
  const v = String(g ?? '').toLowerCase();
  if (v === 'male' || v === 'm') return '♂️';
  if (v === 'female' || v === 'f') return '♀️';
  return '❓';
}

function birdLine(b: BirdVM): string {
  const bits = [b.nickName || 'Unnamed'];
  if (b.mutationName) bits.push(`_${b.mutationName}_`);
  if (b.ringNumber) bits.push(`*${b.ringNumber}*`);
  const age = b.age ? ` · ${b.age}` : '';
  return `${genderIcon(b.gender)} ${bits.join(' · ')}${age}`;
}

// ── search + eligibility ───────────────────────────────────────

/** Birds whose ring digits or nickname match the free-text term. */
function matchTerm(birds: BirdVM[], term: string): BirdVM[] {
  const ring = extractRingNumber(term);
  if (ring) {
    const target = ringDigits(ring);
    const byRing = birds.filter((b) => ringDigits(b.ringNumber) === target);
    if (byRing.length) return byRing;
  }
  const digits = term.replace(/\D/g, '');
  const needle = term.trim().toLowerCase();
  return birds.filter((b) => {
    const nick = (b.nickName ?? '').toLowerCase();
    if (needle && nick.includes(needle)) return true;
    if (digits && ringDigits(b.ringNumber) === digits) return true;
    return false;
  });
}

function genderMatches(b: BirdVM, want: 'male' | 'female'): boolean {
  return String(b.gender ?? '').toLowerCase() === want;
}

/** Why a matched bird can't fill the requested slot (or null if it can). */
function ineligibleReason(b: BirdVM, want: 'male' | 'female', otherId?: string): string | null {
  if (otherId && b.birdId === otherId) return `already selected as the ${want === 'male' ? 'female' : 'male'}`;
  if (b.isAlive === false) return 'deceased';
  if (b.isSold) return 'sold / adopted';
  if (!genderMatches(b, want)) {
    const g = String(b.gender ?? '').trim();
    if (!g) return `gender not set — set it first with "${b.ringNumber || b.nickName} ${want}"`;
    return `is ${g}, not ${want}`;
  }
  if (b.isInBreeding) return 'already in an active clutch';
  if (!b.readyForBreeding) return 'not ready for breeding (too young or within cooldown)';
  return null;
}

function eligible(birds: BirdVM[], want: 'male' | 'female', otherId?: string): BirdVM[] {
  return birds.filter((b) => ineligibleReason(b, want, otherId) === null);
}

function askTerm(want: 'male' | 'female'): string {
  const icon = want === 'male' ? '♂️' : '♀️';
  return withCancel(`${icon} Enter the *${want}* bird's *ring number* or *nickname*.`);
}

/** Handle a ring/nickname entry for the male or female slot. */
function resolveTerm(
  birds: BirdVM[],
  term: string,
  want: 'male' | 'female',
  s: State,
  otherId: string | undefined,
): string {
  const matches = matchTerm(birds, term);
  const ok = eligible(matches, want, otherId);

  if (ok.length === 1) {
    s.pendingId = ok[0].birdId;
    s.step = want === 'male' ? 'male_confirm' : 'female_confirm';
    return withCancel(
      `Found this ${want}:\n${LINE}\n${birdLine(ok[0])}\n${LINE}\nIs this correct? Reply *YES* or *NO*.`,
    );
  }
  if (ok.length > 1) {
    s.candidates = ok.map((b) => b.birdId);
    s.step = want === 'male' ? 'male_pick' : 'female_pick';
    const list = ok.map((b, i) => `${i + 1}. ${birdLine(b)}`).join('\n');
    return withCancel(`Multiple ${want} birds match — pick one:\n${LINE}\n${list}\n${LINE}\nReply with the number.`);
  }
  // Nothing eligible.
  if (matches.length === 0) {
    return withCancel(`❌ No bird found matching "*${term}*". ${askTerm(want).replace(CANCEL_HINT, '')}`);
  }
  const reasons = matches
    .slice(0, 5)
    .map((b) => `• ${birdLine(b)} — _${ineligibleReason(b, want, otherId)}_`)
    .join('\n');
  return withCancel(
    `⚠️ Found ${matches.length} match(es), but none can be the *${want}*:\n${reasons}\n\nEnter another *${want}* ring number or nickname.`,
  );
}

// ── entry + step handling ──────────────────────────────────────

export function beginStartClutch(key: string): string {
  flows.set(key, { step: 'male_term', createdAt: Date.now() });
  return `🥚 *Start a clutch*\n${LINE}\n${askTerm('male')}`;
}

const isCancelWord = (t: string) => /^(cancel|stop|abort|quit|exit)$/i.test(t.trim());

export async function continueStartClutch(
  key: string,
  userId: string,
  text: string,
  intent: IntentName,
): Promise<string> {
  const s = flows.get(key);
  if (!s) return beginStartClutch(key);

  if (isCancelWord(text)) {
    flows.delete(key);
    return `👍 Okay, cancelled — no clutch was started.`;
  }
  if (intent === 'undo') {
    return clutchUndoBlocked(true);
  }

  let birds: BirdVM[];
  try {
    birds = await getCockatiels(userId);
  } catch {
    flows.delete(key);
    return `❌ The data service was unreachable. Please try again shortly.`;
  }

  switch (s.step) {
    case 'male_term': {
      const out = resolveTerm(birds, text, 'male', s, undefined);
      save(key, s);
      return out;
    }
    case 'female_term': {
      const out = resolveTerm(birds, text, 'female', s, s.maleId);
      save(key, s);
      return out;
    }
    case 'male_pick':
    case 'female_pick': {
      const want = s.step === 'male_pick' ? 'male' : 'female';
      const n = parseInt(text.trim(), 10);
      const ids = s.candidates ?? [];
      if (Number.isNaN(n) || n < 1 || n > ids.length) {
        return withCancel(`🤔 Reply with a number between 1 and ${ids.length}.`);
      }
      s.pendingId = ids[n - 1];
      s.step = want === 'male' ? 'male_confirm' : 'female_confirm';
      const b = birds.find((x) => x.birdId === s.pendingId)!;
      save(key, s);
      return withCancel(`Selected ${want}:\n${LINE}\n${birdLine(b)}\n${LINE}\nConfirm? Reply *YES* or *NO*.`);
    }
    case 'male_confirm':
    case 'female_confirm': {
      const want = s.step === 'male_confirm' ? 'male' : 'female';
      if (intent === 'confirm_yes') {
        if (want === 'male') {
          s.maleId = s.pendingId;
          s.pendingId = undefined;
          s.step = 'female_term';
          save(key, s);
          return askTerm('female');
        }
        s.femaleId = s.pendingId;
        s.pendingId = undefined;
        s.step = 'cage';
        save(key, s);
        return withCancel(`🏠 Which *cage* should this clutch be in? (e.g. 5)`);
      }
      if (intent === 'confirm_no') {
        s.pendingId = undefined;
        s.step = want === 'male' ? 'male_term' : 'female_term';
        save(key, s);
        return askTerm(want);
      }
      return withCancel(`Please reply *YES* or *NO*.`);
    }
    case 'cage': {
      const cage = extractCage(text) ?? (text.trim().match(/^[a-z0-9]+$/i) ? text.trim() : null);
      if (!cage) return withCancel(`🏠 Please send a valid *cage* (e.g. 5).`);
      let pairs;
      try {
        pairs = await getBreedingPairs(userId);
      } catch {
        flows.delete(key);
        return `❌ The data service was unreachable. Please try again shortly.`;
      }
      const active = pairs.find(
        (p) => String(p.cageNumber).toLowerCase() === cage.toLowerCase() && p.isClutchInProgress && p.activeClutch,
      );
      if (active) {
        return withCancel(
          `❌ Cage ${cage} already has an *active clutch #${active.activeClutch?.clutchNumber}*. End it first, or choose another cage.`,
        );
      }
      s.cage = cage;
      const existing = pairs.find((p) => p.maleId === s.maleId && p.femaleId === s.femaleId);
      if (existing) {
        s.existingPairId = existing.pairId;
        const existingCage = String(existing.cageNumber);
        if (existingCage.toLowerCase() === cage.toLowerCase()) {
          s.needMove = false;
          s.step = 'start_date';
          save(key, s);
          return withCancel(dateQuestion());
        }
        s.existingPairCage = existingCage;
        s.needMove = true;
        s.step = 'move_confirm';
        save(key, s);
        return withCancel(
          `ℹ️ This pair already exists in *Cage ${existingCage}*. Move it to *Cage ${cage}* and start a new clutch here? Reply *YES* or *NO*.`,
        );
      }
      s.step = 'start_date';
      save(key, s);
      return withCancel(dateQuestion());
    }
    case 'move_confirm': {
      if (intent === 'confirm_yes') {
        s.step = 'start_date';
        save(key, s);
        return withCancel(dateQuestion());
      }
      if (intent === 'confirm_no') {
        flows.delete(key);
        return `👍 Okay, cancelled — the pair stays in Cage ${s.existingPairCage}.`;
      }
      return withCancel(`Please reply *YES* or *NO*.`);
    }
    case 'start_date': {
      let date: string | null = null;
      if (/^(skip|today|now|no)$/i.test(text.trim())) date = todayDDMMYYYY();
      else {
        const d = parseFlexibleDate(text);
        date = d ? toDDMMYYYY(d) : null;
      }
      if (!date) return withCancel(dateQuestion());
      s.startDate = date;
      s.step = 'final_confirm';
      save(key, s);
      return finalSummary(s, birds);
    }
    case 'final_confirm': {
      if (intent === 'confirm_yes') return execute(key, userId, s, birds);
      if (intent === 'confirm_no') {
        flows.delete(key);
        return `👍 Okay, cancelled — no clutch was started.`;
      }
      return withCancel(`Please reply *YES* to start or *NO* to cancel.`);
    }
    default:
      flows.delete(key);
      return beginStartClutch(key);
  }
}

function dateQuestion(): string {
  return `📅 What's the *clutch start date*? (e.g. 26/05/2026, or reply *today*)`;
}

function finalSummary(s: State, birds: BirdVM[]): string {
  const male = birds.find((b) => b.birdId === s.maleId);
  const female = birds.find((b) => b.birdId === s.femaleId);
  const pairNote = s.existingPairId
    ? s.needMove
      ? `\nMove: *Cage ${s.existingPairCage}* → *Cage ${s.cage}*`
      : `\nExisting pair in *Cage ${s.cage}*`
    : `\n*New pair*`;
  return withCancel(
    `🥚 *Confirm start clutch*\n${LINE}\n` +
      `Male: ${male ? birdLine(male) : '?'}\n` +
      `Female: ${female ? birdLine(female) : '?'}\n` +
      `Cage: *${s.cage}*${pairNote}\n` +
      `Start date: *${s.startDate}*\n${LINE}\n` +
      `Reply *YES* to start or *NO* to cancel.`,
  );
}

async function execute(key: string, userId: string, s: State, birds: BirdVM[]): Promise<string> {
  const male = birds.find((b) => b.birdId === s.maleId);
  const female = birds.find((b) => b.birdId === s.femaleId);
  try {
    let pairId = s.existingPairId;
    if (!pairId) {
      const pair = await createPair(userId, {
        maleId: String(s.maleId),
        femaleId: String(s.femaleId),
        cageNumber: String(s.cage),
        setDate: s.startDate,
      });
      pairId = pair.pairId;
    } else if (s.needMove) {
      await updatePairCage(userId, pairId, String(s.cage));
    }
    const started = await startClutch(userId, String(pairId));
    const num = started.activeClutch?.clutchNumber;
    if (s.startDate && s.startDate !== todayDDMMYYYY()) {
      await setClutchStartDate(userId, String(pairId), s.startDate, true);
    }
    flows.delete(key);
    markLastClutchOp(key);
    return (
      `✅ 🥚 Clutch *#${num ?? ''}* started in *Cage ${s.cage}*.\n` +
      `${male ? birdLine(male) : ''}\n${female ? birdLine(female) : ''}\n` +
      `Start date *${s.startDate}*. Log eggs with "egg laid cage ${s.cage}".`
    );
  } catch (err) {
    flows.delete(key);
    const msg = (err as Error).message || 'the change could not be applied';
    logger.error({ err: msg, userId }, 'start clutch failed');
    return `❌ Couldn't start the clutch — ${msg}`;
  }
}
