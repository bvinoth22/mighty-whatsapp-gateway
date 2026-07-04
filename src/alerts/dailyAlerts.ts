/**
 * Daily aviary digest — a once-a-day WhatsApp summary of things that need
 * attention: eggs nearing hatch, overdue eggs, idle pairs, chicks needing a
 * ring, clutches ready to close, and stale clutches.
 *
 * All thresholds are cockatiel-tuned: incubation 18–21 days; first eggs usually
 * within ~10 days of pairing; ring reminder window 20–75 days after hatch.
 */
import {
  getCockatiels,
  getBreedingPairs,
  type BirdVM,
  type PairVM,
  type EggVM,
} from '../core/mightyApi.js';
import { australianExclusiveCodes, birdIsAustralianExclusive } from '../core/mutations.js';
import { parseFlexibleDate, toDDMMYYYY } from '../core/dates.js';
import { logger } from '../config/logger.js';

const DAY_MS = 86_400_000;
const LINE = '━━━━━━━━━━━━━━━━━━';

// Incubation window (days since laid).
const HATCH_MIN = 18;
const HATCH_MAX = 21;
const NEAR_HATCH_LEAD = 3; // flag "due soon" this many days before HATCH_MIN

// Ring reminder window (days since hatch).
const RING_MIN_AGE = 20;
const RING_MAX_AGE = 75;

// A pair with an active clutch but no eggs for this many days is "idle".
const NO_EGG_DAYS = 10;
// Chicks re-trigger a new clutch ~30 days after hatch, so a chick older than
// this means the current clutch should already have been closed.
const CHICK_MATURE_DAYS = 45;

function todayMidnight(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whole days between a stored date (dd-MM-yyyy / dd/MM/yyyy / ISO) and today. */
function daysSince(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const d = parseFlexibleDate(dateStr);
  if (!d) return null;
  return Math.floor((todayMidnight() - d.getTime()) / DAY_MS);
}

function birdLabel(b: BirdVM): string {
  return [b.ringNumber, b.nickName].filter(Boolean).join(' · ') || b.birdId;
}

/** An egg still under incubation (not hatched/DIS/infertile). */
function isPendingEgg(e: EggVM): boolean {
  const status = (e.status ?? '').toString().trim().toLowerCase();
  if (status && status !== 'pending') return false; // DIS / infertile / hatched
  const hatched = e.hatchDate && !/^0*1-0*1-0*1$/.test(String(e.hatchDate));
  return !hatched;
}

export interface DigestSection {
  title: string;
  lines: string[];
}

/** Compute all alert sections for a tenant (empty array → nothing to report). */
export async function computeDigest(userId: string): Promise<DigestSection[]> {
  const [birds, pairs, exclusive] = await Promise.all([
    getCockatiels(userId),
    getBreedingPairs(userId),
    australianExclusiveCodes(userId),
  ]);

  const nearing: string[] = [];
  const overdue: string[] = [];
  const idle: string[] = [];
  const closeReady: string[] = [];
  const stale: string[] = [];

  for (const pair of pairs) {
    const clutch = pair.activeClutch;
    if (!clutch || !clutch.isActive) continue;
    const cage = `Cage ${pair.cageNumber}`;
    const n = clutch.clutchNumber;
    const eggs = clutch.eggs ?? [];
    const pending = eggs.filter(isPendingEgg);
    const clutchAge = daysSince(clutch.startDate ?? pair.currentClutchDate);

    // Eggs nearing hatch / overdue.
    for (const egg of pending) {
      const age = daysSince(egg.laidDate);
      if (age === null) continue;
      if (age > HATCH_MAX) {
        overdue.push(`⏰ ${cage} · egg laid ${egg.laidDate} — *${age - HATCH_MAX} days late*, check it or mark DIS/Infertile`);
      } else if (age >= HATCH_MIN - NEAR_HATCH_LEAD) {
        const from = new Date(parseFlexibleDate(egg.laidDate)!.getTime() + HATCH_MIN * DAY_MS);
        const to = new Date(parseFlexibleDate(egg.laidDate)!.getTime() + HATCH_MAX * DAY_MS);
        nearing.push(`🥚 ${cage} · should hatch ${toDDMMYYYY(from)}–${toDDMMYYYY(to)} (day ${age})`);
      }
    }

    // Only the chicks from THIS clutch count — i.e. ones hatched on/after the
    // clutch started. Older offspring from earlier clutches must not influence
    // whether the current clutch can be closed.
    const clutchStart = parseFlexibleDate(clutch.startDate ?? pair.currentClutchDate ?? '');
    const offspring = birds.filter((b) => {
      if (b.isAlive === false || b.isSold) return false; // re-entered birds are present
      if (b.fatherId !== pair.maleId || b.motherId !== pair.femaleId) return false;
      if (!clutchStart) return true;
      const h = parseFlexibleDate(b.hatchDate ?? '');
      return h ? h.getTime() >= clutchStart.getTime() : false;
    });
    const chickAges = offspring
      .map((b) => daysSince(b.hatchDate))
      .filter((a): a is number => a !== null);
    // A chick still under 45 days means the pair is actively raising young and
    // the clutch CANNOT be closed yet.
    const hasYoungChick = chickAges.some((a) => a <= CHICK_MATURE_DAYS);
    const maturedOnly = chickAges.length > 0 && chickAges.every((a) => a > CHICK_MATURE_DAYS);
    const oldestChick = chickAges.length ? Math.max(...chickAges) : null;

    const hasActiveEggs = pending.length > 0;

    // Pair state only matters once no eggs are still incubating.
    if (!hasActiveEggs) {
      if (hasYoungChick) {
        // Still feeding young chicks (under 45 days) → all good, no reminder.
      } else if (maturedOnly) {
        // Every chick has grown past 45 days → this clutch should be closed.
        stale.push(`🗓️ ${cage} · Clutch #${n} — chicks are now *${oldestChick} days* old, time to close it and start the next clutch`);
      } else if (eggs.length > 0 || offspring.length > 0) {
        // Eggs are all done (hatched or resolved) and no chicks left to raise.
        closeReady.push(`⏳ ${cage} · Clutch #${n} — *no active eggs*, ready to close`);
      } else if (clutchAge !== null && clutchAge > NO_EGG_DAYS) {
        // Pair set but nothing laid yet.
        idle.push(`🐦 ${cage} · Clutch #${n} open ${clutchAge} days, *no eggs laid yet*`);
      }
    }
  }

  // Ring reminders.
  const ring: string[] = [];
  for (const b of birds) {
    if (b.isAlive === false || b.isSold) continue; // re-entered birds are present
    if (!b.fatherId || !b.motherId) continue; // needs both parents
    if (b.ringNumber && String(b.ringNumber).trim()) continue;
    if (birdIsAustralianExclusive(b, exclusive)) continue;
    const age = daysSince(b.hatchDate);
    if (age === null || age < RING_MIN_AGE || age > RING_MAX_AGE) continue;
    const cage = b.cageNumber ? ` (Cage ${b.cageNumber})` : '';
    ring.push(`⭕ ${b.nickName || birdLabel(b)}${cage} · *${age}d* old`);
  }

  const sections: DigestSection[] = [];
  const add = (title: string, lines: string[]) => {
    if (lines.length) sections.push({ title, lines });
  };
  add('🥚 Eggs hatching soon', nearing);
  add('⏰ Eggs overdue to hatch', overdue);
  add('🐦 Pairs with no eggs', idle);
  add('⭕ Rings to add', ring);
  add('⏳ Clutches ready to close', closeReady);
  add('🗓️ Clutches to close now', stale);
  return sections;
}

/** Render the digest message. Always returns text (an "all clear" heartbeat when empty). */
export async function buildDailyDigest(userId: string): Promise<string> {
  let sections: DigestSection[];
  try {
    sections = await computeDigest(userId);
  } catch (err: any) {
    logger.error({ err: err.message, userId }, 'daily digest computation failed');
    return `🚨 Couldn't build today's *Report* — the data service was down. I'll try again tomorrow.`;
  }

  const header = `🚨 *Report* — ${toDDMMYYYY(new Date())}\n${LINE}`;
  if (sections.length === 0) {
    return `${header}\n✅ All good — nothing needs attention today. 🐦`;
  }
  const body = sections
    .map((s) => `*${s.title}*\n${s.lines.map((l) => `• ${l}`).join('\n')}`)
    .join('\n\n');
  return `${header}\n${body}`;
}
