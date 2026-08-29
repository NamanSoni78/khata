"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import {
  Mic, MicOff, Send, LogOut, Loader2, Lock, KeyRound, Paperclip,
  Fingerprint, Settings as SettingsIcon, Trash2, Plus, Moon, Sun,
  BarChart3, WifiOff, CheckCheck, Clock3, ChevronDown, X,
} from "lucide-react";

type Stage = "login" | "mpin-setup" | "unlock" | "chat";

interface Props {
  initialStage: Stage;
  username?: string;
  userId?: string;
}

interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: string;
  pending?: boolean;
  queued?: boolean;
}

interface Passkey {
  id: string;
  deviceType: string;
  createdAt: string;
  credentialIdShort: string;
}

const QUEUE_KEY = "khata-offline-queue";

function loadQueue(): string[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function saveQueue(q: string[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
}

export default function DailyApp({ initialStage, username }: Props) {
  const [stage, setStage] = useState<Stage>(initialStage);

  // Login state
  const [loginU, setLoginU] = useState("");
  const [loginP, setLoginP] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);

  // MPIN setup
  const [mpin, setMpin] = useState("");
  const [mpin2, setMpin2] = useState("");
  const [mpinLoading, setMpinLoading] = useState(false);

  // Unlock
  const [unlockMpin, setUnlockMpin] = useState("");
  const [unlockLoading, setUnlockLoading] = useState(false);
  const [webauthnUnlockLoading, setWebauthnUnlockLoading] = useState(false);
  const [hasWebauthn, setHasWebauthn] = useState(false);

  // Settings sheet
  const [showSettings, setShowSettings] = useState(false);
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [passkeyActionLoading, setPasskeyActionLoading] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);

  // Chat
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const [online, setOnline] = useState(true);
  const [chatUser, setChatUser] = useState(username);
  const [uploadingStatement, setUploadingStatement] = useState(false);
  const [pdfUploadEnabled, setPdfUploadEnabled] = useState(true);
  const [ocrEnabled, setOcrEnabled] = useState(false);
  const [queuedCount, setQueuedCount] = useState(0);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ===== Theme (icon visibility handled purely via CSS dark: variants) =====
  const toggleTheme = () => {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("khata-theme", next ? "dark" : "light");
    } catch { /* private mode */ }
  };

  // ===== Network status =====
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    setOnline(navigator.onLine);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  // ===== Load profile + chat history when entering chat =====
  useEffect(() => {
    if (stage !== "chat") return;
    let active = true;
    (async () => {
      const res = await fetch("/api/auth/me");
      if (!res.ok) return;
      const j = await res.json();
      if (!active || !j.authenticated) return;
      setChatUser(j.username);
      if (j.flags) {
        setPdfUploadEnabled(j.flags.pdfUpload !== false);
        setOcrEnabled(j.flags.ocr === true);
      }
      // Load persisted chat history so the conversation survives reloads
      try {
        const hres = await fetch("/api/chat?action=history&limit=60");
        if (hres.ok && active) {
          const hj = await hres.json();
          if (Array.isArray(hj.messages) && hj.messages.length > 0) {
            setMessages(
              hj.messages.map((m: any) => ({
                id: `h_${m.ts}_${Math.random().toString(36).slice(2, 6)}`,
                role: m.role,
                content: m.content,
                ts: m.ts,
              }))
            );
          }
        }
      } catch { /* history is best-effort */ }
      if (active) setHistoryLoaded(true);
    })();
    return () => { active = false; };
  }, [stage]);

  // ===== Offline queue: flush when back online =====
  const flushQueue = useCallback(async () => {
    const queue = loadQueue();
    if (queue.length === 0) return;
    setQueuedCount(queue.length);
    const remaining = [...queue];
    while (remaining.length > 0) {
      const text = remaining[0];
      setMessages((m) => [
        ...m,
        { id: `q_${Date.now()}`, role: "user", content: text, ts: new Date().toISOString() },
        { id: `qp_${Date.now()}`, role: "assistant", content: "", ts: new Date().toISOString(), pending: true },
      ]);
      try {
        const res = await fetch("/api/chat?action=daily", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text }),
        });
        const j = await res.json();
        setMessages((m) =>
          m.map((mm, i) =>
            i === m.length - 1
              ? { ...mm, content: res.ok ? j.reply : (j.error ?? "Couldn't send — will try again."), pending: false }
              : i === m.length - 2
                ? { ...mm, queued: false }
                : mm
          )
        );
        if (res.ok) {
          remaining.shift();
          saveQueue(remaining);
          setQueuedCount(remaining.length);
        } else {
          break; // still failing — keep the rest queued
        }
      } catch {
        break;
      }
    }
    setSending(false);
  }, []);

  useEffect(() => {
    if (stage === "chat" && online && historyLoaded) {
      const queue = loadQueue();
      if (queue.length > 0) {
        setQueuedCount(queue.length);
        setSending(true);
        flushQueue();
      }
    }
  }, [stage, online, historyLoaded, flushQueue]);

  // ===== Auto-scroll =====
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ===== Auto-resize textarea =====
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 128) + "px";
  }, [input]);

  // ============================================================
  //  AUTH ACTIONS
  // ============================================================
  const doLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: loginU, password: loginP }),
      });
      const j = await res.json();
      if (!res.ok) {
        toast.error(j.error ?? "Login failed");
        return;
      }
      toast.success(`Welcome, ${loginU}`);
      if (j.requiresMpinSetup) setStage("mpin-setup");
      else setStage("unlock");
    } catch (e: any) {
      toast.error(e?.message ?? "Login failed");
    }
    setLoginLoading(false);
  };

  const doMpinSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{4,6}$/.test(mpin)) {
      toast.error("MPIN must be 4-6 digits");
      return;
    }
    if (mpin !== mpin2) {
      toast.error("MPINs don't match");
      return;
    }
    setMpinLoading(true);
    try {
      const res = await fetch("/api/auth/mpin?action=setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mpin }),
      });
      const j = await res.json();
      if (!res.ok) {
        toast.error(j.error ?? "MPIN setup failed");
        return;
      }
      toast.success("MPIN set — you're all set");
      setStage("chat");
    } finally {
      setMpinLoading(false);
    }
  };

  const doUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{4,6}$/.test(unlockMpin)) {
      toast.error("MPIN must be 4-6 digits");
      return;
    }
    setUnlockLoading(true);
    try {
      const res = await fetch("/api/auth/mpin?action=verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mpin: unlockMpin }),
      });
      const j = await res.json();
      if (!res.ok) {
        toast.error(j.error ?? "Invalid MPIN");
        return;
      }
      setStage("chat");
    } finally {
      setUnlockLoading(false);
    }
  };

  const unlockWithWebauthn = async () => {
    setWebauthnUnlockLoading(true);
    try {
      const beginRes = await fetch("/api/auth/webauthn/login/begin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: chatUser ?? undefined }),
      });
      const beginOpts = await beginRes.json();
      if (!beginRes.ok) {
        toast.error(beginOpts.error ?? "Couldn't start fingerprint unlock");
        return;
      }
      const assertion = await startAuthentication({ optionsJSON: beginOpts });
      const finishRes = await fetch("/api/auth/webauthn/login/finish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: chatUser, assertion }),
      });
      const finishJ = await finishRes.json();
      if (!finishRes.ok) {
        toast.error(finishJ.error ?? "Fingerprint verification failed");
        return;
      }
      toast.success(`Welcome back, ${finishJ.username}`);
      setStage("chat");
    } catch (e: any) {
      if (e?.name !== "NotAllowedError") {
        toast.error(e?.message ?? "Fingerprint unlock failed");
      }
    } finally {
      setWebauthnUnlockLoading(false);
    }
  };

  // ============================================================
  //  PASSKEYS + NOTIFICATIONS
  // ============================================================
  const loadPasskeys = async () => {
    const res = await fetch("/api/auth/me");
    if (!res.ok) return;
    const j = await res.json();
    if (j.passkeys) setPasskeys(j.passkeys);
  };

  const loadPushSettings = async () => {
    const res = await fetch("/api/notifications/vapid-public-key");
    if (!res.ok) return;
    const j = await res.json();
    setPushEnabled(j.enabled === true);
    if (j.enabled) {
      try {
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        setPushSubscribed(!!existing);
      } catch { /* SW not ready */ }
    }
  };

  const subscribeToPush = async () => {
    setPushLoading(true);
    try {
      const res = await fetch("/api/notifications/vapid-public-key");
      const j = await res.json();
      if (!j.enabled) {
        toast.error("Notifications aren't available right now");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(j.publicKey),
      });
      const postRes = await fetch("/api/notifications/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub),
      });
      if (postRes.ok) {
        toast.success("Notifications on");
        setPushSubscribed(true);
      } else {
        toast.error("Couldn't enable notifications");
      }
    } catch (e: any) {
      if (e?.name === "NotAllowedError") {
        toast.error("Notification permission denied — enable it in browser settings");
      } else {
        toast.error(e?.message ?? "Couldn't enable notifications");
      }
    } finally {
      setPushLoading(false);
    }
  };

  const sendTestNotification = async () => {
    setPushLoading(true);
    try {
      const res = await fetch("/api/notifications/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Test notification from Khata" }),
      });
      const j = await res.json();
      if (res.ok) toast.success(`Test sent to ${j.sent} device(s)`);
      else toast.error(j.error ?? "Couldn't send test");
    } finally {
      setPushLoading(false);
    }
  };

  function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = atob(base64);
    const arr = new Uint8Array(new ArrayBuffer(rawData.length));
    for (let i = 0; i < rawData.length; i++) arr[i] = rawData.charCodeAt(i);
    return arr;
  }

  const registerPasskey = async () => {
    setPasskeyActionLoading(true);
    try {
      const beginRes = await fetch("/api/auth/webauthn/register/begin", { method: "POST" });
      const beginOpts = await beginRes.json();
      if (!beginRes.ok) {
        toast.error(beginOpts.error ?? "Couldn't start registration");
        return;
      }
      const credential = await startRegistration({ optionsJSON: beginOpts });
      const finishRes = await fetch("/api/auth/webauthn/register/finish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          credential,
          deviceType:
            navigator.userAgent.includes("iPhone") || navigator.userAgent.includes("iPad")
              ? "iOS"
              : navigator.userAgent.includes("Mac")
                ? "macOS"
                : navigator.userAgent.includes("Android")
                  ? "Android"
                  : "Other",
        }),
      });
      const finishJ = await finishRes.json();
      if (!finishRes.ok) {
        toast.error(finishJ.error ?? "Registration failed");
        return;
      }
      toast.success("Passkey added");
      await loadPasskeys();
    } catch (e: any) {
      if (e?.name !== "NotAllowedError") {
        toast.error(e?.message ?? "Registration failed");
      }
    } finally {
      setPasskeyActionLoading(false);
    }
  };

  const deletePasskey = async (id: string) => {
    if (!confirm("Remove this passkey?")) return;
    setPasskeyActionLoading(true);
    try {
      const res = await fetch("/api/auth/webauthn/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentialId: id }),
      });
      if (res.ok) {
        toast.success("Passkey removed");
        await loadPasskeys();
      } else {
        const e = await res.json();
        toast.error(e.error ?? "Couldn't remove passkey");
      }
    } finally {
      setPasskeyActionLoading(false);
    }
  };

  // ============================================================
  //  SPEECH TO TEXT
  // ============================================================
  const startListening = () => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      toast.error("Voice input isn't supported on this device");
      return;
    }
    const rec = new SpeechRecognition();
    rec.lang = "en-IN";
    rec.continuous = false;
    rec.interimResults = true;
    rec.onresult = (e: any) => {
      let final = "";
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) final += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      setInput(final + interim);
    };
    rec.onerror = (e: any) => {
      if (e.error !== "no-speech") toast.error(`Voice error: ${e.error}`);
      setListening(false);
    };
    rec.onend = () => setListening(false);
    rec.start();
    recognitionRef.current = rec;
    setListening(true);
  };
  const stopListening = () => {
    recognitionRef.current?.stop();
    setListening(false);
  };

  // ============================================================
  //  SEND MESSAGE (with offline queue)
  // ============================================================
  const sendMessage = async () => {
    const text = input.trim();
    if (!text || sending) return;

    if (!online) {
      // Queue it — will auto-send when back online
      const q = loadQueue();
      q.push(text);
      saveQueue(q);
      setQueuedCount(q.length);
      setMessages((m) => [
        ...m,
        { id: `q_${Date.now()}`, role: "user", content: text, ts: new Date().toISOString(), queued: true },
      ]);
      setInput("");
      toast.info("Offline — saved. It'll send when you're back online.");
      return;
    }

    setMessages((m) => [
      ...m,
      { id: `u_${Date.now()}`, role: "user", content: text, ts: new Date().toISOString() },
      { id: `a_${Date.now()}`, role: "assistant", content: "", ts: new Date().toISOString(), pending: true },
    ]);
    setInput("");
    setSending(true);
    try {
      const res = await fetch("/api/chat?action=daily", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const j = await res.json();
      if (!res.ok) {
        setMessages((m) => m.map((mm, i) => i === m.length - 1 ? { ...mm, content: j.error ?? "Something went wrong", pending: false } : mm));
      } else {
        setMessages((m) =>
          m.map((mm, i) =>
            i === m.length - 1
              ? { ...mm, content: j.reply, pending: false }
              : mm
          )
        );
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Network error");
      setMessages((m) => m.slice(0, -1));
    } finally {
      setSending(false);
    }
  };

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    location.reload();
  };

  // ============================================================
  //  STATEMENT UPLOAD
  // ============================================================
  const handleStatementUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const isPdf = file.type === "application/pdf";
    const isImage = file.type === "image/jpeg" || file.type === "image/png" || file.type === "image/webp";

    if (isPdf && !pdfUploadEnabled) {
      toast.error("PDF uploads are currently disabled");
      return;
    }
    if (isImage && !ocrEnabled) {
      toast.error("Image uploads aren't enabled yet");
      return;
    }
    if (!isPdf && !isImage) {
      toast.error("Please choose a PDF or image file");
      return;
    }

    setUploadingStatement(true);
    setMessages((m) => [
      ...m,
      { id: `u_${Date.now()}`, role: "user", content: `Uploaded ${isImage ? "image" : "statement"}: ${file.name}`, ts: new Date().toISOString() },
      { id: `a_${Date.now()}`, role: "assistant", content: "", ts: new Date().toISOString(), pending: true },
    ]);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/chat/upload-statement", {
        method: "POST",
        body: fd,
      });
      const j = await res.json();
      if (!res.ok) {
        toast.error(j.error ?? "Upload failed");
        setMessages((m) => m.slice(0, -1));
        return;
      }
      let detail = j.summary;
      if (j.duplicates_for_review?.length > 0) {
        detail += `\n\n${j.duplicates_for_review.length} possible duplicate(s) found:`;
        for (const d of j.duplicates_for_review.slice(0, 5)) {
          detail += `\n• Rs ${d.extracted.amount} on ${d.extracted.date} — similar to an existing Rs ${d.existing_amount} on ${d.existing_timestamp?.slice(0, 10)}`;
        }
        if (j.duplicates_for_review.length > 5) detail += `\n...and ${j.duplicates_for_review.length - 5} more`;
      }
      setMessages((m) =>
        m.map((mm, i) =>
          i === m.length - 1 ? { ...mm, content: detail, pending: false } : mm
        )
      );
    } catch (e: any) {
      toast.error(e?.message ?? "Upload failed");
      setMessages((m) => m.slice(0, -1));
    } finally {
      setUploadingStatement(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // ============================================================
  //  RENDER — shared shell
  // ============================================================
  const EXAMPLES = [
    "aaj 20 rs rapido ke kharch hue",
    "2000 sip mein dale",
    "shorya ne 30 hazar diye IPO ke liye SBI mein",
  ];

  if (stage === "login") {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-background">
        <div className="w-full max-w-sm anim-fade-up">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary text-primary-foreground mb-4 shadow-sm">
              <svg width="26" height="26" viewBox="0 0 30 30" fill="none">
                <path d="M9 8h12M9 11.5h12M11.5 8c0 6.5 1.3 8 5.2 9.3M18.5 8c0 6.5-1.3 8-5.2 9.3M15 17.3v4.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Khata</h1>
            <p className="text-muted-foreground text-sm mt-1.5">Your daily money diary</p>
          </div>
          <form onSubmit={doLogin} className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5 ml-1">Username</label>
              <input
                autoFocus
                autoComplete="username"
                value={loginU}
                onChange={(e) => setLoginU(e.target.value)}
                className="w-full h-11 rounded-xl border border-input bg-card px-3.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring/50 focus:border-ring transition-shadow"
                placeholder="e.g. rahul"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5 ml-1">Password</label>
              <input
                type="password"
                autoComplete="current-password"
                value={loginP}
                onChange={(e) => setLoginP(e.target.value)}
                className="w-full h-11 rounded-xl border border-input bg-card px-3.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring/50 focus:border-ring transition-shadow"
                placeholder="••••••••"
              />
            </div>
            <button
              type="submit"
              disabled={loginLoading}
              className="press w-full h-11 rounded-xl bg-primary text-primary-foreground text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-60 hover:opacity-95 transition-opacity"
            >
              {loginLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Sign in
            </button>
          </form>
          <p className="text-xs text-muted-foreground/80 mt-6 text-center">
            Don&apos;t have an account? Ask your administrator to create one.
          </p>
        </div>
      </div>
    );
  }

  if (stage === "mpin-setup") {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-background">
        <div className="w-full max-w-sm anim-fade-up">
          <div className="text-center mb-6">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-accent text-accent-foreground mb-3">
              <KeyRound className="w-5 h-5" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">Set your MPIN</h1>
            <p className="text-muted-foreground text-sm mt-1.5">A 4–6 digit code for quick daily unlock</p>
          </div>
          <form onSubmit={doMpinSetup} className="space-y-3">
            <input
              type="password"
              inputMode="numeric"
              autoFocus
              placeholder="New MPIN"
              value={mpin}
              onChange={(e) => setMpin(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="w-full h-12 rounded-xl border border-input bg-card px-4 text-center text-xl tracking-[0.5em] text-foreground focus:outline-none focus:ring-2 focus:ring-ring/50 focus:border-ring transition-shadow"
            />
            <input
              type="password"
              inputMode="numeric"
              placeholder="Confirm MPIN"
              value={mpin2}
              onChange={(e) => setMpin2(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="w-full h-12 rounded-xl border border-input bg-card px-4 text-center text-xl tracking-[0.5em] text-foreground focus:outline-none focus:ring-2 focus:ring-ring/50 focus:border-ring transition-shadow"
            />
            <button
              type="submit"
              disabled={mpinLoading}
              className="press w-full h-11 rounded-xl bg-primary text-primary-foreground text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-60 hover:opacity-95 transition-opacity"
            >
              {mpinLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Save MPIN
            </button>
          </form>
          <p className="text-xs text-muted-foreground/80 mt-4 text-center">
            You can also add fingerprint unlock later from Settings.
          </p>
        </div>
      </div>
    );
  }

  if (stage === "unlock") {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-background">
        <div className="w-full max-w-sm anim-fade-up">
          <div className="text-center mb-6">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-accent text-accent-foreground mb-3">
              <Lock className="w-5 h-5" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">Welcome back{username ? `, ${username}` : ""}</h1>
            <p className="text-muted-foreground text-sm mt-1.5">Enter your MPIN to continue</p>
          </div>
          <form onSubmit={doUnlock} className="space-y-3">
            <input
              type="password"
              inputMode="numeric"
              autoFocus
              placeholder="MPIN"
              value={unlockMpin}
              onChange={(e) => setUnlockMpin(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="w-full h-12 rounded-xl border border-input bg-card px-4 text-center text-xl tracking-[0.5em] text-foreground focus:outline-none focus:ring-2 focus:ring-ring/50 focus:border-ring transition-shadow"
            />
            <button
              type="submit"
              disabled={unlockLoading}
              className="press w-full h-11 rounded-xl bg-primary text-primary-foreground text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-60 hover:opacity-95 transition-opacity"
            >
              {unlockLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Unlock
            </button>
          </form>
          {hasWebauthn && (
            <>
              <div className="flex items-center gap-3 mt-5">
                <div className="flex-1 h-px bg-border" />
                <span className="text-xs text-muted-foreground">or</span>
                <div className="flex-1 h-px bg-border" />
              </div>
              <button
                onClick={unlockWithWebauthn}
                disabled={webauthnUnlockLoading}
                className="press w-full h-11 mt-4 rounded-xl border border-input bg-card text-foreground text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-60 hover:bg-accent/60 transition-colors"
              >
                {webauthnUnlockLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Fingerprint className="w-4 h-4 text-primary" />
                )}
                Use fingerprint
              </button>
            </>
          )}
          <button
            onClick={logout}
            className="w-full text-xs text-muted-foreground hover:text-foreground mt-5 transition-colors"
          >
            Use a different account
          </button>
        </div>
      </div>
    );
  }

  // ============================================================
  //  CHAT STAGE
  // ============================================================
  return (
    <div className="h-dvh flex flex-col bg-background">
      {/* Header */}
      <header className="safe-top shrink-0 border-b border-border bg-background/90 backdrop-blur-sm">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-primary text-primary-foreground flex items-center justify-center shrink-0">
              <svg width="15" height="15" viewBox="0 0 30 30" fill="none">
                <path d="M9 8h12M9 11.5h12M11.5 8c0 6.5 1.3 8 5.2 9.3M18.5 8c0 6.5-1.3 8-5.2 9.3M15 17.3v4.4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div className="min-w-0">
              <p className="font-semibold text-sm text-foreground truncate leading-tight">{chatUser ?? "You"}</p>
              <p className="text-[11px] text-muted-foreground flex items-center gap-1 leading-tight">
                {online ? (
                  <>
                    <span className="w-1.5 h-1.5 rounded-full bg-success inline-block" />
                    online
                  </>
                ) : (
                  <>
                    <WifiOff className="w-3 h-3" />
                    offline{queuedCount > 0 ? ` · ${queuedCount} queued` : ""}
                  </>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-0.5">
            <a
              href="/dashboard"
              className="press h-9 px-3 rounded-xl flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
              title="Open dashboard"
            >
              <BarChart3 className="w-4 h-4" />
              <span className="hidden sm:inline">Dashboard</span>
            </a>
            <button
              onClick={toggleTheme}
              className="press h-9 w-9 rounded-xl flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
              title="Toggle theme"
            >
              <Moon className="w-4 h-4 dark:hidden" />
              <Sun className="w-4 h-4 hidden dark:block" />
            </button>
            <button
              onClick={async () => {
                await Promise.all([loadPasskeys(), loadPushSettings()]);
                setShowSettings(true);
              }}
              className="press h-9 w-9 rounded-xl flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
              title="Settings"
            >
              <SettingsIcon className="w-4 h-4" />
            </button>
            <button
              onClick={logout}
              className="press h-9 w-9 rounded-xl flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
              title="Sign out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Settings sheet */}
      {showSettings && (
        <div
          className="fixed inset-0 z-50 bg-foreground/30 backdrop-blur-[2px] flex items-end sm:items-center justify-center anim-fade-in"
          onClick={() => setShowSettings(false)}
        >
          <div
            className="bg-card border border-border rounded-t-3xl sm:rounded-3xl w-full sm:max-w-md max-h-[82vh] overflow-y-auto anim-sheet-in shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-card px-5 pt-4 pb-3 flex items-center justify-between border-b border-border">
              <div className="w-10" />
              <div className="absolute left-1/2 -translate-x-1/2 top-2 w-10 h-1 rounded-full bg-border sm:hidden" />
              <p className="font-semibold text-sm text-foreground">Settings</p>
              <button
                onClick={() => setShowSettings(false)}
                className="press h-8 w-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-6">
              {/* Appearance */}
              <div>
                <p className="text-sm font-medium text-foreground mb-1.5">Appearance</p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => { document.documentElement.classList.remove("dark"); try { localStorage.setItem("khata-theme", "light"); } catch {} }}
                    className="press h-10 rounded-xl border text-sm font-medium flex items-center justify-center gap-2 transition-colors border-primary bg-accent text-accent-foreground dark:border-input dark:bg-transparent dark:text-muted-foreground dark:hover:bg-accent/40"
                  >
                    <Sun className="w-4 h-4" /> Light
                  </button>
                  <button
                    onClick={() => { document.documentElement.classList.add("dark"); try { localStorage.setItem("khata-theme", "dark"); } catch {} }}
                    className="press h-10 rounded-xl border text-sm font-medium flex items-center justify-center gap-2 transition-colors border-input text-muted-foreground hover:bg-accent/40 dark:border-primary dark:bg-accent dark:text-accent-foreground"
                  >
                    <Moon className="w-4 h-4" /> Dark
                  </button>
                </div>
              </div>

              {/* Passkeys */}
              <div className="border-t border-border pt-5">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <p className="text-sm font-medium text-foreground flex items-center gap-1.5">
                      <Fingerprint className="w-4 h-4 text-primary" /> Passkeys
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">Fingerprint / Face ID for quick unlock</p>
                  </div>
                  <button
                    onClick={registerPasskey}
                    disabled={passkeyActionLoading}
                    className="press h-8 px-3 rounded-lg border border-input text-xs font-medium text-foreground flex items-center gap-1 hover:bg-accent/50 transition-colors disabled:opacity-60"
                  >
                    <Plus className="w-3 h-3" /> Add
                  </button>
                </div>
                {passkeys.length === 0 ? (
                  <p className="text-xs text-muted-foreground/80">No passkeys yet — add one to skip the MPIN.</p>
                ) : (
                  <div className="space-y-1.5">
                    {passkeys.map((pk) => (
                      <div
                        key={pk.id}
                        className="flex items-center justify-between p-2.5 bg-muted/60 border border-border rounded-xl text-xs"
                      >
                        <div>
                          <p className="font-medium text-foreground">{pk.deviceType}</p>
                          <p className="text-muted-foreground font-mono text-[10px]">{pk.credentialIdShort}</p>
                        </div>
                        <button
                          onClick={() => deletePasskey(pk.id)}
                          disabled={passkeyActionLoading}
                          className="press text-destructive/80 hover:text-destructive p-1.5 rounded-lg transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Notifications */}
              <div className="border-t border-border pt-5">
                <p className="text-sm font-medium text-foreground mb-1">Notifications</p>
                <p className="text-xs text-muted-foreground mb-3">
                  Gentle reminders to log your transactions, plus scheduled summaries.
                </p>
                {!pushEnabled ? (
                  <div className="text-xs text-muted-foreground/80 bg-muted/60 border border-border rounded-xl p-3">
                    Notifications aren&apos;t available on this deployment yet.
                  </div>
                ) : pushSubscribed ? (
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-success font-medium flex items-center gap-1.5">
                      <CheckCheck className="w-3.5 h-3.5" /> Enabled on this device
                    </span>
                    <button
                      onClick={sendTestNotification}
                      disabled={pushLoading}
                      className="press h-8 px-3 rounded-lg border border-input text-xs font-medium text-foreground hover:bg-accent/50 transition-colors disabled:opacity-60"
                    >
                      {pushLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : "Send test"}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={subscribeToPush}
                    disabled={pushLoading}
                    className="press h-9 px-4 rounded-xl bg-primary text-primary-foreground text-xs font-medium flex items-center gap-2 disabled:opacity-60"
                  >
                    {pushLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                    Enable notifications
                  </button>
                )}
                <p className="text-[11px] text-muted-foreground/70 mt-3">
                  Tip: you can also ask me things like &quot;remind me at 8pm daily&quot;.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Messages */}
      <main className="flex-1 overflow-y-auto" style={{ minHeight: 0 }}>
        <div className="max-w-2xl mx-auto px-4 py-4 space-y-2.5">
          {messages.length === 0 && (
            <div className="text-center py-10 anim-fade-up">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-accent text-accent-foreground mb-4">
                <svg width="22" height="22" viewBox="0 0 30 30" fill="none">
                  <path d="M9 8h12M9 11.5h12M11.5 8c0 6.5 1.3 8 5.2 9.3M18.5 8c0 6.5-1.3 8-5.2 9.3M15 17.3v4.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <p className="text-foreground font-medium">Hi{chatUser ? ` ${chatUser}` : ""} — what happened today?</p>
              <p className="text-muted-foreground text-sm mt-1.5">Tell me in any mix of English or Hindi.</p>
              <div className="mt-5 space-y-2 max-w-xs mx-auto">
                {EXAMPLES.map((ex, i) => (
                  <button
                    key={ex}
                    onClick={() => { setInput(ex); textareaRef.current?.focus(); }}
                    className={`press w-full text-left text-xs text-muted-foreground bg-card border border-border rounded-xl px-3.5 py-2.5 hover:border-ring/60 hover:text-foreground transition-colors anim-fade-up-d${i + 1}`}
                  >
                    &ldquo;{ex}&rdquo;
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground/70 mt-5 flex items-center justify-center gap-1.5">
                <Mic className="w-3 h-3" /> Tap the mic to speak instead
              </p>
            </div>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              className={`flex ${m.role === "user" ? "justify-end" : "justify-start"} anim-msg-in`}
            >
              <div
                className={`group max-w-[82%] sm:max-w-[75%] px-3.5 py-2.5 text-sm leading-relaxed ${
                  m.role === "user"
                    ? "bg-primary text-primary-foreground rounded-2xl rounded-br-md"
                    : "bg-card border border-border text-foreground rounded-2xl rounded-bl-md"
                }`}
              >
                {m.pending && !m.content ? (
                  <span className="inline-flex items-center gap-1.5 py-0.5">
                    <span className="typing-dot w-1.5 h-1.5 rounded-full bg-muted-foreground inline-block" />
                    <span className="typing-dot w-1.5 h-1.5 rounded-full bg-muted-foreground inline-block" />
                    <span className="typing-dot w-1.5 h-1.5 rounded-full bg-muted-foreground inline-block" />
                  </span>
                ) : (
                  <>
                    <span className="whitespace-pre-wrap break-words">{m.content}</span>
                    {m.queued && (
                      <span className="inline-flex items-center gap-1 text-[10px] opacity-80 mt-1 block">
                        <Clock3 className="w-3 h-3" /> queued
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      </main>

      {/* Input bar */}
      <footer className="shrink-0 border-t border-border bg-background/95 backdrop-blur-sm safe-bottom">
        <div className="max-w-2xl mx-auto px-3 py-2.5 flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept={(pdfUploadEnabled ? "application/pdf," : "") + (ocrEnabled ? "image/jpeg,image/png,image/webp" : "")}
            onChange={handleStatementUpload}
            className="hidden"
          />
          {(pdfUploadEnabled || ocrEnabled) && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingStatement}
              className="press shrink-0 w-11 h-11 rounded-2xl flex items-center justify-center bg-card border border-border text-muted-foreground hover:text-foreground hover:border-ring/50 transition-colors disabled:opacity-50"
              title={`Upload ${pdfUploadEnabled ? "bank statement PDF" : ""}${pdfUploadEnabled && ocrEnabled ? " or " : ""}${ocrEnabled ? "receipt image" : ""}`}
            >
              {uploadingStatement ? <Loader2 className="w-5 h-5 animate-spin" /> : <Paperclip className="w-5 h-5" />}
            </button>
          )}
          <button
            type="button"
            onClick={listening ? stopListening : startListening}
            className={`press shrink-0 w-11 h-11 rounded-2xl flex items-center justify-center transition-all ${
              listening
                ? "bg-destructive text-white anim-rec-pulse"
                : "bg-card border border-border text-muted-foreground hover:text-foreground hover:border-ring/50"
            }`}
            title="Voice input"
          >
            {listening ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
          </button>
          <div className="flex-1 rounded-2xl bg-card border border-border focus-within:border-ring/70 focus-within:ring-2 focus-within:ring-ring/30 transition-all">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              placeholder={listening ? "Listening…" : uploadingStatement ? "Reading your file…" : "Tell me about a transaction…"}
              rows={1}
              className="w-full resize-none bg-transparent px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none max-h-32"
              style={{ minHeight: "44px" }}
            />
          </div>
          <button
            type="button"
            onClick={sendMessage}
            disabled={!input.trim() || sending}
            className="press shrink-0 w-11 h-11 rounded-2xl bg-primary text-primary-foreground flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-95 transition-opacity"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </footer>
    </div>
  );
}
