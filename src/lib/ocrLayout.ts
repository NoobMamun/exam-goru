/**
 * Turns Tesseract's line/word boxes into text lines, re-reading short cells that the
 * mixed Bangla+English model garbled. Pure logic: the actual re-read is a callback,
 * so this runs the same in the browser and in Node tests.
 */

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface OcrWord {
  text: string;
  bbox: Box;
}
export interface OcrLine {
  text: string;
  bbox: Box;
  words: OcrWord[];
}
/** Re-read a rectangle of the page with a Bangla-only single-line model; null if nothing useful. */
export type RereadFn = (rect: { left: number; top: number; width: number; height: number }) => Promise<string | null>;

const BANGLA = /[ঀ-৿]/;
const banglaCount = (s: string) => (s.match(/[ঀ-৿]/g) ?? []).length;
const latinCount = (s: string) => (s.match(/[A-Za-z]/g) ?? []).length;

interface Cell extends Box {
  text: string;
}

/** Split a line into cells at wide gaps (2×2 option grids keep big gaps between columns). */
export function lineCells(line: OcrLine): Cell[] {
  const h = line.bbox.y1 - line.bbox.y0;
  const cells: Cell[] = [];
  for (const w of line.words) {
    const last = cells[cells.length - 1];
    if (last && w.bbox.x0 - last.x1 <= h * 1.5) {
      last.text += ` ${w.text}`;
      last.x1 = w.bbox.x1;
      last.y0 = Math.min(last.y0, w.bbox.y0);
      last.y1 = Math.max(last.y1, w.bbox.y1);
    } else {
      cells.push({ text: w.text, ...w.bbox });
    }
  }
  return cells;
}

/**
 * On a Bangla page, a short cell with no Bangla and no real English word ("F8", "Faq", "F TM")
 * is almost always a Bangla option the mixed model misread.
 */
export function looksGarbled(text: string): boolean {
  if (BANGLA.test(text) || text.length > 14) return false;
  const words = text.match(/[A-Za-z]+/g) ?? [];
  return words.length > 0 && !words.some((w) => w.length >= 4);
}

function rectFor(b: Box) {
  const h = b.y1 - b.y0;
  const pad = Math.max(4, Math.round(h * 0.4));
  return { left: Math.max(0, b.x0 - pad), top: Math.max(0, b.y0 - pad), width: b.x1 - b.x0 + 2 * pad, height: h + 2 * pad };
}

/** Build page text lines (grid cells joined by 4 spaces), repairing garbled Bangla cells. */
export async function linesFromOcr(lines: OcrLine[], pageText: string, reread: RereadFn | null): Promise<string[]> {
  const banglaPage = reread !== null && banglaCount(pageText) > latinCount(pageText) * 0.5;
  const out: string[] = [];
  for (const line of lines) {
    const cells = lineCells(line);
    if (banglaPage && reread) {
      for (const c of cells) {
        // "Answer: 4. 8" — the English word is fine, the Bangla answer after it is not.
        const answer = /^(Answer:?)\s+(.+)$/i.exec(c.text);
        if (answer && !BANGLA.test(answer[2])) {
          const rest = line.words.slice(1).filter((x) => x.bbox.x0 >= c.x0 && x.bbox.x1 <= c.x1);
          if (rest.length) {
            const fixed = await reread(
              rectFor({
                x0: rest[0].bbox.x0,
                x1: rest[rest.length - 1].bbox.x1,
                y0: Math.min(...rest.map((x) => x.bbox.y0)),
                y1: Math.max(...rest.map((x) => x.bbox.y1)),
              }),
            );
            if (fixed && BANGLA.test(fixed)) c.text = `${answer[1]} ${fixed}`;
          }
        } else if (looksGarbled(c.text)) {
          const fixed = await reread(rectFor(c));
          if (fixed && BANGLA.test(fixed)) c.text = fixed;
        }
      }
    }
    out.push(cells.map((c) => c.text).join("    "));
  }
  return out;
}
