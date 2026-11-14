import type { Attempt, AttemptResult, Exam, ExamConfig, Question } from "./types";
import { shuffle, uid } from "./util";

export const defaultConfig = (title = "Untitled exam"): ExamConfig => ({
  title,
  durationMin: 30,
  marksPerCorrect: 1,
  negativeEnabled: false,
  negativePerWrong: 0.25,
  randomizeQuestions: false,
  randomizeOptions: false,
});

export const totalMarks = (config: ExamConfig, questionCount: number) =>
  config.marksPerCorrect * questionCount;

/** Problems that must be fixed before an exam can start. */
export function validateQuestions(questions: Question[]): string[] {
  const issues: string[] = [];
  if (questions.length === 0) issues.push("There are no questions.");
  questions.forEach((q, i) => {
    const name = `Q${q.number || i + 1}`;
    if (!q.text.trim()) issues.push(`${name}: question text is empty.`);
    if (q.options.length < 2) issues.push(`${name}: needs at least 2 options.`);
    if (q.options.some((o) => !o.text.trim())) issues.push(`${name}: has an empty option.`);
  });
  return issues;
}

const BN = "০১২৩৪৫৬৭৮৯";
const ascii = (s: string) => s.replace(/[০-৯]/g, (d) => String(BN.indexOf(d)));

/**
 * Read exam rules printed on the paper's first page:
 * "Time: 35 minutes", "সময়: ৩০ মিনিট", "Full marks: 100", "পূর্ণমান: ১০০",
 * "প্রতি প্রশ্নের মান ১", "ভুল উত্তরের জন্য ০.৫০ কাটা যাবে", "0.25 marks will be deducted".
 */
export function detectExamRules(firstPageLines: string[]): {
  durationMin?: number;
  fullMarks?: number;
  marksPerQuestion?: number;
  negativePerWrong?: number;
} {
  const text = ascii(firstPageLines.join("\n"));
  const num = (re: RegExp) => {
    const m = re.exec(text);
    return m ? Number(m[1]) : undefined;
  };
  const hours = num(/([0-9]{1,2})\s*(?:hours?|hrs?|ঘণ্টা|ঘন্টা)/i);
  const minutes = num(/([0-9]{1,3})\s*(?:minutes?|mins?|মিনিট)/i);
  const durationMin = hours || minutes ? (hours ?? 0) * 60 + (minutes ?? 0) : undefined;
  return {
    durationMin: durationMin && durationMin <= 600 ? durationMin : undefined,
    fullMarks: num(/(?:full\s*marks?|total\s*marks?|পূর্ণমান|পূর্ণ\s*মান|মোট\s*নম্বর)\s*[:ঃ\-–=]?\s*([0-9]{1,4})/i),
    marksPerQuestion: num(/(?:প্রতি\s*প্রশ্নের\s*মান|each\s*question\s*carries|marks?\s*per\s*question)\s*[:ঃ\-–=]?\s*([0-9]+(?:\.[0-9]+)?)/i),
    negativePerWrong:
      num(/(?:ভুল\s*উত্তরের\s*জন্য|প্রতিটি\s*ভুল\s*উত্তরে(?:র\s*জন্য)?)\s*([0-9]+(?:\.[0-9]+)?)/i) ??
      num(/([0-9]+(?:\.[0-9]+)?)\s*(?:marks?\s*)?(?:will\s*be\s*)?deducted/i) ??
      num(/negative\s*marking\s*[:\-–=]?\s*([0-9]+(?:\.[0-9]+)?)/i),
  };
}

/** A question can be graded only when it has a valid answer key. */
export const hasKey = (q: Question) => q.correct !== null && q.correct < q.options.length;

/**
 * Copy answer keys from the current exam into an attempt's snapshot (by question id)
 * and re-score it. Lets you take an exam first and fill in the answer key afterwards.
 */
export function regradeAttempt(a: Attempt, exam: Exam): Attempt {
  const byId = new Map(exam.questions.map((q) => [q.id, q]));
  const questions = a.questions.map((q) => {
    const latest = byId.get(q.id);
    return latest && latest.options.length === q.options.length ? { ...q, correct: latest.correct, answerSource: latest.answerSource } : q;
  });
  const next = { ...a, questions };
  return { ...next, result: scoreAttempt(next, a.submittedAt ?? a.endsAt) };
}

/** True when the exam now has answer keys that differ from those the attempt was graded with. */
export function canRegrade(a: Attempt, exam: Exam): boolean {
  const byId = new Map(exam.questions.map((q) => [q.id, q]));
  return a.questions.some((q) => {
    const latest = byId.get(q.id);
    return !!latest && latest.options.length === q.options.length && latest.correct !== q.correct;
  });
}

export function validateConfig(c: ExamConfig): string[] {
  const issues: string[] = [];
  if (!c.title.trim()) issues.push("Exam title is required.");
  if (!(c.durationMin >= 1)) issues.push("Duration must be at least 1 minute.");
  if (!(c.marksPerCorrect > 0)) issues.push("Marks per correct answer must be greater than 0.");
  if (c.negativeEnabled && !(c.negativePerWrong >= 0)) issues.push("Negative marks must be 0 or more.");
  return issues;
}

/** Indices of options that actually have text. */
const filledOptions = (q: Question) => q.options.map((_, i) => i).filter((i) => q.options[i].text.trim());

/** A question can appear in an exam when it has a stem and at least two options with text. */
export const isUsable = (q: Question) => !!q.text.trim() && filledOptions(q).length >= 2;

export const usableQuestions = (questions: Question[]) => questions.filter(isUsable);

export function createAttempt(exam: Exam): Attempt {
  const { config } = exam;
  // Incomplete questions (OCR lost the options) are left out; empty options are hidden.
  const questions = structuredClone(usableQuestions(exam.questions)).map((q) =>
    q.correct !== null && !q.options[q.correct]?.text.trim() ? { ...q, correct: null } : q,
  );
  const ordered = config.randomizeQuestions ? shuffle(questions) : questions;
  const now = Date.now();
  return {
    id: uid(),
    examId: exam.id,
    status: "in_progress",
    startedAt: now,
    endsAt: now + config.durationMin * 60_000,
    config: structuredClone(config),
    questions,
    items: ordered.map((q) => {
      const order = filledOptions(q);
      return { questionId: q.id, optionOrder: config.randomizeOptions ? shuffle(order) : order };
    }),
    answers: {},
    flagged: [],
    currentIndex: 0,
  };
}

export function scoreAttempt(a: Attempt, submittedAt: number): AttemptResult {
  let correct = 0;
  let wrong = 0;
  let skipped = 0;
  let ungraded = 0;
  for (const q of a.questions) {
    const ans = a.answers[q.id];
    if (!hasKey(q)) ungraded++;
    else if (ans === undefined) skipped++;
    else if (ans === q.correct) correct++;
    else wrong++;
  }
  const negativeDeducted = a.config.negativeEnabled ? wrong * a.config.negativePerWrong : 0;
  const score = correct * a.config.marksPerCorrect - negativeDeducted;
  const limit = a.endsAt - a.startedAt;
  return {
    correct,
    wrong,
    skipped,
    ungraded,
    score,
    totalMarks: totalMarks(a.config, a.questions.length - ungraded),
    negativeDeducted,
    timeTakenSec: Math.min(limit, submittedAt - a.startedAt) / 1000,
  };
}

export function submitAttempt(a: Attempt, auto = false): Attempt {
  const submittedAt = Math.min(Date.now(), a.endsAt);
  return { ...a, status: "submitted", submittedAt, autoSubmitted: auto, result: scoreAttempt(a, submittedAt) };
}
