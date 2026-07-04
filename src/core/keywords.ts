/**
 * Keyword registry. Adding or tuning commands is a config edit here — the
 * router code does not change. Order matters: the first matching intent wins,
 * so put more specific verbs before generic ones.
 */

export type IntentName =
  | 'confirm_yes'
  | 'confirm_no'
  | 'undo'
  | 'help'
  | 'dis'
  | 'hatch'
  | 'infertile'
  | 'egg_laid'
  | 'ring'
  | 'death'
  | 'gender'
  | 'start_clutch'
  | 'end_clutch'
  | 'breeding'
  | 'report'
  | 'details'
  | 'unknown';

export interface IntentDef {
  name: IntentName;
  keywords: string[];
  /** When true, the keyword must match as a whole word (avoids false hits). */
  wholeWord?: boolean;
}

export const INTENTS: IntentDef[] = [
  { name: 'confirm_yes', keywords: ['yes', 'y', 'confirm', 'ok', 'okay', 'yep', 'yup'], wholeWord: true },
  { name: 'confirm_no', keywords: ['no', 'n', 'cancel', 'stop', 'nope'], wholeWord: true },
  { name: 'undo', keywords: ['undo', 'revert'] },
  // Clutch lifecycle — multi-word keys, placed before 'help' (has "start") and
  // 'breeding' (has "clutch") so the specific phrase wins.
  { name: 'start_clutch', keywords: ['start clutch', 'begin clutch', 'new clutch', 'open clutch'] },
  { name: 'end_clutch', keywords: ['end clutch', 'close clutch', 'finish clutch', 'stop clutch'] },
  { name: 'help', keywords: ['help', 'menu', 'start', 'hi', 'hello', 'hey'] },
  // Egg outcomes — must precede the generic "egg laid" and "death" intents
  // ("dead in shell" contains "dead").
  { name: 'dis', keywords: ['dead in shell', 'dead-in-shell', 'dis'] },
  { name: 'hatch', keywords: ['hatched', 'hatch'] },
  { name: 'infertile', keywords: ['infertile', 'not fertile', 'unfertile'] },
  { name: 'egg_laid', keywords: ['egg laid', 'laid', 'new egg', 'egg'] },
  { name: 'ring', keywords: ['ring', 'ringed'] },
  { name: 'death', keywords: ['died', 'death', 'rip', 'expired', 'passed', 'no more', 'lost', 'dead'] },
  // Gender update, e.g. "ARR 123 male" / "AMWA 7021 is female". Whole-word so
  // "male" never fires inside "female", and "cock" never fires in "cockatiel".
  { name: 'gender', keywords: ['male', 'female', 'hen', 'cock', 'gender'], wholeWord: true },
  // List active breeding cages/clutches. Placed before generic reads.
  { name: 'breeding', keywords: ['breeding', 'clutches', 'clutch', 'cages', 'active pairs', 'pairs'] },
  // On-demand daily digest (same content the 6 AM scheduler posts).
  { name: 'report', keywords: ['report', 'alerts', 'digest', 'reminders'] },
  { name: 'details', keywords: ['details', 'detail', 'info', 'information', 'status'] },
];

function matches(text: string, def: IntentDef): boolean {
  const lower = text.toLowerCase();
  return def.keywords.some((k) => {
    if (def.wholeWord) {
      return new RegExp(`(^|\\W)${k}(\\W|$)`, 'i').test(lower);
    }
    return lower.includes(k);
  });
}

export function detectIntent(text: string): IntentName {
  for (const intent of INTENTS) {
    if (matches(text, intent)) return intent.name;
  }
  return 'unknown';
}

/** Ring-number patterns used across the aviary (e.g. "ARR 123", "AMWA456"). */
const RING_PATTERNS: RegExp[] = [
  /\b(ARR|AMWA|ANWA|MW|MWA)\s+(\d+)\b/i,
  /\b(ARR|AMWA|ANWA|MW|MWA)(\d+)\b/i,
  /\b([A-Z]{2,4})\s*-?\s*(\d{2,5})\b/i,
];

// Common words that look like a ring prefix but aren't (avoid e.g. "cage 12",
// "rs 2500", "to 500"). Keeps currency/connective words from parsing as rings.
const RING_PREFIX_STOPLIST = new Set([
  'CAGE', 'EGG', 'RING', 'SOLD', 'SALE', 'SELL', 'CELL', 'BOX',
  'TO', 'RS', 'INR', 'FOR', 'AND', 'AT', 'ADOPT', 'GIFT',
  'ON', 'BY', 'OF', 'IN',
]);

export function extractRingNumber(text: string): string | null {
  for (const pattern of RING_PATTERNS) {
    const m = text.match(pattern);
    if (m && !RING_PREFIX_STOPLIST.has(m[1].toUpperCase())) {
      return `${m[1].toUpperCase()} ${m[2]}`;
    }
  }
  return null;
}

/**
 * Reads a gender word from a message. "hen"→Female, "cock"→Male. Whole-word so
 * "male" is not detected inside "female". Returns the app's stored value
 * ('Male' | 'Female') or 'Unknown', or null when no gender word is present.
 */
export function extractGender(text: string): 'Male' | 'Female' | 'Unknown' | null {
  const t = text.toLowerCase();
  if (/(^|\W)(female|hen)(\W|$)/.test(t)) return 'Female';
  if (/(^|\W)(male|cock)(\W|$)/.test(t)) return 'Male';
  if (/(^|\W)(unknown|unsure|unsexed)(\W|$)/.test(t)) return 'Unknown';
  return null;
}

/** Just the digits of a ring number, for fuzzy matching/suggestions. */
export function ringDigits(ring: string | undefined | null): string {
  return (ring ?? '').replace(/\D/g, '');
}

// Words that trigger a lookup but aren't part of the search term itself.
const SEARCH_STOPWORDS = /\b(details?|info(?:rmation)?|status|show|find|search|get|for|the|a|an)\b/gi;

/**
 * Strips the "details"/"info" style keywords from a lookup message, leaving the
 * nickname or mutation query (e.g. "details pf pied/rs" → "pf pied/rs").
 */
export function extractSearchTerm(text: string): string {
  return text.replace(SEARCH_STOPWORDS, ' ').replace(/\s+/g, ' ').trim();
}

/** Extracts a cage number, e.g. "cage 5", "cage-5", "c5". */
export function extractCage(text: string): string | null {
  const m = text.match(/\bcage\s*-?\s*([A-Za-z0-9]+)\b/i) || text.match(/\bc\s*-?\s*(\d{1,4})\b/i);
  return m ? m[1] : null;
}

/** Extracts an auto-generated chick nickname, e.g. "COCKATIEL_5". */
export function extractNickname(text: string): string | null {
  const m = text.match(/\b(cockatiel_\d+)\b/i);
  return m ? m[1].toUpperCase() : null;
}
