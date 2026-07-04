import type { BirdVM, PairVM, SaleVM } from './mightyApi.js';
import { ageInDays } from './dates.js';
import { ringColorEmoji } from './ringColors.js';

const LINE = '━━━━━━━━━━━━━━━━━━';
const DOTTED = '┈┈┈┈┈┈┈┈┈┈┈┈┈┈';

/** Just the gender icon (no text): ♂️ / ♀️ / ❓ when unknown. */
function genderIcon(gender: unknown): string {
  const g = String(gender ?? '').toLowerCase();
  if (g === 'male' || g === '1' || g === 'm') return '♂️';
  if (g === 'female' || g === '2' || g === 'f') return '♀️';
  return '❓';
}

export function greeting(name: string): string {
  return `👋 Hi ${name}! I'm your MightyVision aviary assistant.\n\nReply *menu* to see what I can do.`;
}

export function help(name: string): string {
  return (
    `🦜 *MightyVision Assistant* — Hi ${name}!\n` +
    `${LINE}\n` +
    `Here's what I can do:\n\n` +
    `🔎 *Bird details*\n` +
    `   "AMWA 123 details"\n` +
    `   "<nickname> details"\n` +
    `   "pf pied /rs details"\n\n` +
    `💍 *Assign ring*\n` +
    `   "ring"\n` +
    `   "ring AMWA 123"\n\n` +
    `⚧ *Set gender*\n` +
    `   "AMWA 123 male"\n` +
    `   "AMWA 7021 is female"\n\n` +
    `💀 *Record death*\n` +
    `   "AMWA 123 died 26/05/2026"\n\n` +
    `🐣 *Breeding Pair Details*\n` +
    `   "breeding"\n` +
    `   "cages"\n\n` +
    `🥚 *Start / end clutch*\n` +
    `   "start clutch"\n` +
    `   "end clutch cage 5"\n\n` +
    `🐣 *Egg laid · Hatched · DIS · Infertile*\n` +
    `   "egg laid cage 5"\n` +
    `   "cage 5 Hatched"\n` +
    `   "cage 5 dis"\n` +
    `   "cage 5 Infertile"\n\n` +
    `🚨 *Report*\n` +
    `   "report"\n\n` +
    `↩️ *Undo* last change\n` +
    `   "undo"\n\n` +
    `_I'll ask for any missing details and confirm before saving._`
  );
}

export function subscriptionInactive(name: string): string {
  return (
    `🔒 Hi ${name}, your *WhatsApp assistant* subscription isn't active.\n\n` +
    `Please renew it in the MightyVision app to use bot commands here.`
  );
}

export function askForRing(): string {
  return `🔎 Which bird? Send the ring number, e.g. *AMWA 123 details*.`;
}

export function notFound(ring: string, suggestions: string[]): string {
  let msg = `❌ I couldn't find a bird with ring *${ring}*.`;
  if (suggestions.length) {
    msg += `\n\nDid you mean: ${suggestions.map((s) => `*${s}*`).join(', ')}?`;
  }
  return msg;
}

export function unknown(name: string): string {
  return (
    `🤔 Sorry ${name}, I didn't catch that.\n\n` +
    `Try "*AMWA 123 details*", "*AMWA 123 died*", or reply *menu*.`
  );
}

/**
 * A bird currently in the aviary. A "re-entered" bird (isReturned) is back and
 * owned again — in the data model isReturned⟹!isSold — so it counts as present.
 */
export function isActiveBird(bird: BirdVM): boolean {
  return bird.isAlive !== false && !bird.isSold;
}

function statusLabel(bird: BirdVM): string {
  if (bird.isAlive === false) return '💀 Deceased';
  if (bird.isSold) return '💰 Sold';
  if (bird.isReturned) return '🟢 Alive · 🔄 Re-entered';
  return '🟢 Alive';
}

/** Status icon for inactive birds only (used in lists and parent lines). */
/** A short status marker: skull (dead), money (sold), or 🔄 (re-entered). */
function statusMarker(bird: BirdVM): string {
  if (bird.isAlive === false) return '💀';
  if (bird.isSold) return '💰';
  if (bird.isReturned) return '🔄';
  return '';
}

/** Parent detail: status marker (if any) · gender · nickname · mutation · ring. */
function parentLine(id: string | null | undefined, gender: '♂️' | '♀️', all: BirdVM[]): string {
  if (!id) return 'Unknown';
  const p = all.find((b) => b.birdId === id);
  if (!p) return 'Unknown';
  const status = statusMarker(p);
  const lead = status ? `${status} ${gender}` : gender;
  const parts = [p.nickName || 'Unnamed'];
  if (p.mutationName) parts.push(`_${p.mutationName}_`);
  if (p.ringNumber) parts.push(`*_${p.ringNumber}_*`);
  return `${lead} ${parts.join(' · ')}`;
}

/** Extra data used to enrich a bird card. All optional. */
export interface CardContext {
  all?: BirdVM[]; // full bird list, to resolve parent labels
  pairs?: PairVM[]; // breeding pairs, to show active-breeding info
  sales?: SaleVM[]; // sales, to show sold-to / amount / date
}

function isoToDisplay(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** "NAME" from a buyer field that may be "NAME | 99999999". */
function buyerName(soldTo: string | null | undefined): string {
  return (soldTo ?? '').split('|')[0].trim() || 'Unknown';
}

function saleLine(bird: BirdVM, sales: SaleVM[]): string {
  const sale = sales.find((s) => s.birdId === bird.birdId);
  if (!sale) return '';
  const when = sale.soldOn ? ` · ${isoToDisplay(sale.soldOn)}` : '';
  return sale.isAdoption
    ? `💝 Adopted by ${buyerName(sale.soldTo)}${when}\n`
    : `💰 Sold to ${buyerName(sale.soldTo)} · ₹${sale.amount}${when}\n`;
}

function breedingLine(bird: BirdVM, pairs: PairVM[]): string {
  const pair = pairs.find(
    (p) => p.isClutchInProgress && (p.maleId === bird.birdId || p.femaleId === bird.birdId),
  );
  if (!pair || !pair.activeClutch) return '';
  const role = pair.maleId === bird.birdId ? 'Male' : 'Female';
  const state = pair.activeClutch.isActive ? '🟢 Active' : '⚪ Inactive';
  return `🐣 Cage ${pair.cageNumber} · Clutch #${pair.activeClutch.clutchNumber} (${state}) as ${role}\n`;
}

/** Compact single-block card. Secondary info appears only when relevant. */
export function birdCard(bird: BirdVM, ctx: CardContext = {}): string {
  const all = ctx.all ?? [];
  const ring = bird.ringNumber || 'No ring';
  const name = bird.nickName || 'Unnamed';

  let out = `🦜 *${ring}* · ${name}\n${LINE}\n`;
  out += `${genderIcon(bird.gender)} · _${bird.mutationName || 'Unknown'}_\n`;
  out += `*Age:* ${bird.age || 'Unknown'}\n`;
  out += `*Status:* ${statusLabel(bird)}`;
  out += bird.ringColor ? `   ·   *Ring color:* ${ringColorEmoji(bird.ringColor)}\n` : `\n`;

  const father = parentLine(bird.fatherId, '♂️', all);
  const mother = parentLine(bird.motherId, '♀️', all);
  if (father !== 'Unknown' || mother !== 'Unknown') {
    out += `*Father:* ${father}\n`;
    out += `*Mother:* ${mother}\n`;
  }

  if (ctx.pairs) out += breedingLine(bird, ctx.pairs);
  if (bird.isSold && ctx.sales) out += saleLine(bird, ctx.sales);
  if (bird.isAlive === false && bird.deathDate) out += `💀 Died ${bird.deathDate}\n`;
  return out;
}

/** Youngest first (ascending age in days). Birds without a hatch date go last. */
function sortByAgeAsc(a: BirdVM, b: BirdVM): number {
  const da = ageInDays(a.hatchDate) ?? Number.MAX_SAFE_INTEGER;
  const db = ageInDays(b.hatchDate) ?? Number.MAX_SAFE_INTEGER;
  return da - db;
}

/** One compact line: "♂️ Sunny · PF Pied / RS · 45 days · 🔵 *ARR 110*". */
function birdListItem(bird: BirdVM): string {
  const statusIcon = statusMarker(bird);
  const parts = [bird.nickName || 'Unnamed', bird.mutationName || '']
    .filter(Boolean)
    .join(' · ');
  const age = bird.age || (() => {
    const days = ageInDays(bird.hatchDate);
    return days !== null ? `${days} days` : '';
  })();
  const color = ringColorEmoji(bird.ringColor);
  const ring = bird.ringNumber
    ? `${color ? `${color} ` : ''}*${bird.ringNumber}*`
    : '*No ring*';
  const body = [parts, age].filter(Boolean).join(' · ');
  const prefix = statusIcon ? `${statusIcon} ${genderIcon(bird.gender)}` : genderIcon(bird.gender);
  return body ? `${prefix} ${body} · ${ring}` : `${prefix} ${ring}`;
}

const LIST_LIMIT = 25;

/** Compact list for multi-match searches (nickname / mutation). Alive birds only. */
export function birdList(title: string, birds: BirdVM[], opts?: { inactiveCount?: number }): string {
  const sorted = [...birds].sort(sortByAgeAsc);
  const shown = sorted.slice(0, LIST_LIMIT);
  const remaining = sorted.length - shown.length;
  const example = shown[0]?.ringNumber || 'AMWA 123';
  let out =
    `🔎 *${title}* (${birds.length})\n${LINE}\n` +
    shown.map(birdListItem).join(`\n${DOTTED}\n`);
  if (remaining > 0) {
    out += `\n${DOTTED}\n…and *${remaining}* more — refine your search to narrow it down.`;
  }
  out += `\n${LINE}\n_Send a ring number for full details, e.g. "${example} details"._`;
  if (opts?.inactiveCount) out += alsoInactiveHint(opts.inactiveCount);
  return out;
}

/** No living birds matched, but inactive records exist. */
export function noLivingMatches(title: string, count: number): string {
  const noun = count === 1 ? 'bird' : 'birds';
  return (
    `❌ No *living* birds matched ${title}.\n` +
    `ℹ️ There ${count === 1 ? 'is' : 'are'} *${count}* deceased / sold / adopted ${noun}.\n` +
    `Reply *yes* to view ${count === 1 ? 'it' : 'them'}.`
  );
}

/** The reveal itself: inactive birds from a search list. */
export function otherSearchResults(title: string, birds: BirdVM[]): string {
  const sorted = [...birds].sort(sortByAgeAsc);
  return (
    `🗂️ Other records for ${title} (deceased / sold / adopted):\n${LINE}\n` +
    sorted.map(birdListItem).join(`\n${DOTTED}\n`)
  );
}

export function noMatches(term: string): string {
  return `❌ No birds matched *${term}*.\n\nTry a ring (AMWA 123), a nickname, or a mutation like "pf pied /rs details".`;
}

/** Warns when the same ring is on more than one *living* bird (data slip-up). */
export function multipleActive(ring: string, birds: BirdVM[], ctx: CardContext = {}): string {
  const header =
    `⚠️ *Heads up:* ${birds.length} living birds share ring *${ring}*.\n` +
    `You may want to fix one of them.\n`;
  return `${header}\n${birds.map((b) => birdCard(b, ctx)).join(`\n${LINE}\n`)}`;
}

/** Offer to reveal the deceased/sold/adopted birds that also carry this ring. */
export function alsoInactiveHint(count: number): string {
  const noun = count === 1 ? 'bird' : 'birds';
  return (
    `\n${LINE}\n` +
    `ℹ️ There ${count === 1 ? 'is' : 'are'} also *${count}* deceased / sold / adopted ${noun} ` +
    `with this ring.\nReply *yes* to view ${count === 1 ? 'it' : 'them'}.`
  );
}

/** No alive bird for a ring, but deceased/sold/adopted records exist. */
export function noLivingBird(ring: string, count: number): string {
  const noun = count === 1 ? 'record' : 'records';
  return (
    `❌ No *living* bird with ring *${ring}*.\n` +
    `ℹ️ There ${count === 1 ? 'is' : 'are'} *${count}* deceased / sold / adopted ${noun} ` +
    `with this ring.\nReply *yes* to view ${count === 1 ? 'it' : 'them'}.`
  );
}

/** The reveal itself: the inactive birds for a ring. */
export function otherBirds(ring: string, birds: BirdVM[], ctx: CardContext = {}): string {
  const header = `🗂️ Other records for ring *${ring}* (deceased / sold / adopted):\n`;
  return `${header}\n${birds.map((b) => birdCard(b, ctx)).join(`\n${LINE}\n`)}`;
}

// ── Confirmation prompts ───────────────────────────────────────

function birdLabel(bird: BirdVM): string {
  const parts = [bird.ringNumber, bird.nickName].filter(Boolean);
  return parts.length ? parts.join(' · ') : bird.birdId;
}

export function confirmDeath(bird: BirdVM): string {
  return (
    `⚠️ *Confirm death*\n${LINE}\n` +
    `Mark *${birdLabel(bird)}* as *deceased* (today)?\n\n` +
    `Reply *YES* to confirm or *NO* to cancel.`
  );
}

export function deathDone(bird: BirdVM): string {
  return `🔴 Recorded: *${birdLabel(bird)}* marked deceased.\n_Reply *undo* within 10 min to reverse._`;
}

export function cancelled(): string {
  return `👍 Okay, cancelled — nothing was changed.`;
}

export function nothingToConfirm(): string {
  return `🤷 There's nothing waiting for confirmation.`;
}

export function nothingToUndo(): string {
  return `🤷 There's nothing recent to undo.`;
}

/** Shown when *undo* is used during or right after a clutch start/end. */
export function clutchUndoBlocked(inProgress = false): string {
  if (inProgress) {
    return `↩️ Undo is not available for clutch operations. Reply *cancel* or *NO* to abort.`;
  }
  return `↩️ Undo is not available for clutch operations.`;
}

export function undone(detail: string): string {
  return `✅ ↩️ Undone: ${detail}`;
}

export function actionFailed(): string {
  return `❌ Something went wrong applying that change. Please try again shortly.`;
}

// ── Breeding (eggs / clutches) ─────────────────────────────────

export function confirmEggLaid(cage: string): string {
  return `⚠️ *Confirm egg* \n${LINE}\nLog a *new egg* for the active clutch in *Cage ${cage}*?\n\nReply *YES* to confirm or *NO* to cancel.`;
}
export function eggLaidDone(cage: string, eggCount: number): string {
  return `🥚 Egg logged for *Cage ${cage}* (now ${eggCount} egg${eggCount === 1 ? '' : 's'} this clutch).\n_Reply *undo* within 10 min to reverse._`;
}

export function confirmHatch(cage: string, laidDate: string): string {
  return `⚠️ *Confirm hatch*\n${LINE}\nHatch the oldest egg in *Cage ${cage}* (laid ${laidDate})?\nThis creates a new chick.\n\nReply *YES* to confirm or *NO* to cancel.`;
}
export function hatchDone(cage: string): string {
  return `🐣 Hatched! A new chick was added from *Cage ${cage}*.\nSend "*ring <number> cage ${cage}*" once you ring it.`;
}

export function confirmEggOutcome(cage: string, outcome: string, laidDate: string): string {
  return `⚠️ *Confirm ${outcome}*\n${LINE}\nMark the oldest egg in *Cage ${cage}* (laid ${laidDate}) as *${outcome}*?\n\nReply *YES* to confirm or *NO* to cancel.`;
}
export function eggOutcomeDone(cage: string, outcome: string): string {
  return `✅ Egg in *Cage ${cage}* marked *${outcome}*.`;
}

/** Lists cages that have an active clutch, with clutch number + egg counts. */
export function breedingList(pairs: PairVM[], all: BirdVM[] = []): string {
  const active = pairs
    .filter((p) => p.isClutchInProgress && p.activeClutch)
    .sort((a, b) => {
      const na = Number(a.cageNumber);
      const nb = Number(b.cageNumber);
      if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
      return String(a.cageNumber).localeCompare(String(b.cageNumber), undefined, { numeric: true });
    });
  if (active.length === 0) {
    return (
      `🪹 No *active clutches* right now.\n` +
      `Start a clutch in the MightyVision app, then you can log eggs, hatches, etc. here.`
    );
  }

  const blocks = active.map((p) => {
    const c = p.activeClutch!;
    const eggs = c.eggs ?? [];
    const pending = eggs.filter((e) => !e.status).length;

    let block =
      `🏠 *Cage ${p.cageNumber}* — Clutch *#${c.clutchNumber}*\n` +
      `${parentLine(p.maleId, '♂️', all)}\n` +
      `${parentLine(p.femaleId, '♀️', all)}`;
    if (eggs.length > 0) {
      block +=
        `\n   🥚 ${eggs.length} egg${eggs.length === 1 ? '' : 's'}` +
        `${pending ? ` · ${pending} pending` : ''}`;
    }
    return block;
  });

  const DOTTED = '┈┈┈┈┈┈┈┈┈┈┈┈┈┈';
  return (
    `🐣 *Active Breeding*\n${LINE}\n` +
    blocks.join(`\n${DOTTED}\n`) +
    `\n${LINE}\n_Use a cage above, e.g. "egg laid cage ${active[0].cageNumber}" or "cage ${active[0].cageNumber} hatched"._`
  );
}

export function askForCage(): string {
  return `🏠 Which cage? Include it like "*cage 5*", e.g. "egg laid cage 5".`;
}
export function noPairInCage(cage: string): string {
  return `❌ I couldn't find an *active breeding pair* in *Cage ${cage}*. Start a clutch in the app first.`;
}
export function noEggToResolve(cage: string): string {
  return `❌ There are no unresolved eggs in *Cage ${cage}*'s active clutch.`;
}

// ── Ring assignment ────────────────────────────────────────────

export function confirmRing(bird: BirdVM, newRing: string): string {
  return `⚠️ *Confirm ring*\n${LINE}\nAssign ring *${newRing}* to *${bird.nickName || bird.birdId}*${bird.cageNumber ? ` (Cage ${bird.cageNumber})` : ''}?\n\nReply *YES* to confirm or *NO* to cancel.`;
}
export function ringDone(bird: BirdVM, newRing: string): string {
  return `💍 Ring *${newRing}* assigned to *${bird.nickName || bird.birdId}*.\n_Reply *undo* within 10 min to reverse._`;
}
export function ringFormatHelp(): string {
  return `💍 To assign a ring, use:\n*ring* or *ring AMWA 123*\n\n_e.g._ "ring AMWA 123"`;
}
export function noRinglessChick(cage: string): string {
  return `❌ No un-ringed living birds found in *Cage ${cage}*.`;
}
export function multipleChicks(cage: string, names: string[]): string {
  return (
    `🤔 There are multiple un-ringed birds in *Cage ${cage}*:\n` +
    names.map((n) => `• ${n}`).join('\n') +
    `\n\nReply "*ring <number> ${names[0]}*" to pick one.`
  );
}
