import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getExam, getPages, saveExam, savePages } from "../lib/db";
import { extractQuestions } from "../lib/extract";
import { hasKey, validateQuestions } from "../lib/exam";
import { OCR_LANG_LABELS, type OcrLang } from "../lib/ocr";
import { parseAnswerKey, toAsciiDigits } from "../lib/parser";
import type { Exam, PageImage, Question } from "../lib/types";
import { DISPLAY_LABELS } from "../lib/util";

type Filter = "all" | "nokey" | "issues";

export default function ReviewQuestions() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [exam, setExam] = useState<Exam | null | undefined>(undefined);
  const [pages, setPages] = useState<PageImage[]>([]);
  const [activePage, setActivePage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [saveState, setSaveState] = useState<"saved" | "saving" | "dirty">("saved");
  const [zoom, setZoom] = useState(false);
  const [reextracting, setReextracting] = useState<number | null>(null);
  const [showIssues, setShowIssues] = useState(false);
  const [viewText, setViewText] = useState(false);
  const [ocrLang, setOcrLang] = useState<OcrLang>("ben+eng");
  const [keyText, setKeyText] = useState("");
  const [keyMsg, setKeyMsg] = useState<string | null>(null);
  const saveTimer = useRef<number>();

  useEffect(() => {
    Promise.all([getExam(id), getPages(id)]).then(([e, p]) => {
      setExam(e ?? null);
      setPages(p);
    });
  }, [id]);

  const persist = useCallback((next: Exam) => {
    setSaveState("dirty");
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      setSaveState("saving");
      await saveExam(next);
      setSaveState("saved");
    }, 500);
  }, []);

  /** Any edit drops the exam back to draft so it must be re-approved. */
  const mutate = (fn: (qs: Question[]) => Question[]) => {
    setExam((prev) => {
      if (!prev) return prev;
      const next: Exam = { ...prev, status: "draft", questions: fn(prev.questions) };
      persist(next);
      return next;
    });
  };

  const updateQ = (qid: string, patch: Partial<Question>) =>
    mutate((qs) => qs.map((q) => (q.id === qid ? { ...q, ...patch } : q)));

  const issues = useMemo(() => (exam ? validateQuestions(exam.questions) : []), [exam]);
  const issueIds = useMemo(() => {
    const s = new Set<string>();
    exam?.questions.forEach((q) => {
      if (validateQuestions([q]).length) s.add(q.id);
    });
    return s;
  }, [exam]);

  if (exam === undefined) return <div className="page muted">Loading…</div>;
  if (exam === null) return <div className="page empty">Exam not found. <Link to="/">Back to dashboard</Link></div>;

  const noKeyCount = exam.questions.filter((q) => !hasKey(q)).length;
  const visible = exam.questions.filter((q) =>
    filter === "nokey" ? !hasKey(q) : filter === "issues" ? issueIds.has(q.id) : true,
  );

  const applyAnswerKey = () => {
    const { byNumber, sequence } = parseAnswerKey(keyText);
    const keyFor = (q: Question, i: number) => (byNumber.size ? byNumber.get(Number(toAsciiDigits(q.number))) : sequence[i]);
    const applied = exam.questions.filter((q, i) => {
      const idx = keyFor(q, i);
      return idx !== undefined && idx < q.options.length;
    }).length;
    mutate((qs) =>
      qs.map((q, i) => {
        const idx = keyFor(q, i);
        if (idx === undefined || idx >= q.options.length) return q;
        return { ...q, correct: idx, answerSource: "manual" };
      }),
    );
    setKeyMsg(applied ? `Set answers for ${applied} question(s).` : "No answers matched. Use a format like 1-b 2-c, or a sequence like bcad.");
  };

  const mergeUp = (index: number) =>
    mutate((qs) => {
      const prev = qs[index - 1];
      const cur = qs[index];
      let merged: Question;
      if (prev.options.length === 0) {
        // Previous block was only a stem: this block holds the rest of the stem plus the options.
        merged = { ...prev, text: `${prev.text} ${cur.text}`.trim(), options: cur.options, correct: cur.correct, answerSource: cur.answerSource };
      } else {
        // This block's "stem" is really the tail of the previous question's last option.
        const options = [...prev.options];
        if (cur.text) options[options.length - 1] = { ...options[options.length - 1], text: `${options[options.length - 1].text} ${cur.text}`.trim() };
        merged = { ...prev, options: [...options, ...cur.options] };
      }
      return qs.filter((x) => x.id !== cur.id).map((x) => (x.id === prev.id ? merged : x));
    });

  const select = (q: Question) => {
    setSelected(q.id);
    if (q.pageIndex !== null) setActivePage(q.pageIndex);
  };

  const reextractPage = async (pageIndex: number) => {
    const count = exam.questions.filter((q) => q.pageIndex === pageIndex).length;
    if (count && !confirm(`Replace the ${count} question(s) from page ${pageIndex + 1} with a fresh extraction? Your edits on that page will be lost.`)) return;
    setReextracting(pageIndex);
    try {
      const { pages: read, questions: fresh } = await extractQuestions(
        [pages[pageIndex]],
        { lang: ocrLang, forceOcr: true },
        () => {},
        undefined,
        pageIndex,
      );
      const nextPages = pages.map((p, i) => (i === pageIndex ? read[0] : p));
      setPages(nextPages);
      await savePages(exam.id, nextPages);
      mutate((qs) => {
        // Put the fresh questions where that page's questions belong in the sequence.
        const kept = qs.filter((q) => q.pageIndex !== pageIndex);
        const after = kept.findIndex((q) => q.pageIndex !== null && q.pageIndex > pageIndex);
        const at = after === -1 ? kept.length : after;
        return [...kept.slice(0, at), ...fresh, ...kept.slice(at)];
      });
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setReextracting(null);
    }
  };

  const approve = async () => {
    if (issues.length) {
      setShowIssues(true);
      setFilter("issues");
      return;
    }
    window.clearTimeout(saveTimer.current);
    await saveExam({ ...exam, status: "ready" });
    navigate(`/exam/${exam.id}/configure`);
  };

  return (
    <div className="page wide">
      <div className="row-between wrap">
        <div>
          <h1 className="bn">{exam.config.title}</h1>
          <p className="muted">
            Step 2 of 3 — check every question against the original page. Fix OCR mistakes, confirm the correct answers,
            and delete anything that isn't a real question.
          </p>
        </div>
        <span className={`save-indicator ${saveState}`}>
          {saveState === "saved" ? "All changes saved" : saveState === "saving" ? "Saving…" : "Unsaved changes"}
        </span>
      </div>

      <div className="review-toolbar card">
        <div className="chips">
          <button className={`chip ${filter === "all" ? "on" : ""}`} onClick={() => setFilter("all")}>
            All ({exam.questions.length})
          </button>
          <button className={`chip ${filter === "nokey" ? "on" : ""}`} onClick={() => setFilter("nokey")}>
            Missing answer ({noKeyCount})
          </button>
          <button className={`chip ${filter === "issues" ? "on" : ""}`} onClick={() => setFilter("issues")}>
            Needs fixing ({issueIds.size})
          </button>
        </div>
        <button className="btn btn-primary" onClick={approve}>
          Approve {exam.questions.length} questions →
        </button>
      </div>

      {showIssues && issues.length > 0 && (
        <div className="alert alert-error">
          <strong>Fix these before continuing:</strong>
          <ul>
            {issues.slice(0, 8).map((i) => (
              <li key={i}>{i}</li>
            ))}
            {issues.length > 8 && <li>…and {issues.length - 8} more</li>}
          </ul>
        </div>
      )}

      <details className="card key-panel" open={noKeyCount > 0}>
        <summary>
          <strong>Answer key</strong>{" "}
          <span className="muted small">
            {noKeyCount === 0
              ? "· every question has an answer"
              : `· ${noKeyCount} question(s) have no answer. They stay ungraded until you add one, even after the exam.`}
          </span>
        </summary>
        <p className="muted small">
          Type or paste the answer key to set many answers at once. Use numbered pairs like <code>1-b 2-c 3-a</code> or{" "}
          <code>১-খ ২-গ</code>, or just the letters in order, like <code>bcadab…</code>. You can also click the radio button next to
          the correct option on each question.
        </p>
        <textarea
          className="input textarea"
          rows={3}
          value={keyText}
          onChange={(e) => {
            setKeyText(e.target.value);
            setKeyMsg(null);
          }}
          placeholder="1-b 2-c 3-a 4-d …"
        />
        <div className="row-between">
          <span className="muted small">{keyMsg}</span>
          <button className="btn btn-ghost btn-sm" disabled={!keyText.trim()} onClick={applyAnswerKey}>
            Apply answer key
          </button>
        </div>
      </details>

      <div className="review-layout">
        <div className="review-list">
          {visible.length === 0 && <div className="empty card">Nothing to show for this filter.</div>}
          {visible.map((q) => {
            const index = exam.questions.indexOf(q);
            return (
              <QuestionEditor
                key={q.id}
                q={q}
                index={index}
                total={exam.questions.length}
                active={selected === q.id}
                hasIssue={issueIds.has(q.id)}
                onFocus={() => select(q)}
                onChange={(patch) => updateQ(q.id, patch)}
                onMergeUp={index > 0 ? () => mergeUp(index) : undefined}
                onDelete={() => {
                  if (confirm(`Delete question ${q.number || index + 1}?`)) mutate((qs) => qs.filter((x) => x.id !== q.id));
                }}
                onMove={(dir) =>
                  mutate((qs) => {
                    const next = [...qs];
                    const j = index + dir;
                    if (j < 0 || j >= next.length) return qs;
                    [next[index], next[j]] = [next[j], next[index]];
                    return next;
                  })
                }
              />
            );
          })}
        </div>

        <aside className="review-viewer">
          <div className="card viewer-card">
            <div className="viewer-head">
              <strong>Original page</strong>
              <div className="actions">
                <button className="icon-btn" disabled={activePage === 0} onClick={() => setActivePage((p) => p - 1)}>‹</button>
                <span className="small">
                  {pages.length ? activePage + 1 : 0} / {pages.length}
                </span>
                <button className="icon-btn" disabled={activePage >= pages.length - 1} onClick={() => setActivePage((p) => p + 1)}>›</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setViewText((v) => !v)}>{viewText ? "Image" : "Text"}</button>
                {!viewText && <button className="btn btn-ghost btn-sm" onClick={() => setZoom((z) => !z)}>{zoom ? "Fit" : "Zoom"}</button>}
              </div>
            </div>
            {pages[activePage] ? (
              <>
                {viewText ? (
                  <pre className="viewer-text bn">
                    {pages[activePage].text?.join("\n").trim() || "No text was recognised on this page."}
                  </pre>
                ) : (
                  <div className={`viewer-img ${zoom ? "zoomed" : ""}`}>
                    <img src={pages[activePage].dataUrl} alt={`Page ${activePage + 1}`} />
                  </div>
                )}
                <div className="muted small">
                  {pages[activePage].source}
                  {pages[activePage].textMethod && ` · text from ${pages[activePage].textMethod === "pdf" ? "PDF" : "OCR"}`}
                </div>
                <div className="row-between small">
                  <select className="input input-sm" value={ocrLang} onChange={(e) => setOcrLang(e.target.value as OcrLang)} aria-label="OCR language">
                    {(Object.keys(OCR_LANG_LABELS) as OcrLang[]).map((l) => (
                      <option key={l} value={l}>{OCR_LANG_LABELS[l]}</option>
                    ))}
                  </select>
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={reextracting !== null}
                    onClick={() => reextractPage(activePage)}
                  >
                    {reextracting === activePage ? "Running OCR…" : "Re-run OCR on this page"}
                  </button>
                </div>
              </>
            ) : (
              <div className="muted">No page images stored.</div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function QuestionEditor(props: {
  q: Question;
  index: number;
  total: number;
  active: boolean;
  hasIssue: boolean;
  onFocus: () => void;
  onChange: (patch: Partial<Question>) => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
  onMergeUp?: () => void;
}) {
  const { q, index, total, active, hasIssue, onFocus, onChange, onDelete, onMove, onMergeUp } = props;

  const setOption = (i: number, patch: Partial<{ label: string; text: string }>) =>
    onChange({ options: q.options.map((o, j) => (j === i ? { ...o, ...patch } : o)) });

  const removeOption = (i: number) => {
    const options = q.options.filter((_, j) => j !== i);
    let correct = q.correct;
    if (correct === i) correct = null;
    else if (correct !== null && correct > i) correct -= 1;
    onChange({ options, correct, answerSource: correct === null ? "unknown" : q.answerSource });
  };

  const sourceBadge =
    q.correct === null ? (
      <span className="badge badge-amber">No answer set</span>
    ) : q.answerSource === "paper" ? (
      <span className="badge badge-green">Answer found in paper</span>
    ) : (
      <span className="badge badge-blue">Answer set by you</span>
    );

  return (
    <div className={`card q-editor ${active ? "active" : ""} ${hasIssue ? "has-issue" : ""}`} onFocusCapture={onFocus} onClick={onFocus}>
      <div className="q-editor-head">
        <div className="q-num">
          <span className="muted small">#{index + 1}</span>
          <input
            className="input input-num bn"
            value={q.number}
            onChange={(e) => onChange({ number: e.target.value })}
            aria-label="Question number"
          />
        </div>
        {sourceBadge}
        {q.pageIndex !== null && <span className="muted small">page {q.pageIndex + 1}</span>}
        <div className="spacer" />
        <button className="icon-btn" title="Move up" disabled={index === 0} onClick={() => onMove(-1)}>↑</button>
        <button className="icon-btn" title="Move down" disabled={index === total - 1} onClick={() => onMove(1)}>↓</button>
        {onMergeUp && (
          <button className="btn btn-ghost btn-sm" title="Join onto the previous question (fixes a question that was split in two)" onClick={onMergeUp}>
            Merge ↑
          </button>
        )}
        <button className="btn btn-ghost btn-sm danger" onClick={onDelete}>Delete</button>
      </div>

      <AutoTextarea value={q.text} onChange={(text) => onChange({ text })} placeholder="Question text" />

      <div className="opt-list">
        {q.options.map((o, i) => (
          <div key={i} className={`opt-row ${q.correct === i ? "correct" : ""}`}>
            <label className="opt-radio" title="Mark as correct answer">
              <input
                type="radio"
                name={`correct-${q.id}`}
                checked={q.correct === i}
                onChange={() => onChange({ correct: i, answerSource: "manual" })}
              />
            </label>
            <input
              className="input input-label bn"
              value={o.label}
              placeholder={DISPLAY_LABELS[i]}
              onChange={(e) => setOption(i, { label: e.target.value })}
              aria-label="Option label"
            />
            <input
              className="input bn"
              value={o.text}
              onChange={(e) => setOption(i, { text: e.target.value })}
              placeholder="Option text"
            />
            <button className="icon-btn" title="Remove option" onClick={() => removeOption(i)}>×</button>
          </div>
        ))}
        {q.options.length < 8 && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => onChange({ options: [...q.options, { label: DISPLAY_LABELS[q.options.length], text: "" }] })}
          >
            + Add missing option
          </button>
        )}
      </div>
      <div className="muted small">Select the radio button next to the correct option.</div>
      <details className="q-expl" open={!!q.explanation && active}>
        <summary className="small">
          {q.explanation ? "Explanation" : "Add explanation"} <span className="muted">(shown after the exam)</span>
        </summary>
        <AutoTextarea
          value={q.explanation ?? ""}
          onChange={(explanation) => onChange({ explanation })}
          placeholder="Why this answer is correct, notes to remember…"
        />
      </details>
    </div>
  );
}

function AutoTextarea({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      className="input textarea bn"
      rows={2}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
