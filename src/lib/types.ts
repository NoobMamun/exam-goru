export interface Option {
  label: string;
  text: string;
}

/** paper = found printed in the paper/answer key; manual = set by you during review. */
export type AnswerSource = "paper" | "manual" | "unknown";

export interface Question {
  id: string;
  number: string;
  text: string;
  options: Option[];
  /** Index into options of the correct answer; null when not determined. */
  correct: number | null;
  answerSource: AnswerSource;
  /** Index into the exam's page list where this question appears. */
  pageIndex: number | null;
  /** Explanation printed in the paper (or added by you), shown in the answer review. */
  explanation?: string;
}

export interface PageImage {
  id: string;
  dataUrl: string;
  /** Human label, e.g. "paper.pdf · p3" */
  source: string;
  /** Text layer from the PDF itself, when present and readable. */
  pdfText?: string[];
  /** Text lines actually used for extraction. */
  text?: string[];
  textMethod?: "pdf" | "ocr";
}

export interface ExamConfig {
  title: string;
  durationMin: number;
  marksPerCorrect: number;
  negativeEnabled: boolean;
  negativePerWrong: number;
  randomizeQuestions: boolean;
  randomizeOptions: boolean;
}

export type ExamStatus = "draft" | "ready";

export interface Exam {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: ExamStatus;
  pageCount: number;
  questions: Question[];
  config: ExamConfig;
}

export interface AttemptItem {
  questionId: string;
  /** Display order of options, as indices into the original options array. */
  optionOrder: number[];
}

export interface AttemptResult {
  correct: number;
  wrong: number;
  skipped: number;
  /** Questions with no answer key — not counted in the score. */
  ungraded: number;
  score: number;
  totalMarks: number;
  negativeDeducted: number;
  timeTakenSec: number;
}

export interface Attempt {
  id: string;
  examId: string;
  status: "in_progress" | "submitted";
  startedAt: number;
  endsAt: number;
  submittedAt?: number;
  autoSubmitted?: boolean;
  config: ExamConfig;
  /** Snapshot of the questions at the time the attempt started. */
  questions: Question[];
  items: AttemptItem[];
  /** questionId -> original option index chosen */
  answers: Record<string, number>;
  flagged: string[];
  currentIndex: number;
  result?: AttemptResult;
}
