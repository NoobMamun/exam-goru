import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { deleteExam, listAttempts, listExams, saveAttempt } from "../lib/db";
import type { Attempt, Exam } from "../lib/types";
import { formatDate, formatDuration, num } from "../lib/util";
import { createAttempt, totalMarks, usableQuestions } from "../lib/exam";

export default function Dashboard() {
  const [exams, setExams] = useState<Exam[] | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const navigate = useNavigate();

  const load = async () => {
    const [e, a] = await Promise.all([listExams(), listAttempts()]);
    setExams(e);
    setAttempts(a);
  };

  useEffect(() => {
    load();
  }, []);

  const remove = async (exam: Exam) => {
    if (!confirm(`Delete "${exam.config.title}" and all of its attempts? This cannot be undone.`)) return;
    await deleteExam(exam.id);
    load();
  };

  const startNow = async (exam: Exam) => {
    const attempt = createAttempt(exam);
    await saveAttempt(attempt);
    navigate(`/attempt/${attempt.id}`);
  };

  const submitted = attempts.filter((a) => a.status === "submitted" && a.result);
  const avgPct = submitted.length
    ? submitted.reduce((s, a) => s + (a.result!.score / a.result!.totalMarks) * 100, 0) / submitted.length
    : null;
  const examTitle = (id: string) => exams?.find((e) => e.id === id)?.config.title ?? "Deleted exam";

  return (
    <div className="page">
      <section className="hero">
        <div>
          <h1>Your exam hall</h1>
          <p className="muted">
            Upload a question paper (PDF or photos). The MCQs are read on this computer, fully offline. Review them, then
            sit a timed exam with instant results.
          </p>
        </div>
        <button className="btn btn-primary btn-lg" onClick={() => navigate("/new")}>
          + Create New Exam
        </button>
      </section>

      <section className="stats-row">
        <Stat label="Exams" value={exams?.length ?? "–"} />
        <Stat label="Attempts submitted" value={submitted.length} />
        <Stat label="Average score" value={avgPct === null ? "–" : `${num(avgPct)}%`} />
      </section>

      <h2 className="section-title">Exams</h2>
      {exams === null ? (
        <div className="muted">Loading…</div>
      ) : exams.length === 0 ? (
        <div className="empty card">
          <p>No exams yet.</p>
          <Link to="/new" className="btn btn-primary">Upload your first question paper</Link>
        </div>
      ) : (
        <div className="exam-grid">
          {exams.map((exam) => {
            const mine = attempts.filter((a) => a.examId === exam.id);
            const inProgress = mine.find((a) => a.status === "in_progress" && a.endsAt > Date.now());
            const best = mine
              .filter((a) => a.result)
              .reduce<Attempt | null>((b, a) => (!b || a.result!.score > b.result!.score ? a : b), null);
            return (
              <div key={exam.id} className="card exam-card">
                <div className="exam-card-head">
                  <h3 className="bn">{exam.config.title}</h3>
                  {usableQuestions(exam.questions).length < exam.questions.length && (
                    <span className="badge badge-amber">{exam.questions.length - usableQuestions(exam.questions).length} incomplete</span>
                  )}
                </div>
                <div className="meta">
                  <span>{usableQuestions(exam.questions).length} questions</span>
                  <span>{exam.config.durationMin} min</span>
                  <span>{num(totalMarks(exam.config, usableQuestions(exam.questions).length))} marks</span>
                  {exam.config.negativeEnabled && <span>−{num(exam.config.negativePerWrong)} / wrong</span>}
                </div>
                <div className="meta muted">
                  {mine.length} attempt{mine.length === 1 ? "" : "s"}
                  {best?.result && ` · best ${num(best.result.score)}/${num(best.result.totalMarks)}`}
                </div>
                <div className="actions">
                  {inProgress ? (
                    <Link to={`/attempt/${inProgress.id}`} className="btn btn-primary btn-sm">Resume exam</Link>
                  ) : (
                    <button className="btn btn-primary btn-sm" disabled={!usableQuestions(exam.questions).length} onClick={() => startNow(exam)}>
                      Start exam ▶
                    </button>
                  )}
                  <Link to={`/exam/${exam.id}/configure`} className="btn btn-ghost btn-sm">Settings</Link>
                  <Link to={`/exam/${exam.id}/review`} className="btn btn-ghost btn-sm">Edit questions</Link>
                  <button className="btn btn-ghost btn-sm danger" onClick={() => remove(exam)}>Delete</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {submitted.length > 0 && (
        <>
          <h2 className="section-title">Recent results</h2>
          <div className="card table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Exam</th>
                  <th>Date</th>
                  <th>Score</th>
                  <th>Correct / Wrong / Skipped</th>
                  <th>Time</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {submitted.slice(0, 15).map((a) => (
                  <tr key={a.id}>
                    <td className="bn">{a.config.title || examTitle(a.examId)}</td>
                    <td>{formatDate(a.submittedAt ?? a.startedAt)}</td>
                    <td>
                      <strong>{num(a.result!.score)}</strong> / {num(a.result!.totalMarks)}
                    </td>
                    <td>
                      <span className="c-green">{a.result!.correct}</span> /{" "}
                      <span className="c-red">{a.result!.wrong}</span> /{" "}
                      <span className="muted">{a.result!.skipped}</span>
                    </td>
                    <td>{formatDuration(a.result!.timeTakenSec)}</td>
                    <td>
                      <Link to={`/attempt/${a.id}/result`}>View</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
