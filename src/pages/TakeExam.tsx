import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getAttempt, saveAttempt } from "../lib/db";
import { submitAttempt } from "../lib/exam";
import type { Attempt } from "../lib/types";

const BN_DIGITS = "০১২৩৪৫৬৭৮৯";
const bn = (v: number | string) => String(v).replace(/\d/g, (d) => BN_DIGITS[Number(d)]);
/** Marks like 0.5 → "০.৫০", 1 → "১" — the way Bangladeshi exam notices print them. */
const bnMarks = (n: number) => bn(Number.isInteger(n) ? String(n) : n.toFixed(2));

function clock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

export default function TakeExam() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [attempt, setAttempt] = useState<Attempt | null | undefined>(undefined);
  const [now, setNow] = useState(Date.now());
  const [confirming, setConfirming] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const attemptRef = useRef<Attempt | null>(null);
  const warned = useRef<Set<number>>(new Set());
  const submitting = useRef(false);

  useEffect(() => {
    getAttempt(id).then((a) => {
      if (a?.status === "submitted") {
        navigate(`/attempt/${a.id}/result`, { replace: true });
        return;
      }
      attemptRef.current = a ?? null;
      setAttempt(a ?? null);
    });
  }, [id, navigate]);

  const update = useCallback((fn: (a: Attempt) => Attempt) => {
    const cur = attemptRef.current;
    if (!cur || cur.status !== "in_progress") return;
    const next = fn(cur);
    attemptRef.current = next;
    setAttempt(next);
    saveAttempt(next);
  }, []);

  const finish = useCallback(
    async (auto: boolean) => {
      const cur = attemptRef.current;
      if (!cur || submitting.current || cur.status !== "in_progress") return;
      submitting.current = true;
      const done = submitAttempt(cur, auto);
      attemptRef.current = done;
      await saveAttempt(done);
      navigate(`/attempt/${done.id}/result`, { replace: true, state: { auto } });
    },
    [navigate],
  );

  // Clock: tick 4×/s so the display never lags a whole second.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, []);

  const remainingSec = attempt ? Math.max(0, (attempt.endsAt - now) / 1000) : 0;

  useEffect(() => {
    if (!attempt || attempt.status !== "in_progress") return;
    if (remainingSec <= 0) {
      finish(true);
      return;
    }
    for (const mark of [300, 60]) {
      if (remainingSec <= mark && !warned.current.has(mark) && attempt.endsAt - attempt.startedAt > mark * 1000) {
        warned.current.add(mark);
        setToast(mark === 300 ? "আর ৫ মিনিট বাকি" : "আর ১ মিনিট বাকি — সময় শেষ হলে উত্তর স্বয়ংক্রিয়ভাবে জমা হবে");
        window.setTimeout(() => setToast(null), 6000);
      }
    }
  }, [remainingSec, attempt, finish]);

  // Warn before leaving mid-exam (the timer keeps running regardless).
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (attemptRef.current?.status === "in_progress") {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const choose = (qid: string, originalIdx: number) =>
    update((a) => ({ ...a, answers: { ...a.answers, [qid]: originalIdx } }));

  const clear = (qid: string) =>
    update((a) => {
      const { [qid]: _removed, ...rest } = a.answers;
      return { ...a, answers: rest };
    });

  const jumpTo = (i: number) => {
    setPanelOpen(false);
    document.getElementById(`q-${i}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (attempt === undefined) return <div className="ex-page"><div className="ex-loading">লোড হচ্ছে…</div></div>;
  if (attempt === null) return <div className="page empty">Attempt not found. <Link to="/">Back to dashboard</Link></div>;

  const { config } = attempt;
  const total = attempt.items.length;
  const answered = Object.keys(attempt.answers).length;
  const low = remainingSec <= 60;
  const warn = remainingSec <= 300;

  return (
    <div className="ex-page">
      <div className="ex-wrap">
        <header className="ex-sticky">
          <div className="ex-topbar">
            <button className="ex-submit" onClick={() => setConfirming(true)}>
              Submit
            </button>
            <div className={`ex-timer ${low ? "low" : warn ? "warn" : ""}`} role="timer" aria-label="Time remaining">
              {clock(remainingSec)}
            </div>
          </div>
          <button className="ex-titlebar bn" onClick={() => setPanelOpen((o) => !o)} aria-expanded={panelOpen}>
            <span className="ex-title">{config.title}</span>
            <svg className={`ex-chevron ${panelOpen ? "open" : ""}`} viewBox="0 0 24 24" width="20" height="20" aria-hidden>
              <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {panelOpen && (
            <div className="ex-panel bn">
              <div className="ex-panel-stats">
                <span>
                  মোট প্রশ্ন: <b>{bn(total)}</b>
                </span>
                <span>
                  উত্তর দেওয়া: <b className="ex-c-green">{bn(answered)}</b>
                </span>
                <span>
                  বাকি: <b className="ex-c-red">{bn(total - answered)}</b>
                </span>
                <span>
                  সময়: <b>{bn(config.durationMin)} মিনিট</b>
                </span>
              </div>
              <div className="ex-jump">
                {attempt.items.map((it, i) => (
                  <button
                    key={it.questionId}
                    className={attempt.answers[it.questionId] !== undefined ? "done" : ""}
                    onClick={() => jumpTo(i)}
                  >
                    {bn(i + 1)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </header>

        {toast && <div className="ex-toast bn">{toast}</div>}

        <div className="ex-rules bn">
          প্রতি প্রশ্নের মান {bnMarks(config.marksPerCorrect)}
          {config.negativeEnabled && config.negativePerWrong > 0
            ? ` ও ভুল উত্তরের জন্য ${bnMarks(config.negativePerWrong)} কাটা যাবে।`
            : "। ভুল উত্তরের জন্য কোনো নম্বর কাটা যাবে না।"}
        </div>

        <ol className="ex-list">
          {attempt.items.map((it, i) => {
            const q = attempt.questions.find((x) => x.id === it.questionId)!;
            const chosen = attempt.answers[q.id];
            return (
              <li key={q.id} id={`q-${i}`} className="ex-q">
                <div className="ex-qtext bn">
                  {bn(i + 1)}) {q.text}
                </div>
                <div className="ex-opts" role="radiogroup" aria-label={`প্রশ্ন ${bn(i + 1)}`}>
                  {it.optionOrder.map((orig) => (
                    <label key={orig} className={`ex-opt bn ${chosen === orig ? "on" : ""}`}>
                      <input type="radio" name={`q-${q.id}`} checked={chosen === orig} onChange={() => choose(q.id, orig)} />
                      <span className="ex-radio" aria-hidden />
                      <span className="ex-opt-text">{q.options[orig].text}</span>
                    </label>
                  ))}
                </div>
                {chosen !== undefined && (
                  <button className="ex-clear bn" onClick={() => clear(q.id)}>
                    উত্তর মুছুন
                  </button>
                )}
              </li>
            );
          })}
        </ol>

        <div className="ex-bottom">
          <button className="ex-submit" onClick={() => setConfirming(true)}>
            Submit
          </button>
        </div>
      </div>

      {confirming && (
        <div className="modal-backdrop" onClick={() => setConfirming(false)}>
          <div className="modal bn" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h2>উত্তর জমা দিতে চান?</h2>
            <div className="summary-grid">
              <div>
                <span className="muted">উত্তর দেওয়া</span>
                <strong className="c-green">{bn(answered)}</strong>
              </div>
              <div>
                <span className="muted">উত্তর বাকি</span>
                <strong className="c-red">{bn(total - answered)}</strong>
              </div>
              <div>
                <span className="muted">সময় বাকি</span>
                <strong>{clock(remainingSec)}</strong>
              </div>
            </div>
            {total - answered > 0 && <p className="muted">কিছু প্রশ্নের উত্তর এখনো দেওয়া হয়নি। জমা দেওয়ার পর আর পরিবর্তন করা যাবে না।</p>}
            <div className="actions end">
              <button className="btn btn-ghost" onClick={() => setConfirming(false)}>
                ফিরে যান
              </button>
              <button className="btn ex-submit-btn" onClick={() => finish(false)}>
                জমা দিন
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
