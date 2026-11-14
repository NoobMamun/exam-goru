import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ACCEPT_ATTR, fileToPages, isAccepted, isPdf } from "../lib/files";
import { toQuestions } from "../lib/extract";
import { OCR_LANG_LABELS, ocrImage, terminateOcr, type OcrLang } from "../lib/ocr";
import { saveAttempt, saveExam, savePages } from "../lib/db";
import { createAttempt, defaultConfig, detectExamRules, hasKey, isUsable, validateConfig } from "../lib/exam";
import type { Exam, ExamConfig, PageImage, Question } from "../lib/types";
import { num, uid } from "../lib/util";

interface UploadItem {
  id: string;
  file: File;
  status: "processing" | "ready" | "error";
  done: number;
  total: number;
  pages: PageImage[];
  error?: string;
}

interface Reading {
  page: number;
  total: number;
  progress: number;
  method: "pdf" | "ocr";
}

type Settings = Omit<ExamConfig, "title">;
const BN = "০১২৩৪৫৬৭৮৯";
const bn = (v: number | string) => String(v).replace(/\d/g, (d) => BN[Number(d)]);

export default function CreateExam() {
  const navigate = useNavigate();
  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [lang, setLang] = useState<OcrLang>("ben+eng");
  const [forceOcr, setForceOcr] = useState(false);
  const [readPages, setReadPages] = useState<PageImage[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [reading, setReading] = useState<Reading | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [settings, setSettings] = useState<Settings>(() => {
    const { title: _t, ...rest } = defaultConfig();
    return rest;
  });
  const [showMore, setShowMore] = useState(false);
  const touched = useRef(new Set<keyof Settings>());
  const textCache = useRef(new Map<string, { text: string[]; method: "pdf" | "ocr" }>());
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | null>(null);

  useEffect(() => () => void terminateOcr(), []);

  // ---------- files ----------
  const update = (id: string, patch: Partial<UploadItem>) =>
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));

  const process = async (item: UploadItem) => {
    try {
      const pages = await fileToPages(item.file, (done, total) => update(item.id, { done, total }));
      update(item.id, { status: "ready", pages, done: pages.length, total: pages.length });
    } catch (e) {
      console.error(e);
      update(item.id, { status: "error", error: "Couldn't read this file. Is it a valid image or PDF?" });
    }
  };

  const makeItem = (file: File): UploadItem => ({ id: uid(), file, status: "processing", done: 0, total: isPdf(file) ? 0 : 1, pages: [] });

  const addFiles = (list: FileList | File[]) => {
    const files = Array.from(list);
    const ok = files.filter(isAccepted);
    setRejected(files.filter((f) => !isAccepted(f)).map((f) => f.name));
    if (!ok.length) return;
    const newItems = ok.map(makeItem);
    if (!title) setTitle(ok[0].name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "));
    setItems((prev) => [...prev, ...newItems]);
    newItems.forEach(process);
  };

  const replaceFile = (file: File) => {
    const target = replaceTarget.current;
    if (!target || !isAccepted(file)) return;
    const fresh = { ...makeItem(file), id: target };
    setItems((prev) => prev.map((it) => (it.id === target ? fresh : it)));
    process(fresh);
  };

  const move = (idx: number, dir: -1 | 1) =>
    setItems((prev) => {
      const next = [...prev];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });

  // ---------- automatic extraction ----------
  const pages = useMemo(() => items.filter((i) => i.status === "ready").flatMap((i) => i.pages), [items]);
  const filesBusy = items.some((i) => i.status === "processing");
  const signature = `${pages.map((p) => p.id).join(",")}|${lang}|${forceOcr}`;

  useEffect(() => {
    if (filesBusy) return;
    if (!pages.length) {
      setReadPages([]);
      setQuestions([]);
      setReading(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setError(null);
      const done: PageImage[] = [];
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        const key = `${p.id}|${lang}|${forceOcr}`;
        let entry = textCache.current.get(key);
        if (!entry) {
          if (!forceOcr && p.pdfText) {
            entry = { text: p.pdfText, method: "pdf" };
          } else {
            setReading({ page: i, total: pages.length, progress: 0, method: "ocr" });
            try {
              const lines = await ocrImage(p.dataUrl, lang, (progress) => {
                if (!cancelled) setReading({ page: i, total: pages.length, progress, method: "ocr" });
              });
              entry = { text: lines, method: "ocr" };
            } catch (e) {
              if (!cancelled) {
                console.error(e);
                setError(`Couldn't read page ${i + 1}. ${(e as Error).message || ""}`);
                setReading(null);
              }
              return;
            }
          }
          textCache.current.set(key, entry);
        }
        if (cancelled) return;
        done.push({ ...p, text: entry.text, textMethod: entry.method });
        // Show questions as soon as each page is read.
        setReadPages([...done]);
        setQuestions(toQuestions(done));
      }
      if (!cancelled) setReading(null);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, filesBusy]);

  // Fill time / marks / negative marking from the paper, unless you've changed them yourself.
  const usable = questions.filter(isUsable);
  const skipped = questions.length - usable.length;
  useEffect(() => {
    if (!usable.length) return;
    const rules = detectExamRules(readPages[0]?.text ?? []);
    setSettings((s) => {
      const next = { ...s };
      const set = <K extends keyof Settings>(k: K, v: Settings[K] | undefined) => {
        if (v !== undefined && !touched.current.has(k)) next[k] = v;
      };
      set("durationMin", rules.durationMin ?? Math.max(5, usable.length));
      const perQ = rules.marksPerQuestion ?? (rules.fullMarks ? Math.round((rules.fullMarks / usable.length) * 100) / 100 : undefined);
      set("marksPerCorrect", perQ && perQ > 0 ? perQ : undefined);
      if (rules.negativePerWrong !== undefined) {
        set("negativeEnabled", rules.negativePerWrong > 0);
        set("negativePerWrong", rules.negativePerWrong);
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usable.length, readPages.length]);

  const setSetting = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    touched.current.add(k);
    setSettings((s) => ({ ...s, [k]: v }));
  };

  // ---------- create & go live ----------
  const ready = !filesBusy && !reading && pages.length > 0 && readPages.length === pages.length;
  const configIssues = validateConfig({ ...settings, title: title || "x" });

  const buildExam = (): Exam => {
    const now = Date.now();
    return {
      id: uid(),
      createdAt: now,
      updatedAt: now,
      status: "ready",
      pageCount: readPages.length,
      questions,
      config: { ...settings, title: title.trim() || "Untitled exam" },
    };
  };

  const createAndStart = async () => {
    if (!ready || !usable.length || configIssues.length) return;
    setStarting(true);
    try {
      const exam = buildExam();
      await savePages(exam.id, readPages);
      await saveExam(exam);
      const attempt = createAttempt(exam);
      await saveAttempt(attempt);
      navigate(`/attempt/${attempt.id}`);
    } catch (e) {
      setError((e as Error).message);
      setStarting(false);
    }
  };

  const saveAndEdit = async () => {
    const exam = buildExam();
    await savePages(exam.id, readPages);
    await saveExam(exam);
    navigate(`/exam/${exam.id}/review`);
  };

  const pct = reading ? Math.round(((reading.page + reading.progress) / Math.max(1, reading.total)) * 100) : 100;
  const totalMarks = settings.marksPerCorrect * usable.length;

  return (
    <div className="page narrow">
      <h1>Create New Exam</h1>
      <p className="muted">
        Upload the question paper. The questions are read on this computer and listed below. Press <b>Create Exam</b> and
        the exam starts straight away.
      </p>

      {/* ---------- upload ---------- */}
      <div className="card">
        <div
          className={`dropzone ${dragging ? "dragging" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            addFiles(e.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
        >
          <div className="dropzone-icon">⬆</div>
          <div>
            <strong>Drop the PDF or photos here</strong> or click to browse
          </div>
          <div className="muted small">JPG, JPEG, PNG or PDF · add several files to combine them into one paper</div>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT_ATTR}
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <input
            ref={replaceRef}
            type="file"
            accept={ACCEPT_ATTR}
            hidden
            onChange={(e) => {
              if (e.target.files?.[0]) replaceFile(e.target.files[0]);
              e.target.value = "";
            }}
          />
        </div>

        {rejected.length > 0 && <div className="alert alert-error small">Skipped unsupported file(s): {rejected.join(", ")}</div>}

        {items.length > 0 && (
          <ul className="file-list">
            {items.map((it, idx) => (
              <li key={it.id} className="file-item">
                <div className="file-thumb">
                  {it.pages[0] ? <img src={it.pages[0].dataUrl} alt="" /> : <span>{isPdf(it.file) ? "PDF" : "IMG"}</span>}
                </div>
                <div className="file-info">
                  <div className="file-name">{it.file.name}</div>
                  <div className="muted small">
                    {(it.file.size / 1024 / 1024).toFixed(2)} MB
                    {it.status === "ready" && ` · ${it.pages.length} page${it.pages.length === 1 ? "" : "s"}`}
                    {it.status === "processing" &&
                      (it.total ? ` · opening page ${Math.min(it.done + 1, it.total)} of ${it.total}…` : " · opening…")}
                  </div>
                  {it.status === "processing" && (
                    <div className="progress small-bar">
                      <div style={{ width: `${it.total ? (it.done / it.total) * 100 : 10}%` }} />
                    </div>
                  )}
                  {it.status === "error" && <div className="c-red small">{it.error}</div>}
                </div>
                <div className="file-actions">
                  <button className="icon-btn" title="Move up" disabled={idx === 0} onClick={() => move(idx, -1)}>↑</button>
                  <button className="icon-btn" title="Move down" disabled={idx === items.length - 1} onClick={() => move(idx, 1)}>↓</button>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      replaceTarget.current = it.id;
                      replaceRef.current?.click();
                    }}
                  >
                    Replace
                  </button>
                  <button className="btn btn-ghost btn-sm danger" onClick={() => setItems((prev) => prev.filter((p) => p.id !== it.id))}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <details className="ocr-more">
          <summary className="small muted">Text reading options</summary>
          <div className="grid-2">
            <label className="field">
              <span>Paper language</span>
              <select className="input" value={lang} onChange={(e) => setLang(e.target.value as OcrLang)}>
                {(Object.keys(OCR_LANG_LABELS) as OcrLang[]).map((l) => (
                  <option key={l} value={l}>
                    {OCR_LANG_LABELS[l]}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={forceOcr} onChange={(e) => setForceOcr(e.target.checked)} />
              <span>
                Always use OCR
                <span className="muted small block">Read the page images even if the PDF contains text.</span>
              </span>
            </label>
          </div>
        </details>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {/* ---------- reading progress ---------- */}
      {(reading || (filesBusy && items.length > 0)) && (
        <div className="card extract-progress">
          <div className="row-between">
            <strong>
              {filesBusy ? "Opening files…" : `Reading page ${reading!.page + 1} of ${reading!.total}…`}
            </strong>
            <span className="muted">{questions.length} questions found so far</span>
          </div>
          <div className="progress">
            <div style={{ width: `${Math.max(filesBusy ? 5 : pct, 4)}%` }} className="pulse" />
          </div>
          <div className="muted small">Everything runs on this computer. Scanned pages take roughly 5–30 seconds each.</div>
        </div>
      )}

      {/* ---------- questions + create ---------- */}
      {questions.length > 0 && (
        <>
          <div className="card create-card">
            <label className="field">
              <span>Exam title</span>
              <input className="input bn" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. বিসিএস জব সল্যুশন - রিভিশন" />
            </label>
            <div className="create-grid">
              <label className="field">
                <span>Time (minutes)</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={Number.isFinite(settings.durationMin) ? settings.durationMin : ""}
                  onChange={(e) => setSetting("durationMin", e.target.valueAsNumber)}
                />
              </label>
              <label className="field">
                <span>Marks per question</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  step={0.25}
                  value={Number.isFinite(settings.marksPerCorrect) ? num(settings.marksPerCorrect) : ""}
                  onChange={(e) => setSetting("marksPerCorrect", e.target.valueAsNumber)}
                />
              </label>
              <label className="field">
                <span>Minus per wrong answer</span>
                <select
                  className="input"
                  value={settings.negativeEnabled ? String(settings.negativePerWrong) : "0"}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setSetting("negativeEnabled", v > 0);
                    if (v > 0) setSetting("negativePerWrong", v);
                  }}
                >
                  {[0, 0.25, 0.5, 0.75, 1].map((v) => (
                    <option key={v} value={v}>
                      {v === 0 ? "No negative marking" : `−${v}`}
                    </option>
                  ))}
                  {settings.negativeEnabled && ![0.25, 0.5, 0.75, 1].includes(settings.negativePerWrong) && (
                    <option value={settings.negativePerWrong}>−{settings.negativePerWrong}</option>
                  )}
                </select>
              </label>
            </div>
            <button className="link-btn small" onClick={() => setShowMore((v) => !v)}>
              {showMore ? "Hide" : "More options"} (shuffle questions / options)
            </button>
            {showMore && (
              <div className="actions">
                <label className="check inline">
                  <input type="checkbox" checked={settings.randomizeQuestions} onChange={(e) => setSetting("randomizeQuestions", e.target.checked)} />
                  <span>Shuffle question order</span>
                </label>
                <label className="check inline">
                  <input type="checkbox" checked={settings.randomizeOptions} onChange={(e) => setSetting("randomizeOptions", e.target.checked)} />
                  <span>Shuffle options</span>
                </label>
              </div>
            )}

            <div className="create-summary">
              <span>
                <b>{usable.length}</b> questions
              </span>
              <span>
                <b>{num(totalMarks)}</b> marks
              </span>
              <span>
                <b>{settings.durationMin || "–"}</b> min
              </span>
              <span>{settings.negativeEnabled ? `−${num(settings.negativePerWrong)} per wrong` : "no negative marking"}</span>
            </div>
            {skipped > 0 && (
              <div className="muted small">
                {skipped} question(s) came out incomplete and will be left out. Use <b>Edit questions</b> to fix them.
              </div>
            )}
            {configIssues.length > 0 && <div className="c-red small">{configIssues.join(" ")}</div>}
          </div>

          <h2 className="section-title">
            {questions.length} questions found{reading ? " so far" : ""}
          </h2>
          <ol className="qprev-list">
            {questions.map((q, i) => {
              const ok = isUsable(q);
              return (
                <li key={q.id} className={`qprev ${ok ? "" : "bad"}`}>
                  <div className="qprev-text bn">
                    {bn(i + 1)}) {q.text || <i className="muted">(question text missing)</i>}
                  </div>
                  <ul className="qprev-opts bn">
                    {q.options.map((o, j) => (
                      <li key={j} className={q.correct === j ? "correct" : ""}>
                        <span className="qprev-dot" />
                        {o.text || <i className="muted">(empty)</i>}
                        {q.correct === j && <span className="qprev-tick">✓</span>}
                      </li>
                    ))}
                  </ul>
                  {!ok && <div className="qprev-flag">Incomplete — left out of the exam unless you fix it</div>}
                  {ok && !hasKey(q) && <div className="qprev-flag soft">No answer found in the paper — this question won't be graded</div>}
                </li>
              );
            })}
          </ol>

          {/* Always-visible action bar: one click and the exam is live. */}
          <div className="create-bar">
            <span className="create-bar-info">
              {ready ? (
                <>
                  <b>{usable.length}</b> questions · <b>{settings.durationMin || "–"}</b> min · <b>{num(totalMarks)}</b> marks
                </>
              ) : (
                <>Reading pages… {questions.length} found</>
              )}
            </span>
            <div className="create-actions">
              <button className="btn btn-ghost" disabled={!ready} onClick={saveAndEdit}>
                Edit questions first
              </button>
              <button className="btn btn-create" disabled={!ready || !usable.length || configIssues.length > 0 || starting} onClick={createAndStart}>
                {starting ? "Starting…" : ready ? "Create Exam ▶" : "Reading pages…"}
              </button>
            </div>
          </div>
        </>
      )}

      {ready && questions.length === 0 && (
        <div className="alert alert-warn">
          No numbered multiple-choice questions were found. Check that the pages are clear and upright, or try a different
          paper language under “Text reading options”.
        </div>
      )}
    </div>
  );
}
