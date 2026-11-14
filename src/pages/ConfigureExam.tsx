import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getExam, listAttempts, saveAttempt, saveExam } from "../lib/db";
import { createAttempt, hasKey, totalMarks, usableQuestions, validateConfig } from "../lib/exam";
import type { Attempt, Exam, ExamConfig } from "../lib/types";
import { formatDate, num } from "../lib/util";

const PRESETS = [20, 30, 45, 60, 90, 120];

export default function ConfigureExam() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [exam, setExam] = useState<Exam | null | undefined>(undefined);
  const [config, setConfig] = useState<ExamConfig | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  // Text mirrors so people can clear and retype numbers freely.
  const [totalText, setTotalText] = useState("");
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    getExam(id).then((e) => {
      setExam(e ?? null);
      if (e) {
        setConfig(e.config);
        setTotalText(num(totalMarks(e.config, usableQuestions(e.questions).length)));
      }
    });
    listAttempts(id).then(setAttempts);
  }, [id]);

  if (exam === undefined || (exam && !config)) return <div className="page muted">Loading…</div>;
  if (exam === null || !config) return <div className="page empty">Exam not found. <Link to="/">Back to dashboard</Link></div>;

  const usable = usableQuestions(exam.questions);
  const n = usable.length;
  const incomplete = exam.questions.length - n;
  const reviewed = n > 0;
  const noKey = usable.filter((q) => !hasKey(q)).length;
  const inProgress = attempts.find((a) => a.status === "in_progress" && a.endsAt > Date.now());

  const set = <K extends keyof ExamConfig>(key: K, value: ExamConfig[K]) => {
    const next = { ...config, [key]: value };
    setConfig(next);
    if (key === "marksPerCorrect") setTotalText(num(Number(value) * n));
  };

  const setTotal = (text: string) => {
    setTotalText(text);
    const t = Number(text);
    if (t > 0 && n > 0) setConfig({ ...config, marksPerCorrect: t / n });
  };

  const save = async () => {
    const saved = await saveExam({ ...exam, config });
    setExam(saved);
    return saved;
  };

  const start = async () => {
    const errs = validateConfig(config);
    setErrors(errs);
    if (errs.length || !reviewed) return;
    const saved = await save();
    const attempt = createAttempt(saved);
    await saveAttempt(attempt);
    navigate(`/attempt/${attempt.id}`);
  };

  return (
    <div className="page narrow">
      <h1>Exam configuration</h1>
      <p className="muted">Set the rules, then start when you're ready.</p>

      {!reviewed && (
        <div className="alert alert-warn">
          None of the questions are complete enough to use. <Link to={`/exam/${exam.id}/review`}>Fix them →</Link>
        </div>
      )}
      {incomplete > 0 && reviewed && (
        <div className="alert alert-info">
          {incomplete} incomplete question(s) will be left out. <Link to={`/exam/${exam.id}/review`}>Fix them →</Link>
        </div>
      )}
      {reviewed && noKey > 0 && (
        <div className="alert alert-info">
          {noKey} of {n} questions have no answer key, so they won't be graded and the total marks will drop to match. You can
          add the answers later in <Link to={`/exam/${exam.id}/review`}>Edit questions</Link> and re-grade past attempts.
        </div>
      )}
      {inProgress && (
        <div className="alert alert-info">
          You have an unfinished attempt of this exam. <Link to={`/attempt/${inProgress.id}`}>Resume it →</Link>
        </div>
      )}

      <div className="card form">
        <label className="field">
          <span>Exam title</span>
          <input className="input bn" value={config.title} onChange={(e) => set("title", e.target.value)} />
        </label>

        <div className="grid-2">
          <div className="field">
            <span>Total questions</span>
            <div className="readonly-value">{n}</div>
            <small className="muted">Calculated from the extracted questions</small>
          </div>
          <label className="field">
            <span>Exam duration (minutes)</span>
            <input
              className="input"
              type="number"
              min={1}
              max={600}
              value={Number.isFinite(config.durationMin) ? config.durationMin : ""}
              onChange={(e) => set("durationMin", e.target.valueAsNumber)}
            />
          </label>
        </div>
        <div className="chips">
          {PRESETS.map((m) => (
            <button key={m} className={`chip ${config.durationMin === m ? "on" : ""}`} onClick={() => set("durationMin", m)}>
              {m} min
            </button>
          ))}
          <span className="muted small">or type any custom duration</span>
        </div>

        <div className="grid-2">
          <label className="field">
            <span>Marks per correct answer</span>
            <input
              className="input"
              type="number"
              min={0}
              step={0.25}
              value={Number.isFinite(config.marksPerCorrect) ? num(config.marksPerCorrect) : ""}
              onChange={(e) => set("marksPerCorrect", e.target.valueAsNumber)}
            />
          </label>
          <label className="field">
            <span>Total marks</span>
            <input className="input" type="number" min={0} step={1} value={totalText} onChange={(e) => setTotal(e.target.value)} />
            <small className="muted">Linked: total = questions × marks per correct</small>
          </label>
        </div>

        <div className="toggle-block">
          <Toggle
            checked={config.negativeEnabled}
            onChange={(v) => set("negativeEnabled", v)}
            label="Negative marking"
            hint="Deduct marks for each wrong answer. Unanswered questions are never penalised."
          />
          {config.negativeEnabled && (
            <div className="grid-2 indent">
              <label className="field">
                <span>Marks deducted per wrong answer</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  step={0.05}
                  value={Number.isFinite(config.negativePerWrong) ? config.negativePerWrong : ""}
                  onChange={(e) => set("negativePerWrong", e.target.valueAsNumber)}
                />
              </label>
              <div className="chips align-end">
                {[0.25, 0.5, 1].map((v) => (
                  <button key={v} className={`chip ${config.negativePerWrong === v ? "on" : ""}`} onClick={() => set("negativePerWrong", v)}>
                    −{v}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <Toggle
          checked={config.randomizeQuestions}
          onChange={(v) => set("randomizeQuestions", v)}
          label="Randomize question order"
          hint="Shuffle questions for each attempt."
        />
        <Toggle
          checked={config.randomizeOptions}
          onChange={(v) => set("randomizeOptions", v)}
          label="Randomize MCQ options"
          hint="Shuffle the A/B/C/D order within each question."
        />
      </div>

      <div className="card summary">
        <h3>Exam summary</h3>
        <div className="summary-grid">
          <div><span className="muted">Questions</span><strong>{n}</strong></div>
          <div><span className="muted">Duration</span><strong>{config.durationMin || "–"} min</strong></div>
          <div><span className="muted">Total marks</span><strong>{num(totalMarks(config, n))}</strong></div>
          <div><span className="muted">Per correct</span><strong>+{num(config.marksPerCorrect || 0)}</strong></div>
          <div><span className="muted">Per wrong</span><strong>{config.negativeEnabled ? `−${num(config.negativePerWrong || 0)}` : "0"}</strong></div>
        </div>
        <p className="muted small">
          The timer starts as soon as you press Start and keeps running if you close or refresh the tab. When it reaches
          zero your answers are submitted automatically.
        </p>
      </div>

      {errors.length > 0 && (
        <div className="alert alert-error">
          {errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      )}

      <div className="row-between sticky-actions">
        <Link to={`/exam/${exam.id}/review`} className="btn btn-ghost">← Back to questions</Link>
        <div className="actions">
          <button className="btn btn-ghost" onClick={save}>Save settings</button>
          <button className="btn btn-primary btn-lg" disabled={!reviewed} onClick={start}>
            Start exam
          </button>
        </div>
      </div>

      {attempts.some((a) => a.result) && (
        <>
          <h2 className="section-title">Previous attempts</h2>
          <div className="card table-wrap">
            <table className="table">
              <tbody>
                {attempts
                  .filter((a) => a.result)
                  .map((a) => (
                    <tr key={a.id}>
                      <td>{formatDate(a.startedAt)}</td>
                      <td>
                        <strong>{num(a.result!.score)}</strong> / {num(a.result!.totalMarks)}
                      </td>
                      <td>
                        <Link to={`/attempt/${a.id}/result`}>View result</Link>
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

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track"><span className="toggle-thumb" /></span>
      <span>
        <span className="toggle-label">{label}</span>
        {hint && <span className="muted small block">{hint}</span>}
      </span>
    </label>
  );
}
