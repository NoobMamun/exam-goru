// Copies the OCR engine, its WebAssembly core and the Bangla/English language
// data into public/ocr so the app never downloads anything at runtime.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const nm = (...p) => path.join(root, "node_modules", ...p);
const out = path.join(root, "public", "ocr");

fs.mkdirSync(path.join(out, "core"), { recursive: true });
fs.mkdirSync(path.join(out, "lang"), { recursive: true });

fs.copyFileSync(nm("tesseract.js", "dist", "worker.min.js"), path.join(out, "worker.min.js"));

for (const f of fs.readdirSync(nm("tesseract.js-core"))) {
  if (/^tesseract-core.*\.(js|wasm)$/.test(f)) {
    fs.copyFileSync(nm("tesseract.js-core", f), path.join(out, "core", f));
  }
}

for (const lang of ["ben", "eng"]) {
  fs.copyFileSync(
    nm("@tesseract.js-data", lang, "4.0.0_best_int", `${lang}.traineddata.gz`),
    path.join(out, "lang", `${lang}.traineddata.gz`),
  );
}

console.log("OCR assets copied to public/ocr");
