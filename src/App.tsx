import { Link, Route, Routes, useLocation } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import CreateExam from "./pages/CreateExam";
import ReviewQuestions from "./pages/ReviewQuestions";
import ConfigureExam from "./pages/ConfigureExam";
import TakeExam from "./pages/TakeExam";
import Result from "./pages/Result";

export default function App() {
  const { pathname } = useLocation();
  // The exam screen gets the whole viewport, like a real exam hall terminal.
  const inExam = /^\/attempt\/[^/]+$/.test(pathname);

  return (
    <div className="app">
      {!inExam && (
        <header className="topbar">
          <Link to="/" className="brand">
            <span className="brand-mark">✎</span>
            <span>Personal Exam Creator</span>
          </Link>
          <nav>
            <Link to="/" className="nav-link">Dashboard</Link>
            <Link to="/new" className="btn btn-primary btn-sm">+ Create New Exam</Link>
          </nav>
        </header>
      )}
      <main className={inExam ? "main main-exam" : "main"}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/new" element={<CreateExam />} />
          <Route path="/exam/:id/review" element={<ReviewQuestions />} />
          <Route path="/exam/:id/configure" element={<ConfigureExam />} />
          <Route path="/attempt/:id" element={<TakeExam />} />
          <Route path="/attempt/:id/result" element={<Result />} />
          <Route path="*" element={<div className="empty">Page not found. <Link to="/">Go home</Link></div>} />
        </Routes>
      </main>
    </div>
  );
}
