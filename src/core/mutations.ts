import { getMutations, type BirdVM } from './mightyApi.js';

/**
 * Mutation-query support for "details" searches.
 *
 * Notation:
 * - "wf pied rs"        → all three must be *visuals* (extra visuals/splits OK)
 * - "wf pied/rs"        → wf+pied visual, rs split
 * - "wf pied split rs"  → same as slash form
 *
 * Tokens resolve via genetic code, short name, or full name from tieldata.
 */

export interface MutationQuery {
  visuals: string[]; // must all appear in bird.visuals (extra visuals OK)
  splits: string[]; // must all appear in bird.splits (extra splits OK)
  unresolved: string[];
}

const CACHE_TTL_MS = 30 * 60 * 1000;
let cache: { map: Map<string, string>; at: number } | null = null;

/** token (lowercased code / shortName / name) → canonical genetic code. */
export async function mutationCodeMap(userId: string): Promise<Map<string, string>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.map;
  const map = new Map<string, string>();
  try {
    for (const m of await getMutations(userId)) {
      const code = (m.geneticCode || '').toLowerCase();
      if (!code) continue;
      for (const token of [m.geneticCode, m.shortName, m.name]) {
        if (token) map.set(String(token).toLowerCase(), code);
      }
    }
  } catch {
    /* leave map empty; caller falls back to nickname search */
  }
  cache = { map, at: Date.now() };
  return map;
}

const AUS_CACHE_TTL_MS = 30 * 60 * 1000;
let ausCache: { codes: Set<string>; at: number } | null = null;

/**
 * Genetic codes of mutations flagged `isAustralianExclusive` in the API's
 * tieldata. Used to skip Australian-exclusive birds from ring reminders.
 */
export async function australianExclusiveCodes(userId: string): Promise<Set<string>> {
  if (ausCache && Date.now() - ausCache.at < AUS_CACHE_TTL_MS) return ausCache.codes;
  const codes = new Set<string>();
  try {
    for (const m of await getMutations(userId)) {
      if ((m as { isAustralianExclusive?: boolean }).isAustralianExclusive) {
        const code = (m.geneticCode || '').toLowerCase();
        if (code) codes.add(code);
      }
    }
  } catch {
    /* leave empty; no exclusions */
  }
  ausCache = { codes, at: Date.now() };
  return codes;
}

/** True when any of the bird's visual mutations is Australian-exclusive. */
export function birdIsAustralianExclusive(bird: BirdVM, exclusive: Set<string>): boolean {
  if (exclusive.size === 0) return false;
  return (bird.visuals ?? []).some((v) => exclusive.has(String(v).toLowerCase()));
}

const tokenize = (s: string): string[] =>
  s
    .split(/[\s,]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

/** Split the query into visual and split sections (by "/" or the word "split"). */
function splitVisualAndSplitParts(text: string): { visualPart: string; splitPart: string } {
  const slash = text.indexOf('/');
  if (slash !== -1) {
    return { visualPart: text.slice(0, slash), splitPart: text.slice(slash + 1) };
  }
  const m = text.match(/\bsplit\b/i);
  if (m?.index !== undefined) {
    return {
      visualPart: text.slice(0, m.index),
      splitPart: text.slice(m.index + m[0].length),
    };
  }
  return { visualPart: text, splitPart: '' };
}

/** Parse "wf pied rs", "wf pied/rs", or "wf pied split rs". */
export function parseMutationQuery(text: string, map: Map<string, string>): MutationQuery {
  const resolveTokens = (part: string | undefined) => {
    const codes: string[] = [];
    const unresolved: string[] = [];
    for (const t of tokenize(part ?? '')) {
      const code = map.get(t);
      if (code) codes.push(code);
      else unresolved.push(t);
    }
    return { codes, unresolved };
  };

  const { visualPart, splitPart } = splitVisualAndSplitParts(text);
  const v = resolveTokens(visualPart);
  const s = resolveTokens(splitPart);
  return {
    visuals: v.codes,
    splits: s.codes,
    unresolved: [...v.unresolved, ...s.unresolved],
  };
}

/**
 * A bird matches when every requested visual is in bird.visuals and every
 * requested split is in bird.splits. Extra visuals/splits on the bird are fine.
 * With no "/" or "split" keyword, all tokens are visuals only.
 */
export function birdMatchesMutation(bird: BirdVM, q: MutationQuery): boolean {
  if (q.visuals.length === 0 && q.splits.length === 0) return false;
  const bv = (bird.visuals ?? []).map((x) => String(x).toLowerCase());
  const bs = (bird.splits ?? []).map((x) => String(x).toLowerCase());
  const hasAll = (need: string[], have: string[]) => need.every((n) => have.includes(n));
  return hasAll(q.visuals, bv) && hasAll(q.splits, bs);
}
