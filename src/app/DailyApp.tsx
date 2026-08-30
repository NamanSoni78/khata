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
  BarChart3, WifiOff, CheckCheck, Clock3, X, Download, Languages,
  ImageIcon, ChevronUp, Loader,
} from "lucide-react";
import Markdown from "@/components/chat/Markdown";
import { InlineChartReveal, type ChartSpec } from "@/components/charts/InlineChart";

type Stage = "login" | "mpin-setup" | "unlock" | "chat";

interface Props {
  initialStage: Stage;
  username?: string;
  userId?: string;
  /** Server-known: user has at least one passkey — skips a round-trip on unlock. */
  hasWebauthn?: boolean;
}

interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: string;
  pending?: boolean;
  queued?: boolean;
  chartSpec?: ChartSpec | null;
}

interface Passkey {
  id: string;
  deviceType: string;
  createdAt: string;
  credentialIdShort: string;
}

const QUEUE_KEY = "khata-offline-queue";
const VOICE_LANG_KEY = "khata-voice-lang";

/** Chat wallpapers — subtle, non-distracting gradients (applied to the chat area). */
const WALLPAPERS: Record<string, { label: string; light: string; dark: string }> = {
  none: { label: "None", light: "", dark: "" },
  paper: { label: "Paper", light: "bg-[#faf9f4]", dark: "dark:bg-[#26241f]" },
  mint: { label: "Mint", light: "bg-[#f0f7f2]", dark: "dark:bg-[#1e2621]" },
  peach: { label: "Peach", light: "bg-[#fbf3ec]", dark: "dark:bg-[#282119]" },
  sky: { label: "Sky", light: "bg-[#eef4fa]", dark: "dark:bg-[#1d2430]" },
  lavender: { label: "Lavender", light: "bg-[#f4f1fa]", dark: "dark:bg-[#241f2e]" },
};

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

export default function DailyApp({ initialStage, username, hasWebauthn: hasWebauthnProp }: Props) {
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
  const [hasWebauthn, setHasWebauthn] = useState(hasWebauthnProp ?? false);

  // Settings sheet
  const [showSettings, setShowSettings] = useState(false);
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [passkeyActionLoading, setPasskeyActionLoading] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [canInstall, setCanInstall] = useState(false);
  const installPromptRef = useRef<any>(null);
  const [voiceLang, setVoiceLang] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(VOICE_LANG_KEY);
      return saved ?? "en-IN";
    } catch {
      return "en-IN";
    }
  });
  const [wallpaper, setWallpaper] = useState<string>("none");
  const [autoFingerprint, setAutoFingerprint] = useState<boolean>(true);

  // Chat
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const [online, setOnline] = useState(() => (typeof navigator !== "undefined" ? navigator.onLine : true));
  const [chatUser, setChatUser] = useState(username);
  const [uploadingStatement, setUploadingStatement] = useState(false);
  const [pdfUploadEnabled, setPdfUploadEnabled] = useState(true);
  const [ocrEnabled, setOcrEnabled] = useState(false);
  const [queuedCount, setQueuedCount] = useState(0);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollMainRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const autoWebauthnTriedRef = useRef(false);
  const webauthnBeginRef = useRef<Promise<{ ok: boolean; opts?: any }> | null>(null);
  const baseTextRef = useRef("");
  const finalTranscriptRef = useRef("");
  const [recSeconds, setRecSeconds] = useState(0);
  const recTimerRef = useRef<number | null>(null);
  const inputRef = useRef("");
  useEffect(() => { inputRef.current = input; }, [input]);
  const holdTimerRef = useRef<number | null>(null);
  const heldRef = useRef(false);

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
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  // ===== PWA install prompt (Chrome/Edge fire beforeinstallprompt when installable) =====
  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault(); // stop Chrome's default mini-infobar — we show our own button
      installPromptRef.current = e;
      setCanInstall(true);
    };
    window.addEventListener("beforeinstallprompt", handler);
    const installed = () => {
      installPromptRef.current = null;
      setCanInstall(false);
    };
    window.addEventListener("appinstalled", installed);
    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
      window.removeEventListener("appinstalled", installed);
    };
  }, []);

  const promptInstall = async () => {
    const ev = installPromptRef.current;
    if (!ev) return;
    ev.prompt();
    const { outcome } = await ev.userChoice.catch(() => ({ outcome: "dismissed" }));
    if (outcome === "accepted") toast.success("Installing Khata…");
    installPromptRef.current = null;
    setCanInstall(false);
  };

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
      if (j.prefs) {
        if (typeof j.prefs.wallpaper === "string" && WALLPAPERS[j.prefs.wallpaper]) {
          setWallpaper(j.prefs.wallpaper);
        }
        if (typeof j.prefs.autoFingerprint === "boolean") setAutoFingerprint(j.prefs.autoFingerprint);
      }
      // Load persisted chat history (latest page — older pages load on scroll-up)
      try {
        const hres = await fetch("/api/chat?action=history&limit=100");
        if (hres.ok && active) {
          const hj = await hres.json();
          if (Array.isArray(hj.messages)) {
            setMessages(
              hj.messages.map((m: any) => ({
                id: `h_${m.ts}_${Math.random().toString(36).slice(2, 6)}`,
                role: m.role,
                content: m.content,
                ts: m.ts,
                chartSpec: m.chartSpec ?? null,
              }))
            );
            setHasMoreHistory(!!hj.hasMore);
          }
        }
      } catch { /* history is best-effort */ }
      if (active) setHistoryLoaded(true);
    })();
    return () => { active = false; };
  }, [stage]);

  // ===== Unlock screen: INSTANT fingerprint =====
  // The server already tells us (via prop) that a passkey exists — so we fire
  // the webauthn "begin" request the moment the screen mounts (before the user
  // has done anything), and trigger the authenticator immediately. By the time
  // the OS biometric sheet opens, the network work is already done, so it
  // feels instant. MPIN stays as fallback.
  const prefetchWebauthnBegin = useCallback(() => {
    if (!webauthnBeginRef.current) {
      webauthnBeginRef.current = fetch("/api/auth/webauthn/login/begin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username ?? chatUser ?? undefined }),
      })
        .then(async (r) => ({ ok: r.ok, opts: r.ok ? await r.json() : undefined }))
        .catch(() => ({ ok: false as const, opts: undefined }));
    }
    return webauthnBeginRef.current;
  }, [username, chatUser]);

  useEffect(() => {
    if (stage !== "unlock") return;
    let active = true;
    // Instant path: server already confirmed a passkey exists — prefetch the
    // begin options and the prefs check IN PARALLEL, then trigger immediately.
    if (hasWebauthnProp && !autoWebauthnTriedRef.current) {
      autoWebauthnTriedRef.current = true;
      prefetchWebauthnBegin();
      void (async () => {
        try {
          const res = await fetch("/api/auth/me");
          if (!res.ok) return;
          const j = await res.json();
          if (!active) return;
          setHasWebauthn(!!j.hasWebauthn);
          if (j.prefs && typeof j.prefs.autoFingerprint === "boolean") setAutoFingerprint(j.prefs.autoFingerprint);
          // Respect the user's "instant fingerprint" setting
          if (j.prefs?.autoFingerprint === false) {
            autoWebauthnTriedRef.current = true;
            webauthnBeginRef.current = null; // keep the tap-to-use flow snappy instead
            return;
          }
          unlockWithWebauthn(true);
        } catch {
          // Offline / me failed — still try, prefetched begin may succeed.
          if (active) unlockWithWebauthn(true);
        }
      })();
      return () => { active = false; };
    }
    // Fallback path: /chat or first mount — discover passkey availability.
    (async () => {
      try {
        const res = await fetch("/api/auth/me");
        if (!res.ok) return;
        const j = await res.json();
        if (!active) return;
        setHasWebauthn(!!j.hasWebauthn);
        if (j.prefs && typeof j.prefs.autoFingerprint === "boolean") {
          setAutoFingerprint(j.prefs.autoFingerprint);
        }
        if (j.hasWebauthn && j.prefs?.autoFingerprint !== false && !autoWebauthnTriedRef.current) {
          autoWebauthnTriedRef.current = true;
          prefetchWebauthnBegin();
          setTimeout(() => { if (active) unlockWithWebauthn(true); }, 60);
        }
      } catch { /* offline — MPIN still works */ }
    })();
    return () => { active = false; };
  }, [stage, hasWebauthnProp, prefetchWebauthnBegin]);

  // ===== Scroll-up pagination: load older messages when the user reaches the top =====
  const loadOlderMessages = useCallback(async () => {
    if (loadingOlder || !hasMoreHistory || messages.length === 0) return;
    const oldest = messages.find((m) => m.id.startsWith("h_")) ?? messages[0];
    if (!oldest) return;
    setLoadingOlder(true);
    const main = scrollMainRef.current;
    const prevHeight = main?.scrollHeight ?? 0;
    try {
      const res = await fetch(`/api/chat?action=history&limit=100&before=${encodeURIComponent(oldest.ts)}`);
      if (res.ok) {
        const j = await res.json();
        if (Array.isArray(j.messages) && j.messages.length > 0) {
          setMessages((m) => [
            ...j.messages.map((mm: any) => ({
              id: `h_${mm.ts}_${Math.random().toString(36).slice(2, 6)}`,
              role: mm.role,
              content: mm.content,
              ts: mm.ts,
              chartSpec: mm.chartSpec ?? null,
            })),
            ...m,
          ]);
          setHasMoreHistory(!!j.hasMore);
          // Keep the scroll position where the user was (no jump)
          requestAnimationFrame(() => {
            if (main) main.scrollTop = main.scrollHeight - prevHeight;
          });
        } else {
          setHasMoreHistory(false);
        }
      }
    } catch { /* best-effort */ } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, hasMoreHistory, messages]);

  const onMainScroll = useCallback(() => {
    const main = scrollMainRef.current;
    if (main && main.scrollTop < 80) loadOlderMessages();
  }, [loadOlderMessages]);

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
              ? { ...mm, content: res.ok ? j.reply : (j.error ?? "Couldn't send — will try again."), pending: false, chartSpec: res.ok ? (j.chartSpec ?? null) : null }
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
        // Defer state updates out of the effect body (avoids cascading renders)
        const t = window.setTimeout(() => {
          setQueuedCount(queue.length);
          setSending(true);
          flushQueue();
        }, 0);
        return () => window.clearTimeout(t);
      }
    }
  }, [stage, online, historyLoaded, flushQueue]);

  // ===== Reminder self-poll (client-side safety net) =====
  // The server runs its own in-process scheduler (see
  // @/lib/notifications/scheduler.ts), but on serverless that only fires while
  // a function is warm. While the app is open in a tab, this client polls
  // /api/notifications/cron every 60 s — ensuring that even if the server's
  // interval isn't running, due reminders get fired while the user is
  // actively using the app. The cron endpoint is idempotent.
  useEffect(() => {
    if (stage !== "chat" || !online) return;
    const id = window.setInterval(() => {
      // Fire-and-forget — no auth header needed (the endpoint accepts the
      // internal scheduler header OR runs in open mode when no QSTASH_TOKEN
      // is set; when QSTASH_TOKEN IS set, we still want the poll to work,
      // so we pass the header).
      fetch("/api/notifications/cron", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Scheduler": "1",
        },
        body: JSON.stringify({ source: "client-poll" }),
      }).catch(() => { /* best-effort */ });
    }, 60 * 1000); // every 60 s
    return () => window.clearInterval(id);
  }, [stage, online]);

  // ===== Settings sheet: ESC closes (backdrop click already does) =====
  useEffect(() => {
    if (!showSettings) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowSettings(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSettings]);

  // ===== Auto-scroll to bottom on NEW messages (not when loading older) =====
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (last && !loadingOlder) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, loadingOlder]);

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
      setChatUser(loginU);
      if (j.requiresMpinSetup) setStage("mpin-setup");
      else setStage("chat");
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

  // Hoisted function declaration — the auto-fingerprint effect above references
  // it before this line runs, which is legal for `function` declarations.
  async function unlockWithWebauthn(auto = false) {
    setWebauthnUnlockLoading(true);
    try {
      const { ok, opts: beginOpts } = await prefetchWebauthnBegin();
      if (!ok || !beginOpts) {
        webauthnBeginRef.current = null; // allow retry
        if (!auto) toast.error("Couldn't start fingerprint unlock");
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
        webauthnBeginRef.current = null; // challenges are single-use — refetch next time
        if (!auto) toast.error(finishJ.error ?? "Fingerprint verification failed");
        return;
      }
      toast.success(`Welcome back, ${finishJ.username}`);
      setStage("chat");
    } catch (e: any) {
      webauthnBeginRef.current = null;
      // Auto attempts fail silently (user may prefer MPIN); manual ones show errors
      if (!auto && e?.name !== "NotAllowedError") {
        toast.error(e?.message ?? "Fingerprint unlock failed");
      }
    } finally {
      setWebauthnUnlockLoading(false);
    }
  }

  // ============================================================
  //  PASSKEYS + NOTIFICATIONS + PREFS
  // ============================================================
  const loadPasskeys = async () => {
    const res = await fetch("/api/auth/me");
    if (!res.ok) return;
    const j = await res.json();
    if (j.passkeys) setPasskeys(j.passkeys);
  };

  const savePrefs = async (patch: Record<string, unknown>) => {
    try {
      await fetch("/api/auth/prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch { /* best-effort */ }
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
      setHasWebauthn(true);
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
  //  SPEECH TO TEXT (Hinglish-aware)
  //  en-IN is the best native mode for Hinglish: Hindi words come out
  //  transliterated in Latin script, mixed with English — exactly how users
  //  type. hi-IN outputs pure Devanagari. Users pick per-device.
  // ============================================================
  const startListening = () => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      toast.error("Voice input isn't supported on this device");
      return;
    }
    const rec = new SpeechRecognition();
    rec.lang = voiceLang || "en-IN";
    rec.continuous = true;          // keep listening through short pauses
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    baseTextRef.current = inputRef.current;
    finalTranscriptRef.current = "";

    // IMPORTANT: only consume NEW results (from e.resultIndex). Iterating all
    // results on every event re-appends already-finalized text → duplicated
    // words in the input. Finals accumulate; the current interim is appended
    // for display only.
    rec.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalTranscriptRef.current += t + " ";
        else interim += t;
      }
      const prefix = baseTextRef.current ? baseTextRef.current.trim() + " " : "";
      setInput((prefix + finalTranscriptRef.current + interim).replace(/\s+/g, " ").trimStart());
    };
    rec.onerror = (e: any) => {
      if (e.error !== "no-speech" && e.error !== "aborted") toast.error(`Voice error: ${e.error}`);
      if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
      setListening(false);
    };
    rec.onend = () => {
      // continuous=true on Android Chrome still ends after longer silences.
      // Restart while the user is holding the mic; committed finals stay in
      // finalTranscriptRef so the restart can't duplicate them.
      if (recognitionRef.current === rec && listening) {
        try { rec.start(); return; } catch { /* fall through */ }
      }
      if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
      setListening(false);
    };
    try {
      rec.start();
    } catch {
      toast.error("Couldn't start the mic — try again");
      return;
    }
    recognitionRef.current = rec;
    setRecSeconds(0);
    recTimerRef.current = window.setInterval(() => setRecSeconds((s) => s + 1), 1000);
    setListening(true);
  };
  const stopListening = () => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
    setListening(false);
    // Refocus the input so the user can edit the transcript before sending
    setTimeout(() => textareaRef.current?.focus(), 60);
  };

  // Press-and-hold the mic: hold ≥300ms = talk while held (release stops).
  // A quick tap still toggles (accessibility + old habit).
  const onMicPointerDown = () => {
    heldRef.current = false;
    holdTimerRef.current = window.setTimeout(() => {
      heldRef.current = true;
      if (!listening) startListening();
    }, 300);
  };
  const onMicPointerUp = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (heldRef.current) {
      if (listening) stopListening();
    } else {
      // Tap → toggle
      if (listening) stopListening();
      else startListening();
    }
  };
  const onMicPointerLeave = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
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
              ? { ...mm, content: j.reply, pending: false, chartSpec: j.chartSpec ?? null }
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
    "2000 SIP mein dale",
    "kitna balance hai SBI mein?",
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
            Don&apos;t have an account? Ask your{" "}
            <a
              href="mailto:request.Khata@namansoni.in?subject=Khata%20account%20request&body=Hi%2C%20please%20create%20a%20Khata%20account%20for%20me.%0A%0ARequested%20username%3A%20"
              className="text-primary underline underline-offset-2 hover:opacity-80"
            >
              administrator
            </a>{" "}
            to create one.
          </p>
        </div>
        <footer className="absolute bottom-5 left-0 right-0 text-center">
          <a
            href="https://github.com/NamanSoni78"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-muted-foreground/70 hover:text-muted-foreground transition-colors"
          >
            made with <span className="align-middle">❤️</span> by Naman
          </a>
        </footer>
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
                onClick={() => unlockWithWebauthn(false)}
                disabled={webauthnUnlockLoading}
                className="press w-full h-11 mt-4 rounded-xl border border-input bg-card text-foreground text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-60 hover:bg-accent/60 transition-colors"
              >
                {webauthnUnlockLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Fingerprint className="w-4 h-4 text-primary" />
                )}
                {webauthnUnlockLoading ? "Waiting for fingerprint…" : "Use fingerprint"}
              </button>
              <p className="text-[11px] text-muted-foreground/70 mt-2.5 text-center">
                {webauthnUnlockLoading
                  ? "Touch your fingerprint sensor to sign in"
                  : "Fingerprint prompt appears automatically — just touch the sensor"}
              </p>
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
  const wp = WALLPAPERS[wallpaper] ?? WALLPAPERS.none;

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
            {canInstall && (
              <button
                onClick={promptInstall}
                className="press h-9 px-3 rounded-xl flex items-center gap-1.5 text-xs font-medium text-primary hover:bg-accent/50 transition-colors"
                title="Install Khata on this device"
                aria-label="Install Khata on this device"
              >
                <Download className="w-4 h-4" />
                <span className="hidden sm:inline">Install</span>
              </button>
            )}
            <a
              href="/dashboard"
              className="press h-9 px-3 rounded-xl flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
              title="Open dashboard"
              aria-label="Open dashboard"
            >
              <BarChart3 className="w-4 h-4" />
              <span className="hidden sm:inline">Dashboard</span>
            </a>
            <button
              onClick={toggleTheme}
              className="press h-9 w-9 rounded-xl flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
              title="Toggle theme"
              aria-label="Toggle theme"
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
              aria-label="Settings"
            >
              <SettingsIcon className="w-4 h-4" />
            </button>
            <button
              onClick={logout}
              className="press h-9 w-9 rounded-xl flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
              title="Sign out"
              aria-label="Sign out"
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
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
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

              {/* Chat wallpaper */}
              <div className="border-t border-border pt-5">
                <p className="text-sm font-medium text-foreground flex items-center gap-1.5">
                  <ImageIcon className="w-4 h-4 text-primary" /> Chat wallpaper
                </p>
                <p className="text-xs text-muted-foreground mt-0.5 mb-3">A subtle tint behind your messages. Saved to your account.</p>
                <div className="grid grid-cols-3 gap-2">
                  {Object.entries(WALLPAPERS).map(([key, w]) => (
                    <button
                      key={key}
                      onClick={() => {
                        setWallpaper(key);
                        savePrefs({ wallpaper: key });
                      }}
                      className={`press h-12 rounded-xl border text-xs font-medium ${w.light} ${w.dark} flex items-center justify-center transition-colors ${
                        wallpaper === key
                          ? "border-primary ring-2 ring-ring/40"
                          : "border-input text-muted-foreground hover:border-ring/50"
                      }`}
                    >
                      {w.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Voice language */}
              <div className="border-t border-border pt-5">
                <p className="text-sm font-medium text-foreground flex items-center gap-1.5">
                  <Languages className="w-4 h-4 text-primary" /> Voice language
                </p>
                <p className="text-xs text-muted-foreground mt-0.5 mb-3">
                  Hinglish works best in English (India) — Hindi words come out in English letters, mixed naturally.
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: "en-IN", label: "Hinglish" },
                    { id: "hi-IN", label: "हिन्दी" },
                    { id: "en-US", label: "English" },
                  ].map((l) => (
                    <button
                      key={l.id}
                      onClick={() => {
                        setVoiceLang(l.id);
                        try { localStorage.setItem(VOICE_LANG_KEY, l.id); } catch {}
                      }}
                      className={`press h-10 rounded-xl border text-xs font-medium flex items-center justify-center transition-colors ${
                        voiceLang === l.id
                          ? "border-primary bg-accent text-accent-foreground"
                          : "border-input text-muted-foreground hover:border-ring/50"
                      }`}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground/70 mt-2">Tip: hold the mic button to talk; release to stop.</p>
              </div>

              {/* Auto fingerprint */}
              {hasWebauthn && (
                <div className="border-t border-border pt-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-foreground flex items-center gap-1.5">
                        <Fingerprint className="w-4 h-4 text-primary" /> Instant fingerprint
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">Ask for your fingerprint the moment the app opens</p>
                    </div>
                    <button
                      onClick={() => {
                        const next = !autoFingerprint;
                        setAutoFingerprint(next);
                        savePrefs({ autoFingerprint: next });
                      }}
                      className={`press h-8 px-3 rounded-lg border text-xs font-medium transition-colors ${
                        autoFingerprint
                          ? "border-primary bg-accent text-accent-foreground"
                          : "border-input text-muted-foreground hover:border-ring/50"
                      }`}
                    >
                      {autoFingerprint ? "On" : "Off"}
                    </button>
                  </div>
                </div>
              )}

              {/* Install app */}
              {canInstall && (
                <div className="border-t border-border pt-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-foreground flex items-center gap-1.5">
                        <Download className="w-4 h-4 text-primary" /> Install app
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">Add Khata to your home screen</p>
                    </div>
                    <button
                      onClick={promptInstall}
                      className="press h-8 px-3 rounded-lg bg-primary text-primary-foreground text-xs font-medium"
                    >
                      Install
                    </button>
                  </div>
                </div>
              )}

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
                  Tip: ask me things like &quot;remind me at 8pm daily&quot; or &quot;send my day&apos;s summary at 9:10pm&quot;.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Messages */}
      <main
        ref={scrollMainRef}
        onScroll={onMainScroll}
        className={`flex-1 overflow-y-auto transition-colors ${wp.light} ${wp.dark}`}
        style={{ minHeight: 0 }}
      >
        <div className="max-w-2xl mx-auto px-4 py-4 space-y-2.5">
          {loadingOlder && (
            <div className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground py-1">
              <Loader className="w-3 h-3 animate-spin" /> loading earlier messages…
            </div>
          )}
          {hasMoreHistory && !loadingOlder && (
            <button
              onClick={loadOlderMessages}
              className="press mx-auto flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground py-1"
            >
              <ChevronUp className="w-3 h-3" /> load earlier messages
            </button>
          )}
          {!historyLoaded && messages.length === 0 && (
            <div className="space-y-2.5 pt-2" aria-hidden>
              <div className="flex justify-start"><div className="h-10 w-2/5 rounded-2xl rounded-bl-md bg-muted animate-pulse" /></div>
              <div className="flex justify-end"><div className="h-9 w-1/3 rounded-2xl rounded-br-md bg-muted animate-pulse" /></div>
              <div className="flex justify-start"><div className="h-12 w-3/5 rounded-2xl rounded-bl-md bg-muted animate-pulse" /></div>
            </div>
          )}
          {historyLoaded && messages.length === 0 && (
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
                <Mic className="w-3 h-3" /> Hold the mic to speak
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
                    <Markdown text={m.content} />
                    {m.chartSpec && <InlineChartReveal spec={m.chartSpec} />}
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
              aria-label="Upload a statement or receipt"
            >
              {uploadingStatement ? <Loader2 className="w-5 h-5 animate-spin" /> : <Paperclip className="w-5 h-5" />}
            </button>
          )}
          <button
            type="button"
            onPointerDown={onMicPointerDown}
            onPointerUp={onMicPointerUp}
            onPointerLeave={onMicPointerLeave}
            onContextMenu={(e) => e.preventDefault()}
            className={`press shrink-0 w-11 h-11 rounded-2xl flex items-center justify-center transition-all select-none touch-none ${
              listening
                ? "bg-destructive text-white anim-whatsapp-mic scale-105"
                : "bg-card border border-border text-muted-foreground hover:text-foreground hover:border-ring/50"
            }`}
            title="Hold to talk (or tap to toggle)"
            aria-label={listening ? "Stop recording" : "Hold to talk"}
          >
            {listening ? <MicOff className="w-5 h-5 animate-pulse" /> : <Mic className="w-5 h-5" />}
          </button>
          {listening ? (
            /* WhatsApp-style recording pill — input morphs while recording */
            <div className="flex-1 h-11 rounded-2xl bg-card border border-destructive/40 flex items-center gap-2.5 px-4 anim-pop-in overflow-hidden">
              <span className="relative flex h-2.5 w-2.5 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-destructive opacity-60" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-destructive" />
              </span>
              <span className="text-sm font-medium text-foreground tnum w-9 shrink-0">
                {Math.floor(recSeconds / 60)}:{String(recSeconds % 60).padStart(2, "0")}
              </span>
              <div className="flex-1 flex items-center justify-center gap-[3px] h-5" aria-hidden>
                {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                  <span
                    key={i}
                    className="sound-wave-bar"
                    style={{ animationDelay: `${i * 0.12}s` }}
                  />
                ))}
              </div>
              <span className="text-[11px] text-muted-foreground shrink-0 hidden sm:inline">
                release to stop
              </span>
              {/* hidden textarea keeps the transcript value alive while recording */}
            </div>
          ) : (
            <div className="flex-1 rounded-2xl bg-card border border-border focus-within:border-ring/70 focus-within:ring-2 focus-within:ring-ring/30 transition-all relative">
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
                placeholder={uploadingStatement ? "Reading your file…" : "Tell me about a transaction…"}
                rows={1}
                className="w-full resize-none bg-transparent px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none max-h-32"
                style={{ minHeight: "44px" }}
              />
            </div>
          )}
          <button
            type="button"
            onClick={sendMessage}
            disabled={!input.trim() || sending}
            aria-label="Send message"
            className="press shrink-0 w-11 h-11 rounded-2xl bg-primary text-primary-foreground flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-95 transition-opacity"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </footer>
    </div>
  );
}
