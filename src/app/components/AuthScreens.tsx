"use client";

/**
 * AuthScreens v4 — every pre-chat screen for the daily app:
 *   landing (login) · signup · signup-otp · forgot · forgot-otp
 *   mpin-setup · unlock · mpin-reset
 *
 * v4 visual language: quiet gradient canvas (no green band), squircle
 * brand chip, filled composer-style inputs with leading icons, 22px
 * floating cards, display type (Plus Jakarta Sans). The unlock screen
 * is ONE centered column — brand → greeting → dots → keypad — with
 * zero dead zones.
 *
 * No <form> elements anywhere (pre-hydration native submits caused the
 * "login twice" page-refresh bug — Enter is handled explicitly instead).
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Loader2, Mail, KeyRound, Lock, ArrowLeft, ShieldCheck, Eye, EyeOff, Delete } from "lucide-react";
import PinField from "./PinField";
import Keypad, { haptic } from "./Keypad";

export type AuthStage =
  | "landing"
  | "signup"
  | "signup-otp"
  | "forgot"
  | "forgot-otp"
  | "mpin-setup"
  | "unlock"
  | "mpin-reset";

export interface AuthedInfo {
  username: string;
  email: string;
  requiresMpinSetup: boolean;
}

interface AuthScreensProps {
  initialStage: AuthStage;
  /** Set when a daily session exists (server-rendered unlock). */
  rememberedEmail?: string | null;
  rememberedUsername?: string | null;
  onAuthed: (info: AuthedInfo) => void;
}

export const REMEMBER_KEY = "khata-remembered-email";
export const REMEMBER_NAME_KEY = "khata-remembered-name";

export function rememberEmail(email: string, username?: string) {
  try {
    localStorage.setItem(REMEMBER_KEY, email);
    if (username) localStorage.setItem(REMEMBER_NAME_KEY, username);
  } catch { /* private mode */ }
  invalidateRemembered();
}
export function forgetEmail() {
  try {
    localStorage.removeItem(REMEMBER_KEY);
    localStorage.removeItem(REMEMBER_NAME_KEY);
  } catch { /* private mode */ }
  invalidateRemembered();
}
export function getRemembered(): { email: string | null; username: string | null } {
  try {
    return {
      email: localStorage.getItem(REMEMBER_KEY),
      username: localStorage.getItem(REMEMBER_NAME_KEY),
    };
  } catch {
    return { email: null, username: null };
  }
}

/* ---- React-blessed external-store access (no hydration mismatch,
       no setState-in-effect) for the remembered identity ---- */
let rememberedCache: { email: string | null; username: string | null } | null = null;
const rememberedListeners = new Set<() => void>();
const EMPTY = { email: null as string | null, username: null as string | null };

function invalidateRemembered() {
  rememberedCache = null;
  rememberedListeners.forEach((l) => l());
}

let storeHydrated = false;

function snapshotRemembered() {
  if (typeof window !== "undefined") storeHydrated = true;
  if (!rememberedCache) rememberedCache = getRemembered();
  return rememberedCache;
}

function snapshotHydrated() {
  return storeHydrated;
}

/** Hydration-safe access to the remembered email (null during SSR/hydration). */
export function useRemembered() {
  return useSyncExternalStore(
    (cb) => {
      rememberedListeners.add(cb);
      return () => rememberedListeners.delete(cb);
    },
    snapshotRemembered,
    () => EMPTY
  );
}

/**
 * true once the remembered-email store has actually been read on the client
 * (false during SSR + hydration). Lets DailyApp latch its entry stage exactly
 * once instead of re-deriving it whenever rememberEmail() fires mid-flow.
 */
export function useRememberedHydrated() {
  return useSyncExternalStore(
    (cb) => {
      rememberedListeners.add(cb);
      return () => rememberedListeners.delete(cb);
    },
    snapshotHydrated,
    () => false
  );
}

const TERMS_URL = "/terms";
const PRIVACY_URL = "/privacy";

/** Friendly display name derived from a Gmail address (never leaks raw usernames). */
function displayNameOf(email: string | null | undefined, username?: string | null): string {
  const e = (email ?? "").trim().toLowerCase();
  if (e.endsWith("@gmail.com")) {
    const local = e.slice(0, -10).replace(/[^a-z0-9]/g, "");
    if (local) return local.charAt(0).toUpperCase() + local.slice(1);
  }
  if (username && /^[a-z][a-z0-9 _.-]{1,20}$/i.test(username)) {
    return username.charAt(0).toUpperCase() + username.slice(1);
  }
  return "";
}

/* ---------------- little shared pieces (v4) ---------------- */

/** Squircle brand chip with the ₹ mark — reads as a real app icon. */
function BrandMark({ size = 56, className = "" }: { size?: number; className?: string }) {
  return (
    <div
      className={`brand-chip flex items-center justify-center shrink-0 ${className}`}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.3) }}
      aria-hidden
    >
      <span
        className="font-display font-extrabold leading-none text-white"
        style={{ fontSize: Math.round(size * 0.52), marginBottom: Math.round(size * 0.04) }}
      >
        ₹
      </span>
    </div>
  );
}

function AuthFooter() {
  return (
    <footer className="pt-7 pb-3 text-center space-y-1.5">
      <div className="flex items-center justify-center gap-2.5 text-[12.5px]">
        <a
          href="https://payment.namansoni.in/payment"
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground/90 hover:text-[var(--primary)] transition-colors"
        >
          Donate
        </a>
        <span className="text-border">·</span>
        <a
          href="https://github.com/NamanSoni78"
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground/90 hover:text-[var(--primary)] transition-colors"
        >
          Made with <span className="align-middle">❤️</span> by Naman
        </a>
      </div>
      <p className="text-[12px] text-muted-foreground/70">
        <a href={TERMS_URL} className="hover:underline">Terms of Service</a>
        <span className="mx-1.5">·</span>
        <a href={PRIVACY_URL} className="hover:underline">Privacy Policy</a>
      </p>
    </footer>
  );
}

/**
 * AuthShell v4 — quiet gradient canvas, back chevron floating top-left,
 * content centered with consistent vertical rhythm.
 */
function AuthShell({
  title,
  subtitle,
  children,
  onBack,
  showFooter = false,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onBack?: () => void;
  showFooter?: boolean;
}) {
  return (
    <div className="min-h-dvh flex flex-col auth-canvas">
      <div className="safe-top" />
      {onBack && (
        <div className="max-w-sm w-full mx-auto px-4 pt-4">
          <button
            onClick={onBack}
            className="press -ml-2 h-10 w-10 flex items-center justify-center rounded-full text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
            aria-label="Back"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
        </div>
      )}
      <div className="flex-1 w-full max-w-sm mx-auto px-4 pt-6 pb-6 flex flex-col justify-center anim-stage-in">
        <div className="card-v4 p-7">
          <h1 className="display-2 text-foreground">{title}</h1>
          {subtitle && <p className="text-[13.5px] text-muted-foreground mt-1.5 leading-relaxed">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
        {showFooter && <AuthFooter />}
      </div>
    </div>
  );
}

/** Filled composer-style input with a leading icon (WhatsApp-grade). */
function Field({
  icon, label, value, onChange, type = "text", placeholder, autoComplete, inputMode, autoFocus, right, error,
}: {
  icon?: React.ReactNode;
  label?: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
  inputMode?: "text" | "email" | "numeric";
  autoFocus?: boolean;
  right?: React.ReactNode;
  error?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div>
      {label && <label className="block eyebrow mb-2 ml-1.5" onClick={() => ref.current?.focus()}>{label}</label>}
      <div className="field" data-error={!!error}>
        {icon && <span className="field-icon">{icon}</span>}
        <input
          ref={ref}
          type={type}
          value={value}
          placeholder={placeholder}
          autoComplete={autoComplete}
          inputMode={inputMode}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          spellCheck={false}
        />
        {right && <div className="pr-1">{right}</div>}
      </div>
    </div>
  );
}

function PrimaryButton({
  onClick, loading, disabled, children,
}: {
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => { haptic(10); onClick(); }}
      disabled={disabled || loading}
      className="btn-main"
    >
      {loading && <Loader2 className="w-5 h-5 animate-spin" />}
      {children}
    </button>
  );
}

/** Submit on Enter for text inputs (replaces native form submission). */
function useEnterSubmit(fn: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      fn();
    }
  };
}

/* ============================================================
   MAIN COMPONENT
   ============================================================ */

export default function AuthScreens({ initialStage, rememberedEmail, rememberedUsername, onAuthed }: AuthScreensProps) {
  const [stage, setStage] = useState<AuthStage>(initialStage);
  const [loading, setLoading] = useState(false);

  // shared fields
  const [email, setEmail] = useState(initialStage === "unlock" ? (rememberedEmail ?? "") : "");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  // signup
  const [confirmPassword, setConfirmPassword] = useState("");
  const [agreed, setAgreed] = useState(false);

  // otp
  const [otp, setOtp] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const [newPassword, setNewPassword] = useState("");

  // mpin
  const [pin4, setPin4] = useState("");
  const [pin4b, setPin4b] = useState("");
  const [pin6, setPin6] = useState("");
  const [pin6b, setPin6b] = useState("");
  const [showDashPin, setShowDashPin] = useState(false);
  const [unlockError, setUnlockError] = useState(false);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setInterval(() => setResendIn((s) => s - 1), 1000);
    return () => clearInterval(t);
  }, [resendIn]);

  const gmailHint = useMemo(() => {
    const e = email.trim().toLowerCase();
    if (!e) return null;
    if (!e.endsWith("@gmail.com")) return "Only @gmail.com works here";
    const local = e.slice(0, -10);
    if (local.includes(".") || local.includes("+")) return "No dots or +tags — use a plain address like rahul@gmail.com";
    return null;
  }, [email]);

  const passMatch = confirmPassword === "" || password === confirmPassword;

  const api = async (path: string, body: unknown) => {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, j } as const;
  };

  /* ---------------- LANDING / LOGIN ---------------- */
  const doLogin = async () => {
    if (loading) return;
    if (gmailHint) { toast.error(gmailHint); return; }
    if (!email.trim() || !password) { toast.error("Enter your Gmail and password"); return; }
    setLoading(true);
    const { ok, j } = await api("/api/auth/login", { email: email.trim(), password });
    setLoading(false);
    if (!ok) { toast.error(j.error ?? "Login failed"); return; }
    rememberEmail(email.trim().toLowerCase(), j.username);
    if (j.requiresMpinSetup) setStage("mpin-setup");
    else onAuthed({ username: j.username, email: j.email, requiresMpinSetup: false });
  };

  /* ---------------- SIGNUP ---------------- */
  const doSignup = async () => {
    if (loading) return;
    if (gmailHint) { toast.error(gmailHint); return; }
    if (password.length < 8) { toast.error("Password must be at least 8 characters"); return; }
    if (!passMatch) { toast.error("Passwords don't match"); return; }
    if (!agreed) { toast.error("Please agree to the Terms and Privacy Policy"); return; }
    setLoading(true);
    const { ok, j } = await api("/api/auth/signup", { email: email.trim(), password, agreed });
    setLoading(false);
    if (!ok) { toast.error(j.error ?? "Couldn't create your account"); return; }
    if (j.devCode) setDevCode(String(j.devCode));
    setOtp("");
    setResendIn(60);
    setStage("signup-otp");
  };

  const doVerifyOtp = async (code?: string) => {
    const c = code ?? otp;
    if (c.length !== 6) { toast.error("Enter the 6-digit code"); return; }
    if (loading) return;
    setLoading(true);
    const { ok, j } = await api("/api/auth/verify-otp", { email: email.trim(), code: c });
    setLoading(false);
    if (!ok) { toast.error(j.error ?? "Wrong code"); return; }
    rememberEmail(email.trim().toLowerCase(), j.username);
    toast.success(`Welcome, ${j.username}!`);
    if (j.requiresMpinSetup) setStage("mpin-setup");
    else onAuthed({ username: j.username, email: email.trim().toLowerCase(), requiresMpinSetup: false });
  };

  const doResend = async (purpose: "signup" | "forgot") => {
    if (resendIn > 0) return;
    const { ok, j } = await api("/api/auth/resend-otp", { email: email.trim(), purpose });
    if (!ok) { toast.error(j.error ?? "Couldn't resend"); return; }
    if (j.devCode) setDevCode(String(j.devCode));
    setResendIn(60);
    toast.success("New code sent");
  };

  /* ---------------- FORGOT PASSWORD ---------------- */
  const doForgot = async () => {
    if (loading) return;
    if (gmailHint || !email.trim()) { toast.error(gmailHint ?? "Enter your Gmail"); return; }
    setLoading(true);
    const { ok, j } = await api("/api/auth/forgot-password", { email: email.trim() });
    setLoading(false);
    if (!ok) { toast.error(j.error ?? "Couldn't send the code"); return; }
    if (j.devCode) setDevCode(String(j.devCode));
    setOtp("");
    setNewPassword("");
    setResendIn(60);
    setStage("forgot-otp");
    toast.success("If that Gmail has an account, a code is on its way");
  };

  const doResetPassword = async () => {
    if (loading) return;
    if (otp.length !== 6) { toast.error("Enter the 6-digit code"); return; }
    if (newPassword.length < 8) { toast.error("New password must be at least 8 characters"); return; }
    setLoading(true);
    const { ok, j } = await api("/api/auth/reset-password", { email: email.trim(), code: otp, newPassword });
    setLoading(false);
    if (!ok) { toast.error(j.error ?? "Couldn't reset the password"); return; }
    toast.success("Password changed — sign in with it now");
    setPassword("");
    setStage("landing");
  };

  /* ---------------- MPIN SETUP ---------------- */
  const doMpinSetup = async () => {
    if (loading) return;
    if (!/^\d{4}$/.test(pin4)) { toast.error("App MPIN is 4 digits"); return; }
    if (pin4 !== pin4b) { toast.error("App MPINs don't match"); return; }
    if (showDashPin) {
      if (!/^\d{6}$/.test(pin6)) { toast.error("Dashboard MPIN is 6 digits"); return; }
      if (pin6 !== pin6b) { toast.error("Dashboard MPINs don't match"); return; }
    }
    setLoading(true);
    const { ok, j } = await api("/api/auth/mpin?action=setup", {
      appMpin: pin4,
      dashboardMpin: showDashPin ? pin6 : undefined,
    });
    setLoading(false);
    if (!ok) { toast.error(j.error ?? "Couldn't save the MPIN"); return; }
    const r = getRemembered();
    onAuthed({ username: rememberedUsername ?? r.username ?? "", email: r.email ?? email, requiresMpinSetup: false });
  };

  /* ---------------- UNLOCK (returning user — keypad) ---------------- */
  const doUnlock = async (code?: string) => {
    const c = code ?? pin4;
    if (c.length !== 4) { toast.error("Enter your 4-digit MPIN"); return; }
    if (loading) return;
    const em = email.trim() || rememberedEmail || "";
    if (!em) { setStage("landing"); return; }
    setLoading(true);
    const { ok, j } = await api("/api/auth/mpin?action=unlock", { email: em, mpin: c });
    setLoading(false);
    if (!ok) {
      toast.error(j.error ?? "Wrong MPIN");
      haptic(60);
      setUnlockError(true);
      setTimeout(() => { setUnlockError(false); setPin4(""); }, 480);
      if (j.status === 423 || (j.error ?? "").includes("locked")) setStage("mpin-reset");
      return;
    }
    rememberEmail(em, j.username);
    onAuthed({ username: j.username, email: j.email ?? em, requiresMpinSetup: false });
  };

  /** Keypad digit → append; auto-submit at 4. Functional update so
      rapid taps in one React batch can never drop digits. */
  const unlockDigit = (d: string) => {
    if (loading) return;
    setPin4((prev) => {
      const next = (prev + d).slice(0, 4);
      if (next.length === 4) {
        // tiny delay so the user sees the last dot before the spinner
        setTimeout(() => doUnlock(next), 140);
      }
      return next;
    });
  };
  const unlockBackspace = () => setPin4((p) => p.slice(0, -1));

  /* ---------------- MPIN RESET (forgot MPIN) ---------------- */
  const doMpinReset = async () => {
    if (loading) return;
    if (gmailHint || !email.trim()) { toast.error(gmailHint ?? "Enter your Gmail"); return; }
    if (!password) { toast.error("Enter your password"); return; }
    if (!/^\d{4}$/.test(pin4)) { toast.error("App MPIN is 4 digits"); return; }
    if (pin4 !== pin4b) { toast.error("App MPINs don't match"); return; }
    if (showDashPin) {
      if (!/^\d{6}$/.test(pin6)) { toast.error("Dashboard MPIN is 6 digits"); return; }
      if (pin6 !== pin6b) { toast.error("Dashboard MPINs don't match"); return; }
    }
    setLoading(true);
    const { ok, j } = await api("/api/auth/mpin?action=reset", {
      email: email.trim(),
      password,
      appMpin: pin4,
      dashboardMpin: showDashPin ? pin6 : undefined,
    });
    setLoading(false);
    if (!ok) { toast.error(j.error ?? "Couldn't reset the MPIN"); return; }
    rememberEmail(email.trim().toLowerCase(), j.username);
    toast.success("MPIN reset — you're in");
    onAuthed({ username: j.username, email: j.email ?? email, requiresMpinSetup: false });
  };

  const enterLogin = useEnterSubmit(doLogin);
  const enterSignup = useEnterSubmit(doSignup);
  const enterForgot = useEnterSubmit(doForgot);
  const enterResetPw = useEnterSubmit(doResetPassword);
  const enterMpinReset = useEnterSubmit(doMpinReset);

  const eyeBtn = (
    <button
      type="button"
      onClick={() => setShowPassword((s) => !s)}
      className="press h-9 w-9 flex items-center justify-center text-muted-foreground"
      aria-label={showPassword ? "Hide password" : "Show password"}
    >
      {showPassword ? <EyeOff className="w-[18px] h-[18px]" /> : <Eye className="w-[18px] h-[18px]" />}
    </button>
  );

  /* ============================================================
     RENDER
     ============================================================ */

  if (stage === "landing") {
    return (
      <div className="min-h-dvh flex flex-col auth-canvas">
        <div className="safe-top" />
        <div className="flex-1 w-full max-w-sm mx-auto px-4 pt-[7vh] pb-4 flex flex-col">

          {/* Brand hero */}
          <div className="text-center anim-fade-up">
            <div className="inline-block anim-pop-in">
              <BrandMark size={68} />
            </div>
            <h1 className="display-1 text-foreground mt-4">Khata</h1>
            <p className="text-[14.5px] text-muted-foreground mt-1.5 leading-relaxed max-w-[300px] mx-auto">
              Your daily money diary — tell it what you spent, sent or saved.
            </p>
          </div>

          {/* Card */}
          <div className="card-v4 p-7 mt-7 anim-fade-up-d1">
            <h2 className="display-2 text-foreground">Sign in</h2>
            <p className="text-[13px] text-muted-foreground mt-1">Use your Gmail and password</p>
            <div className="mt-5 space-y-3">
              <div onKeyDown={enterLogin}>
                <Field
                  icon={<Mail />}
                  label="Gmail"
                  value={email}
                  onChange={(v) => setEmail(v)}
                  type="email"
                  inputMode="email"
                  autoComplete="username"
                  placeholder="rahul@gmail.com"
                  autoFocus
                  error={!!gmailHint && !!email}
                />
              </div>
              <div onKeyDown={enterLogin}>
                <Field
                  icon={<KeyRound />}
                  label="Password"
                  value={password}
                  onChange={(v) => setPassword(v)}
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="Your password"
                  right={eyeBtn}
                />
              </div>
              {gmailHint && email && (
                <p className="text-[12px] text-destructive ml-1.5 -mt-0.5">{gmailHint}</p>
              )}
              <div className="pt-1.5">
                <PrimaryButton onClick={doLogin} loading={loading}>Sign in</PrimaryButton>
              </div>
              <button
                type="button"
                onClick={() => { setStage("forgot"); }}
                className="w-full text-center text-[13px] font-medium text-[var(--primary)] hover:underline py-1"
              >
                Forgot password?
              </button>
              <div className="flex items-center gap-3 pt-1">
                <div className="flex-1 h-px bg-border" />
                <span className="eyebrow">New here</span>
                <div className="flex-1 h-px bg-border" />
              </div>
              <button
                type="button"
                onClick={() => { setStage("signup"); setConfirmPassword(""); setAgreed(false); }}
                className="btn-outline"
              >
                <Mail className="w-[18px] h-[18px]" /> Create account
              </button>
            </div>
          </div>

          <AuthFooter />
        </div>
      </div>
    );
  }

  if (stage === "signup") {
    return (
      <AuthShell
        title="Create account"
        subtitle="Gmail only — we'll send a code to verify it's yours"
        onBack={() => setStage("landing")}
      >
        <div className="space-y-3">
          <div onKeyDown={enterSignup}>
            <Field
              icon={<Mail />}
              label="Gmail"
              value={email}
              onChange={(v) => setEmail(v)}
              type="email"
              inputMode="email"
              autoComplete="username"
              placeholder="rahul@gmail.com"
              autoFocus
              error={!!gmailHint && !!email}
            />
          </div>
          <Field
            icon={<KeyRound />}
            label="Password (min 8 chars)"
            value={password}
            onChange={(v) => setPassword(v)}
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            placeholder="Create a password"
            right={eyeBtn}
          />
          <div onKeyDown={enterSignup}>
            <Field
              icon={<KeyRound />}
              label="Confirm password"
              value={confirmPassword}
              onChange={(v) => setConfirmPassword(v)}
              type="password"
              autoComplete="new-password"
              placeholder="Repeat it"
            />
          </div>
          {(gmailHint && email) && (
            <p className="text-[12px] text-destructive ml-1.5">{gmailHint}</p>
          )}
          {confirmPassword && !passMatch && (
            <p className="text-[12px] text-destructive ml-1.5">Passwords don&apos;t match</p>
          )}

          <label className="flex items-start gap-3 pt-1.5 cursor-pointer rounded-xl p-1 -m-1">
            <span className="relative inline-flex items-center justify-center mt-0.5 w-[22px] h-[22px] rounded-[7px] border-2 transition-colors shrink-0"
              style={{ borderColor: agreed ? "var(--primary)" : "var(--input)" }}>
              {agreed && (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="anim-pop-in">
                  <path d="M2.5 6.2 5 8.5 9.5 3.5" stroke="var(--primary)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                className="absolute inset-0 opacity-0 cursor-pointer"
              />
            </span>
            <span className="text-[12.5px] leading-relaxed text-muted-foreground">
              I agree to the{" "}
              <a href={TERMS_URL} className="text-[var(--primary)] font-medium underline underline-offset-2">Terms of Service</a>{" "}
              and{" "}
              <a href={PRIVACY_URL} className="text-[var(--primary)] font-medium underline underline-offset-2">Privacy Policy</a>.
            </span>
          </label>

          <div className="pt-1.5">
            <PrimaryButton onClick={doSignup} loading={loading}>Send verification code</PrimaryButton>
          </div>
        </div>
      </AuthShell>
    );
  }

  if (stage === "signup-otp" || stage === "forgot-otp") {
    const isForgot = stage === "forgot-otp";
    return (
      <AuthShell
        title={isForgot ? "Reset password" : "Verify your Gmail"}
        subtitle={`Code sent to ${email || "your Gmail"} — expires in 10 minutes`}
        onBack={() => setStage(isForgot ? "landing" : "signup")}
      >
        <div className="space-y-4">
          {devCode && (
            <div className="rounded-2xl bg-[var(--primary)]/10 border border-[var(--primary)]/25 px-4 py-3 text-[12.5px] text-foreground">
              <span className="font-semibold">Dev mode:</span> email isn&apos;t configured — your code is{" "}
              <span className="font-mono font-bold tracking-[0.18em] text-[14px]">{devCode}</span>
            </div>
          )}
          <PinField
            length={6}
            value={otp}
            onChange={setOtp}
            secret={false}
            autoFocus
            disabled={loading}
            onComplete={(v) => (isForgot ? undefined : doVerifyOtp(v))}
          />
          {isForgot && (
            <Field
              icon={<KeyRound />}
              label="New password (min 8 chars)"
              value={newPassword}
              onChange={(v) => setNewPassword(v)}
              type="password"
              autoComplete="new-password"
              placeholder="Create a new password"
            />
          )}
          {isForgot ? (
            <div onKeyDown={enterResetPw} className="pt-1">
              <PrimaryButton onClick={doResetPassword} loading={loading}>Set new password</PrimaryButton>
            </div>
          ) : (
            <div className="pt-1">
              <PrimaryButton onClick={() => doVerifyOtp()} loading={loading}>Verify</PrimaryButton>
            </div>
          )}
          <div className="flex items-center justify-center gap-2 text-[12.5px] pt-1">
            {resendIn > 0 ? (
              <span className="text-muted-foreground tnum">Resend code in {resendIn}s</span>
            ) : (
              <button
                type="button"
                onClick={() => doResend(isForgot ? "forgot" : "signup")}
                className="text-[var(--primary)] font-medium hover:underline"
              >
                Resend code
              </button>
            )}
            <span className="text-border">·</span>
            <button
              type="button"
              onClick={() => setStage(isForgot ? "landing" : "signup")}
              className="text-muted-foreground hover:underline"
            >
              Wrong email?
            </button>
          </div>
        </div>
      </AuthShell>
    );
  }

  if (stage === "forgot") {
    return (
      <AuthShell
        title="Forgot password"
        subtitle="We'll send a 6-digit code to your Gmail"
        onBack={() => setStage("landing")}
      >
        <div className="space-y-4">
          <div onKeyDown={enterForgot}>
            <Field
              icon={<Mail />}
              label="Your Gmail"
              value={email}
              onChange={(v) => setEmail(v)}
              type="email"
              inputMode="email"
              autoComplete="username"
              placeholder="rahul@gmail.com"
              autoFocus
              error={!!gmailHint && !!email}
            />
          </div>
          {gmailHint && email && (
            <p className="text-[12px] text-destructive ml-1.5">{gmailHint}</p>
          )}
          <div className="pt-1">
            <PrimaryButton onClick={doForgot} loading={loading}>Send code</PrimaryButton>
          </div>
        </div>
      </AuthShell>
    );
  }

  if (stage === "mpin-setup") {
    return (
      <AuthShell
        title="Set your MPINs"
        subtitle="Quick codes so you never type your password on this phone again"
      >
        <div className="space-y-6">
          <div>
            <p className="text-[13px] font-semibold text-foreground flex items-center gap-2 mb-3 ml-0.5">
              <Lock className="w-4 h-4 text-[var(--primary)]" /> App MPIN
              <span className="text-muted-foreground font-normal text-[12px]">— 4 digits, opens Khata</span>
            </p>
            <PinField length={4} value={pin4} onChange={setPin4} autoFocus disabled={loading} />
            <div className="mt-2.5">
              <PinField length={4} value={pin4b} onChange={setPin4b} disabled={loading} />
            </div>
            {pin4b && pin4 !== pin4b && (
              <p className="text-[12px] text-destructive text-center mt-2">MPINs don&apos;t match</p>
            )}
          </div>

          {!showDashPin ? (
            <button
              type="button"
              onClick={() => setShowDashPin(true)}
              className="w-full text-[12.5px] font-medium text-[var(--primary)] hover:underline text-center py-1"
            >
              + Also set a 6-digit MPIN for the dashboard (recommended)
            </button>
          ) : (
            <div className="pt-1 border-t border-border">
              <p className="text-[13px] font-semibold text-foreground flex items-center gap-2 mb-3 mt-1 ml-0.5">
                <ShieldCheck className="w-4 h-4 text-[var(--primary)]" /> Dashboard MPIN
                <span className="text-muted-foreground font-normal text-[12px]">— 6 digits, unlocks insights</span>
              </p>
              <PinField length={6} value={pin6} onChange={setPin6} disabled={loading} />
              <div className="mt-2.5">
                <PinField length={6} value={pin6b} onChange={setPin6b} disabled={loading} />
              </div>
              {pin6b && pin6 !== pin6b && (
                <p className="text-[12px] text-destructive text-center mt-2">MPINs don&apos;t match</p>
              )}
            </div>
          )}

          <PrimaryButton onClick={doMpinSetup} loading={loading}>Save MPINs</PrimaryButton>
          <p className="text-[11.5px] text-muted-foreground text-center leading-relaxed -mt-2.5">
            Forgot them later? Reset with your Gmail + password.
          </p>
        </div>
      </AuthShell>
    );
  }

  if (stage === "unlock") {
    const name = displayNameOf(email || rememberedEmail, rememberedUsername);
    return (
      <div className="min-h-dvh flex flex-col auth-canvas">
        <div className="safe-top" />
        <div className="flex-1 w-full max-w-sm mx-auto px-4 pt-[6vh] pb-3 flex flex-col items-center anim-fade-in">

          {/* Brand + greeting — one tight column, zero dead zones */}
          <div className="flex flex-col items-center text-center anim-fade-up">
            <BrandMark size={56} className={unlockError ? "anim-shake" : ""} />
            <h1 className="display-2 text-foreground mt-4">
              {loading ? "Checking…" : unlockError ? "Wrong MPIN" : name ? `Welcome back, ${name}` : "Welcome back"}
            </h1>
            <p className="text-[13px] text-muted-foreground mt-1">
              {email || rememberedEmail || "Enter your MPIN to continue"}
            </p>
          </div>

          {/* MPIN dots — plain, clean, keypad-driven */}
          <div className={`mt-8 flex items-center justify-center gap-[18px] h-8 ${unlockError ? "anim-shake" : ""}`}>
            {Array.from({ length: 4 }).map((_, i) => {
              const filled = i < pin4.length;
              const isActive = i === pin4.length && !loading;
              return (
                <div key={i} className="w-[13px] h-[13px] flex items-center justify-center">
                  {filled ? (
                    <span
                      className={`block w-[13px] h-[13px] rounded-full anim-pop-in ${unlockError ? "bg-destructive" : "bg-foreground"}`}
                      key={pin4[i] + i}
                    />
                  ) : isActive ? (
                    <span className="block w-[13px] h-[13px] rounded-full border-[2.5px] border-[var(--primary)] anim-breathe" />
                  ) : (
                    <span className="block w-[13px] h-[13px] rounded-full border-[2px] border-muted-foreground/40" />
                  )}
                </div>
              );
            })}
          </div>

          {/* Keypad follows immediately — 32px gap, no void */}
          <div className="mt-8 w-full anim-fade-up-d1">
            <Keypad
              onDigit={unlockDigit}
              onBackspace={unlockBackspace}
              disabled={loading}
              footer={
                <div className="flex items-center justify-center gap-2.5 text-[12.5px] pt-1">
                  <button
                    type="button"
                    onClick={() => { setPin4(""); setPin4b(""); setPin6(""); setPin6b(""); setPassword(""); setShowDashPin(false); setStage("mpin-reset"); }}
                    className="text-[var(--primary)] font-medium hover:underline"
                  >
                    Forgot MPIN?
                  </button>
                  <span className="text-border">·</span>
                  <button
                    type="button"
                    onClick={async () => {
                      forgetEmail();
                      await fetch("/api/auth/logout", { method: "POST" });
                      setEmail(""); setPin4("");
                      setStage("landing");
                    }}
                    className="text-muted-foreground hover:underline"
                  >
                    Different account
                  </button>
                </div>
              }
            />
          </div>
        </div>
      </div>
    );
  }

  if (stage === "mpin-reset") {
    return (
      <AuthShell
        title="Reset your MPINs"
        subtitle="Confirm it's you with Gmail + password, then pick new codes"
        onBack={() => setStage("unlock")}
      >
        <div className="space-y-3.5">
          <Field
            icon={<Mail />}
            label="Gmail"
            value={email || rememberedEmail || ""}
            onChange={setEmail}
            type="email"
            inputMode="email"
            autoComplete="username"
            placeholder="rahul@gmail.com"
            autoFocus
            error={!!gmailHint && !!email}
          />
          <Field
            icon={<KeyRound />}
            label="Password"
            value={password}
            onChange={(v) => setPassword(v)}
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            placeholder="Your password"
            right={eyeBtn}
          />
          {(gmailHint && email) && (
            <p className="text-[12px] text-destructive ml-1.5">{gmailHint}</p>
          )}
          <div className="pt-2 space-y-2.5">
            <p className="eyebrow ml-1.5">New app MPIN · 4 digits</p>
            <PinField length={4} value={pin4} onChange={setPin4} disabled={loading} />
            <div className="mt-2"><PinField length={4} value={pin4b} onChange={setPin4b} disabled={loading} /></div>
          </div>
          {!showDashPin ? (
            <button
              type="button"
              onClick={() => setShowDashPin(true)}
              className="w-full text-[12.5px] font-medium text-[var(--primary)] hover:underline text-center py-1"
            >
              + Also set a new 6-digit dashboard MPIN
            </button>
          ) : (
            <div className="pt-1 space-y-2.5">
              <p className="eyebrow ml-1.5">New dashboard MPIN · 6 digits</p>
              <PinField length={6} value={pin6} onChange={setPin6} disabled={loading} />
              <div className="mt-2"><PinField length={6} value={pin6b} onChange={setPin6b} disabled={loading} /></div>
            </div>
          )}
          <div onKeyDown={enterMpinReset} className="pt-1">
            <PrimaryButton onClick={doMpinReset} loading={loading}>Reset &amp; continue</PrimaryButton>
          </div>
        </div>
      </AuthShell>
    );
  }

  return null;
}
