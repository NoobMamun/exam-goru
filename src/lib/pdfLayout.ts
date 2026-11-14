/**
 * Turning a PDF's text items into reading-order lines, and deciding whether that
 * text layer can be trusted. Pure functions (no browser APIs) so they can be tested in Node.
 */

export interface TextItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Old Bangla PDFs typed with Bijoy/SutonnyMJ fonts store ASCII/Latin-1 codes
 * instead of Unicode Bangla, so their text layer is gibberish ("evsjv‡`k").
 */
export function looksLegacyEncoded(text: string): boolean {
  const chars = text.replace(/\s/g, "");
  if (!chars) return false;
  const odd = (chars.match(/[¡-ÿ†‡ˆŒœ‰Ÿ]/g) ?? []).length;
  return odd / chars.length > 0.02;
}

/**
 * Many Unicode Bangla PDFs (Word/Chrome exports with embedded subset fonts) store glyphs in
 * *visual* order: the vowel sign ি/ে/ৈ comes before its consonant ("িবষয়" for "বিষয়"),
 * conjuncts are split and NUL characters appear. That text can't be repaired reliably.
 */
export function looksBrokenBangla(text: string): boolean {
  const bangla = (text.match(/[ঀ-৿]/g) ?? []).length;
  if (bangla < 20) return false;
  const nul = (text.match(/\u0000/g) ?? []).length;
  const orphanVowelSigns = (text.match(/(^|[^ক-হ়ৎড়-য়])[িেৈ]/gu) ?? []).length;
  return (nul + orphanVowelSigns) / bangla > 0.01;
}

export function buildLines(items: TextItem[]): string[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: { y: number; h: number; items: TextItem[] }[] = [];
  for (const it of sorted) {
    const line = lines.find((l) => Math.abs(l.y - it.y) <= Math.max(l.h, it.h) * 0.5);
    if (line) line.items.push(it);
    else lines.push({ y: it.y, h: it.h, items: [it] });
  }
  lines.sort((a, b) => b.y - a.y);
  return lines.map((l) => {
    const its = l.items.sort((a, b) => a.x - b.x);
    let text = "";
    let lastEnd = -Infinity;
    for (const it of its) {
      if (text && it.x - lastEnd > it.h * 0.2) text += " ";
      text += it.str;
      lastEnd = it.x + it.w;
    }
    return text.replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
  });
}

/** Find an empty vertical band near the middle of the page (two-column layout). */
export function findColumnSplit(items: TextItem[], width: number): number | null {
  const BINS = 100;
  const cover = new Array(BINS).fill(0);
  // Count every item, wide ones included: a real two-column page has almost nothing
  // crossing its gutter, while a single-column page with a 2×2 option grid has full-width
  // question lines crossing the middle.
  for (const it of items) {
    const a = Math.max(0, Math.floor((it.x / width) * BINS));
    const b = Math.min(BINS - 1, Math.floor(((it.x + it.w) / width) * BINS));
    for (let i = a; i <= b; i++) cover[i]++;
  }
  const allowance = Math.max(1, Math.floor(items.length * 0.02)); // a few titles may span the gutter
  let best: [number, number] | null = null;
  let runStart = -1;
  for (let i = 30; i <= 70; i++) {
    if (cover[i] <= allowance) {
      if (runStart < 0) runStart = i;
      if (!best || i - runStart > best[1] - best[0]) best = [runStart, i];
    } else runStart = -1;
  }
  if (!best) return null;
  const split = (((best[0] + best[1]) / 2 + 0.5) / BINS) * width;
  const left = items.filter((it) => it.x + it.w / 2 < split).length;
  const right = items.length - left;
  return left > items.length * 0.15 && right > items.length * 0.15 ? split : null;
}

/** Reading-order lines from a page's text items, or null if the text layer is missing or unusable. */
export function textLinesFromItems(items: TextItem[], pageWidth: number): string[] | null {
  const all = items.map((i) => i.str).join(" ");
  if (all.replace(/\s/g, "").length < 40 || looksLegacyEncoded(all) || looksBrokenBangla(all)) return null;
  const split = findColumnSplit(items, pageWidth);
  if (split === null) return buildLines(items);
  // Full-width lines (titles) that cross the gutter stay with the left column.
  const left = items.filter((it) => it.x + it.w / 2 < split || (it.x < split && it.x + it.w > split));
  const right = items.filter((it) => !left.includes(it));
  return [...buildLines(left), ...buildLines(right)];
}
