# Personal Exam Creator

Upload a question paper as a PDF or photos. The app reads the MCQs **on your computer, fully offline**, with no API key, account or internet. Press **Create Exam** and a timed exam starts straight away, in the style of Bangladeshi online exam sites: all questions on one page, an orange Submit button, a countdown timer, and instant results.

## Setup (one time)

```bash
npm install     # needs internet once to download packages; also copies the OCR engine + Bangla/English data into public/ocr
```

## Run

```bash
npm run dev                 # http://localhost:5173
# or a production build:
npm run build && npm start  # http://localhost:4173
```

After installing, everything works with the network switched off. Fonts, the OCR engine and the language data are all bundled.

## Flow

1. **Upload**: drop one or more PDF, JPG or PNG files. Reading starts automatically, and questions appear in the list as each page is read.
2. **Settings**: time, marks per question and negative marking are filled in from the paper when it states them (e.g. "Time: 35 minutes", "পূর্ণমান: ১০০", "ভুল উত্তরের জন্য ০.৫০ কাটা যাবে"). You can change any of them.
3. **Create Exam**: one click and the exam is live. Questions that came out incomplete are left out automatically. To fix them first, use **Edit questions first**.
4. **Results**: score, correct/wrong/skipped counts, negative-marking breakdown, and a per-question review with the explanation from the paper.

## How questions are extracted (offline)

1. **Text source**: if a PDF contains clean text, it is read directly, which is instant and exact. These go through **Tesseract OCR** in the browser instead:
   - scanned pages and photos
   - PDFs typed with old Bijoy/SutonnyMJ fonts
   - Unicode PDFs whose Bangla text is stored in the wrong order (e.g. `িবষয়` for `বিষয়`)

   On Bangla pages, short option cells that the Bangla + English model garbles are re-read with the Bangla-only model.
2. **Parsing**: built-in rules split the text into questions, options, answers and explanations. They handle:
   - question numbers such as `1.`, `(1)`, `Q1.`, `১।`, or a bare `4 প্রশ্ন…?`
   - option labels such as `(a)`, `a)`, `A.`, `(ক)`, `ক।`, or bare `ক উপজেলা   খ ওয়ার্ড` in a 2×2 grid
   - answers written as `Ans: b`, `Answer: ক. …` or `উত্তর: খ`, or listed in an answer-key table
   - explanation blocks (bullets, "REMEMBER" notes)
   - running headers, tables of contents and section banners, which are skipped
   - common OCR misreads, including a misread or missing question number
3. **Editing (optional)**: each question can be edited next to its original page, with a recognised-text view, merge-split-question, paste-an-answer-key (`1-b 2-c` or `bcad…`), and re-run OCR on one page.

## Answers

There's no AI to solve questions, so answers come from the paper itself or from you. A question with no answer key can still be taken, but it is marked **ungraded** and left out of the score. You can add the key later and re-grade any past attempt from its result page.

## Limits to expect

- OCR accuracy depends on scan quality. Mathematical notation and very short options (a single digit) may need correcting.
- OCR runs on your CPU, at roughly 5–30 seconds per scanned page.

All data (exams, page images, attempts) is stored in your browser's IndexedDB.
