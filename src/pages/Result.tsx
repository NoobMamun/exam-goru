import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { getAttempt, getExam, getPages, saveAttempt } from "../lib/db";
import { canRegrade, createAttempt, hasKey, regradeAttempt } from "../lib/exam";
import type { Attempt, Exam, PageImage } from "../lib/types";
import { DISPLAY_LABELS, formatDate, formatDuration, num } from "../lib/util";

type Filter = "all" | "correct" | "wrong" | "skipped" | "ungraded" | "flagged";

export default function Result() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [attempt, setAttempt] = useState<Attempt | null | undefined>(undefined);
  const [exam, setExam] = useState<Exam | null>(null);
  const [pages, setPages] = useState<PageImage[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [viewPage, setViewPage] = useState<number | null>(null);

  useEffect(() => {
    getAttempt(id).then(async (a) => {
      setAttempt(a ?? null);
      if (a) {
        const [e, p] = await Promise.all([getExam(a.examId), getPages(a.examId)]);
        setExam(e ?? null);
        setPages(p);
      }
    });
  }, [id]);

  if (attempt === undefined) return <div className="page muted">Loading…</div>;
  if (!attempt || !attempt.result) return <div className="page empty">Result not found. <Link to="/">Back to dashboard</Link></div>;

  const r = attempt.result;
  const pct = r.totalMarks > 0 ? (r.score / r.totalMarks) * 100 : 0;
  const attempted = r.correct + r.wrong;
  const accuracy = attempted ? (r.correct / attempted) * 100 : 0;
  const auto = attempt.autoSubmitted || (location.state as { auto?: boolean } | null)?.auto;

  const rows = attempt.items.map((it, i) => {
    const q = attempt.questions.find((x) => x.id === it.questionId)!;
    const ans = attempt.answers[q.id];
    const status = !hasKey(q) ? "ungraded" : ans === undefined ? "skipped" : ans === q.correct ? "correct" : "wrong";
    return { i, it, q, ans, status, flagged: attempt.flagged.includes(q.id) };
  });
  const shown = rows.filter((row) => (filter === "all" ? true : filter === "flagged" ? row.flagged : row.status === filter));

  const regrade = async () => {
    if (!exam) return;
    const next = regradeAttempt(attempt, exam);
    await saveAttempt(next);
    setAttempt(next);
  };

  const retake = async () => {
    if (!exam) return;
    const a = createAttempt(exam);
    await saveAttempt(a);
    navigate(`/attempt/${a.id}`);
  };

  return (
    <div className="page narrow">
      {auto && <div className="alert alert-info">Time ran out, so your answers were submitted automatically.</div>}

      {exam && canRegrade(attempt, exam) && (
        <div className="alert alert-info row-between">
          <span>The answer key for this exam has changed since this attempt was graded.</span>
          <button className="btn btn-primary btn-sm" onClick={regrade}>Re-grade with latest answer key</button>
        </div>
      )}
      {r.ungraded > 0 && (
        <div className="alert alert-warn">
          {r.ungraded} question(s) had no answer key and weren't graded. Add their answers in{" "}
          <Link to={`/exam/${attempt.examId}/review`}>Edit questions</Link>, then come back and re-grade.
        </div>
      )}

      <section className="card result-hero">
        <div className={`score-ring ${pct >= 60 ? "good" : pct >= 40 ? "ok" : "bad"}`} style={{ ["--pct" as string]: `${Math.max(0, pct)}` }}>
          <div>
            <div className="score-big">{num(r.score)}</div>
            <div className="muted small">of {num(r.totalMarks)}</div>
          </div>
        </div>
        <div className="result-info">
          <h1 className="bn">{attempt.config.title}</h1>
          <div className="muted small">Submitted {formatDate(attempt.submittedAt ?? attempt.startedAt)}</div>
          <div className="summary-grid result-grid">
            <div><span className="muted">Score</span><strong>{num(pct)}%</strong></div>
            <div><span className="muted">Correct</span><strong className="c-green">{r.correct}</strong></div>
            <div><span className="muted">Wrong</span><strong className="c-red">{r.wrong}</strong></div>
            <div><span className="muted">Skipped</span><strong>{r.skipped}</strong></div>
            {r.ungraded > 0 && <div><span className="muted">Ungraded</span><strong>{r.ungraded}</strong></div>}
            <div><span className="muted">Accuracy</span><strong>{num(accuracy)}%</strong></div>
            <div><span className="muted">Time taken</span><strong>{formatDuration(r.timeTakenSec)}</strong></div>
          </div>
          <div className="muted small">
            {r.correct} × {num(attempt.config.marksPerCorrect)} = {num(r.correct * attempt.config.marksPerCorrect)}
            {attempt.config.negativeEnabled && (
              <> − negative marking {r.wrong} × {num(attempt.config.negativePerWrong)} = {num(r.negativeDeducted)}</>
            )}
            {" "}→ <strong>{num(r.score)}</strong>
          </div>
          <div className="actions">
            {exam && <button className="btn btn-primary" onClick={retake}>Retake exam</button>}
            <Link to="/" className="btn btn-ghost">Dashboard</Link>
          </div>
        </div>
      </section>

      <h2 className="section-title">Answer review</h2>
      <div className="chips">
        {(["all", "correct", "wrong", "skipped", ...(r.ungraded ? ["ungraded"] : []), "flagged"] as Filter[]).map((f) => (
          <button key={f} className={`chip ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>
            {f[0].toUpperCase() + f.slice(1)} ({f === "all" ? rows.length : f === "flagged" ? rows.filter((x) => x.flagged).length : rows.filter((x) => x.status === f).length})
          </button>
        ))}
      </div>

      <div className="review-answers">
        {shown.map(({ i, it, q, ans, status, flagged }) => (
          <div key={q.id} className={`card answer-card ${status}`}>
            <div className="answer-head">
              <span className="q-index">Q{i + 1}</span>
              <span className={`badge ${status === "correct" ? "badge-green" : status === "wrong" ? "badge-red" : "badge-gray"}`}>
                {status === "correct" ? "Correct" : status === "wrong" ? "Wrong" : status === "ungraded" ? "No answer key" : "Not answered"}
              </span>
              {flagged && <span className="badge badge-amber">Marked</span>}
              <div className="spacer" />
              {q.pageIndex !== null && pages[q.pageIndex] && (
                <button className="btn btn-ghost btn-sm" onClick={() => setViewPage(q.pageIndex)}>View original</button>
              )}
            </div>
            <div className="q-text bn">{q.text}</div>
            <div className="options compact">
              {it.optionOrder.map((orig, pos) => {
                const isCorrect = orig === q.correct;
                const isMine = orig === ans;
                return (
                  <div key={orig} className={`option static ${isCorrect ? "is-correct" : ""} ${isMine && !isCorrect ? "is-wrong" : ""}`}>
                    <span className="option-label">{DISPLAY_LABELS[pos]}</span>
                    <span className="option-text bn">{q.options[orig].text}</span>
                    {isCorrect && <span className="option-tag">✓ Correct</span>}
                    {isMine && <span className="option-tag">Your answer</span>}
                  </div>
                );
              })}
            </div>
            {q.explanation && (
              <details className="explanation">
                <summary>Explanation</summary>
                <div className="bn">{q.explanation}</div>
              </details>
            )}
          </div>
        ))}
      </div>

      {viewPage !== null && pages[viewPage] && (
        <div className="modal-backdrop" onClick={() => setViewPage(null)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="row-between">
              <strong>{pages[viewPage].source}</strong>
              <button className="icon-btn" onClick={() => setViewPage(null)}>×</button>
            </div>
            <div className="viewer-img zoomed">
              <img src={pages[viewPage].dataUrl} alt="" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
