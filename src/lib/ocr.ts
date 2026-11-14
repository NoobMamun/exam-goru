import { createWorker, OEM, PSM, type Worker } from "tesseract.js";
import { linesFromOcr, type OcrLine } from "./ocrLayout";

/** OCR languages. All engine and language files are bundled under /ocr — nothing is downloaded. */
export type OcrLang = "ben+eng" | "eng" | "ben";

export const OCR_LANG_LABELS: Record<OcrLang, string> = {
  "ben+eng": "Bangla + English",
  eng: "English only",
  ben: "Bangla only",
};

const asset = (p: string) => new URL(`${import.meta.env.BASE_URL}ocr/${p}`, window.location.href).href;
const workerOptions = (logger?: (m: { status: string; progress: number }) => void) => ({
  workerPath: asset("worker.min.js"),
  corePath: asset("core"),
  langPath: asset("lang"),
  gzip: true,
  // Passing `logger: undefined` replaces Tesseract's no-op default and crashes ("r is not a function").
  ...(logger ? { logger } : {}),
});

let worker: Worker | null = null;
let workerLang: OcrLang | null = null;
/** Bangla-only, single-line worker used to re-read short cells the mixed model garbled. */
let cellWorker: Worker | null = null;
let progressCb: ((p: number) => void) | null = null;

async function getWorker(lang: OcrLang): Promise<Worker> {
  if (worker && workerLang === lang) return worker;
  await terminateOcr();
  worker = await createWorker(
    lang.split("+"),
    OEM.LSTM_ONLY,
    workerOptions((m) => {
      if (m.status === "recognizing text") progressCb?.(m.progress);
    }),
  );
  await worker.setParameters({ preserve_interword_spaces: "1" });
  workerLang = lang;
  return worker;
}

async function getCellWorker(): Promise<Worker> {
  if (cellWorker) return cellWorker;
  cellWorker = await createWorker(["ben"], OEM.LSTM_ONLY, workerOptions());
  await cellWorker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
  return cellWorker;
}

/** Recognise one page image and return its text lines in reading order (grid cells separated by 4 spaces). */
export async function ocrImage(dataUrl: string, lang: OcrLang, onProgress?: (p: number) => void): Promise<string[]> {
  const w = await getWorker(lang);
  progressCb = onProgress ?? null;
  try {
    const { data } = await w.recognize(dataUrl, {}, { text: true, blocks: true });
    const lines: OcrLine[] = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
    if (!lines.length) return data.text.split("\n");
    const reread =
      lang === "ben+eng"
        ? async (rectangle: { left: number; top: number; width: number; height: number }) => {
            const cw = await getCellWorker();
            const r = await cw.recognize(dataUrl, { rectangle });
            return r.data.text.replace(/\s+/g, " ").trim() || null;
          }
        : null;
    return await linesFromOcr(lines, data.text, reread);
  } finally {
    progressCb = null;
  }
}

export async function terminateOcr(): Promise<void> {
  const ws = [worker, cellWorker];
  worker = null;
  cellWorker = null;
  workerLang = null;
  await Promise.all(ws.map((x) => x?.terminate()));
}
