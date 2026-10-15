"use client";

/**
 * DashboardLogin v4 — 6-digit dashboard MPIN for returning users (password
 * fallback when no dashboard MPIN is set). The remembered email comes from
 * localStorage (saved by the daily app at login/unlock).
 *
 * v4: same centered composition as the daily unlock — brand chip, greeting,
 * plain dots, keypad immediately below (zero dead zones), auth-canvas bg.
 */
import { useEffect, useState } from "react";
import { Loader2, Lock, KeyRound, ArrowLeft } from "lucide-react";
import Keypad, { haptic } from "../components/Keypad";

export default function DashboardLogin() {
  const [email, setEmail] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const [usePassword, setUsePassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [shake, setShake] = useState(false);

  useEffect(() => {
    try {
      setEmail(localStorage.getItem("khata-remembered-email"));
    } catch { /* private mode */ }
    setReady(true);
  }, []);

  const submitMpin = async (code?: string) => {
    const c = code ?? pin;
    if (c.length !== 6 || loading) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/dashboard/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, dashboardMpin: c }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) location.reload();
      else {
        setErr(j.error ?? "Login failed");
        haptic(60);
        setShake(true);
        setTimeout(() => { setShake(false); setPin(""); }, 480);
        if (j.needsPassword) setUsePassword(true);
      }
    } catch {
      setErr("Network error");
    } finally {
      setLoading(false);
    }
  };

  const submitPassword = async () => {
    if (!email || !password || loading) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/dashboard/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) location.reload();
      else setErr(j.error ?? "Login failed");
    } catch {
      setErr("Network error");
    } finally {
      setLoading(false);
    }
  };

  /** Keypad digit → append; auto-submit at 6. Functional update so
      rapid taps in one React batch can never drop digits. */
  const pinDigit = (d: string) => {
    if (loading) return;
    setPin((prev) => {
      const next = (prev + d).slice(0, 6);
      if (next.length === 6) {
        setTimeout(() => submitMpin(next), 140);
      }
      return next;
    });
  };
  const pinBackspace = () => setPin((p) => p.slice(0, -1));

  return (
    <div className="min-h-dvh flex flex-col auth-canvas">
      <div className="safe-top" />
      <div className="flex-1 w-full max-w-sm mx-auto px-4 pt-[6vh] pb-3 flex flex-col items-center anim-fade-in">

        {!ready ? (
          <div className="h-40" />
        ) : !email ? (
          <div className="card-v4 p-7 w-full anim-fade-up">
            <h1 className="display-2 text-foreground">Sign in</h1>
            <p className="text-[13px] text-muted-foreground mt-1.5 mb-5 leading-relaxed">
              Open the daily app once first — it remembers your Gmail here.
            </p>
            <a href="/" className="btn-main">
              Open the app
            </a>
          </div>
        ) : !usePassword ? (
          <>
            <div className="flex flex-col items-center text-center anim-fade-up">
              <div className={`brand-chip w-14 h-14 flex items-center justify-center ${shake ? "anim-shake" : ""}`} style={{ borderRadius: 19 }} aria-hidden>
                {loading ? (
                  <Loader2 className="w-6 h-6 text-white animate-spin" />
                ) : (
                  <Lock className={`w-6 h-6 ${shake ? "text-white" : "text-white"} anim-breathe`} />
                )}
              </div>
              <h1 className="display-2 text-foreground mt-4">
                {loading ? "Checking…" : shake ? "Wrong MPIN" : "Dashboard"}
              </h1>
              <p className="text-[13px] text-muted-foreground mt-1">{email}</p>
              {err && !shake && (
                <p className="text-[12px] text-destructive text-center mt-2 anim-pop-in">{err}</p>
              )}
            </div>

            {/* 6 MPIN dots — plain, clean, keypad-driven */}
            <div className={`mt-8 flex items-center justify-center gap-[14px] h-8 ${shake ? "anim-shake" : ""}`}>
              {Array.from({ length: 6 }).map((_, i) => {
                const filled = i < pin.length;
                const isActive = i === pin.length && !loading;
                return (
                  <div key={i} className="w-[12px] h-[12px] flex items-center justify-center">
                    {filled ? (
                      <span
                        className={`block w-[12px] h-[12px] rounded-full anim-pop-in ${shake ? "bg-destructive" : "bg-foreground"}`}
                        key={pin[i] + i}
                      />
                    ) : isActive ? (
                      <span className="block w-[12px] h-[12px] rounded-full border-[2.5px] border-[var(--primary)] anim-breathe" />
                    ) : (
                      <span className="block w-[12px] h-[12px] rounded-full border-2 border-muted-foreground/40" />
                    )}
                  </div>
                );
              })}
            </div>

            {/* Keypad follows immediately — no void */}
            <div className="mt-8 w-full anim-fade-up-d1">
              <Keypad
                onDigit={pinDigit}
                onBackspace={pinBackspace}
                disabled={loading}
                footer={
                  <div className="flex items-center justify-center gap-2.5 text-[12.5px] pt-1">
                    <button
                      type="button"
                      onClick={() => setUsePassword(true)}
                      className="text-[var(--primary)] font-medium hover:underline"
                    >
                      Use password instead
                    </button>
                    <span className="text-border">·</span>
                    <button
                      type="button"
                      onClick={() => setEmail(null)}
                      className="text-muted-foreground hover:underline"
                    >
                      Different account
                    </button>
                  </div>
                }
              />
            </div>
            {err && /locked/i.test(err) && (
              <p className="text-[11px] text-muted-foreground text-center mt-2">
                Locked? Use your password, or reset MPINs from the daily app.
              </p>
            )}
          </>
        ) : (
          <div className="card-v4 p-7 w-full anim-fade-up">
            <h1 className="display-2 text-foreground">Dashboard</h1>
            <p className="text-[13px] text-muted-foreground mt-1">{email}</p>
            <div className="field mt-5">
              <span className="field-icon"><KeyRound /></span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submitPassword(); }}
                autoComplete="current-password"
                placeholder="Your password"
                autoFocus
              />
            </div>
            {err && <p className="text-[12px] text-destructive mt-2 ml-1.5">{err}</p>}
            <button
              type="button"
              onClick={submitPassword}
              disabled={loading || !password}
              className="btn-main mt-5"
            >
              {loading && <Loader2 className="w-5 h-5 animate-spin" />}
              Sign in
            </button>
            <button
              type="button"
              onClick={() => setUsePassword(false)}
              className="w-full text-center text-[12.5px] text-muted-foreground hover:text-foreground mt-3"
            >
              ← back to MPIN
            </button>
          </div>
        )}
        <a
          href="/"
          className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mt-5 transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> back to daily app
        </a>
      </div>
    </div>
  );
}
