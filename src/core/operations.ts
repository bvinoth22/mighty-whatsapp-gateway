import {
  getCockatiels,
  updateCockatiel,
  deleteCockatiel,
  getBreedingPairs,
  endClutch,
  addEgg,
  deleteEgg,
  updateEgg,
  hatchEgg,
  addChick,
  markEggInfertile,
  markEggDIS,
  type BirdVM,
  type PairVM,
  type EggVM,
} from './mightyApi.js';
import type { Draft, ExecResult } from './conversationStore.js';
import {
  ringDigits,
  extractRingNumber,
  extractCage,
  extractGender,
} from './keywords.js';
import { parseFlexibleDate, toDDMMYYYY, todayDDMMYYYY, ageInDays } from './dates.js';
import {
  ringColorList,
  ringColorByIndex,
  ringColorByName,
} from './ringColors.js';

export interface SlotDef {
  name: string;
  optional?: boolean;
  ask: (d: Draft) => string;
  /** Parse a free-text answer into a value, or null if unreadable. */
  parse: (text: string, d: Draft) => string | number | null;
  default?: (d: Draft) => string | number;
  /**
   * After a valid answer, return true to ask this same slot again (used to
   * walk through a variable-length list, e.g. resolving each egg one by one).
   * The slot's parse() should accumulate progress into d.ctx.
   */
  repeat?: (d: Draft) => boolean;
}

export interface OpSpec {
  label: string;
  /** Slot that must be known before resolve() runs (e.g. cage or ring). */
  anchor: string;
  parseInitial: (text: string) => Record<string, string | number>;
  /** Enrich d.ctx from the anchor; return an error string to abort. */
  resolve: (userId: string, d: Draft) => Promise<string | null>;
  slots: SlotDef[];
  confirm: (d: Draft) => string;
  execute: (userId: string, d: Draft) => Promise<ExecResult>;
}

const LINE = '━━━━━━━━━━━━━━━━━━';

// ── shared helpers ─────────────────────────────────────────────

function birdLabel(b: BirdVM): string {
  return [b.ringNumber, b.nickName].filter(Boolean).join(' · ') || b.birdId;
}

function nameOf(birds: BirdVM[], id?: string): string {
  if (!id) return 'Unknown';
  const b = birds.find((x) => x.birdId === id);
  return b ? birdLabel(b) : id;
}

// "♂️ Male" / "♀️ Female" / "❓ Unknown" for a stored gender value.
function genderIcon(g: string | null | undefined): string {
  const v = String(g ?? '').toLowerCase();
  if (v === 'male' || v === 'm') return '♂️ Male';
  if (v === 'female' || v === 'f') return '♀️ Female';
  return '❓ Unknown';
}

// A reusable "pick a gender" slot. Accepts words (male/female/hen/cock/unknown)
// or a serial number (1 Male, 2 Female, 3 Unknown). Stores 'Male'/'Female'/''.
function genderSlot(): SlotDef {
  return {
    name: 'gender',
    ask: () => '⚧ What is the *gender*?\n1. ♂️ Male\n2. ♀️ Female\n3. ❓ Unknown',
    parse: (t) => {
      const g = extractGender(t);
      if (g) return g === 'Unknown' ? 'unknown' : g;
      const n = t.trim();
      if (n === '1') return 'Male';
      if (n === '2') return 'Female';
      if (n === '3') return 'unknown';
      return null;
    },
  };
}

// Slot value → the value stored on the bird ('Male' | 'Female' | '' for unknown).
function genderToStored(v: unknown): string {
  const s = String(v ?? '');
  return s === 'unknown' ? '' : s;
}

// "Sunny · PF Pied" for a parent id; falls back gracefully when unknown.
function parentInfo(birds: BirdVM[], id?: string | null): string {
  if (!id) return 'Unknown';
  const b = birds.find((x) => x.birdId === id);
  if (!b) return 'Unknown';
  const name = b.nickName || b.ringNumber || b.birdId;
  return b.mutationName ? `${name} · ${b.mutationName}` : name;
}

async function findBirdByRing(userId: string, ring: string): Promise<BirdVM | null> {
  const birds = await getCockatiels(userId);
  const target = ringDigits(ring);
  return birds.find((b) => ringDigits(b.ringNumber) === target) ?? null;
}

async function findActivePairByCage(userId: string, cage: string): Promise<PairVM | null> {
  const pairs = await getBreedingPairs(userId);
  return (
    pairs.find(
      (p) => String(p.cageNumber).toLowerCase() === cage.toLowerCase() && p.isClutchInProgress && p.activeClutch,
    ) ?? null
  );
}

function oldestUnresolvedEgg(pair: PairVM): EggVM | null {
  return (pair.activeClutch?.eggs ?? []).find((e) => !e.status) ?? null;
}

/** Stash the pair's clutch number + active flag so every breeding reply can show it. */
function captureClutch(pair: PairVM, d: Draft): void {
  const c = pair.activeClutch;
  d.ctx.clutchNumber = c?.clutchNumber ?? null;
  d.ctx.clutchActive = Boolean(c?.isActive);
}

/** A common "Clutch: #3 (🟢 Active)" line for all breeding messages. */
function clutchLine(d: Draft): string {
  const num = d.ctx.clutchNumber;
  const state = d.ctx.clutchActive ? '🟢 Active' : '⚪ Inactive';
  return `Clutch: *${num != null ? `#${num}` : 'N/A'}* (${state})\n`;
}

/** Display a stored egg date (ISO or dd-MM-yyyy) as dd/MM/yyyy. */
function fmtDate(s: string | undefined | null): string {
  if (!s) return 'unknown';
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : s.replace(/-/g, '/');
}

interface EggChoice {
  eggId: string;
  laidDate: string;
}

// Slot parsers reused across ops
const cageSlot = (): SlotDef => ({
  name: 'cage',
  ask: () => '🏠 Which *cage*? (e.g. 5)',
  parse: (t) => extractCage(t) ?? (t.trim().match(/^[a-z0-9]+$/i) ? t.trim() : null),
});

const dateSlot = (name: string, label: string, optional = false): SlotDef => ({
  name,
  optional,
  ask: () => `📅 What's the *${label}*? (e.g. 26/05/2026${optional ? ', or "today"' : ''})`,
  parse: (t) => {
    const d = parseFlexibleDate(t);
    return d ? toDDMMYYYY(d) : null;
  },
  default: () => todayDDMMYYYY(),
});

// ── HATCH ──────────────────────────────────────────────────────

const hatch: OpSpec = {
  label: 'hatch',
  anchor: 'cage',
  parseInitial: (text) => {
    const out: Record<string, string | number> = {};
    const cage = extractCage(text);
    if (cage) out.cage = cage;
    const d = parseFlexibleDate(text);
    if (d) out.hatchDate = toDDMMYYYY(d);
    return out;
  },
  resolve: async (userId, d) => {
    const pair = await findActivePairByCage(userId, String(d.slots.cage));
    if (!pair) return `❌ No *active breeding pair* found in Cage ${d.slots.cage}. Start a clutch in the app first.`;
    const birds = await getCockatiels(userId);
    const egg = oldestUnresolvedEgg(pair);
    captureClutch(pair, d);
    d.ctx.pairId = pair.pairId;
    d.ctx.eggId = egg?.eggId ?? null;
    d.ctx.father = nameOf(birds, pair.maleId);
    d.ctx.mother = nameOf(birds, pair.femaleId);
    return null;
  },
  slots: [cageSlot(), dateSlot('hatchDate', 'hatch date')],
  confirm: (d) =>
    `🐣 *Confirm hatch*\n${LINE}\n` +
    `Cage: *${d.slots.cage}*\n` +
    clutchLine(d) +
    `Parents: *${d.ctx.father}* × *${d.ctx.mother}*\n` +
    `Hatch date: *${d.slots.hatchDate}*\n` +
    `${d.ctx.eggId ? 'The oldest egg will be hatched into a chick.' : 'A new chick will be added.'}\n\n` +
    `Reply *YES* to confirm or *NO* to cancel.`,
  execute: async (userId, d) => {
    const pairId = String(d.ctx.pairId);
    const eggId = d.ctx.eggId as string | null;
    const res = eggId ? await hatchEgg(userId, pairId, eggId) : await addChick(userId, pairId);
    const birdId = res.chick?.birdId;
    // Apply the user-provided hatch date to the new chick.
    if (birdId && d.slots.hatchDate) {
      const birds = await getCockatiels(userId);
      const chick = birds.find((b) => b.birdId === birdId);
      if (chick) await updateCockatiel(userId, { ...chick, hatchDate: String(d.slots.hatchDate) });
    }
    return {
      message:
        `✅ Recorded a hatch in *Cage ${d.slots.cage}* — ${clutchLine(d).trim()}\n` +
        `Parents ${d.ctx.father} × ${d.ctx.mother}, hatch date *${d.slots.hatchDate}*.` +
        `${birdId ? '\n_Reply *undo* within 10 min to remove the chick._' : ''}`,
      undo: birdId
        ? async () => {
            await deleteCockatiel(userId, birdId);
            return `chick from Cage ${d.slots.cage} removed.`;
          }
        : undefined,
    };
  },
};

// ── EGG LAID ───────────────────────────────────────────────────

const egg_laid: OpSpec = {
  label: 'egg',
  anchor: 'cage',
  parseInitial: (text) => {
    const out: Record<string, string | number> = {};
    const cage = extractCage(text);
    if (cage) out.cage = cage;
    const d = parseFlexibleDate(text);
    if (d) out.laidDate = toDDMMYYYY(d);
    return out;
  },
  resolve: async (userId, d) => {
    const pair = await findActivePairByCage(userId, String(d.slots.cage));
    if (!pair) return `❌ No *active breeding pair* found in Cage ${d.slots.cage}.`;
    captureClutch(pair, d);
    const birds = await getCockatiels(userId);
    d.ctx.pairId = pair.pairId;
    d.ctx.father = nameOf(birds, pair.maleId);
    d.ctx.mother = nameOf(birds, pair.femaleId);
    return null;
  },
  // Laid date is required — the engine asks for it if it wasn't in the message.
  slots: [cageSlot(), dateSlot('laidDate', 'laid date')],
  confirm: (d) =>
    `🥚 *Confirm egg*\n${LINE}\n` +
    `Cage: *${d.slots.cage}*\n` +
    clutchLine(d) +
    `Parents: ♂️ *${d.ctx.father}* × ♀️ *${d.ctx.mother}*\n` +
    `Log a *new egg* (laid *${d.slots.laidDate}*)?\n\nReply *YES* or *NO*.`,
  execute: async (userId, d) => {
    const pairId = String(d.ctx.pairId);
    const pair = await addEgg(userId, pairId);
    const eggs = pair.activeClutch?.eggs ?? [];
    const newEgg = eggs[eggs.length - 1];
    if (newEgg && d.slots.laidDate) {
      await updateEgg(userId, pairId, newEgg.eggId, { laidDate: String(d.slots.laidDate) });
    }
    // Reflect the freshest clutch state (egg count may have advanced it).
    captureClutch(pair, d);
    return {
      message:
        `✅ Egg logged in *Cage ${d.slots.cage}* — ${clutchLine(d).trim()}\n` +
        `Parents: ♂️ ${d.ctx.father} × ♀️ ${d.ctx.mother}\n` +
        `Laid ${d.slots.laidDate} (now ${eggs.length} egg${eggs.length === 1 ? '' : 's'} this clutch).\n` +
        `_Reply *undo* within 10 min to reverse._`,
      undo: newEgg
        ? async () => {
            await deleteEgg(userId, pairId, newEgg.eggId);
            return `egg removed from Cage ${d.slots.cage}.`;
          }
        : undefined,
    };
  },
};

// ── INFERTILE / DIS ────────────────────────────────────────────

function eggOutcomeOp(kind: 'Infertile' | 'DIS'): OpSpec {
  return {
    label: kind.toLowerCase(),
    anchor: 'cage',
    parseInitial: (text) => {
      const out: Record<string, string | number> = {};
      const cage = extractCage(text);
      if (cage) out.cage = cage;
      return out;
    },
    resolve: async (userId, d) => {
      const pair = await findActivePairByCage(userId, String(d.slots.cage));
      if (!pair) return `❌ No *active breeding pair* found in Cage ${d.slots.cage}.`;
      const unresolved = (pair.activeClutch?.eggs ?? []).filter((e) => !e.status);
      if (unresolved.length === 0) return `❌ No unresolved eggs in Cage ${d.slots.cage}'s active clutch.`;
      captureClutch(pair, d);
      d.ctx.pairId = pair.pairId;
      d.ctx.eggs = unresolved.map((e) => ({ eggId: e.eggId, laidDate: e.laidDate }));
      return null;
    },
    slots: [
      cageSlot(),
      {
        // Show every unresolved egg and let the user pick one or more serials.
        name: 'picks',
        ask: (d) => {
          const eggs = (d.ctx.eggs ?? []) as EggChoice[];
          const list = eggs.map((e, i) => `${i + 1}. laid ${fmtDate(e.laidDate)}`).join('\n');
          return (
            `🥚 Which egg(s) to mark *${kind}* in *Cage ${d.slots.cage}*?\n${list}\n\n` +
            `Reply with the serial number(s) — e.g. "1", "1,3" or "1 3".`
          );
        },
        parse: (t, d) => {
          const eggs = (d.ctx.eggs ?? []) as EggChoice[];
          const nums = t
            .split(/[\s,]+/)
            .map((x) => parseInt(x, 10))
            .filter((n) => !Number.isNaN(n) && n >= 1 && n <= eggs.length);
          if (nums.length === 0) return null;
          return [...new Set(nums)].sort((a, b) => a - b).join(',');
        },
      },
    ],
    confirm: (d) => {
      const eggs = (d.ctx.eggs ?? []) as EggChoice[];
      const serials = String(d.slots.picks).split(',').map(Number);
      const chosen = serials.map((s) => `#${s} (laid ${fmtDate(eggs[s - 1].laidDate)})`).join(', ');
      return (
        `⚠️ *Confirm ${kind}*\n${LINE}\n` +
        `Cage: *${d.slots.cage}*\n` +
        clutchLine(d) +
        `Mark ${serials.length} egg(s) — ${chosen} — as *${kind}*?\n\nReply *YES* or *NO*.`
      );
    },
    execute: async (userId, d) => {
      const eggs = (d.ctx.eggs ?? []) as EggChoice[];
      const pairId = String(d.ctx.pairId);
      const serials = String(d.slots.picks).split(',').map(Number);
      for (const s of serials) {
        const eggId = eggs[s - 1].eggId;
        if (kind === 'Infertile') await markEggInfertile(userId, pairId, eggId);
        else await markEggDIS(userId, pairId, eggId);
      }
      return {
        message: `✅ Marked ${serials.length} egg(s) in *Cage ${d.slots.cage}* as *${kind}* — ${clutchLine(d).trim()}`,
      };
    },
  };
}

// ── DEATH ──────────────────────────────────────────────────────

const death: OpSpec = {
  label: 'death',
  anchor: 'ring',
  parseInitial: (text) => {
    const out: Record<string, string | number> = {};
    const ring = extractRingNumber(text);
    if (ring) out.ring = ring;
    const d = parseFlexibleDate(text);
    if (d) out.deathDate = toDDMMYYYY(d);
    return out;
  },
  resolve: async (userId, d) => {
    const bird = await findBirdByRing(userId, String(d.slots.ring));
    if (!bird) return `❌ No bird found with ring *${d.slots.ring}*.`;
    if (bird.isAlive === false) return `ℹ️ *${birdLabel(bird)}* is already marked deceased.`;
    d.ctx.bird = bird;
    return null;
  },
  slots: [
    {
      name: 'ring',
      ask: () => '🔎 Which bird? Send the *ring number* (e.g. ARR 123).',
      parse: (t) => extractRingNumber(t),
    },
    dateSlot('deathDate', 'death date', true),
  ],
  confirm: (d) => {
    const b = d.ctx.bird as BirdVM;
    return `💀 *Confirm death*\n${LINE}\nMark *${birdLabel(b)}* as *deceased* on *${d.slots.deathDate}*?\n\nReply *YES* or *NO*.`;
  },
  execute: async (userId, d) => {
    const b = d.ctx.bird as BirdVM;
    const wasAlive = b.isAlive;
    const prevDeath = b.deathDate ?? null;
    await updateCockatiel(userId, { ...b, isAlive: false, deathDate: String(d.slots.deathDate) });
    return {
      message: `✅ 🔴 *${birdLabel(b)}* marked deceased (${d.slots.deathDate}).\n_Reply *undo* within 10 min to reverse._`,
      undo: async () => {
        await updateCockatiel(userId, { ...b, isAlive: wasAlive, deathDate: prevDeath });
        return `*${birdLabel(b)}* restored to alive.`;
      },
    };
  },
};

// ── RING ASSIGNMENT ────────────────────────────────────────────

const MAX_RING_AGE_DAYS = 62; // "under 2 months"

/** Eligible to ring: present (alive & not sold), un-ringed, under ~2 months old. */
function isRingeable(b: BirdVM): boolean {
  if (b.isAlive === false || b.isSold) return false;
  if (b.ringNumber && String(b.ringNumber).trim()) return false;
  const days = ageInDays(b.hatchDate);
  return days !== null && days < MAX_RING_AGE_DAYS;
}

const ring: OpSpec = {
  label: 'ring',
  // Sentinel anchor: pre-filled so resolve() runs immediately and builds the
  // eligible-chick list (cage is an optional narrowing filter, not required).
  anchor: 'ready',
  parseInitial: (text) => {
    const out: Record<string, string | number> = { ready: 1 };
    const newRing = extractRingNumber(text);
    if (newRing) out.newRing = newRing;
    const cage = extractCage(text);
    if (cage) out.cage = cage;
    const gender = extractGender(text);
    if (gender) out.gender = gender === 'Unknown' ? 'unknown' : gender;
    return out;
  },
  resolve: async (userId, d) => {
    const all = await getCockatiels(userId);
    let birds = all.filter(isRingeable);
    if (d.slots.cage) birds = birds.filter((b) => String(b.cageNumber) === String(d.slots.cage));
    // Oldest first — those are closest to ageing out of the ringing window.
    birds.sort((a, b) => (ageInDays(b.hatchDate) ?? 0) - (ageInDays(a.hatchDate) ?? 0));
    if (birds.length === 0) {
      return `❌ No eligible chicks (alive, under 2 months, not sold/adopted)${
        d.slots.cage ? ` in Cage ${d.slots.cage}` : ''
      }.`;
    }
    d.ctx.candidates = birds;
    d.ctx.allBirds = all;
    return null;
  },
  slots: [
    { name: 'ready', ask: () => '', parse: () => 1 },
    {
      name: 'pick',
      ask: (d) => {
        const cands = (d.ctx.candidates ?? []) as BirdVM[];
        const all = (d.ctx.allBirds ?? []) as BirdVM[];
        const list = cands
          .map((b, i) => {
            const days = ageInDays(b.hatchDate);
            const age = days !== null ? ` — ${days}d old` : '';
            const cage = b.cageNumber ? ` (Cage ${b.cageNumber})` : '';
            const father = parentInfo(all, b.fatherId);
            const mother = parentInfo(all, b.motherId);
            return (
              `${i + 1}. *${b.nickName || b.birdId}*${cage}${age}\n` +
              `   Parents: ♂️ ${father}  ×  ♀️ ${mother}`
            );
          })
          .join('\n\n');
        return `🐣 Which chick to ring?\n${list}\n\nReply with the *serial number*.`;
      },
      parse: (t, d) => {
        const cands = (d.ctx.candidates ?? []) as BirdVM[];
        const n = parseInt(t.trim(), 10);
        if (Number.isNaN(n) || n < 1 || n > cands.length) return null;
        d.ctx.bird = cands[n - 1];
        return cands[n - 1].birdId;
      },
    },
    {
      name: 'newRing',
      // "ARR 123 male" — capture the gender if it rides along with the ring.
      ask: () => '💍 What *ring number* should I assign? (e.g. ARR 123, or "ARR 123 male")',
      parse: (t, d) => {
        const r = extractRingNumber(t);
        if (!r) return null;
        const g = extractGender(t);
        if (g && d.slots.gender === undefined) d.slots.gender = g === 'Unknown' ? 'unknown' : g;
        return r;
      },
    },
    genderSlot(),
    {
      name: 'color',
      ask: () => `🎨 Pick a *ring color* — reply the number, or "skip":\n${ringColorList()}`,
      parse: (t) => {
        const s = t.trim().toLowerCase();
        if (s === 'skip' || s === 'none' || s === '0') return 'none';
        const n = parseInt(s, 10);
        if (!Number.isNaN(n) && ringColorByIndex(n)) return ringColorByIndex(n)!.name;
        const byName = ringColorByName(s);
        return byName ? byName.name : null;
      },
    },
  ],
  confirm: (d) => {
    const b = d.ctx.bird as BirdVM;
    const color =
      d.slots.color && d.slots.color !== 'none'
        ? ringColorByName(String(d.slots.color))
        : undefined;
    const colorLine = color ? `\nColor: ${color.emoji} ${color.name}` : `\nColor: (none)`;
    const gender = genderToStored(d.slots.gender);
    return (
      `💍 *Confirm ring*\n${LINE}\n` +
      `Assign ring *${d.slots.newRing}* to *${b.nickName || b.birdId}*${
        b.cageNumber ? ` (Cage ${b.cageNumber})` : ''
      }\nGender: ${genderIcon(gender)}${colorLine}\n\nReply *YES* or *NO*.`
    );
  },
  execute: async (userId, d) => {
    const b = d.ctx.bird as BirdVM;
    const newRing = String(d.slots.newRing);
    const color =
      d.slots.color && d.slots.color !== 'none'
        ? ringColorByName(String(d.slots.color))
        : undefined;
    const gender = genderToStored(d.slots.gender);
    const prevRing = b.ringNumber ?? null;
    const prevColor = b.ringColor ?? null;
    const prevGender = b.gender ?? '';
    await updateCockatiel(userId, {
      ...b,
      ringNumber: newRing,
      gender,
      ...(color ? { ringColor: color.hex } : {}),
    });
    const colorTxt = color ? ` (${color.emoji} ${color.name})` : '';
    return {
      message: `✅ 💍 Ring *${newRing}*${colorTxt} · ${genderIcon(gender)} assigned to *${b.nickName || b.birdId}*.\n_Reply *undo* within 10 min to reverse._`,
      undo: async () => {
        await updateCockatiel(userId, {
          ...b,
          ringNumber: prevRing,
          ringColor: prevColor,
          gender: prevGender,
        });
        return `ring on *${b.nickName || b.birdId}* reverted.`;
      },
    };
  },
};

// ── GENDER UPDATE (standalone) ─────────────────────────────────
// "ARR 123 male" / "AMWA 7021 is female" — set gender on an existing bird.

const gender: OpSpec = {
  label: 'gender',
  anchor: 'ring',
  parseInitial: (text) => {
    const out: Record<string, string | number> = {};
    const r = extractRingNumber(text);
    if (r) out.ring = r;
    const g = extractGender(text);
    if (g) out.gender = g === 'Unknown' ? 'unknown' : g;
    return out;
  },
  resolve: async (userId, d) => {
    const target = ringDigits(String(d.slots.ring));
    const matches = (await getCockatiels(userId)).filter(
      (b) => ringDigits(b.ringNumber) === target,
    );
    if (matches.length === 0) return `❌ No bird found with ring *${d.slots.ring}*.`;
    // Prefer a living, still-owned bird when the same ring was reused.
    const active = matches.filter((b) => b.isAlive !== false && !b.isSold);
    d.ctx.bird = active[0] ?? matches[0];
    return null;
  },
  slots: [
    {
      name: 'ring',
      ask: () => '🔎 Which bird? Send the *ring number* (e.g. ARR 123).',
      parse: (t) => extractRingNumber(t),
    },
    genderSlot(),
  ],
  confirm: (d) => {
    const b = d.ctx.bird as BirdVM;
    const g = genderToStored(d.slots.gender);
    return (
      `⚧ *Confirm gender*\n${LINE}\n` +
      `Set *${b.ringNumber || b.nickName || b.birdId}* as ${genderIcon(g)}?\n\nReply *YES* or *NO*.`
    );
  },
  execute: async (userId, d) => {
    const b = d.ctx.bird as BirdVM;
    const g = genderToStored(d.slots.gender);
    const prev = b.gender ?? '';
    await updateCockatiel(userId, { ...b, gender: g });
    return {
      message: `✅ ⚧ *${b.ringNumber || b.nickName || b.birdId}* set as ${genderIcon(g)}.\n_Reply *undo* within 10 min to reverse._`,
      undo: async () => {
        await updateCockatiel(userId, { ...b, gender: prev });
        return `gender on *${b.ringNumber || b.nickName || b.birdId}* reverted.`;
      },
    };
  },
};

// ── CLUTCH LIFECYCLE (start / end) ─────────────────────────────

/** Parse an egg-outcome answer for the end-clutch walk-through. */
function parseEggOutcome(t: string): 'hatch' | 'infertile' | 'dis' | null {
  const s = t.trim().toLowerCase();
  if (s === '1' || s === 'hatch' || s === 'hatched') return 'hatch';
  if (s === '2' || s === 'infertile' || s === 'unfertile') return 'infertile';
  if (s === '3' || s === 'dis' || s === 'dead' || s === 'dead in shell') return 'dis';
  return null;
}

const outcomeLabel: Record<string, string> = {
  hatch: '🐣 Hatched',
  infertile: '⭕ Infertile',
  dis: '💀 Dead-in-shell',
};

const endClutchOp: OpSpec = {
  label: 'end clutch',
  anchor: 'cage',
  parseInitial: (text) => {
    const out: Record<string, string | number> = {};
    const cage = extractCage(text);
    if (cage) out.cage = cage;
    return out;
  },
  resolve: async (userId, d) => {
    const cage = String(d.slots.cage);
    const pair = await findActivePairByCage(userId, cage);
    if (!pair) return `❌ No *active clutch* found in Cage ${cage}.`;
    captureClutch(pair, d);
    const birds = await getCockatiels(userId);
    d.ctx.pairId = pair.pairId;
    d.ctx.father = nameOf(birds, pair.maleId);
    d.ctx.mother = nameOf(birds, pair.femaleId);
    const unresolved = (pair.activeClutch?.eggs ?? []).filter((e) => !e.status);
    d.ctx.unresolved = unresolved.map((e) => ({ eggId: e.eggId, laidDate: e.laidDate }));
    d.ctx.ri = 0;
    d.ctx.resolutions = [];
    // No unresolved eggs → skip the walk-through slot entirely.
    if (unresolved.length === 0) d.slots.resolve = 'none';
    return null;
  },
  slots: [
    cageSlot(),
    {
      // Walk through each unresolved egg, one message at a time.
      name: 'resolve',
      ask: (d) => {
        const eggs = (d.ctx.unresolved ?? []) as EggChoice[];
        const i = Number(d.ctx.ri ?? 0);
        const egg = eggs[i];
        return (
          `🥚 *Cage ${d.slots.cage}* has *${eggs.length}* unresolved egg${eggs.length === 1 ? '' : 's'} — ` +
          `resolve each before closing.\n\n` +
          `Egg *${i + 1}/${eggs.length}* (laid ${fmtDate(egg?.laidDate)}) — what happened?\n` +
          `1. 🐣 Hatched\n2. ⭕ Infertile\n3. 💀 Dead-in-shell`
        );
      },
      parse: (t, d) => {
        const outcome = parseEggOutcome(t);
        if (!outcome) return null;
        const eggs = (d.ctx.unresolved ?? []) as EggChoice[];
        const i = Number(d.ctx.ri ?? 0);
        const resolutions = (d.ctx.resolutions ?? []) as { eggId: string; outcome: string }[];
        resolutions.push({ eggId: eggs[i].eggId, outcome });
        d.ctx.resolutions = resolutions;
        d.ctx.ri = i + 1;
        return outcome;
      },
      repeat: (d) => Number(d.ctx.ri ?? 0) < ((d.ctx.unresolved as EggChoice[]) ?? []).length,
    },
  ],
  confirm: (d) => {
    const resolutions = (d.ctx.resolutions ?? []) as { eggId: string; outcome: string }[];
    const eggs = (d.ctx.unresolved ?? []) as EggChoice[];
    let lines = '';
    if (resolutions.length > 0) {
      lines =
        `\nEggs to resolve first:\n` +
        resolutions
          .map((r, i) => `${i + 1}. laid ${fmtDate(eggs[i]?.laidDate)} → ${outcomeLabel[r.outcome]}`)
          .join('\n') +
        `\n`;
    }
    return (
      `📕 *Confirm end clutch*\n${LINE}\n` +
      `Cage: *${d.slots.cage}*\n` +
      clutchLine(d) +
      `Parents: ♂️ *${d.ctx.father}* × ♀️ *${d.ctx.mother}*\n` +
      lines +
      `\nThis *closes the clutch* (cannot be undone). Reply *YES* to confirm or *NO* to cancel.`
    );
  },
  execute: async (userId, d) => {
    const pairId = String(d.ctx.pairId);
    const resolutions = (d.ctx.resolutions ?? []) as { eggId: string; outcome: string }[];
    for (const r of resolutions) {
      if (r.outcome === 'hatch') await hatchEgg(userId, pairId, r.eggId);
      else if (r.outcome === 'infertile') await markEggInfertile(userId, pairId, r.eggId);
      else await markEggDIS(userId, pairId, r.eggId);
    }
    const pair = await endClutch(userId, pairId);
    const num = d.ctx.clutchNumber as number | null;
    const ended = (pair.clutches ?? []).find((c) => c.clutchNumber === num);
    const stats = ended
      ? `\n🐣 ${ended.hatchedCount} hatched · ⭕ ${ended.infertileCount} infertile · 💀 ${ended.disCount} DIS`
      : '';
    return {
      message: `✅ 📕 Clutch *#${num ?? ''}* closed in *Cage ${d.slots.cage}*.${stats}`,
    };
  },
};

export const OPS: Record<string, OpSpec> = {
  hatch,
  egg_laid,
  infertile: eggOutcomeOp('Infertile'),
  dis: eggOutcomeOp('DIS'),
  death,
  ring,
  gender,
  end_clutch: endClutchOp,
};
