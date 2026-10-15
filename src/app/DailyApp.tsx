"use client";

/**
 * DailyApp — the "/" PWA experience, rebuilt WhatsApp-style.
 *
 * Auth stages are delegated to <AuthScreens/>; once authed we render the chat:
 * green header, doodle wallpaper, tailed bubbles with timestamps + read
 * ticks, recording pill with live mic animation, offline queue, statement
 * uploads, history pagination, push notifications and the settings sheet.
 *
 * STT runs through ONE of two engines (server-told via /api/auth/me):
 *  - "native"            → webkitSpeechRecognition, with a rebuild-from-
 *                           scratch transcript strategy that fixes the
 *                           "5 kilo5 kilo5 kilo" duplication bug.
 *  - "openai-compatible" → MediaRecorder → POST /api/stt/transcribe (the
 *                           API key stays server-side).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Mic, Send, LogOut, Loader2, Paperclip, Settings as SettingsIcon,
  Moon, Sun, BarChart3, WifiOff, CheckCheck, Clock3, X, Download,
  Languages, ImageIcon, ChevronDown, Trash2, Bot,
} from "lucide-react";
import Markdown from "@/components/chat/Markdown";
import { InlineChartReveal, type ChartSpec } from "@/components/charts/InlineChart";
import AuthScreens, { forgetEmail, getRemembered, type AuthedInfo } from "./components/AuthScreens";
import { haptic } from "./components/Keypad";

type Stage = "auth" | "chat";

interface Props {
  /** Server-rendered starting point for the auth flow. */
  initialAuthStage: "landing" | "unlock" | "mpin-setup";
  username?: string | null;
  email?: string | null;
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

const QUEUE_KEY = "khata-offline-queue";
const VOICE_LANG_KEY = "khata-voice-lang";

/** Chat wallpapers — subtle tints layered over the doodle canvas. */
const WALLPAPERS: Record<string, { label: string; light: string; dark: string }> = {
  doodle: { label: "Doodles", light: "", dark: "" },
  plain: { label: "Plain", light: "bg-[#efeae2] dark:bg-[#0b141a]", dark: "dark:bg-[#0b141a]" },
  mint: { label: "Mint", light: "bg-[#e6efe9]", dark: "dark:bg-[#101b16]" },
  rose: { label: "Rose", light: "bg-[#f2e9e6]", dark: "dark:bg-[#1b1210]" },
  sand: { label: "Sand", light: "bg-[#f0ead9]", dark: "dark:bg-[#191710]" },
  slate: { label: "Slate", light: "bg-[#e8ebe9]", dark: "dark:bg-[#10171b]" },
};

function loadQueue(): string[] {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]"); } catch { return []; }
}
function saveQueue(q: string[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
}

/* WhatsApp-style read ticks */
function Ticks() {
  return (
    <svg width="18" height="12" viewBox="0 0 18 12" fill="none" aria-hidden style={{ shapeRendering: "geometricPrecision" }}>
      <path d="M4.5 6.4 1.8 3.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.5 6.4 9.2 1.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.8 6.4 6.1 3.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.8 6.4 13.5 1.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function timeOf(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });
}

function dayLabel(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "TODAY";
  if (same(d, yesterday)) return "YESTERDAY";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: d.getFullYear() !== today.getFullYear() ? "numeric" : undefined }).toUpperCase();
}

export default function DailyApp({ initialAuthStage, username, email }: Props) {
  const [stage, setStage] = useState<Stage>("auth");

  // user info (filled after auth)
  const [user, setUser] = useState<{ username: string; email: string } | null>(
    initialAuthStage !== "landing" ? { username: username ?? "", email: email ?? "" } : null
  );

  // Entry stage = what the SERVER decided (landing / mpin-setup / unlock).
  // A remembered email upgrades landing → unlock ONCE after mount. It is
  // held as STATE (not derived from the remembered store) on purpose:
  // rememberEmail() fires mid-login/OTP flow, and a derived value would
  // change AuthScreens' key and remount it mid-transition — which used to
  // discard the mpin-setup stage right after OTP verification.
  const [authStage, setAuthStage] = useState<"landing" | "unlock" | "mpin-setup">(initialAuthStage);
  useEffect(() => {
    if (initialAuthStage !== "landing") return;
    const r = getRemembered();
    if (r.email) {
      const id = requestAnimationFrame(() => setAuthStage("unlock"));
      return () => cancelAnimationFrame(id);
    }
  }, [initialAuthStage]);

  const onAuthed = useCallback((info: AuthedInfo) => {
    setUser({ username: info.username, email: info.email });
    setStage("chat");
  }, []);

  const onLogout = useCallback(async () => {
    forgetEmail();
    await fetch("/api/auth/logout", { method: "POST" });
    setAuthStage("landing"); // server-rendered stage is stale post-logout
    setUser(null);
    setStage("auth");
  }, []);

  if (stage === "auth") {
    return (
      <AuthScreens
        key={authStage}
        initialStage={authStage}
        rememberedEmail={typeof window === "undefined" ? null : getRemembered().email}
        rememberedUsername={typeof window === "undefined" ? null : getRemembered().username}
        onAuthed={onAuthed}
      />
    );
  }

  return <ChatStage user={user!} onLogout={onLogout} />;
}

/* ============================================================
   CHAT STAGE
   ============================================================ */

function ChatStage({ user, onLogout }: { user: { username: string; email: string }; onLogout: () => void }) {
  // messages + input
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [showJumpDown, setShowJumpDown] = useState(false);

  // voice
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [sttEngine, setSttEngine] = useState<"native" | "openai-compatible">("native");
  const [recSeconds, setRecSeconds] = useState(0);

  // environment
  const [online, setOnline] = useState(() => (typeof navigator !== "undefined" ? navigator.onLine : true));
  const [queuedCount, setQueuedCount] = useState(0);
  const [uploadingStatement, setUploadingStatement] = useState(false);
  const [pdfUploadEnabled, setPdfUploadEnabled] = useState(true);
  const [ocrEnabled, setOcrEnabled] = useState(false);
  const [canInstall, setCanInstall] = useState(false);

  // settings sheet
  const [showSettings, setShowSettings] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [voiceLang, setVoiceLang] = useState<string>(() => {
    try { return localStorage.getItem(VOICE_LANG_KEY) ?? "en-IN"; } catch { return "en-IN"; }
  });
  const [wallpaper, setWallpaper] = useState<string>("doodle");

  // refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollMainRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef("");
  const recognitionRef = useRef<any>(null);
  const recTimerRef = useRef<number | null>(null);
  const listeningRef = useRef(false);
  const baseTextRef = useRef("");            // input text when recording started
  const committedRef = useRef("");           // finalized transcript of prior sessions
  const sessionFinalRef = useRef("");        // finals of the CURRENT session (rebuilt)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const cancelRecordingRef = useRef(false);
  const stopIntentRef = useRef(false);        // user requested stop — onend must NOT auto-restart
  const sendAfterStopRef = useRef(false);     // auto-send the final transcript when it lands
  const installPromptRef = useRef<any>(null);
  const nearBottomRef = useRef(true);

  useEffect(() => { inputRef.current = input; }, [input]);

  /* ---------- theme ---------- */
  const toggleTheme = () => {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("khata-theme", next ? "dark" : "light"); } catch { /* private mode */ }
  };

  /* ---------- network status ---------- */
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

  /* ---------- PWA install prompt ---------- */
  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      installPromptRef.current = e;
      setCanInstall(true);
    };
    window.addEventListener("beforeinstallprompt", handler);
    const installed = () => { installPromptRef.current = null; setCanInstall(false); };
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

  /* ---------- load profile + history on mount ---------- */
  useEffect(() => {
    let active = true;
    (async () => {
      // Fire profile + history together — the two calls are independent,
      // so the chat paints in one round-trip instead of two.
      const meP = fetch("/api/auth/me").then(async (res) => {
        if (!res.ok) return null;
        const j = await res.json();
        return j?.authenticated ? j : null;
      }).catch(() => null);
      // The home app shows the LATEST 50 messages — the full archive is
      // exportable from the dashboard ("Export chat history").
      const histP = fetch("/api/chat?action=history&limit=50")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);

      const [me, hj] = await Promise.all([meP, histP]);
      if (!active) return;

      if (me) {
        if (typeof me.sttEngine === "string") setSttEngine(me.sttEngine);
        if (me.flags) {
          setPdfUploadEnabled(me.flags.pdfUpload !== false);
          setOcrEnabled(me.flags.ocr === true);
          setPushEnabled(me.flags.webPush !== false);
        }
        if (me.prefs) {
          if (typeof me.prefs.wallpaper === "string" && WALLPAPERS[me.prefs.wallpaper]) setWallpaper(me.prefs.wallpaper);
          if (typeof me.prefs.voiceLang === "string") setVoiceLang(me.prefs.voiceLang);
        }
      }

      if (hj && Array.isArray(hj.messages)) {
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
        requestAnimationFrame(() => scrollToBottom("auto"));
      }
      setHistoryLoaded(true);
    })();
    return () => { active = false; };
  }, []);

  /* ---------- scrolling helpers ---------- */
  const scrollToBottom = (behavior: "auto" | "smooth" = "smooth") => {
    const el = scrollMainRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  };

  const onMainScroll = useCallback(() => {
    const el = scrollMainRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    nearBottomRef.current = nearBottom;
    setShowJumpDown(!nearBottom && el.scrollHeight > el.clientHeight + 200);
  }, []);

  useEffect(() => {
    if (nearBottomRef.current) {
      requestAnimationFrame(() => scrollToBottom("smooth"));
    }
  }, [messages.length, sending]);

  /* NOTE: no scroll-up pagination here by design — the home app shows the
     latest 50 messages; anything older is exported from the dashboard
     ("Export chat history" downloads the complete transcript). */

  /* ---------- offline queue ---------- */
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
        } else break;
      } catch { break; }
    }
    setSending(false);
  }, []);

  useEffect(() => {
    if (online && historyLoaded) {
      const queue = loadQueue();
      if (queue.length > 0) {
        const t = window.setTimeout(() => {
          setQueuedCount(queue.length);
          setSending(true);
          flushQueue();
        }, 0);
        return () => window.clearTimeout(t);
      }
    }
  }, [online, historyLoaded, flushQueue]);

  /* ---------- reminder self-poll ---------- */
  useEffect(() => {
    if (!online) return;
    const id = window.setInterval(() => {
      fetch("/api/notifications/cron", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Scheduler": "1" },
        body: "{}",
      }).catch(() => {});
    }, 60_000);
    return () => window.clearInterval(id);
  }, [online]);

  /* ---------- auto-resize textarea ---------- */
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, [input]);

  /* ============================================================
     SPEECH TO TEXT — NATIVE (duplication-proof + stoppable)
     Strategy: rebuild the current session's transcript from ALL results
     on every event (idempotent — duplicate events can't re-append text),
     fold finals into `committed` only when the session ends, and restart
     on silence ONLY while the user hasn't asked to stop (stopIntentRef).
     ============================================================ */
  const appendDedupe = (base: string, add: string): string => {
    const a = add.trim();
    if (!a) return base;
    if (base.trimEnd().endsWith(a)) return base; // exact-repeat guard
    return base ? base.trimEnd() + " " + a : a;
  };

  const startNativeListening = () => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      toast.error("Voice input isn't supported on this device");
      return;
    }
    const rec = new SpeechRecognition();
    rec.lang = voiceLang || "en-IN";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    baseTextRef.current = inputRef.current;
    committedRef.current = "";
    sessionFinalRef.current = "";
    stopIntentRef.current = false;

    rec.onresult = (e: any) => {
      // REBUILD from scratch every event — immune to resultIndex quirks,
      // re-emitted finals, and interim→final double delivery.
      let finals = "";
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finals += t + " ";
        else interim += t;
      }
      sessionFinalRef.current = finals;
      const shown = appendDedupe("", (committedRef.current + " " + finals).trim());
      setInput((baseTextRef.current ? baseTextRef.current.trim() + " " : "") + (shown ? shown + " " : "") + interim);
    };

    rec.onerror = (e: any) => {
      if (e.error !== "no-speech" && e.error !== "aborted") toast.error(`Voice error: ${e.error}`);
      if (recognitionRef.current === rec) stopRecordingUI();
    };

    rec.onend = () => {
      // fold this session's finals into the committed transcript
      committedRef.current = appendDedupe(committedRef.current, sessionFinalRef.current);
      sessionFinalRef.current = "";

      // auto-restart ONLY while still listening AND the user hasn't stopped us
      if (recognitionRef.current === rec && listeningRef.current && !stopIntentRef.current) {
        try {
          rec.start();
          return;
        } catch { /* fall through to finalize */ }
      }
      if (recognitionRef.current === rec) {
        const finalText = (
          baseTextRef.current ? baseTextRef.current.trim() + " " + committedRef.current.trim() : committedRef.current.trim()
        ).trim();
        setInput(finalText);
        if (stopIntentRef.current) {
          recognitionRef.current = null;
          finalizeAfterStop(finalText);
        } else {
          stopRecordingUI();
        }
      }
    };

    try {
      rec.start();
    } catch {
      toast.error("Couldn't start the mic — try again");
      return;
    }
    recognitionRef.current = rec;
    startRecordingUI();
  };

  const stopNativeListening = () => {
    stopIntentRef.current = true;
    try { recognitionRef.current?.stop(); } catch { /* already stopped */ }
    // Safety net: if onend never fires (engine quirk), finalize after 350ms
    const rec = recognitionRef.current;
    window.setTimeout(() => {
      if (recognitionRef.current === rec) {
        recognitionRef.current = null;
        const finalText = (
          baseTextRef.current ? baseTextRef.current.trim() + " " + committedRef.current.trim() : committedRef.current.trim()
        ).trim();
        setInput(finalText);
        finalizeAfterStop(finalText);
      }
    }, 350);
  };

  /* ============================================================
     SPEECH TO TEXT — OPENAI-COMPATIBLE (record → upload → transcribe)
     ============================================================ */
  const startServerListening = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeCandidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
      const mime = mimeCandidates.find((m) =>
        typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(m)
      );
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      audioChunksRef.current = [];
      cancelRecordingRef.current = false;
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        // release the mic immediately
        stream.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;
        if (cancelRecordingRef.current) {
          stopRecordingUI();
          return;
        }
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        if (blob.size < 1200) { // too short — likely a mis-tap
          stopRecordingUI();
          return;
        }
        setTranscribing(true);
        try {
          const fd = new FormData();
          fd.append("audio", blob, "speech.webm");
          if (voiceLang) fd.append("lang", voiceLang);
          const res = await fetch("/api/stt/transcribe", { method: "POST", body: fd });
          const j = await res.json();
          if (!res.ok) {
            toast.error(j.error ?? "Transcription failed");
          } else if (j.text) {
            const prefix = inputRef.current ? inputRef.current.trim() + " " : "";
            const finalText = (prefix + j.text).trim();
            setInput(finalText);
            if (sendAfterStopRef.current) {
              sendAfterStopRef.current = false;
              if (finalText) void sendMessageText(finalText);
            } else {
              setTimeout(() => textareaRef.current?.focus(), 60);
            }
          }
        } catch {
          toast.error("Transcription failed — check your connection");
        } finally {
          setTranscribing(false);
          stopRecordingUI();
        }
      };
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      baseTextRef.current = inputRef.current;
      stopIntentRef.current = false;
      recorder.start(250);
      startRecordingUI();
    } catch (e: any) {
      if (e?.name === "NotAllowedError") toast.error("Microphone permission denied");
      else toast.error("Couldn't start the mic — try again");
    }
  };

  const stopServerListening = (cancel = false) => {
    cancelRecordingRef.current = cancel;
    try { mediaRecorderRef.current?.stop(); } catch { /* already stopped */ }
  };

  /* ---------- shared recording UI state ---------- */
  const startRecordingUI = () => {
    listeningRef.current = true;
    haptic(14);
    setListening(true);
    setRecSeconds(0);
    recTimerRef.current = window.setInterval(() => setRecSeconds((s) => s + 1), 1000);
  };
  const stopRecordingUI = () => {
    listeningRef.current = false;
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
    haptic(10);
    setListening(false);
    setTimeout(() => textareaRef.current?.focus(), 60);
  };

  /** After a user-requested stop: auto-send when requested, else focus composer. */
  const finalizeAfterStop = (finalText: string) => {
    const wantsSend = sendAfterStopRef.current;
    sendAfterStopRef.current = false;
    stopRecordingUI();
    if (wantsSend && finalText.trim()) {
      void sendMessageText(finalText.trim());
    }
  };

  const startListening = () => {
    if (sttEngine === "openai-compatible") void startServerListening();
    else startNativeListening();
  };
  const stopListening = (opts: { send?: boolean } = {}) => {
    sendAfterStopRef.current = !!opts.send;
    if (sttEngine === "openai-compatible") stopServerListening(false);
    else stopNativeListening();
  };

  const cancelRecording = () => {
    sendAfterStopRef.current = false;
    if (sttEngine === "openai-compatible") {
      stopServerListening(true);
    } else {
      // drop everything the mic added
      setInput(baseTextRef.current);
      committedRef.current = "";
      sessionFinalRef.current = "";
      stopIntentRef.current = true;
      stopNativeListening();
      stopRecordingUI();
    }
  };

  /* ---------- mic: simple tap-to-toggle ---------- */
  const onMicClick = () => {
    if (listening || transcribing) return; // pill buttons take over
    startListening();
  };

  /* ---------- send message ---------- */
  const sendMessage = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    await sendMessageText(text);
  };

  const sendMessageText = async (text: string) => {
    if (!text || sending) return;
    haptic(10);

    if (!online) {
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

    nearBottomRef.current = true;
    setMessages((m) => [
      ...m,
      { id: `u_${Date.now()}`, role: "user", content: text, ts: new Date().toISOString() },
      { id: `a_${Date.now()}`, role: "assistant", content: "", ts: new Date().toISOString(), pending: true },
    ]);
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setSending(true);
    try {
      const res = await fetch("/api/chat?action=daily", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const j = await res.json();
      if (!res.ok) {
        setMessages((m) => m.map((mm, i) => (i === m.length - 1 ? { ...mm, content: j.error ?? "Something went wrong", pending: false } : mm)));
      } else {
        setMessages((m) =>
          m.map((mm, i) =>
            i === m.length - 1 ? { ...mm, content: j.reply || "Done.", pending: false, chartSpec: j.chartSpec ?? null } : mm
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

  /* ---------- statement upload ---------- */
  const handleStatementUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isPdf = file.type === "application/pdf";
    const isImage = file.type === "image/jpeg" || file.type === "image/png" || file.type === "image/webp";
    if (isPdf && !pdfUploadEnabled) { toast.error("PDF uploads are currently disabled"); return; }
    if (isImage && !ocrEnabled) { toast.error("Image uploads aren't enabled yet"); return; }
    if (!isPdf && !isImage) { toast.error("Please choose a PDF or image file"); return; }

    setUploadingStatement(true);
    nearBottomRef.current = true;
    setMessages((m) => [
      ...m,
      { id: `u_${Date.now()}`, role: "user", content: `📎 ${file.name}`, ts: new Date().toISOString() },
      { id: `a_${Date.now()}`, role: "assistant", content: "", ts: new Date().toISOString(), pending: true },
    ]);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/chat/upload-statement", { method: "POST", body: fd });
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
      setMessages((m) => m.map((mm, i) => (i === m.length - 1 ? { ...mm, content: detail, pending: false } : mm)));
    } catch (e: any) {
      toast.error(e?.message ?? "Upload failed");
      setMessages((m) => m.slice(0, -1));
    } finally {
      setUploadingStatement(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  /* ---------- push notifications ---------- */
  const savePrefs = async (patch: Record<string, unknown>) => {
    try {
      await fetch("/api/auth/prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch { /* best-effort */ }
  };

  const subscribeToPush = async () => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      toast.error("This browser doesn't support notifications");
      return;
    }
    setPushLoading(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const keyRes = await fetch("/api/notifications/vapid-public-key");
      if (!keyRes.ok) throw new Error("Push isn't configured on this deployment");
      const { publicKey } = await keyRes.json();
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: publicKey,
      });
      const res = await fetch("/api/notifications/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
      if (!res.ok) throw new Error("Couldn't save the subscription");
      setPushSubscribed(true);
      toast.success("Notifications on 🔔");
    } catch (e: any) {
      toast.error(e?.message ?? "Couldn't enable notifications");
    } finally {
      setPushLoading(false);
    }
  };

  const sendTestNotification = async () => {
    setPushLoading(true);
    try {
      const res = await fetch("/api/notifications/test", { method: "POST" });
      const j = await res.json();
      if (res.ok) toast.success("Sent! Check your notifications");
      else toast.error(j.error ?? "Couldn't send the test");
    } finally {
      setPushLoading(false);
    }
  };

  /* ---------- render helpers ---------- */
  const wp = WALLPAPERS[wallpaper] ?? WALLPAPERS.doodle;
  const EXAMPLES = [
    "aaj 20 rs rapido ke kharch hue",
    "2000 SIP mein dale",
    "kitna balance hai SBI mein?",
  ];

  let lastDay = "";

  /**
   * WhatsApp-style message GROUPING: consecutive messages from the same
   * side collapse into a group — tail only on the last one, tighter
   * vertical rhythm within the group, full margin between groups.
   */
  const renderMessage = (m: ChatMsg, idx: number) => {
    const day = dayLabel(m.ts);
    const showDay = day && day !== lastDay;
    if (showDay) lastDay = day;
    const isUser = m.role === "user";
    const next = messages[idx + 1];
    const isLastInGroup =
      !next || next.role !== m.role || next.queued !== m.queued || dayLabel(next.ts) !== day;
    return (
      <div key={m.id}>
        {showDay && (
          <div className="flex justify-center py-2.5">
            <span className="date-chip">{day}</span>
          </div>
        )}
        <div className={`flex ${isUser ? "justify-end" : "justify-start"} anim-msg-in msg-row ${isLastInGroup ? "group-end" : ""}`}>
          <div className={`bubble ${isUser ? "bubble-out" : "bubble-in"} max-w-[82%] sm:max-w-[70%] ${isLastInGroup ? "" : "no-tail"}`}>
            {m.pending && !m.content ? (
              <span className="inline-flex items-center gap-1.5 py-1">
                <span className="typing-dot w-1.5 h-1.5 rounded-full bg-muted-foreground inline-block" />
                <span className="typing-dot w-1.5 h-1.5 rounded-full bg-muted-foreground inline-block" />
                <span className="typing-dot w-1.5 h-1.5 rounded-full bg-muted-foreground inline-block" />
              </span>
            ) : (
              <>
                <div className="text-[14.5px] leading-[1.42] text-foreground whitespace-pre-wrap break-words">
                  <Markdown text={m.content} />
                  {m.chartSpec && <InlineChartReveal spec={m.chartSpec} />}
                  {m.queued && (
                    <span className="inline-flex items-center gap-1 text-[10px] opacity-70 mt-1 block">
                      <Clock3 className="w-3 h-3" /> queued
                    </span>
                  )}
                </div>
                <span className="bubble-meta">
                  {timeOf(m.ts)}
                  {isUser && !m.queued && (
                    <span className={m.pending ? "text-muted-foreground" : "text-[var(--tick)]"}>
                      <Ticks />
                    </span>
                  )}
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    );
  };

  /* ============================================================
     RENDER
     ============================================================ */
  return (
    <div className="h-dvh flex flex-col bg-background">
      {/* ---------- Header (WhatsApp green) ---------- */}
      <header className="safe-top shrink-0 bg-[var(--header)] text-[var(--header-foreground)]" style={{ boxShadow: "var(--shadow-2)" }}>
        <div className="max-w-2xl mx-auto px-3 h-14 flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <div className="brand-chip w-9 h-9 flex items-center justify-center shrink-0" style={{ borderRadius: 12 }} aria-hidden>
              <span className="font-display font-extrabold text-white leading-none" style={{ fontSize: 17, marginBottom: 1 }}>₹</span>
            </div>
            <div className="min-w-0">
              <p className="font-display font-bold text-[15.5px] truncate leading-tight tracking-[-0.01em]">Khata</p>
              <p className="text-[11px] opacity-80 flex items-center gap-1 leading-tight">
                {sending ? (
                  <span className="inline-flex items-center gap-1">
                    <span className="typing-dot w-1 h-1 rounded-full bg-white inline-block" />
                    <span className="typing-dot w-1 h-1 rounded-full bg-white inline-block" />
                    <span className="typing-dot w-1 h-1 rounded-full bg-white inline-block" />
                    typing…
                  </span>
                ) : online ? (
                  <>
                    <span className="w-1.5 h-1.5 rounded-full bg-[#25d366] inline-block" />
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
                className="press h-9 px-2.5 rounded-full flex items-center gap-1.5 text-xs font-medium hover:bg-white/10 transition-colors"
                title="Install Khata on this device"
                aria-label="Install Khata on this device"
              >
                <Download className="w-4 h-4" />
                <span className="hidden sm:inline">Install</span>
              </button>
            )}
            <a
              href="/dashboard"
              className="press h-9 px-2.5 rounded-full flex items-center gap-1.5 text-xs font-medium hover:bg-white/10 transition-colors"
              title="Open dashboard (6-digit MPIN)"
              aria-label="Open dashboard"
            >
              <BarChart3 className="w-4 h-4" />
              <span className="hidden sm:inline">Dashboard</span>
            </a>
            <button
              onClick={toggleTheme}
              className="press h-9 w-9 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors"
              title="Toggle theme"
              aria-label="Toggle theme"
            >
              <Moon className="w-4 h-4 dark:hidden" />
              <Sun className="w-4 h-4 hidden dark:block" />
            </button>
            <button
              onClick={() => setShowSettings(true)}
              className="press h-9 w-9 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors"
              title="Settings"
              aria-label="Settings"
            >
              <SettingsIcon className="w-4 h-4" />
            </button>
            <button
              onClick={onLogout}
              className="press h-9 w-9 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors"
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* ---------- Settings sheet ---------- */}
      {showSettings && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center anim-fade-in"
          onClick={() => setShowSettings(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
        >
          <div
            className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[85vh] overflow-y-auto anim-sheet-in shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-card px-5 pt-4 pb-3 flex items-center justify-between border-b border-border z-10">
              <div className="w-10" />
              <div className="absolute left-1/2 -translate-x-1/2 top-2 w-10 h-1 rounded-full bg-border sm:hidden" />
              <p className="font-medium text-[15px]">Settings</p>
              <button
                onClick={() => setShowSettings(false)}
                className="press h-8 w-8 rounded-full flex items-center justify-center text-muted-foreground hover:bg-accent transition-colors"
                aria-label="Close settings"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-6">
              {/* Appearance */}
              <div>
                <p className="text-sm font-medium mb-2">Appearance</p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => { document.documentElement.classList.remove("dark"); try { localStorage.setItem("khata-theme", "light"); } catch {} }}
                    className="press h-10 rounded-xl border text-sm font-medium flex items-center justify-center gap-2 border-[var(--primary)] bg-accent text-accent-foreground dark:border-input dark:bg-transparent dark:text-muted-foreground"
                  >
                    <Sun className="w-4 h-4" /> Light
                  </button>
                  <button
                    onClick={() => { document.documentElement.classList.add("dark"); try { localStorage.setItem("khata-theme", "dark"); } catch {} }}
                    className="press h-10 rounded-xl border text-sm font-medium flex items-center justify-center gap-2 border-input text-muted-foreground dark:border-[var(--primary)] dark:bg-accent dark:text-accent-foreground"
                  >
                    <Moon className="w-4 h-4" /> Dark
                  </button>
                </div>
              </div>

              {/* Chat wallpaper */}
              <div className="border-t border-border pt-5">
                <p className="text-sm font-medium flex items-center gap-1.5">
                  <ImageIcon className="w-4 h-4 text-[var(--primary)]" /> Chat wallpaper
                </p>
                <p className="text-xs text-muted-foreground mt-0.5 mb-3">Saved to your account.</p>
                <div className="grid grid-cols-3 gap-2">
                  {Object.entries(WALLPAPERS).map(([key, w]) => (
                    <button
                      key={key}
                      onClick={() => {
                        setWallpaper(key);
                        savePrefs({ wallpaper: key });
                      }}
                      className={`press h-12 rounded-xl border text-xs font-medium chat-canvas ${w.light} ${w.dark} flex items-center justify-center transition-colors ${
                        wallpaper === key ? "border-[var(--primary)] ring-2 ring-[var(--primary)]/30" : "border-input text-muted-foreground"
                      }`}
                    >
                      {w.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Voice language */}
              <div className="border-t border-border pt-5">
                <p className="text-sm font-medium flex items-center gap-1.5">
                  <Languages className="w-4 h-4 text-[var(--primary)]" /> Voice language
                </p>
                <p className="text-xs text-muted-foreground mt-0.5 mb-3">
                  Hinglish works best on English (India) — Hindi words come out in English letters.
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
                        savePrefs({ voiceLang: l.id });
                      }}
                      className={`press h-10 rounded-xl border text-xs font-medium flex items-center justify-center transition-colors ${
                        voiceLang === l.id
                          ? "border-[var(--primary)] bg-accent text-accent-foreground"
                          : "border-input text-muted-foreground"
                      }`}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground/70 mt-2">
                  Tip: hold the mic to talk; release to stop. Tap the mic to toggle.
                </p>
              </div>

              {/* Install app */}
              {canInstall && (
                <div className="border-t border-border pt-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium flex items-center gap-1.5">
                        <Download className="w-4 h-4 text-[var(--primary)]" /> Install app
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">Add Khata to your home screen</p>
                    </div>
                    <button onClick={promptInstall} className="press h-8 px-3 rounded-lg bg-[var(--primary)] text-white text-xs font-medium">
                      Install
                    </button>
                  </div>
                </div>
              )}

              {/* Notifications */}
              <div className="border-t border-border pt-5">
                <p className="text-sm font-medium mb-1">Notifications</p>
                <p className="text-xs text-muted-foreground mb-3">
                  Gentle reminders to log your transactions, plus scheduled summaries.
                </p>
                {!pushEnabled ? (
                  <div className="text-xs text-muted-foreground/80 bg-muted border border-border rounded-xl p-3">
                    Notifications aren&apos;t available on this deployment yet.
                  </div>
                ) : pushSubscribed ? (
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-[var(--success)] font-medium flex items-center gap-1.5">
                      <CheckCheck className="w-3.5 h-3.5" /> Enabled on this device
                    </span>
                    <button
                      onClick={sendTestNotification}
                      disabled={pushLoading}
                      className="press h-8 px-3 rounded-lg border border-input text-xs font-medium hover:bg-accent transition-colors disabled:opacity-60"
                    >
                      {pushLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : "Send test"}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={subscribeToPush}
                    disabled={pushLoading}
                    className="press h-9 px-4 rounded-xl bg-[var(--primary)] text-white text-xs font-medium flex items-center gap-2 disabled:opacity-60"
                  >
                    {pushLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                    Enable notifications
                  </button>
                )}
                <p className="text-[11px] text-muted-foreground/70 mt-3">
                  Tip: ask me things like &quot;remind me at 8pm daily&quot; or &quot;send my day&apos;s summary at 9:10pm&quot;.
                </p>
              </div>

              {/* AI keys hint */}
              <div className="border-t border-border pt-5">
                <p className="text-sm font-medium flex items-center gap-1.5">
                  <Bot className="w-4 h-4 text-[var(--primary)]" /> Your own AI keys
                </p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                  Prefer your own OpenAI-compatible key for chat, speech or vision? Set it up in{" "}
                  <a href="/dashboard/settings" className="text-[var(--primary)] underline underline-offset-2">
                    Dashboard → Settings
                  </a>
                  .
                </p>
              </div>

              {/* Sign out */}
              <div className="border-t border-border pt-5">
                <button
                  onClick={onLogout}
                  className="press w-full h-11 rounded-xl border border-destructive/40 text-destructive text-sm font-medium flex items-center justify-center gap-2 hover:bg-destructive/5 transition-colors"
                >
                  <LogOut className="w-4 h-4" /> Sign out
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ---------- Messages (doodle canvas) ---------- */}
      <main
        ref={scrollMainRef}
        onScroll={onMainScroll}
        className={`chat-canvas relative flex-1 overflow-y-auto ${wp.light} ${wp.dark}`}
        style={{ minHeight: 0 }}
      >
        <div className="max-w-2xl mx-auto px-3.5 py-3">
          {hasMoreHistory && historyLoaded && messages.length > 0 && (
            <div className="flex justify-center pb-1.5">
              <span className="date-chip !normal-case">
                Showing your last 50 messages · full history exports from Dashboard
              </span>
            </div>
          )}

          {!historyLoaded && (
            <div className="space-y-2 pt-2" aria-hidden>
              <div className="flex justify-start"><div className="skeleton-bubble h-10 w-2/5" /></div>
              <div className="flex justify-end"><div className="skeleton-bubble h-9 w-1/3" /></div>
              <div className="flex justify-start"><div className="skeleton-bubble h-12 w-3/5" /></div>
              <div className="flex justify-end"><div className="skeleton-bubble h-9 w-2/5" /></div>
              <div className="flex justify-start"><div className="skeleton-bubble h-10 w-1/2" /></div>
            </div>
          )}

          {historyLoaded && messages.length === 0 && (
            <div className="pt-8 anim-fade-up flex flex-col items-center">
              {/* privacy notice */}
              <div className="max-w-[85%] rounded-2xl bg-[#fdf4c5] dark:bg-[#1f2c19] border border-[#f0d860]/60 dark:border-[#3a4a25] px-4 py-3 text-[12.5px] text-[#5e5000] dark:text-[#c9d19a] leading-relaxed text-center">
                Your diary is private to your account. Only you can see these messages.
              </div>

              {/* breathing hero */}
              <div className="brand-chip w-20 h-20 flex items-center justify-center mt-7 anim-breathe" style={{ borderRadius: 26 }} aria-hidden>
                <span className="font-display font-extrabold text-white leading-none" style={{ fontSize: 38, marginBottom: 2 }}>₹</span>
              </div>
              <p className="font-display font-bold text-foreground text-[19px] mt-5 tracking-[-0.02em]">
                Hi{user.username ? ` ${user.username}` : ""} — what happened today?
              </p>
              <p className="text-muted-foreground text-[13px] mt-1">
                Tell me in any mix of English or Hindi.
              </p>
              <div className="mt-5 space-y-2 w-full max-w-xs">
                {EXAMPLES.map((ex, i) => (
                  <button
                    key={ex}
                    onClick={() => { setInput(ex); textareaRef.current?.focus(); }}
                    className={`press w-full text-left text-[12.5px] text-muted-foreground bg-card/95 border border-border rounded-2xl px-4 py-3 hover:border-[var(--primary)]/50 hover:text-foreground transition-colors anim-fade-up-d${i + 1}`}
                  >
                    &ldquo;{ex}&rdquo;
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground/70 mt-5 flex items-center justify-center gap-1.5">
                <Mic className="w-3 h-3" /> Tap the mic to speak
              </p>
            </div>
          )}

          {messages.map(renderMessage)}
          <div ref={messagesEndRef} />
        </div>

        {/* Jump-to-bottom FAB */}
        {showJumpDown && (
          <button
            onClick={() => scrollToBottom("smooth")}
            className="press fixed right-4 bottom-24 z-10 w-10 h-10 rounded-full bg-card shadow-md border border-border flex items-center justify-center text-muted-foreground anim-pop-in"
            aria-label="Scroll to latest messages"
          >
            <ChevronDown className="w-5 h-5" />
          </button>
        )}
      </main>

      {/* ---------- Input bar ---------- */}
      <footer className="shrink-0 bg-[#f0f2f5] dark:bg-[#111b21] safe-bottom">
        <div className="max-w-2xl mx-auto px-2.5 py-2 flex items-end gap-1.5">
          <input
            ref={fileInputRef}
            type="file"
            accept={(pdfUploadEnabled ? "application/pdf," : "") + (ocrEnabled ? "image/jpeg,image/png,image/webp" : "")}
            onChange={handleStatementUpload}
            className="hidden"
          />

          {listening || transcribing ? (
            /* --- WhatsApp-style recording pill (remade) --- */
            <>
              <button
                type="button"
                onClick={cancelRecording}
                disabled={transcribing}
                className="pill-btn pill-btn-ghost shrink-0"
                title="Discard recording"
                aria-label="Discard recording"
              >
                <Trash2 className="w-5 h-5" />
              </button>
              <div className="composer flex-1 !items-center gap-3 overflow-hidden anim-pop-in" title={input}>
                <span className="relative flex h-2.5 w-2.5 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-destructive opacity-60" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-destructive" />
                </span>
                <span className="text-sm font-medium text-foreground tnum w-11 shrink-0">
                  {Math.floor(recSeconds / 60)}:{String(recSeconds % 60).padStart(2, "0")}
                </span>
                {/* live transcript preview (native STT) or waveform */}
                <div className="flex-1 min-w-0 flex items-center h-5" aria-hidden>
                  {input.trim() && !transcribing ? (
                    <span className="text-[12.5px] text-muted-foreground truncate">{input.trim()}</span>
                  ) : (
                    <div className="flex-1 flex items-center justify-center gap-[3px]">
                      {Array.from({ length: 9 }).map((_, i) => (
                        <span key={i} className="sound-wave-bar" style={{ animationDelay: `${(i % 5) * 0.11}s` }} />
                      ))}
                    </div>
                  )}
                </div>
                {transcribing && (
                  <span className="text-[11px] text-muted-foreground shrink-0 flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" /> decoding
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => stopListening({ send: true })}
                disabled={transcribing}
                className="pill-btn pill-btn-send shrink-0 disabled:opacity-50"
                title="Stop and send"
                aria-label="Stop and send"
              >
                {transcribing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
              </button>
            </>
          ) : (
            <>
              <div className="composer flex-1">
                {(pdfUploadEnabled || ocrEnabled) && (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingStatement}
                    className="pill-btn pill-btn-ghost !w-9 !h-9 shrink-0"
                    title={`Upload ${pdfUploadEnabled ? "bank statement PDF" : ""}${pdfUploadEnabled && ocrEnabled ? " or " : ""}${ocrEnabled ? "receipt image" : ""}`}
                    aria-label="Upload a statement or receipt"
                  >
                    {uploadingStatement ? <Loader2 className="w-5 h-5 animate-spin" /> : <Paperclip className="w-[21px] h-[21px]" />}
                  </button>
                )}
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    const el = e.currentTarget;
                    el.style.height = "auto";
                    el.style.height = `${Math.min(el.scrollHeight, 110)}px`;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage();
                    }
                  }}
                  placeholder={uploadingStatement ? "Reading your file…" : "Tell me about a transaction…"}
                  rows={1}
                  enterKeyHint="send"
                />
              </div>
              {input.trim() ? (
                <button
                  type="button"
                  onClick={sendMessage}
                  disabled={sending}
                  aria-label="Send message"
                  className="pill-btn pill-btn-send shrink-0 disabled:opacity-40"
                >
                  {sending ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onMicClick}
                  disabled={sending || uploadingStatement}
                  onContextMenu={(e) => e.preventDefault()}
                  className="pill-btn pill-btn-send shrink-0 select-none touch-none"
                  title="Tap to record"
                  aria-label="Record a voice message"
                >
                  <Mic className="w-5 h-5" />
                </button>
              )}
            </>
          )}
        </div>
      </footer>
    </div>
  );
}
