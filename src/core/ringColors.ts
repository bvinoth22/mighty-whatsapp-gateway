/**
 * Default ring-color palette for the WhatsApp assistant. WhatsApp can't render a
 * true color swatch, so each color pairs a name with the closest circle emoji.
 * The hex is stored on the bird (ringColor) so it stays consistent with the web
 * app, which shows ring color via a hex color-picker.
 */
export interface RingColor {
  name: string;
  emoji: string;
  hex: string;
}

export const RING_COLORS: RingColor[] = [
  { name: 'Red', emoji: '🔴', hex: '#e53935' },
  { name: 'Orange', emoji: '🟠', hex: '#fb8c00' },
  { name: 'Yellow', emoji: '🟡', hex: '#fdd835' },
  { name: 'Green', emoji: '🟢', hex: '#43a047' },
  { name: 'Blue', emoji: '🔵', hex: '#1e88e5' },
  { name: 'Purple', emoji: '🟣', hex: '#8e24aa' },
  { name: 'Brown', emoji: '🟤', hex: '#6d4c41' },
  { name: 'Black', emoji: '⚫', hex: '#000000' },
  { name: 'White', emoji: '⚪', hex: '#ffffff' },
];

/** Numbered list for the picker prompt. */
export function ringColorList(): string {
  return RING_COLORS.map((c, i) => `${i + 1}. ${c.emoji} ${c.name}`).join('\n');
}

export function ringColorByIndex(n: number): RingColor | undefined {
  return RING_COLORS[n - 1];
}

export function ringColorByName(name: string): RingColor | undefined {
  const n = name.toLowerCase();
  return RING_COLORS.find((c) => c.name.toLowerCase() === n);
}

export function ringColorByHex(hex: string | null | undefined): RingColor | undefined {
  if (!hex) return undefined;
  const h = hex.toLowerCase();
  return RING_COLORS.find((c) => c.hex.toLowerCase() === h);
}

/** "🔴 Red" for a stored value (hex or name); falls back to the raw value. */
export function ringColorLabel(value: string | null | undefined): string {
  if (!value) return '';
  const c = ringColorByHex(value) ?? ringColorByName(value);
  return c ? `${c.emoji} ${c.name}` : value;
}

/** Parse "#rgb" or "#rrggbb" into RGB components (null if not a hex color). */
function hexToRgb(value: string): { r: number; g: number; b: number } | null {
  const h = value.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(h)) {
    return {
      r: parseInt(h[0] + h[0], 16),
      g: parseInt(h[1] + h[1], 16),
      b: parseInt(h[2] + h[2], 16),
    };
  }
  if (/^[0-9a-f]{6}$/i.test(h)) {
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }
  return null;
}

/** Closest palette color to an arbitrary hex, by squared RGB distance. */
export function nearestRingColor(value: string): RingColor | undefined {
  const rgb = hexToRgb(value);
  if (!rgb) return undefined;
  let best: RingColor | undefined;
  let bestDist = Infinity;
  for (const c of RING_COLORS) {
    const cr = hexToRgb(c.hex)!;
    const dist = (cr.r - rgb.r) ** 2 + (cr.g - rgb.g) ** 2 + (cr.b - rgb.b) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return best;
}

/**
 * Just the colored-circle emoji closest to a stored ring color (hex or name).
 * WhatsApp can't render a real swatch, so this is the visual stand-in.
 */
export function ringColorEmoji(value: string | null | undefined): string {
  if (!value) return '';
  const exact = ringColorByHex(value) ?? ringColorByName(value);
  if (exact) return exact.emoji;
  const near = nearestRingColor(value);
  return near ? near.emoji : '⭕';
}
