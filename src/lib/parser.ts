/**
 * Offline, rule-based MCQ parser.
 *
 * Takes text lines (from a PDF text layer or OCR) and splits them into
 * questions, options, answers and explanations. Handles Bangla and English:
 *   questions:    "1.", "1)", "(1)", "Q1.", "১.", "১।", "প্রশ্ন ১:", and bare "4 প্রশ্ন…?" (strictly sequential)
 *   options:      "(a)", "a)", "a.", "(A)", "A.", "(ক)", "ক)", "ক.", "ক।", and bare "ক উপজেলা   খ ওয়ার্ড"
 *   answers:      "Ans: b", "Answer: ক. উপজেলা", "উত্তর: খ", answer-key tables "1-b 2-c …"
 *   explanations: everything after an answer line (bullets, "REMEMBER" boxes) until the next question
 */

export interface ParsedQuestion {
  number: string;
  text: string;
  options: { label: string; text: string }[];
  correct: number | null;
  explanation: string;
  pageIndex: number;
}

export interface PageLines {
  pageIndex: number;
  lines: string[];
  /** Text came from OCR: apply fixes for typical Tesseract misreads. */
  ocr?: boolean;
}

const BN_DIGITS = "০১২৩৪৫৬৭৮৯";
export const toAsciiDigits = (s: string) => s.replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));

const OPTION_SETS = [
  ["a", "b", "c", "d", "e", "f"],
  ["A", "B", "C", "D", "E", "F"],
  ["ক", "খ", "গ", "ঘ", "ঙ", "চ"],
];

/** Map an option letter (any script/case) to [setIndex, optionIndex]. */
function letterInfo(ch: string): [number, number] | null {
  for (let s = 0; s < OPTION_SETS.length; s++) {
    const i = OPTION_SETS[s].indexOf(ch);
    if (i >= 0) return [s, i];
  }
  return null;
}

/** Option letter → index, ignoring script and case. */
export function letterToIndex(ch: string): number | null {
  return letterInfo(ch)?.[1] ?? null;
}

const L = "[a-fA-Fক-চ]";
const BN_LETTER = "[\\u0980-\\u09ff]";

/**
 * Option markers.
 *   group 1: "(a)" "[ক]"           strong, anywhere
 *   group 2: "a)" "ক)"             strong, after start/space
 *   group 3: "a." "ক।" "ক:"        weak: only at line start or after another accepted marker
 *   group 4: bare "ক " (Bangla)    weak, same rule — used by many Bangla guide books
 */
const OPTION_RE = new RegExp(
  `[(\\[{]\\s*(${L})\\s*[)\\]}]` +
    `|(?<=^|[\\s,;])(${L})\\s?\\)` +
    `|(?<=^|[\\s,;])(${L})[.।:](?=\\s)` +
    `|(?<=^|\\s)([কখগঘঙ])(?=\\s+${BN_LETTER}|\\s+[0-9০-৯A-Za-z])`,
  "gu",
);

/**
 * Damaged option markers as OCR tends to produce them: "@" for "(a)", "(0" for "(c)",
 * "()" / "(A)" / "কে)" for Bangla labels. Only trusted on lines that are clearly option rows.
 */
const FUZZY_RE = /(?<=^|[\s,;])@|\(\s*[^\s()]{0,3}\s*\)|\([0oe©¢](?=[\s\d])|(?<=^|[\s,;])[^\s()]{1,2}\)/gu;
const ROMAN_RE = /^\(?\s*(?:i{1,3}|iv|vi{0,3}|ix|x)\s*\)?$/i;
const hasBangla = (s: string) => /[ঀ-৿]/.test(s);

const QUESTION_RE =
  /^\s*(?:(?:Q(?:uestion)?|প্রশ্ন)\s*[.:]?\s*)?[(\[]?\s*([0-9০-৯]{1,3})\s*[)\].।:\-–](?:\s+|(?![0-9০-৯]))(.*)$/iu;
/** "4 বাংলাদেশের প্রশাসন…?" — number then a space, no punctuation. Accepted only in strict sequence. */
const BARE_QUESTION_RE = /^\s*([0-9০-৯]{1,3})\s+(\S.*)$/u;
const NUMBER_ONLY_RE = /^\s*([0-9০-৯]{1,3})\s*[.।)]?\s*$/u;

const ANSWER_RE = new RegExp(
  `(?:^|\\s)(?:ans(?:wer)?|correct\\s*answer|সঠিক\\s*উত্তর|উত্তর|উঃ|উ:)\\s*[:ঃ.\\-–=]?\\s*[:'‘’"“(\\[]?\\s*(${L})\\s*[)\\]]?(?=[\\s.।:,]|$)`,
  "iu",
);

/** Any line that starts like an answer line, even when the letter after it is unreadable. */
const ANSWER_LINE_RE = /^\s*(?:ans(?:wer)?|correct\s*answer|সঠিক\s*উত্তর|উত্তর)\s*[:ঃ]/iu;

const normForMatch = (s: string) => s.replace(/[\s‌‍।.,:;'"‘’“”()\-–—]/g, "").toLowerCase();

/** Find the option whose text is repeated in an answer line ("Answer: গ. material noun"). */
function answerByText(q: { options: { text: string }[] }, line: string): number | null {
  const rest = line.replace(ANSWER_LINE_RE, "").replace(/^\s*\S{1,3}[.)]\s*/u, "");
  const target = normForMatch(rest);
  if (target.length < 2) return null;
  let best: number | null = null;
  let bestLen = 0;
  q.options.forEach((o, i) => {
    const t = normForMatch(o.text);
    if (t.length >= 2 && (t === target || (t.length >= 3 && target.includes(t))) && t.length > bestLen) {
      best = i;
      bestLen = t.length;
    }
  });
  return best;
}

/** Lines that begin an explanation block even without an answer line. */
const EXPLANATION_START_RE = /^\s*(?:[•*▪◦●■]|REMEMBER\b|মনে\s*রাখ|ব্যাখ্যা|Explanation\b|Note\b|টীকা)/iu;
const BULLET_RE = /^\s*[•*▪◦●■]\s*/u;
/** Section banners: "Part A · …", "Section B", "অংশ ক", "বিভাগ: খ". */
const SECTION_RE = /^\s*(?:Part|Section|অংশ|বিভাগ)\s*[-:–·]?\s*[A-Zক-ঘ0-9০-৯]{1,2}\b[\s\-–·:.]/iu;

const KEY_PAIR_RE = new RegExp(`(?<![0-9০-৯])([0-9০-৯]{1,3})\\s*[.\\-–):।=]?\\s*[(\\[]?(${L})[)\\]]?(?=[\\s,;|]|$)`, "gu");
const KEY_HEADER_RE = /^\s*(answer\s*key|answers|উত্তরমালা|উত্তরপত্র|উত্তর\s*সমূহ|সঠিক\s*উত্তর\s*সমূহ)\s*[:ঃ\-]?\s*$/iu;

/**
 * Fix systematic OCR misreads that break numbering:
 *   "৩ |" / "3 |"  → danda read as a pipe
 *   "©" at line start → Bangla digit ৩
 *   "কে)" / "(গে)" / "(থখে)" → vowel-sign noise glued to Bangla option letters
 */
export function normalizeOcrLine(line: string): string {
  let s = line;
  s = s.replace(/^\s*©/, "৩");
  s = s.replace(/^(\s*[0-9০-৯]{1,3})\s*[|।l]\s+/, "$1। ");
  s = s.replace(/(^|\s)\(?\s*থ?([কখগঘ])[েো্]+\s*\)/gu, "$1($2)");
  // Noise marks glued to a bare label at a cell start: "ঘ্৫" / "কঃ৪" → "ঘ ৫" / "ক ৪"
  s = s.replace(/(^|\s{3,})([কখগঘ])[্ঃ]+/gu, "$1$2 ");
  return s;
}

interface Draft extends ParsedQuestion {
  num: number;
  optionSet: number | null;
  /** Answer line or explanation seen: further lines are explanation, not options. */
  closed: boolean;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** Parse answer-key text such as "1-b 2-c 3.a", "১-খ ২-গ", or a bare sequence "bcad". */
export function parseAnswerKey(text: string): { byNumber: Map<number, number>; sequence: number[] } {
  const byNumber = new Map<number, number>();
  for (const m of text.matchAll(KEY_PAIR_RE)) {
    const idx = letterToIndex(m[2]);
    if (idx !== null) byNumber.set(Number(toAsciiDigits(m[1])), idx);
  }
  const sequence: number[] = [];
  if (byNumber.size === 0) {
    for (const ch of text.replace(/[\s,;|]/g, "")) {
      const idx = letterToIndex(ch);
      if (idx !== null) sequence.push(idx);
    }
  }
  return { byNumber, sequence };
}

function keyPairsIn(line: string): { pairs: [number, number][]; coverage: number } {
  const pairs: [number, number][] = [];
  let covered = 0;
  for (const m of line.matchAll(KEY_PAIR_RE)) {
    const idx = letterToIndex(m[2]);
    if (idx === null) continue;
    pairs.push([Number(toAsciiDigits(m[1])), idx]);
    covered += m[0].replace(/\s/g, "").length;
  }
  const total = line.replace(/\s/g, "").length || 1;
  return { pairs, coverage: covered / total };
}

/** Running headers/footers repeated on many pages (book title, chapter name) are noise. */
function findRepeatedLines(pages: PageLines[]): Set<string> {
  const repeated = new Set<string>();
  if (pages.length < 3) return repeated;
  const counts = new Map<string, number>();
  for (const p of pages) {
    for (const l of new Set(p.lines.map((x) => clean(x)).filter((x) => x.length > 3))) {
      counts.set(l, (counts.get(l) ?? 0) + 1);
    }
  }
  const min = Math.max(3, Math.ceil(pages.length * 0.4));
  for (const [l, c] of counts) if (c >= min) repeated.add(l);
  return repeated;
}

export function parseQuestions(pages: PageLines[]): ParsedQuestion[] {
  const out: Draft[] = [];
  const answerKey = new Map<number, number>();
  const repeated = findRepeatedLines(pages);
  let cur: Draft | null = null;
  let inKeySection = false;
  /** A question number that appeared alone on its line; the next line is its stem. */
  let pendingNumber: { printed: string; num: number; pageIndex: number } | null = null;

  const startQuestion = (printed: string, num: number, pageIndex: number): Draft => {
    const q: Draft = { number: printed, num, text: "", options: [], correct: null, explanation: "", pageIndex, optionSet: null, closed: false };
    out.push(q);
    cur = q;
    return q;
  };

  const addExplanation = (q: Draft, line: string) => {
    const t = line.replace(/^\s*\|\s*/, "").replace(/\s+/g, " ").trim(); // OCR reads the box edge as "|"
    if (!t) return;
    if (BULLET_RE.test(t) || /^REMEMBER\b/i.test(t) || !q.explanation) {
      const body = t.replace(BULLET_RE, "");
      q.explanation += (q.explanation ? "\n" : "") + (BULLET_RE.test(t) ? `• ${body}` : body);
    } else {
      q.explanation += ` ${t}`;
    }
  };

  const appendText = (q: Draft, text: string) => {
    if (!text.trim()) return;
    if (q.options.length === 0) q.text = clean(`${q.text} ${text}`);
    else {
      const last = q.options[q.options.length - 1];
      last.text = clean(`${last.text} ${text}`);
    }
  };

  /**
   * OCR option rows ("@21 (b)27 (029 (d)33", "কে) গোলাপ (A) শাপলা (গে)জবা () রজনীগন্ধা"):
   * when a line clearly lists options, take every marker-like token in order and
   * label it by position instead of trusting the damaged letters.
   * Returns false if the line doesn't look like an option row.
   */
  const consumeFuzzy = (q: Draft, text: string): boolean => {
    type M = { index: number; length: number; letter: string | null };
    const marks: M[] = [];
    for (const m of text.matchAll(OPTION_RE)) {
      marks.push({ index: m.index!, length: m[0].length, letter: m[1] ?? m[2] ?? m[3] ?? m[4] });
    }
    for (const m of text.matchAll(FUZZY_RE)) {
      if (ROMAN_RE.test(m[0].trim())) continue;
      const overlaps = marks.some((x) => m.index! < x.index + x.length && x.index < m.index! + m[0].length);
      if (!overlaps) marks.push({ index: m.index!, length: m[0].length, letter: null });
    }
    marks.sort((a, b) => a.index - b.index);
    if (!marks.length || text.slice(0, marks[0].index).trim() !== "") return false;
    if (marks.every((m) => m.letter)) return false; // all clean — let the strict path handle it
    const isRow = marks.length >= 2 || q.options.length > 0;
    if (!isRow || q.options.length + marks.length > 6) return false;

    const set =
      q.optionSet ??
      marks.map((m) => (m.letter ? letterInfo(m.letter)?.[0] : undefined)).find((s) => s !== undefined) ??
      (hasBangla(text) ? 2 : 0);
    q.optionSet = set;
    marks.forEach((m, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
      q.options.push({ label: OPTION_SETS[set][q.options.length], text: clean(text.slice(m.index + m.length, end)) });
    });
    return true;
  };

  /** Split a line into stem/option segments using option markers that continue the expected sequence. */
  const consume = (q: Draft, text: string, ocr: boolean) => {
    if (ocr && q.options.length < 4 && consumeCells(q, text)) return;
    if (ocr && q.options.length < 4 && consumeFuzzy(q, text)) return;
    text = text.replace(/\s+/g, " ");
    const matches = [...text.matchAll(OPTION_RE)];
    let cursor = 0;
    let acceptedInLine = false;
    let pending: { label: string } | null = null;

    const flush = (end: number) => {
      const seg = text.slice(cursor, end);
      if (pending) q.options.push({ label: pending.label, text: clean(seg) });
      else appendText(q, seg);
    };

    for (const m of matches) {
      const letter = m[1] ?? m[2] ?? m[3] ?? m[4];
      const weak = m[3] !== undefined || m[4] !== undefined;
      const info = letterInfo(letter);
      if (!info) continue;
      const [set, idx] = info;
      const expected = q.options.length + (pending ? 1 : 0);
      if (idx !== expected) continue;
      if (q.optionSet !== null && set !== q.optionSet && expected > 0) continue;
      const atLineStart = text.slice(0, m.index).trim() === "";
      if (weak && !atLineStart && !acceptedInLine) continue;
      // A bare Bangla letter as the first option needs the stem to be finished (not mid-sentence).
      if (m[4] !== undefined && expected === 0 && !atLineStart) continue;

      flush(m.index!);
      if (q.optionSet === null || expected === 0) q.optionSet = set;
      pending = { label: letter };
      cursor = m.index! + m[0].length;
      acceptedInLine = true;
    }
    flush(text.length);
  };

  /** Text that reads like a question stem: ends with "?", ":" or a dash, or has a "..." blank. */
  const questionLike = (text: string) => /[?？:ঃ\-–—]\s*$/.test(text.trim()) || /\.{3}|…|_{3,}/.test(text);

  /**
   * Decide whether a numbered line starts a new question. Returns the number to use, or null.
   * Bare numbers (no punctuation) must be sequential — or, when the current question is
   * finished and the line reads like a question, we trust the layout over an OCR-misread digit.
   */
  const acceptQuestion = (n: number, bare: boolean, text: string): number | null => {
    const c = cur as Draft | null;
    if (!c) return (!bare && !/^[0-9০-৯]/.test(text)) || n === 1 || /[?？]\s*$/.test(text) ? n : null;
    // Restart at 1 after pseudo-questions with no options (e.g. a table of contents "1. Part A — Q1-13").
    if (n === 1 && c.options.length === 0) return n;
    if (bare && /^[0-9০-৯]/.test(text) && !questionLike(text)) return null;
    if (bare) {
      if (n === c.num + 1) return n;
      if (n === 1 && c.options.length >= 2 && questionLike(text)) return n;
      if ((c.closed || c.options.length >= 4) && questionLike(text)) return n > c.num && n <= c.num + 3 ? n : c.num + 1;
      return null;
    }
    if ((n > c.num && n <= c.num + 5) || (n === 1 && c.options.length >= 2) || (c.options.length >= 2 && n > c.num && n <= c.num + 20)) {
      return n;
    }
    if ((c.closed || c.options.length >= 4) && questionLike(text)) return c.num + 1;
    return null;
  };

  /**
   * OCR keeps wide gaps between grid cells ("কস্বণ্ণ          খ ডলার"). If the cells after the
   * first start with the next labels in sequence, treat every cell as an option — even when the
   * first cell's label is glued to its text.
   */
  const consumeCells = (q: Draft, text: string): boolean => {
    const cells = text.split(/\s{3,}/).map((c) => c.trim()).filter(Boolean);
    if (cells.length < 2 || q.options.length + cells.length > 6) return false;
    const exp = q.options.length;
    const set = q.optionSet ?? (hasBangla(text) ? 2 : 0);
    const labelAt = (cell: string, idx: number) => {
      const letter = OPTION_SETS[set][idx];
      const m = new RegExp(`^[(\\[]?\\s*${letter}\\s*[)\\].।:]?\\s*`, "u").exec(cell);
      return m ? m[0].length : -1;
    };
    // Damaged label: 1–2 junk characters before the text ("4 abstract noun", "ST হরমুজ" for "গ হরমুজ").
    const damagedLabel = (cell: string) => {
      const m = /^([A-Za-z0-9]{1,2}|[^\sঀ-৿A-Za-z0-9])\s+\S/u.exec(cell);
      return m && !(m[1].length === 1 && letterInfo(m[1])) ? m[1].length : -1;
    };
    // Each cell sits in a known grid position, so its expected label — even glued to the text
    // ("ক৪", "ঘওঙ৬") or standing alone because OCR lost the text — is trusted. Need at least one
    // cell with a clean, spaced label so ordinary sentences are never split.
    const cuts: number[] = [];
    let spacedLabels = 0;
    for (let i = 0; i < cells.length; i++) {
      let len = labelAt(cells[i], exp + i);
      if (len > 0 && /\s|[)\].।:]/u.test(cells[i].slice(0, len))) spacedLabels++;
      if (len <= 0) len = damagedLabel(cells[i]);
      if (len <= 0) return false;
      cuts[i] = len;
    }
    // Without any cleanly spaced label, only trust the row if it continues a grid already started.
    // A glued row right after a finished stem ("…একটি উৎপাদক-" then "কর্ম+৮-1    খস্-১") is still the grid.
    if (spacedLabels === 0 && q.options.length === 0 && !(q.text && questionLike(q.text) && exp === 0)) return false;
    q.optionSet = set;
    cells.forEach((cell, i) => {
      q.options.push({ label: OPTION_SETS[set][exp + i], text: clean(cell.slice(cuts[i])) });
    });
    return true;
  };

  const flat = pages.flatMap((p) => p.lines.map((raw) => ({ pageIndex: p.pageIndex, raw, ocr: p.ocr ?? false })));
  /** Next non-blank line after index i (for "is an option row coming?" checks). */
  const peek = (i: number) => {
    for (let j = i + 1; j < flat.length && j <= i + 3; j++) if (flat[j].raw.trim()) return flat[j].raw;
    return "";
  };
  const OPTION_ROW_START = /^\s*(?:[(\[]\s*)?[aAকk]\s*[)\].।:]?\s/u;

  for (let li = 0; li < flat.length; li++) {
    {
      const { pageIndex, raw: rawLine, ocr } = flat[li];
      let line = rawLine.replace(/\u0000/g, "").replace(/ /g, " ").replace(/[（]/g, "(").replace(/[）]/g, ")").trim();
      if (ocr) line = normalizeOcrLine(line);
      if (!line || repeated.has(clean(line))) continue;

      // Number alone on its line: either a question number whose stem follows,
      // a duplicate (boxed "4" with a small "৪" under it), or a page number.
      const numOnly = NUMBER_ONLY_RE.exec(line);
      if (numOnly) {
        const n = Number(toAsciiDigits(numOnly[1]));
        const c = cur as Draft | null;
        if (c && n === c.num && !c.options.length) continue;
        if (!c ? n === 1 : n === c.num + 1 && (c.options.length >= 2 || c.closed)) {
          pendingNumber = { printed: numOnly[1], num: n, pageIndex };
        }
        continue;
      }
      if (/^[\d০-৯\s\-–—|.]*$/.test(line)) continue; // rules / stray digits
      if (/^[^ঀ-৿A-Za-z0-9]*[A-Za-z]?[^ঀ-৿A-Za-z0-9]*$/.test(line) && line.length <= 2) continue; // OCR specks like "q"

      if (SECTION_RE.test(line)) continue; // "Part A · বাংলাদেশ বিষয়াবলি   Q1–Q13 …"

      if (KEY_HEADER_RE.test(line)) {
        inKeySection = true;
        continue;
      }
      // Answer-key tables ("1-b 2-c 3-a"). Option rows like "(a) 100 (b) 200" must not qualify.
      const key = keyPairsIn(line);
      const startsWithOption = /^[(\[{]?\s*[a-fA-Fক-চ]\s*[)\]}.।]/u.test(line);
      const increasing = key.pairs.every((p, i) => i === 0 || p[0] > key.pairs[i - 1][0]);
      // Inside an "Answer key" section, OCR may garble letters (খ → 4), so judge by shape: "N.x N.x …".
      const keyLike = (line.match(/(?<![0-9০-৯])[0-9০-৯]{1,3}\s*[.\-–):।=]\s*\S{1,2}(?=\s|$)/gu) ?? []).join("").replace(/\s/g, "").length;
      const keyLikeCoverage = keyLike / (line.replace(/\s/g, "").length || 1);
      const isKeyLine =
        !startsWithOption &&
        increasing &&
        ((inKeySection && keyLikeCoverage > 0.6) || (key.pairs.length >= 3 && key.coverage > 0.8));
      if (isKeyLine) {
        key.pairs.forEach(([n, idx]) => answerKey.set(n, idx));
        continue;
      }
      inKeySection = false;

      // New question?
      let started = false;
      const qm = QUESTION_RE.exec(line);
      const bm = qm ? null : BARE_QUESTION_RE.exec(line);
      const m = qm ?? bm;
      const accepted = m ? acceptQuestion(Number(toAsciiDigits(m[1])), !qm, m[2]) : null;
      if (m && accepted !== null) {
        const printed = accepted === Number(toAsciiDigits(m[1])) ? m[1] : String(accepted);
        const q = startQuestion(printed, accepted, pageIndex);
        pendingNumber = null;
        consume(q, m[2], ocr);
        started = true;
      } else if (pendingNumber && !ANSWER_RE.test(line)) {
        const q = startQuestion(pendingNumber.printed, pendingNumber.num, pendingNumber.pageIndex);
        pendingNumber = null;
        consume(q, line, ocr);
        started = true;
      }
      if (started) continue;

      const q = cur as Draft | null;
      if (!q) continue; // preamble before the first question

      // Answer line ("Answer: ক. উপজেলা"): record it; the rest of the line just repeats the option.
      const am = ANSWER_RE.exec(line);
      if (am && q.options.length >= 2) {
        const idx = letterToIndex(am[1]);
        // If OCR garbled the letter, the repeated option text still identifies the answer.
        const byText = answerByText(q, line);
        q.correct = byText ?? idx;
        q.closed = true;
        continue;
      }
      // "Answer: 91. material noun" — letter unreadable, match the option text instead.
      // An answer line always ends the options, even if too few were recognised (review will flag it).
      if (ANSWER_LINE_RE.test(line)) {
        q.correct = q.options.length >= 2 ? answerByText(q, line) : null;
        q.closed = true;
        continue;
      }

      if (q.closed && /[?？]\s*$/.test(line) && !EXPLANATION_START_RE.test(line) && OPTION_ROW_START.test(peek(li))) {
        const stem = line.replace(/^\S{1,2}\s+(?=\S)/u, (m) => (m.trim().length <= 2 && !hasBangla(m.trim()[0] ?? "") ? "" : m));
        const nq = startQuestion(String(q.num + 1), q.num + 1, pageIndex);
        consume(nq, stem.replace(/^[^\s\u0980-\u09ff]{0,2}\s+/u, ""), ocr);
        continue;
      }
      if (q.closed) {
        addExplanation(q, line);
        continue;
      }
      if (q.options.length >= 2 && EXPLANATION_START_RE.test(line)) {
        q.closed = true;
        addExplanation(q, line);
        continue;
      }

      // Answer at the end of an option row ("(d) 40   Ans: b").
      if (am) {
        const idx = letterToIndex(am[1]);
        line = (line.slice(0, am.index) + line.slice(am.index + am[0].length)).trim();
        consume(q, line, ocr);
        if (idx !== null) q.correct = idx;
        continue;
      }
      consume(q, line, ocr);
    }
  }

  for (const q of out) {
    if (q.correct === null && answerKey.has(q.num)) q.correct = answerKey.get(q.num)!;
    if (q.correct !== null && q.correct >= q.options.length) q.correct = null;
  }

  return out
    // Drop optionless "questions" that don't read like questions (tables of contents, headings).
    .filter((q) => q.options.length > 0 || (q.text && questionLike(q.text)))
    .map(({ number, text, options, correct, explanation, pageIndex }) => ({
      number,
      // OCR noise after the question mark (from the small number printed under a boxed "2"): "…করেন? টড"
      text: clean(text).replace(/([?？])\s+\S{1,3}$/u, "$1"),
      options: options.map((o) => ({ label: o.label, text: clean(o.text) })),
      correct,
      explanation: explanation.trim(),
      pageIndex,
    }));
}
