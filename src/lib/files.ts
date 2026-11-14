import * as pdfjs from "pdfjs-dist";
import type { PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { uid } from "./util";
import { textLinesFromItems, type TextItem } from "./pdfLayout";
import type { PageImage } from "./types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Long edge in px — high enough for OCR of small Bangla print. */
const MAX_EDGE = 2600;
const JPEG_QUALITY = 0.88;

export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "application/pdf"];
export const ACCEPT_ATTR = ".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf";

export function isAccepted(file: File): boolean {
  if (ACCEPTED_TYPES.includes(file.type)) return true;
  return /\.(jpe?g|png|pdf)$/i.test(file.name);
}

export const isPdf = (file: File) => file.type === "application/pdf" || /\.pdf$/i.test(file.name);

async function imageFileToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

/** Read the PDF's own text layer in reading order, or null if it's missing/unusable. */
async function pdfTextLines(page: PDFPageProxy): Promise<string[] | null> {
  const content = await page.getTextContent();
  const items: TextItem[] = [];
  for (const raw of content.items) {
    if (!("str" in raw) || !raw.str.trim()) continue;
    const t = raw.transform;
    items.push({ str: raw.str, x: t[4], y: t[5], w: raw.width, h: Math.abs(t[3]) || raw.height || 10 });
  }
  return textLinesFromItems(items, page.getViewport({ scale: 1 }).width);
}

/**
 * Convert an uploaded file into page images (plus the PDF text layer when usable).
 * onProgress receives (pagesDone, pagesTotal).
 */
export async function fileToPages(
  file: File,
  onProgress?: (done: number, total: number) => void,
): Promise<PageImage[]> {
  if (!isPdf(file)) {
    onProgress?.(0, 1);
    const dataUrl = await imageFileToDataUrl(file);
    onProgress?.(1, 1);
    return [{ id: uid(), dataUrl, source: file.name }];
  }

  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages: PageImage[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      onProgress?.(i - 1, doc.numPages);
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(4, MAX_EDGE / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const textLayer = await pdfTextLines(page).catch(() => null);
      pages.push({
        id: uid(),
        dataUrl: canvas.toDataURL("image/jpeg", JPEG_QUALITY),
        source: `${file.name} · p${i}`,
        pdfText: textLayer ?? undefined,
      });
      page.cleanup();
    }
    onProgress?.(doc.numPages, doc.numPages);
  } finally {
    await doc.destroy();
  }
  return pages;
}
