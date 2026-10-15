"use client";

/**
 * SettingsApp (dashboard) — user-owned settings:
 *  1. AI Models   — bring your own OpenAI-compatible keys for the home chat
 *                   LLM, dashboard LLM, speech-to-text and vision/OCR.
 *                   Empty fields fall back to the server defaults.
 *  2. Custom instructions — per-agent behavior tweaks.
 *  3. Security    — change MPINs (password-confirmed).
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Loader2, Bot, KeyRound, FlaskConical, RotateCcw, ChevronDown, Lock,
  Mic, Camera, ArrowLeft, Eye,
} from "lucide-react";
import PinField from "../../components/PinField";

interface AiPatchUi {
  provider?: "openai-compatible" | "anthropic";
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  maxTokensMode?: "max_tokens" | "max_completion_tokens";
  toolCallingSupported?: boolean;
  engine?: "native" | "openai-compatible";
}

interface AllAi {
  daily: AiPatchUi | null;
  dashboard: AiPatchUi | null;
  stt: AiPatchUi | null;
  vision: AiPatchUi | null;
  instructions: { daily?: string; dashboard?: string };
}

type SectionKey = "ai.daily" | "ai.dashboard" | "ai.stt" | "ai.vision";

const MASK = "••••••••";

function emptyPatch(): AiPatchUi {
  return { baseUrl: "", apiKey: "", model: "" };
}

function toUi(p: AiPatchUi | null): AiPatchUi {
  if (!p) return emptyPatch();
  return { ...emptyPatch(), ...p };
}

export default function SettingsApp({
  username,
  email,
  hasDashboardMpin,
}: {
  username: string;
  email: string;
  hasDashboardMpin: boolean;
}) {
  const [ai, setAi] = useState<AllAi | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState<Record<string, boolean>>({});

  // instructions
  const [insDaily, setInsDaily] = useState("");
  const [insDashboard, setInsDashboard] = useState("");

  // MPIN change
  const [showMpin, setShowMpin] = useState(false);
  const [mpinPassword, setMpinPassword] = useState("");
  const [pin4, setPin4] = useState("");
  const [pin4b, setPin4b] = useState("");
  const [pin6, setPin6] = useState("");
  const [pin6b, setPin6b] = useState("");
  const [mpinLoading, setMpinLoading] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/user/ai-config");
      if (!res.ok) return;
      const j: AllAi = await res.json();
      setAi(j);
      setInsDaily(j.instructions?.daily ?? "");
      setInsDashboard(j.instructions?.dashboard ?? "");
    })();
  }, []);

  const setPatch = (key: SectionKey, patch: AiPatchUi) => {
    setAi((a) => (a ? { ...a, [key.replace("ai.", "")]: patch } : a));
  };

  const saveSection = async (key: SectionKey) => {
    if (!ai) return;
    const short = key.replace("ai.", "");
    setSavingKey(key);
    try {
      const res = await fetch("/api/user/ai-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: ai[short as "daily" | "dashboard" | "stt" | "vision"] }),
      });
      const j = await res.json();
      if (res.ok) toast.success("Saved");
      else toast.error(j.error ?? "Couldn't save");
    } finally {
      setSavingKey(null);
    }
  };

  const resetSection = async (key: SectionKey) => {
    if (!confirm("Reset this service to the server defaults?")) return;
    setSavingKey(key);
    try {
      const res = await fetch(`/api/user/ai-config?key=${encodeURIComponent(key)}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Back to server defaults");
        const short = key.replace("ai.", "");
        setAi((a) => (a ? { ...a, [short]: null } : a));
      } else toast.error("Couldn't reset");
    } finally {
      setSavingKey(null);
    }
  };

  const testSection = async (key: SectionKey) => {
    if (!ai) return;
    const short = key.replace("ai.", "");
    setTesting(key);
    try {
      const res = await fetch("/api/user/ai-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          config: { apiKey: ai[short as "daily" | "dashboard" | "stt" | "vision"]?.apiKey },
        }),
      });
      const j = await res.json();
      if (j.ok) toast.success(`✓ ${j.message}`);
      else toast.error(`✗ ${j.message ?? "Test failed"}`);
    } finally {
      setTesting(null);
    }
  };

  const saveInstructions = async () => {
    setSavingKey("ai.instructions");
    try {
      const res = await fetch("/api/user/ai-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "ai.instructions",
          value: { daily: insDaily, dashboard: insDashboard },
        }),
      });
      if (res.ok) toast.success("Instructions saved");
      else toast.error("Couldn't save");
    } finally {
      setSavingKey(null);
    }
  };

  const changeMpins = async () => {
    if (mpinLoading) return;
    if (!mpinPassword) { toast.error("Enter your password"); return; }
    if (!/^\d{4}$/.test(pin4)) { toast.error("App MPIN is 4 digits"); return; }
    if (pin4 !== pin4b) { toast.error("App MPINs don't match"); return; }
    if (pin6 || pin6b) {
      if (!/^\d{6}$/.test(pin6)) { toast.error("Dashboard MPIN is 6 digits"); return; }
      if (pin6 !== pin6b) { toast.error("Dashboard MPINs don't match"); return; }
    }
    setMpinLoading(true);
    try {
      const res = await fetch("/api/auth/mpin?action=reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password: mpinPassword,
          appMpin: pin4,
          dashboardMpin: pin6 || undefined,
        }),
      });
      const j = await res.json();
      if (res.ok) {
        toast.success("MPINs updated");
        setShowMpin(false);
        setMpinPassword(""); setPin4(""); setPin4b(""); setPin6(""); setPin6b("");
      } else toast.error(j.error ?? "Couldn't change MPINs");
    } finally {
      setMpinLoading(false);
    }
  };

  if (!ai) {
    return (
      <div className="p-8 flex items-center justify-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading settings…
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-5 pb-16">
      <div className="flex items-center gap-3">
        <a
          href="/dashboard"
          className="press h-9 w-9 rounded-full border border-input flex items-center justify-center text-muted-foreground hover:text-foreground"
          aria-label="Back to dashboard"
        >
          <ArrowLeft className="w-4 h-4" />
        </a>
        <div>
          <h1 className="text-xl font-semibold">Settings</h1>
          <p className="text-[13px] text-muted-foreground">{username} · {email}</p>
        </div>
      </div>

      {/* ============ AI MODELS ============ */}
      <section className="bg-card rounded-2xl border border-border/60 shadow-sm overflow-hidden">
        <div className="p-5 pb-4 border-b border-border">
          <h2 className="text-[15px] font-semibold flex items-center gap-2">
            <Bot className="w-4 h-4 text-[var(--primary)]" /> AI models
          </h2>
          <p className="text-[12.5px] text-muted-foreground mt-1 leading-relaxed">
            Use your own OpenAI-compatible keys (Groq, OpenAI, OpenRouter, DeepSeek…). Empty fields
            fall back to the server defaults — set just a model to try it on the shared gateway, or
            set everything to go fully independent.
          </p>
        </div>

        <div className="divide-y divide-border">
          <ServiceCard
            title="Home chat"
            hint="The assistant in the daily app (‘/’)"
            icon={<Bot className="w-4 h-4" />}
            patch={toUi(ai.daily)}
            onChange={(p) => setPatch("ai.daily", p)}
            onSave={() => saveSection("ai.daily")}
            onReset={() => resetSection("ai.daily")}
            onTest={() => testSection("ai.daily")}
            saving={savingKey === "ai.daily"}
            testing={testing === "ai.daily"}
            advOpen={!!advanced["ai.daily"]}
            toggleAdv={() => setAdvanced((a) => ({ ...a, "ai.daily": !a["ai.daily"] }))}
          />

          <ServiceCard
            title="Dashboard agent"
            hint="The analysis assistant on this dashboard"
            icon={<Bot className="w-4 h-4" />}
            patch={toUi(ai.dashboard)}
            onChange={(p) => setPatch("ai.dashboard", p)}
            onSave={() => saveSection("ai.dashboard")}
            onReset={() => resetSection("ai.dashboard")}
            onTest={() => testSection("ai.dashboard")}
            saving={savingKey === "ai.dashboard"}
            testing={testing === "ai.dashboard"}
            advOpen={!!advanced["ai.dashboard"]}
            toggleAdv={() => setAdvanced((a) => ({ ...a, "ai.dashboard": !a["ai.dashboard"] }))}
          />

          <ServiceCard
            title="Speech-to-text"
            hint="Mic input in the daily app"
            icon={<Mic className="w-4 h-4" />}
            patch={toUi(ai.stt)}
            onChange={(p) => setPatch("ai.stt", p)}
            onSave={() => saveSection("ai.stt")}
            onReset={() => resetSection("ai.stt")}
            onTest={() => testSection("ai.stt")}
            saving={savingKey === "ai.stt"}
            testing={testing === "ai.stt"}
            stt
            advOpen={!!advanced["ai.stt"]}
            toggleAdv={() => setAdvanced((a) => ({ ...a, "ai.stt": !a["ai.stt"] }))}
          />

          <ServiceCard
            title="Vision / OCR"
            hint="Reading receipt images you upload"
            icon={<Camera className="w-4 h-4" />}
            patch={toUi(ai.vision)}
            onChange={(p) => setPatch("ai.vision", p)}
            onSave={() => saveSection("ai.vision")}
            onReset={() => resetSection("ai.vision")}
            onTest={() => testSection("ai.vision")}
            saving={savingKey === "ai.vision"}
            testing={testing === "ai.vision"}
            advOpen={!!advanced["ai.vision"]}
            toggleAdv={() => setAdvanced((a) => ({ ...a, "ai.vision": !a["ai.vision"] }))}
          />
        </div>
      </section>

      {/* ============ CUSTOM INSTRUCTIONS ============ */}
      <section className="bg-card rounded-2xl border border-border/60 shadow-sm p-5">
        <h2 className="text-[15px] font-semibold flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-[var(--primary)]" /> Custom instructions
        </h2>
        <p className="text-[12.5px] text-muted-foreground mt-1 leading-relaxed">
          How the assistants should behave for you — tone, language, reply length, nicknames
          (e.g. &quot;call me bro, reply in Hinglish, always show today&apos;s totals at the end&quot;).
        </p>
        <div className="mt-4 space-y-4">
          <div>
            <label className="block text-[12px] font-medium text-muted-foreground mb-1.5">Home chat</label>
            <textarea
              value={insDaily}
              onChange={(e) => setInsDaily(e.target.value)}
              rows={3}
              placeholder="e.g. Reply short and casual. Use Hinglish. My SIP day is the 5th."
              className="w-full rounded-xl border border-transparent bg-[var(--field)] px-3.5 py-2.5 text-[13.5px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary)]/15 resize-none transition-colors"
            />
          </div>
          <div>
            <label className="block text-[12px] font-medium text-muted-foreground mb-1.5">Dashboard agent</label>
            <textarea
              value={insDashboard}
              onChange={(e) => setInsDashboard(e.target.value)}
              rows={3}
              placeholder="e.g. Always compare this month vs last month. Prefer tables."
              className="w-full rounded-xl border border-transparent bg-[var(--field)] px-3.5 py-2.5 text-[13.5px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary)]/15 resize-none transition-colors"
            />
          </div>
          <button
            type="button"
            onClick={saveInstructions}
            disabled={savingKey === "ai.instructions"}
            className="press h-10 px-4 rounded-xl bg-[var(--primary)] text-white text-[13.5px] font-medium flex items-center gap-2 disabled:opacity-60"
          >
            {savingKey === "ai.instructions" ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            Save instructions
          </button>
        </div>
      </section>

      {/* ============ SECURITY / MPIN ============ */}
      <section className="bg-card rounded-2xl border border-border/60 shadow-sm p-5">
        <h2 className="text-[15px] font-semibold flex items-center gap-2">
          <Lock className="w-4 h-4 text-[var(--primary)]" /> Security
        </h2>
        <p className="text-[12.5px] text-muted-foreground mt-1">
          4-digit MPIN opens the app · 6-digit MPIN{hasDashboardMpin ? "" : " (not set — password is used for the dashboard)"} unlocks this dashboard.
        </p>
        {!showMpin ? (
          <button
            type="button"
            onClick={() => setShowMpin(true)}
            className="press mt-4 h-10 px-4 rounded-xl border border-input text-[13.5px] font-medium flex items-center gap-2 hover:bg-accent transition-colors"
          >
            Change MPINs
          </button>
        ) : (
          <div className="mt-4 space-y-4 anim-fade-up">
            <div>
              <label className="block text-[12px] font-medium text-muted-foreground mb-1.5">Confirm your password</label>
              <input
                type="password"
                value={mpinPassword}
                onChange={(e) => setMpinPassword(e.target.value)}
                autoComplete="current-password"
                placeholder="••••••••"
                className="w-full h-11 rounded-xl border border-transparent bg-[var(--field)] px-3.5 text-[14px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary)]/15 transition-colors"
              />
            </div>
            <div>
              <p className="text-[12px] font-medium text-muted-foreground mb-2">New app MPIN · 4 digits</p>
              <PinField length={4} value={pin4} onChange={setPin4} disabled={mpinLoading} />
              <div className="mt-2"><PinField length={4} value={pin4b} onChange={setPin4b} disabled={mpinLoading} /></div>
            </div>
            <div>
              <p className="text-[12px] font-medium text-muted-foreground mb-2">
                New dashboard MPIN · 6 digits <span className="font-normal">(leave empty to keep password login)</span>
              </p>
              <PinField length={6} value={pin6} onChange={setPin6} disabled={mpinLoading} />
              <div className="mt-2"><PinField length={6} value={pin6b} onChange={setPin6b} disabled={mpinLoading} /></div>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={changeMpins}
                disabled={mpinLoading}
                className="press h-10 px-4 rounded-xl bg-[var(--primary)] text-white text-[13.5px] font-medium flex items-center gap-2 disabled:opacity-60"
              >
                {mpinLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Update MPINs
              </button>
              <button
                type="button"
                onClick={() => setShowMpin(false)}
                className="press h-10 px-4 rounded-xl border border-input text-[13.5px] font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

/* ============================================================
   ServiceCard — one AI service's override form
   ============================================================ */
function ServiceCard({
  title, hint, icon, patch, onChange, onSave, onReset, onTest, saving, testing, stt, advOpen, toggleAdv,
}: {
  title: string;
  hint: string;
  icon: React.ReactNode;
  patch: AiPatchUi;
  onChange: (p: AiPatchUi) => void;
  onSave: () => void;
  onReset: () => void;
  onTest: () => void;
  saving: boolean;
  testing: boolean;
  stt?: boolean;
  advOpen: boolean;
  toggleAdv: () => void;
}) {
  return (
    <div className="p-5">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-muted-foreground shrink-0">{icon}</span>
          <div className="min-w-0">
            <p className="text-[13.5px] font-medium leading-tight">{title}</p>
            <p className="text-[11.5px] text-muted-foreground truncate">{hint}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onReset}
          className="press h-8 px-2.5 rounded-lg border border-input text-[11.5px] text-muted-foreground flex items-center gap-1 shrink-0 hover:text-foreground"
          title="Reset to server defaults"
        >
          <RotateCcw className="w-3 h-3" /> Default
        </button>
      </div>

      {stt && (
        <div className="mb-3">
          <label className="block text-[11.5px] font-medium text-muted-foreground mb-1.5">Engine</label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => onChange({ ...patch, engine: "native" })}
              className={`press h-10 rounded-xl border text-[12.5px] font-medium ${
                patch.engine !== "openai-compatible" ? "border-[var(--primary)] bg-accent text-accent-foreground" : "border-input text-muted-foreground"
              }`}
            >
              Device (free)
            </button>
            <button
              type="button"
              onClick={() => onChange({ ...patch, engine: "openai-compatible" })}
              className={`press h-10 rounded-xl border text-[12.5px] font-medium ${
                patch.engine === "openai-compatible" ? "border-[var(--primary)] bg-accent text-accent-foreground" : "border-input text-muted-foreground"
              }`}
            >
              OpenAI-compatible
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <label className="block text-[11.5px] font-medium text-muted-foreground mb-1.5">
            Base URL {stt ? "(we auto-fix /chat/completions pastes)" : ""}
          </label>
          <input
            value={patch.baseUrl ?? ""}
            onChange={(e) => onChange({ ...patch, baseUrl: e.target.value })}
            placeholder={stt ? "https://api.groq.com/openai/v1" : "https://api.groq.com/openai/v1"}
            className="w-full h-10 rounded-xl border border-transparent bg-[var(--field)] px-3 text-[13px] font-mono text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary)]/15 transition-colors"
          />
        </div>
        <div>
          <label className="block text-[11.5px] font-medium text-muted-foreground mb-1.5">API key</label>
          <input
            type="password"
            value={patch.apiKey ?? ""}
            onChange={(e) => onChange({ ...patch, apiKey: e.target.value })}
            placeholder="sk-…"
            autoComplete="off"
            className="w-full h-10 rounded-xl border border-transparent bg-[var(--field)] px-3 text-[13px] font-mono text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary)]/15 transition-colors"
          />
        </div>
        <div>
          <label className="block text-[11.5px] font-medium text-muted-foreground mb-1.5">Model</label>
          <input
            value={patch.model ?? ""}
            onChange={(e) => onChange({ ...patch, model: e.target.value })}
            placeholder={stt ? "whisper-large-v3" : "llama-3.3-70b-versatile"}
            className="w-full h-10 rounded-xl border border-transparent bg-[var(--field)] px-3 text-[13px] font-mono text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary)]/15 transition-colors"
          />
        </div>
      </div>

      {!stt && (
        <button
          type="button"
          onClick={toggleAdv}
          className="mt-3 text-[11.5px] text-muted-foreground hover:text-foreground flex items-center gap-1"
        >
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${advOpen ? "rotate-180" : ""}`} />
          Advanced
        </button>
      )}
      {!stt && advOpen && (
        <div className="mt-2 grid grid-cols-2 gap-3 anim-fade-in">
          <div>
            <label className="block text-[11.5px] font-medium text-muted-foreground mb-1.5">Provider</label>
            <select
              value={patch.provider ?? "openai-compatible"}
              onChange={(e) => onChange({ ...patch, provider: e.target.value as AiPatchUi["provider"] })}
              className="w-full h-10 rounded-xl border border-input bg-card px-2.5 text-[12.5px] focus:outline-none focus:border-[var(--primary)]"
            >
              <option value="openai-compatible">OpenAI-compatible</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </div>
          <div>
            <label className="block text-[11.5px] font-medium text-muted-foreground mb-1.5">Max tokens mode</label>
            <select
              value={patch.maxTokensMode ?? "max_tokens"}
              onChange={(e) => onChange({ ...patch, maxTokensMode: e.target.value as AiPatchUi["maxTokensMode"] })}
              className="w-full h-10 rounded-xl border border-input bg-card px-2.5 text-[12.5px] focus:outline-none focus:border-[var(--primary)]"
            >
              <option value="max_tokens">max_tokens</option>
              <option value="max_completion_tokens">max_completion_tokens (o1-style)</option>
            </select>
          </div>
          <div>
            <label className="block text-[11.5px] font-medium text-muted-foreground mb-1.5">Temperature</label>
            <input
              type="number" step="0.1" min="0" max="2"
              value={patch.temperature ?? ""}
              onChange={(e) => onChange({ ...patch, temperature: e.target.value === "" ? undefined : Number(e.target.value) })}
              placeholder="default"
              className="w-full h-10 rounded-xl border border-transparent bg-[var(--field)] px-3 text-[13px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary)]/15 transition-colors"
            />
          </div>
          <div>
            <label className="block text-[11.5px] font-medium text-muted-foreground mb-1.5">Max tokens</label>
            <input
              type="number" min="1"
              value={patch.maxTokens ?? ""}
              onChange={(e) => onChange({ ...patch, maxTokens: e.target.value === "" ? undefined : Number(e.target.value) })}
              placeholder="default"
              className="w-full h-10 rounded-xl border border-transparent bg-[var(--field)] px-3 text-[13px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary)]/15 transition-colors"
            />
          </div>
          <label className="col-span-2 flex items-center gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={patch.toolCallingSupported ?? true}
              onChange={(e) => onChange({ ...patch, toolCallingSupported: e.target.checked })}
              className="w-4 h-4 accent-[var(--primary)]"
            />
            <span className="text-[12px] text-muted-foreground">
              Model supports tool/function calling (leave ON for most models; OFF only for Gemma-style models)
            </span>
          </label>
        </div>
      )}

      <div className="flex gap-2 mt-4">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="press h-9 px-4 rounded-xl bg-[var(--primary)] text-white text-[12.5px] font-medium flex items-center gap-1.5 disabled:opacity-60"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
          Save
        </button>
        <button
          type="button"
          onClick={onTest}
          disabled={testing}
          className="press h-9 px-4 rounded-xl border border-input text-[12.5px] font-medium flex items-center gap-1.5 disabled:opacity-60"
        >
          {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FlaskConical className="w-3.5 h-3.5" />}
          Test
        </button>
      </div>
    </div>
  );
}
