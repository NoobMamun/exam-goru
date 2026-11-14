import type { PageImage, Question } from "./types";
import { ocrImage, terminateOcr, type OcrLang } from "./ocr";
import { parseQuestions } from "./parser";
import { uid } from "./util";

export interface ExtractOptions {
  lang: OcrLang;
  /** Ignore PDF text layers and OCR every page. */
  forceOcr: boolean;
}

export interface ExtractProgress {
  page: number; // 0-based page currently being read
  pageCount: number;
  method: "pdf" | "ocr";
  /** 0..1 progress within the current page */
  pageProgress: number;
}

/** Read text for each page (PDF text layer or on-device OCR), storing it on the page. */
async function readPages(
  pages: PageImage[],
  opts: ExtractOptions,
  onProgress: (p: ExtractProgress) => void,
  signal?: AbortSignal,
): Promise<PageImage[]> {
  const out: PageImage[] = [];
  for (let i = 0; i < pages.length; i++) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const p = pages[i];
    if (!opts.forceOcr && p.pdfText) {
      onProgress({ page: i, pageCount: pages.length, method: "pdf", pageProgress: 1 });
      out.push({ ...p, text: p.pdfText, textMethod: "pdf" });
      continue;
    }
    onProgress({ page: i, pageCount: pages.length, method: "ocr", pageProgress: 0 });
    const lines = await ocrImage(p.dataUrl, opts.lang, (pp) =>
      onProgress({ page: i, pageCount: pages.length, method: "ocr", pageProgress: pp }),
    );
    out.push({ ...p, text: lines, textMethod: "ocr" });
  }
  return out;
}

export function toQuestions(pages: PageImage[], pageOffset = 0): Question[] {
  return parseQuestions(
    pages.map((p, i) => ({ pageIndex: pageOffset + i, lines: p.text ?? [], ocr: p.textMethod === "ocr" })),
  ).map((q) => ({
    id: uid(),
    number: q.number,
    text: q.text,
    options: q.options,
    correct: q.correct,
    answerSource: q.correct === null ? "unknown" : "paper",
    pageIndex: q.pageIndex,
    explanation: q.explanation || undefined,
  }));
}

/** Extract questions from all pages, fully on-device. Returns pages with their recognised text attached. */
export async function extractQuestions(
  pages: PageImage[],
  opts: ExtractOptions,
  onProgress: (p: ExtractProgress) => void,
  signal?: AbortSignal,
  pageOffset = 0,
): Promise<{ pages: PageImage[]; questions: Question[] }> {
  const onAbort = () => void terminateOcr();
  signal?.addEventListener("abort", onAbort);
  try {
    const read = await readPages(pages, opts, onProgress, signal);
    return { pages: read, questions: toQuestions(read, pageOffset) };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await terminateOcr();
  }
}
