import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Thin client for the existing MightyVisionWeb API. Every call carries the
 * tenant's userId in the X-User-ID header, which is how the API scopes data to
 * a single tenant. All business logic lives in that API — never duplicated here.
 */
async function apiRequest<T>(
  userId: string,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<T> {
  const url = `${env.mightyApiUrl}${pathname}`;
  const res = await fetch(url, {
    method,
    headers: {
      'X-User-ID': userId,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    // Surface the server's own message (e.g. clutch/cage constraints) when present.
    let serverMsg = '';
    try {
      const errBody = (await res.json()) as { message?: string };
      serverMsg = errBody?.message ?? '';
    } catch {
      /* non-JSON error body */
    }
    const err = new Error(serverMsg || `API ${method} ${pathname} -> ${res.status}`);
    (err as Error & { apiMessage?: string; status?: number }).apiMessage = serverMsg;
    (err as Error & { apiMessage?: string; status?: number }).status = res.status;
    throw err;
  }
  const json = (await res.json()) as { success?: boolean; data?: T; message?: string };
  if (json.success === false) throw new Error(json.message || 'API error');
  return (json.data ?? (json as unknown)) as T;
}

const apiGet = <T>(userId: string, pathname: string) => apiRequest<T>(userId, 'GET', pathname);

/**
 * The view-model shape returned by GET /api/cockatiels and accepted by
 * PUT /api/cockatiels/:id (camelCase). Round-tripping this object preserves all
 * fields, so we only change the ones we mean to.
 */
export interface BirdVM {
  birdId: string;
  nickName?: string;
  gender?: string;
  age?: string;
  ageStage?: string;
  hatchDate?: string | null;
  deathDate?: string | null;
  cageNumber?: string | null;
  originCage?: string | null;
  ringNumber?: string | null;
  ringColor?: string | null;
  isAlive?: boolean;
  isSold?: boolean;
  isReturned?: boolean;
  isHandicapped?: boolean;
  isInBreeding?: boolean;
  readyForBreeding?: boolean;
  fatherId?: string | null;
  motherId?: string | null;
  clutchId?: string | null;
  clutchNumber?: string | null;
  visuals?: string[];
  splits?: string[];
  comments?: string;
  params?: string | null;
  mutationName?: string;
  [key: string]: unknown;
}

export async function getCockatiels(userId: string): Promise<BirdVM[]> {
  try {
    const data = await apiGet<BirdVM[]>(userId, '/api/cockatiels');
    return Array.isArray(data) ? data : [];
  } catch (err: any) {
    logger.error({ err: err.message, userId }, 'getCockatiels failed');
    throw err;
  }
}

/** Updates a bird. Send the full view model with only intended fields changed. */
export async function updateCockatiel(userId: string, vm: BirdVM): Promise<BirdVM> {
  return apiRequest<BirdVM>(userId, 'PUT', `/api/cockatiels/${vm.birdId}`, vm);
}

export async function deleteCockatiel(userId: string, birdId: string): Promise<void> {
  await apiRequest(userId, 'DELETE', `/api/cockatiels/${birdId}`);
}

/** A sale row as returned by GET /api/sales (one row per bird per transaction). */
export interface SaleVM {
  salesId: string;
  soldOn: string; // YYYY-MM-DD
  soldTo: string | null; // buyer (may include a phone, e.g. "NAME | 99999")
  amount: number;
  isAdoption: boolean;
  birdId: string | null;
  nickName?: string | null;
  mutation?: string | null;
  ringNumber?: string | null;
  soldMonth?: string;
  [key: string]: unknown;
}

export async function getSales(userId: string): Promise<SaleVM[]> {
  const data = await apiGet<SaleVM[]>(userId, '/api/sales');
  return Array.isArray(data) ? data : [];
}

// ── Mutation reference data ────────────────────────────────────

export interface MutationDef {
  name: string;
  geneticCode: string;
  shortName: string;
  [key: string]: unknown;
}

/** GET /api/tieldata returns { allMutations: [...] } (unwrapped from data). */
export async function getMutations(userId: string): Promise<MutationDef[]> {
  const data = await apiGet<{ allMutations?: MutationDef[] }>(userId, '/api/tieldata');
  return Array.isArray(data?.allMutations) ? data.allMutations : [];
}

// ── Breeding (pairs / clutches / eggs) ─────────────────────────

export interface EggVM {
  eggId: string;
  laidDate: string;
  hatchDate?: string | null;
  status?: string | null;
  isInIncubator?: boolean;
  progressCode?: string;
  [key: string]: unknown;
}

export interface ClutchVM {
  clutchId: string;
  clutchNumber: number;
  isActive: boolean;
  eggs: EggVM[];
  startDate?: string | null;
  isStartDateSet?: boolean;
  endDate?: string | null;
  totalEggsLaid?: number;
  hatchedCount?: number;
  infertileCount?: number;
  disCount?: number;
  [key: string]: unknown;
}

export interface PairVM {
  pairId: string;
  cageNumber: string | number;
  maleId?: string;
  femaleId?: string;
  isClutchInProgress: boolean;
  activeClutch: ClutchVM | null;
  clutches?: ClutchVM[];
  setDate?: string | null;
  currentClutchDate?: string | null;
  totalClutches?: number;
  [key: string]: unknown;
}

export async function getBreedingPairs(userId: string): Promise<PairVM[]> {
  const data = await apiGet<PairVM[]>(userId, '/api/breeding');
  return Array.isArray(data) ? data : [];
}

/** Create a breeding pair. Server rejects a duplicate (same male + female). */
export async function createPair(
  userId: string,
  data: { maleId: string; femaleId: string; cageNumber: string; setDate?: string; startClutch?: boolean },
): Promise<PairVM> {
  return apiRequest<PairVM>(userId, 'POST', '/api/breeding', data);
}

/** Move an existing pair to a different cage (server checks cage conflicts). */
export async function updatePairCage(userId: string, pairId: string, cageNumber: string): Promise<PairVM> {
  return apiRequest<PairVM>(userId, 'PUT', `/api/breeding/${pairId}`, { cageNumber });
}

/** Begin a new clutch for a pair. Server enforces cage/parent constraints. */
export async function startClutch(userId: string, pairId: string): Promise<PairVM> {
  return apiRequest<PairVM>(userId, 'POST', `/api/breeding/${pairId}/clutch/start`);
}

/** End the active clutch. Server requires every egg to be resolved first. */
export async function endClutch(userId: string, pairId: string): Promise<PairVM> {
  return apiRequest<PairVM>(userId, 'POST', `/api/breeding/${pairId}/clutch/end`);
}

/**
 * Set the active clutch's start date. Passing adjustLastClutchDate=true auto-
 * accepts the server's -1 day shift of the previous clutch when the new start
 * date overlaps it (avoids the interactive confirmation round-trip).
 */
export async function setClutchStartDate(
  userId: string,
  pairId: string,
  startDate: string,
  adjustLastClutchDate = false,
): Promise<PairVM> {
  return apiRequest<PairVM>(userId, 'POST', `/api/breeding/${pairId}/clutch/start-date`, {
    startDate,
    adjustLastClutchDate,
  });
}

export async function addEgg(userId: string, pairId: string): Promise<PairVM> {
  return apiRequest<PairVM>(userId, 'POST', `/api/breeding/${pairId}/eggs`);
}

export async function deleteEgg(userId: string, pairId: string, eggId: string): Promise<void> {
  await apiRequest(userId, 'DELETE', `/api/breeding/${pairId}/eggs/${eggId}`);
}

export async function updateEgg(
  userId: string,
  pairId: string,
  eggId: string,
  data: { laidDate?: string; status?: string | null; hatchDate?: string },
): Promise<void> {
  await apiRequest(userId, 'PUT', `/api/breeding/${pairId}/eggs/${eggId}`, data);
}

export interface ChickResult {
  chick?: { birdId?: string };
}

export async function hatchEgg(
  userId: string,
  pairId: string,
  eggId: string,
): Promise<ChickResult> {
  return apiRequest<ChickResult>(userId, 'POST', `/api/breeding/${pairId}/eggs/${eggId}/hatch`);
}

export async function addChick(userId: string, pairId: string): Promise<ChickResult> {
  return apiRequest<ChickResult>(userId, 'POST', `/api/breeding/${pairId}/chicks`);
}

export async function markEggInfertile(userId: string, pairId: string, eggId: string): Promise<unknown> {
  return apiRequest(userId, 'POST', `/api/breeding/${pairId}/eggs/${eggId}/infertile`);
}

export async function markEggDIS(userId: string, pairId: string, eggId: string): Promise<unknown> {
  return apiRequest(userId, 'POST', `/api/breeding/${pairId}/eggs/${eggId}/dis`);
}
