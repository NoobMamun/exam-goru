import { createStore, get, set, del, entries } from "idb-keyval";
import type { Attempt, Exam, PageImage } from "./types";

const examStore = createStore("exam-creator", "exams");
const pageStore = createStore("exam-creator-pages", "pages");
const attemptStore = createStore("exam-creator-attempts", "attempts");

export async function listExams(): Promise<Exam[]> {
  const all = await entries<string, Exam>(examStore);
  return all.map(([, e]) => e).sort((a, b) => b.updatedAt - a.updatedAt);
}

export const getExam = (id: string) => get<Exam>(id, examStore);

export async function saveExam(exam: Exam): Promise<Exam> {
  const next = { ...exam, updatedAt: Date.now() };
  await set(exam.id, next, examStore);
  return next;
}

export async function deleteExam(id: string): Promise<void> {
  await del(id, examStore);
  await del(id, pageStore);
  const attempts = await listAttempts(id);
  await Promise.all(attempts.map((a) => del(a.id, attemptStore)));
}

export const getPages = async (examId: string) => (await get<PageImage[]>(examId, pageStore)) ?? [];
export const savePages = (examId: string, pages: PageImage[]) => set(examId, pages, pageStore);

export async function listAttempts(examId?: string): Promise<Attempt[]> {
  const all = await entries<string, Attempt>(attemptStore);
  return all
    .map(([, a]) => a)
    .filter((a) => !examId || a.examId === examId)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export const getAttempt = (id: string) => get<Attempt>(id, attemptStore);
export const saveAttempt = (a: Attempt) => set(a.id, a, attemptStore);
export const deleteAttempt = (id: string) => del(id, attemptStore);
