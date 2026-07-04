/** Date helpers matching the MightyVision storage formats. */

/** Today as dd-MM-yyyy (the format the WPF/API store uses for bird dates). */
export function todayDDMMYYYY(d = new Date()): string {
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}-${month}-${d.getFullYear()}`;
}

/** Today as yyyy-MM-dd (the format the sales API accepts). */
export function todayISO(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

export function toDDMMYYYY(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(
    2,
    '0',
  )}-${d.getFullYear()}`;
}

export function toISO(d: Date): string {
  return todayISO(d);
}

/**
 * Parses a human date: "26/05/2026", "26-5-26", "today", "yesterday".
 * Returns a Date at local midnight, or null if unrecognized.
 */
export function parseFlexibleDate(input: string): Date | null {
  const t = input.trim().toLowerCase();
  if (!t) return null;
  if (t === 'today' || t === 'now') return atMidnight(new Date());
  if (t === 'yesterday') {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return atMidnight(d);
  }
  const m = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    const d = new Date(year, month - 1, day);
    if (!Number.isNaN(d.getTime()) && d.getDate() === day && d.getMonth() === month - 1) {
      return d;
    }
  }
  return null;
}

function atMidnight(d: Date): Date {
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Days since hatch (dd-MM-yyyy, dd/MM/yyyy or ISO); null if unknown. */
export function ageInDays(hatchDate: string | null | undefined): number | null {
  if (!hatchDate) return null;
  let dt: Date | null = null;
  const iso = hatchDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) dt = new Date(+iso[1], +iso[2] - 1, +iso[3]);
  else {
    const m = hatchDate.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
    if (m) dt = new Date(+m[3], +m[2] - 1, +m[1]);
  }
  if (!dt || Number.isNaN(dt.getTime())) return null;
  return Math.floor((Date.now() - dt.getTime()) / 86_400_000);
}
