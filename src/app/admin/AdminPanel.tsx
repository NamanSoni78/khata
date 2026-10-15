"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  Users, Cpu, Flag, BookOpen, Clock, Database, LogOut, FlaskConical, Plus, Save, RefreshCw,
} from "lucide-react";
import {
  GENERAL_PRESETS, OCR_PRESETS, applyPreset, COST_STYLES, type ModelPreset,
} from "@/lib/llm/presets";

interface AgentConfig {
  provider: "openai-compatible" | "anthropic";
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokensMode: "max_tokens" | "max_completion_tokens";
  maxTokens: number;
  toolCallingSupported: boolean;
  systemPrompt: string;
  extraHeaders?: string;
}
interface SttConfig extends AgentConfig { engine: "native" | "openai-compatible"; }
interface OcrConfig extends AgentConfig { enabled: boolean; }
interface FeatureFlags {
  pdfUpload: boolean;
  ocr: boolean;
  sttNative: boolean;
  webPush: boolean;
  autoAppendTotals: boolean;
  defaultLanguage: "english" | "hinglish" | "hindi";
}
interface SchemaMode { mode: "llm" | "rag"; lastNTxns: number; refreshEveryCall: boolean; chatHistoryLimit?: number; }
interface UxConfig { replyDelayMs?: number; }
interface GlossaryEntry { term: string; desc: string; }

export default function AdminPanel() {
  const [tab, setTab] = useState("agents");
  const [all, setAll] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const res = await fetch("/api/admin/config");
      if (active && res.ok) {
        setAll(await res.json());
      }
      if (active) setLoading(false);
    })();
    return () => { active = false; };
  }, []);

  const reload = async () => {
    setLoading(true);
    const res = await fetch("/api/admin/config");
    if (res.ok) setAll(await res.json());
    setLoading(false);
  };

  const saveKey = async (key: string, value: any) => {
    const res = await fetch("/api/admin/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
    if (res.ok) {
      toast.success(`Saved ${key}`);
      setAll((p) => ({ ...p, [key]: value }));
    } else toast.error(`Failed to save ${key}`);
  };

  const testAgent = async (which: string, cfg: AgentConfig) => {
    setTesting(which);
    try {
      const res = await fetch("/api/admin/test-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ which, ...cfg }),
      });
      const r = await res.json();
      if (r.ok) toast.success(`✓ ${which}: ${r.message}`);
      else toast.error(`✗ ${which}: ${r.message}`);
    } catch (e: any) {
      toast.error(`${which}: ${e?.message ?? "error"}`);
    }
    setTesting(null);
  };

  if (loading) return <div className="p-8 text-muted-foreground">Loading…</div>;

  const daily = (all["agent.daily"] ?? {}) as AgentConfig;
  const dashboard = (all["agent.dashboard"] ?? {}) as AgentConfig;
  const stt = (all["agent.stt"] ?? {}) as SttConfig;
  const ocr = (all["agent.ocr"] ?? {}) as OcrConfig;
  const flags = (all["featureFlags"] ?? {}) as FeatureFlags;
  const schemaMode = (all["schemaMode"] ?? {}) as SchemaMode;
  const uxConfig = (all["uxConfig"] ?? {}) as UxConfig;
  const glossary = (all["glossary"] ?? []) as GlossaryEntry[];
  const timeTemplate = (all["timeTemplate"] ?? "") as string;

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border px-6 py-3 flex items-center justify-between sticky top-0 bg-background/90 backdrop-blur-sm z-10 safe-top">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-accent text-accent-foreground flex items-center justify-center">
            <Cpu className="w-4 h-4" />
          </div>
          <div>
            <h1 className="text-base font-semibold leading-tight">Admin Panel</h1>
            <p className="text-[11px] text-muted-foreground leading-tight">Khata control room</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={reload}>
            <RefreshCw className="w-4 h-4 mr-1" /> Reload
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await fetch("/api/admin/logout", { method: "POST" });
              location.href = "/admin";
            }}
          >
            <LogOut className="w-4 h-4 mr-1" /> Logout
          </Button>
        </div>
      </header>

      {/* Tabs */}
      <div className="px-4 sm:px-6 py-4 max-w-5xl mx-auto">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="bg-muted border border-border flex-wrap h-auto">
            <TabsTrigger value="agents">Agents</TabsTrigger>
            <TabsTrigger value="flags"><Flag className="w-4 h-4 mr-1" /> Flags</TabsTrigger>
            <TabsTrigger value="prompts"><BookOpen className="w-4 h-4 mr-1" /> Prompts</TabsTrigger>
            <TabsTrigger value="glossary">Glossary</TabsTrigger>
            <TabsTrigger value="context"><Clock className="w-4 h-4 mr-1" /> Context</TabsTrigger>
            <TabsTrigger value="users"><Users className="w-4 h-4 mr-1" /> Users</TabsTrigger>
            <TabsTrigger value="db"><Database className="w-4 h-4 mr-1" /> DB</TabsTrigger>
          </TabsList>

          {/* AGENTS */}
          <TabsContent value="agents" className="mt-4 space-y-4">
            <AgentConfigCard
              title="Daily chat agent (/)"
              icon="💬"
              cfg={daily}
              onChange={(c) => setAll({ ...all, "agent.daily": c })}
              onSave={() => saveKey("agent.daily", all["agent.daily"])}
              onTest={() => testAgent("daily", all["agent.daily"])}
              testing={testing === "daily"}
            />
            <AgentConfigCard
              title="Dashboard analysis agent (/dashboard)"
              icon="📊"
              cfg={dashboard}
              onChange={(c) => setAll({ ...all, "agent.dashboard": c })}
              onSave={() => saveKey("agent.dashboard", all["agent.dashboard"])}
              onTest={() => testAgent("dashboard", all["agent.dashboard"])}
              testing={testing === "dashboard"}
            />
            <SttConfigCard
              cfg={stt}
              onChange={(c) => setAll({ ...all, "agent.stt": c })}
              onSave={() => saveKey("agent.stt", all["agent.stt"])}
              onTest={() => testAgent("stt", all["agent.stt"])}
              testing={testing === "stt"}
            />
            <OcrConfigCard
              cfg={ocr}
              onChange={(c) => setAll({ ...all, "agent.ocr": c })}
              onSave={() => saveKey("agent.ocr", all["agent.ocr"])}
              onTest={() => testAgent("ocr", all["agent.ocr"])}
              testing={testing === "ocr"}
            />
          </TabsContent>

          {/* FEATURE FLAGS */}
          <TabsContent value="flags" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle>Feature flags</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <FlagRow
                  label="PDF bank statement upload"
                  desc="Let users upload PDF statements for parsing"
                  checked={flags.pdfUpload}
                  onChange={(v) => setAll({ ...all, featureFlags: { ...flags, pdfUpload: v } })}
                />
                <FlagRow
                  label="OCR / vision (photo upload)"
                  desc="Users can upload statement/receipt images. Requires a vision-capable OCR agent configured above."
                  checked={flags.ocr}
                  onChange={(v) => setAll({ ...all, featureFlags: { ...flags, ocr: v } })}
                />
                <FlagRow
                  label="Native STT (Web Speech API)"
                  desc="Use the device's built-in speech recognition (free, no API key)"
                  checked={flags.sttNative}
                  onChange={(v) => setAll({ ...all, featureFlags: { ...flags, sttNative: v } })}
                />
                <FlagRow
                  label="Web Push notifications"
                  desc="Requires NEXT_PUBLIC_VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY env vars"
                  checked={flags.webPush}
                  onChange={(v) => setAll({ ...all, featureFlags: { ...flags, webPush: v } })}
                />
                <FlagRow
                  label="Auto-append totals in daily replies"
                  desc="Append today's + this month's in/out totals at the end of each daily chat reply"
                  checked={flags.autoAppendTotals}
                  onChange={(v) => setAll({ ...all, featureFlags: { ...flags, autoAppendTotals: v } })}
                />
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Default AI response language</Label>
                    <p className="text-xs text-muted-foreground mt-1">Users can override per-message in chat</p>
                  </div>
                  <select
                    className="bg-background border border-input rounded-lg px-2 py-1.5 text-sm"
                    value={flags.defaultLanguage}
                    onChange={(e) =>
                      setAll({ ...all, featureFlags: { ...flags, defaultLanguage: e.target.value as any } })
                    }
                  >
                    <option value="english">English</option>
                    <option value="hinglish">Hinglish</option>
                    <option value="hindi">Hindi</option>
                  </select>
                </div>
                <div className="flex items-center justify-between pt-4 border-t border-border">
                  <div>
                    <Label>Minimum reply delay (ms)</Label>
                    <p className="text-xs text-muted-foreground mt-1">
                      Optional artificial delay before a chat reply is returned — keeps the typing indicator visible on
                      very fast models. 0 = disabled (replies stream as soon as the model answers). There is no other
                      built-in delay anywhere in the chat pipeline.
                    </p>
                  </div>
                  <Input
                    type="number"
                    min={0}
                    max={5000}
                    step={100}
                    className="w-24"
                    value={uxConfig.replyDelayMs ?? 0}
                    onChange={(e) =>
                      setAll({
                        ...all,
                        uxConfig: { ...uxConfig, replyDelayMs: Math.max(0, Math.min(5000, Number(e.target.value) || 0)) },
                      })
                    }
                  />
                </div>
                <div className="flex gap-2 mt-2">
                  <Button onClick={() => saveKey("featureFlags", all["featureFlags"])}>
                    <Save className="w-4 h-4 mr-1" /> Save flags
                  </Button>
                  <Button variant="outline" onClick={() => saveKey("uxConfig", all["uxConfig"])}>
                    <Save className="w-4 h-4 mr-1" /> Save UX config
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* SYSTEM PROMPTS */}
          <TabsContent value="prompts" className="mt-4 space-y-4">
            <PromptCard
              title="Daily agent system prompt"
              value={daily.systemPrompt}
              onChange={(v) => setAll({ ...all, "agent.daily": { ...daily, systemPrompt: v } })}
              onSave={() => saveKey("agent.daily", all["agent.daily"])}
            />
            <PromptCard
              title="Dashboard agent system prompt"
              value={dashboard.systemPrompt}
              onChange={(v) => setAll({ ...all, "agent.dashboard": { ...dashboard, systemPrompt: v } })}
              onSave={() => saveKey("agent.dashboard", all["agent.dashboard"])}
            />
            <PromptCard
              title="OCR agent system prompt"
              value={ocr.systemPrompt}
              onChange={(v) => setAll({ ...all, "agent.ocr": { ...ocr, systemPrompt: v } })}
              onSave={() => saveKey("agent.ocr", all["agent.ocr"])}
            />
          </TabsContent>

          {/* GLOSSARY */}
          <TabsContent value="glossary" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle>Finance glossary ({glossary.length} terms)</CardTitle>
                <p className="text-xs text-muted-foreground mt-1">
                  Injected into the dashboard agent&apos;s context so it can disambiguate IPO / SIP / FD / etc.
                </p>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="max-h-96 overflow-y-auto space-y-2 pr-2">
                  {glossary.map((g, i) => (
                    <div key={i} className="grid grid-cols-[120px_1fr_auto] gap-2 items-center">
                      <Input
                        value={g.term}
                        onChange={(e) => {
                          const next = [...glossary];
                          next[i] = { ...next[i], term: e.target.value };
                          setAll({ ...all, glossary: next });
                        }}
                      />
                      <Input
                        value={g.desc}
                        onChange={(e) => {
                          const next = [...glossary];
                          next[i] = { ...next[i], desc: e.target.value };
                          setAll({ ...all, glossary: next });
                        }}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          const next = glossary.filter((_, j) => j !== i);
                          setAll({ ...all, glossary: next });
                        }}
                      >
                        ✕
                      </Button>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setAll({ ...all, glossary: [...glossary, { term: "New term", desc: "Description" }] })
                    }
                  >
                    <Plus className="w-4 h-4 mr-1" /> Add
                  </Button>
                  <Button onClick={() => saveKey("glossary", all["glossary"])}>
                    <Save className="w-4 h-4 mr-1" /> Save glossary
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* CONTEXT / TIME */}
          <TabsContent value="context" className="mt-4 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Time-injection template</CardTitle>
                <p className="text-xs text-muted-foreground mt-1">
                  Injected into every agent call. Placeholders:{" "}
                  <code>{"{now_ist}"}</code>, <code>{"{date_ist}"}</code>,{" "}
                  <code>{"{time_ist}"}</code>, <code>{"{weekday_ist}"}</code>,{" "}
                  <code>{"{user_tz}"}</code>.
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                <Textarea
                  rows={6}
                  value={timeTemplate}
                  onChange={(e) => setAll({ ...all, timeTemplate: e.target.value })}
                  className="font-mono text-xs"
                />
                <Button onClick={() => saveKey("timeTemplate", all["timeTemplate"])}>
                  <Save className="w-4 h-4 mr-1" /> Save template
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  Schema-in-context mode
                  <span className={`ml-auto text-[10px] px-2 py-0.5 rounded-full border ${
                    schemaMode.mode === "rag"
                      ? "border-amber-400 bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                      : "border-emerald-400 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                  }`}>
                    {schemaMode.mode === "rag" ? "RAG ACTIVE" : "LLM (full schema)"}
                  </span>
                </CardTitle>
                <p className="text-xs text-muted-foreground mt-1">
                  Controls how the user&apos;s accounts/contacts/categories/recent transactions reach the agent.
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label>Mode</Label>
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <button
                      type="button"
                      onClick={() => setAll({ ...all, schemaMode: { ...schemaMode, mode: "llm" } })}
                      className={`text-left p-3 rounded-xl border transition-colors ${
                        schemaMode.mode === "llm"
                          ? "border-primary bg-accent text-accent-foreground"
                          : "border-input bg-background hover:bg-accent/40 text-muted-foreground"
                      }`}
                    >
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <span>🧠 LLM</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">RECOMMENDED</span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        Inject compact JSON of all accounts/contacts/categories + recent txns directly into the system prompt. Best under ~5k txns. Faster, but more tokens per call.
                      </p>
                    </button>
                    <button
                      type="button"
                      onClick={() => setAll({ ...all, schemaMode: { ...schemaMode, mode: "rag" } })}
                      className={`text-left p-3 rounded-xl border transition-colors ${
                        schemaMode.mode === "rag"
                          ? "border-amber-500 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
                          : "border-input bg-background hover:bg-accent/40 text-muted-foreground"
                      }`}
                    >
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <span>🔍 RAG</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">For large histories</span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        Agent calls <code className="text-foreground/80">retrieve_transactions</code> on demand — keyword + bigram scoring, no vector DB. Saves tokens for 5k+ txn users, adds latency on historical queries.
                      </p>
                    </button>
                  </div>
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-border">
                  <div>
                    <Label>Last N transactions in context (LLM mode)</Label>
                    <p className="text-xs text-muted-foreground mt-1">
                      Higher = better duplicate detection, but more tokens per call.
                    </p>
                  </div>
                  <Input
                    type="number"
                    className="w-24"
                    value={schemaMode.lastNTxns}
                    onChange={(e) =>
                      setAll({ ...all, schemaMode: { ...schemaMode, lastNTxns: Number(e.target.value) } })
                    }
                  />
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-border">
                  <div>
                    <Label>Chat history window (messages)</Label>
                    <p className="text-xs text-muted-foreground mt-1">
                      Recent chat messages fed to the LLM each call. Older messages are always reachable by the agent via
                      the search_chat_history tool — so context is effectively infinite either way.
                    </p>
                  </div>
                  <Input
                    type="number"
                    min={4}
                    max={80}
                    className="w-24"
                    value={schemaMode.chatHistoryLimit ?? 24}
                    onChange={(e) =>
                      setAll({
                        ...all,
                        schemaMode: {
                          ...schemaMode,
                          chatHistoryLimit: Math.max(4, Math.min(80, Number(e.target.value) || 24)),
                        },
                      })
                    }
                  />
                </div>
                <FlagRow
                  label="Refresh every call"
                  desc="If OFF, schema is cached for 5 minutes between calls (faster). If ON, always re-fetch from DB before each agent call."
                  checked={schemaMode.refreshEveryCall}
                  onChange={(v) => setAll({ ...all, schemaMode: { ...schemaMode, refreshEveryCall: v } })}
                />
                <Button onClick={() => saveKey("schemaMode", all["schemaMode"])}>
                  <Save className="w-4 h-4 mr-1" /> Save mode
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          {/* USERS */}
          <TabsContent value="users" className="mt-4">
            <UsersTab />
          </TabsContent>

          {/* DB STATUS */}
          <TabsContent value="db" className="mt-4">
            <DbStatusTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function FlagRow({ label, desc, checked, onChange }: { label: string; desc?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <Label>{label}</Label>
        {desc && <p className="text-xs text-muted-foreground mt-1">{desc}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function PresetChips({
  presets, cfg, onApply,
}: {
  presets: ModelPreset[];
  cfg: { provider: string; baseUrl: string; model: string };
  onApply: (p: ModelPreset) => void;
}) {
  const isMatch = (p: ModelPreset) =>
    cfg.provider === p.provider && cfg.model === p.model;
  return (
    <div className="flex flex-wrap gap-1.5">
      {presets.map((p) => {
        const matched = isMatch(p);
        return (
          <button
            key={p.label}
            type="button"
            onClick={() => onApply(p)}
            title={p.description}
            className={`text-xs px-2.5 py-1 rounded-lg border transition-colors flex items-center gap-1.5 ${
              matched
                ? "border-primary bg-accent text-accent-foreground"
                : COST_STYLES[p.cost]
            }`}
          >
            <span className="font-medium">{p.label}</span>
            <span className="opacity-60 text-[10px] uppercase tracking-wide">{p.cost}</span>
          </button>
        );
      })}
    </div>
  );
}

function AgentConfigCard({
  title, icon, cfg, onChange, onSave, onTest, testing,
}: {
  title: string; icon: string; cfg: AgentConfig;
  onChange: (c: AgentConfig) => void; onSave: () => void; onTest: () => void; testing: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><span>{icon}</span> {title}</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="md:col-span-2">
          <Label>Quick presets</Label>
          <p className="text-xs text-muted-foreground mt-1 mb-2">
            Click a chip to fill provider + model + sensible defaults. Your API key is preserved.
          </p>
          <PresetChips presets={GENERAL_PRESETS} cfg={cfg} onApply={(p) => onChange(applyPreset(cfg, p) as AgentConfig)} />
        </div>
        <div>
          <Label>Provider</Label>
          <select
            className="w-full mt-1 bg-background border border-input rounded-lg px-2 py-2 text-sm"
            value={cfg.provider}
            onChange={(e) => onChange({ ...cfg, provider: e.target.value as any })}
          >
            <option value="openai-compatible">OpenAI-compatible (Groq / OpenAI / DeepSeek / OpenRouter / LM Studio)</option>
            <option value="anthropic">Anthropic (native)</option>
          </select>
        </div>
        <div>
          <Label>Model</Label>
          <Input
            value={cfg.model}
            onChange={(e) => onChange({ ...cfg, model: e.target.value })}
            className="mt-1"
            placeholder="llama-3.3-70b-versatile"
          />
        </div>
        <div className="md:col-span-2">
          <Label>Base URL</Label>
          <Input
            value={cfg.baseUrl}
            onChange={(e) => onChange({ ...cfg, baseUrl: e.target.value })}
            className="mt-1 font-mono text-xs"
            placeholder="https://api.groq.com/openai/v1"
          />
        </div>
        <div>
          <Label>API key</Label>
          <Input
            type="password"
            value={cfg.apiKey}
            onChange={(e) => onChange({ ...cfg, apiKey: e.target.value })}
            className="mt-1 font-mono text-xs"
            placeholder="sk-..."
          />
        </div>
        <div>
          <Label>Extra headers (optional, JSON)</Label>
          <Input
            value={cfg.extraHeaders ?? ""}
            onChange={(e) => onChange({ ...cfg, extraHeaders: e.target.value })}
            className="mt-1 font-mono text-xs"
            placeholder='{"HTTP-Referer":"https://myapp.com"}'
          />
          <p className="text-[11px] text-muted-foreground mt-1">
            Merged into every request. Useful for OpenRouter (HTTP-Referer / X-Title) or gateway auth headers.
          </p>
        </div>
        <div>
          <Label>Temperature</Label>
          <Input
            type="number" step="0.1" min="0" max="2"
            value={cfg.temperature}
            onChange={(e) => onChange({ ...cfg, temperature: Number(e.target.value) })}
            className="mt-1"
          />
        </div>
        <div>
          <Label>Max tokens mode</Label>
          <select
            className="w-full mt-1 bg-background border border-input rounded-lg px-2 py-2 text-sm"
            value={cfg.maxTokensMode}
            onChange={(e) => onChange({ ...cfg, maxTokensMode: e.target.value as any })}
          >
            <option value="max_tokens">max_tokens (standard)</option>
            <option value="max_completion_tokens">max_completion_tokens (o1/o3-style reasoning models)</option>
          </select>
        </div>
        <div>
          <Label>Max tokens</Label>
          <Input
            type="number"
            value={cfg.maxTokens}
            onChange={(e) => onChange({ ...cfg, maxTokens: Number(e.target.value) })}
            className="mt-1"
          />
        </div>
        <div className="flex items-center">
          <FlagRow
            label="Tool calling supported"
            desc="OFF = JSON fallback mode (for Gemma-style models without native function calling)"
            checked={cfg.toolCallingSupported}
            onChange={(v) => onChange({ ...cfg, toolCallingSupported: v })}
          />
        </div>
        <div className="md:col-span-2 flex gap-2 pt-2">
          <Button onClick={onSave}><Save className="w-4 h-4 mr-1" /> Save</Button>
          <Button variant="outline" onClick={onTest} disabled={testing}>
            <FlaskConical className="w-4 h-4 mr-1" /> {testing ? "Testing…" : "Test connection"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SttConfigCard({
  cfg, onChange, onSave, onTest, testing,
}: {
  cfg: SttConfig; onChange: (c: SttConfig) => void; onSave: () => void; onTest: () => void; testing: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><span>🎤</span> Speech-to-Text</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <FlagRow
          label="Engine"
          desc="Native = device's built-in Web Speech API (free, no key). OpenAI-compatible = a Whisper-style /audio/transcriptions endpoint. Paste either a base URL (…/v1) or the full endpoint — wrong pastes like /chat/completions are auto-corrected."
          checked={cfg.engine === "native"}
          onChange={(v) => onChange({ ...cfg, engine: v ? "native" : "openai-compatible" })}
        />
        {cfg.engine === "openai-compatible" && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <Label>Base URL</Label>
                <Input
                  value={cfg.baseUrl}
                  onChange={(e) => onChange({ ...cfg, baseUrl: e.target.value })}
                  className="mt-1 font-mono text-xs"
                />
              </div>
              <div>
                <Label>API key</Label>
                <Input
                  type="password"
                  value={cfg.apiKey}
                  onChange={(e) => onChange({ ...cfg, apiKey: e.target.value })}
                  className="mt-1 font-mono text-xs"
                />
              </div>
              <div>
                <Label>Model</Label>
                <Input
                  value={cfg.model}
                  onChange={(e) => onChange({ ...cfg, model: e.target.value })}
                  className="mt-1"
                />
              </div>
            </div>
          </>
        )}
        <div className="flex gap-2 pt-2">
          <Button onClick={onSave}><Save className="w-4 h-4 mr-1" /> Save</Button>
          {cfg.engine === "openai-compatible" && (
            <Button variant="outline" onClick={onTest} disabled={testing}>
              <FlaskConical className="w-4 h-4 mr-1" /> {testing ? "Testing…" : "Test connection"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function OcrConfigCard({
  cfg, onChange, onSave, onTest, testing,
}: {
  cfg: OcrConfig; onChange: (c: OcrConfig) => void; onSave: () => void; onTest: () => void; testing: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><span>📷</span> OCR / Vision</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <FlagRow
          label="Enable OCR / vision"
          desc="When ON, users can upload images of bank statements / receipts. Requires a vision-capable model (gpt-4o, Claude Sonnet, Gemini…)."
          checked={cfg.enabled}
          onChange={(v) => onChange({ ...cfg, enabled: v })}
        />
        {cfg.enabled && (
          <>
            <div className="md:col-span-2">
              <Label>Quick presets (vision-capable)</Label>
              <p className="text-xs text-muted-foreground mt-1 mb-2">
                Only vision-capable models are shown — text-only models can&apos;t do OCR.
              </p>
              <PresetChips presets={OCR_PRESETS} cfg={cfg} onApply={(p) => onChange(applyPreset(cfg, p) as OcrConfig)} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label>Provider</Label>
                <select
                  className="w-full mt-1 bg-background border border-input rounded-lg px-2 py-2 text-sm"
                  value={cfg.provider}
                  onChange={(e) => onChange({ ...cfg, provider: e.target.value as any })}
                >
                  <option value="openai-compatible">OpenAI-compatible (gpt-4o, Groq llama-vision, OpenRouter Gemini…)</option>
                  <option value="anthropic">Anthropic (claude-3-5-sonnet, claude-3-opus)</option>
                </select>
              </div>
              <div>
                <Label>Model</Label>
                <Input
                  value={cfg.model}
                  onChange={(e) => onChange({ ...cfg, model: e.target.value })}
                  className="mt-1"
                  placeholder="gpt-4o"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label>Base URL</Label>
                <Input
                  value={cfg.baseUrl}
                  onChange={(e) => onChange({ ...cfg, baseUrl: e.target.value })}
                  className="mt-1 font-mono text-xs"
                  placeholder="https://api.openai.com/v1"
                />
              </div>
              <div>
                <Label>API key</Label>
                <Input
                  type="password"
                  value={cfg.apiKey}
                  onChange={(e) => onChange({ ...cfg, apiKey: e.target.value })}
                  className="mt-1 font-mono text-xs"
                  placeholder="sk-..."
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Temperature</Label>
                <Input
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  value={cfg.temperature}
                  onChange={(e) => onChange({ ...cfg, temperature: Number(e.target.value) })}
                  className="mt-1"
                />
              </div>
              <div>
                <Label>Max tokens</Label>
                <Input
                  type="number"
                  value={cfg.maxTokens}
                  onChange={(e) => onChange({ ...cfg, maxTokens: Number(e.target.value) })}
                  className="mt-1"
                />
              </div>
            </div>
            <div>
              <Label>Extra headers (optional, JSON)</Label>
              <Input
                value={cfg.extraHeaders ?? ""}
                onChange={(e) => onChange({ ...cfg, extraHeaders: e.target.value })}
                className="mt-1 font-mono text-xs"
                placeholder='{"HTTP-Referer":"https://myapp.com"}'
              />
            </div>
          </>
        )}
        <div className="flex gap-2 pt-2">
          <Button onClick={onSave}><Save className="w-4 h-4 mr-1" /> Save</Button>
          {cfg.enabled && (
            <Button variant="outline" onClick={onTest} disabled={testing}>
              <FlaskConical className="w-4 h-4 mr-1" /> {testing ? "Testing…" : "Test connection"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function PromptCard({
  title, value, onChange, onSave,
}: {
  title: string; value: string; onChange: (v: string) => void; onSave: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          rows={10}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="font-mono text-xs"
        />
        <Button onClick={onSave}><Save className="w-4 h-4 mr-1" /> Save</Button>
      </CardContent>
    </Card>
  );
}

function UsersTab() {
  const [users, setUsers] = useState<any[]>([]);

  const load = async () => {
    const res = await fetch("/api/admin/users");
    if (res.ok) {
      const j = await res.json();
      setUsers(j.users);
    }
  };
  useEffect(() => {
    let active = true;
    (async () => {
      const res = await fetch("/api/admin/users");
      if (active && res.ok) {
        const j = await res.json();
        setUsers(j.users);
      }
    })();
    return () => { active = false; };
  }, []);

  const toggle = async (userId: string, isActive: boolean) => {
    await fetch("/api/admin/users", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, isActive }),
    });
    load();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Users</CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Users create their own accounts (Gmail + OTP verification) from the app. Data is strictly
          isolated — accounts, contacts, transactions and chats are never shared. Flip a switch to
          suspend an account.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="border border-border rounded-xl overflow-x-auto">
          <table className="w-full text-sm min-w-[560px]">
            <thead className="bg-muted/60 text-muted-foreground">
              <tr>
                <th className="text-left p-2.5 font-medium">Gmail</th>
                <th className="text-left p-2.5 font-medium">Name</th>
                <th className="text-right p-2.5 font-medium">Accounts</th>
                <th className="text-right p-2.5 font-medium">Txns</th>
                <th className="text-left p-2.5 font-medium">Created</th>
                <th className="p-2.5 font-medium">Active</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-border">
                  <td className="p-2.5 font-mono text-xs">{u.email}</td>
                  <td className="p-2.5 font-mono">{u.username}</td>
                  <td className="p-2.5 text-right tnum">{u._count?.accounts ?? 0}</td>
                  <td className="p-2.5 text-right tnum">{u._count?.transactions ?? 0}</td>
                  <td className="p-2.5 text-xs text-muted-foreground">{new Date(u.createdAt).toLocaleDateString("en-IN")}</td>
                  <td className="p-2.5">
                    <Switch checked={u.isActive} onCheckedChange={(v) => toggle(u.id, v)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function DbStatusTab() {
  const [status, setStatus] = useState<any>(null);
  useEffect(() => {
    fetch("/api/admin/db-status").then((r) => r.json()).then(setStatus);
  }, []);
  if (!status) return <div className="text-muted-foreground">Loading…</div>;
  return (
    <Card>
      <CardHeader><CardTitle>Database & environment</CardTitle></CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat label="Users" value={status.counts.users} />
          <Stat label="Accounts" value={status.counts.accounts} />
          <Stat label="Transactions" value={status.counts.transactions} />
          <Stat label="Contacts" value={status.counts.contacts} />
          <Stat label="Categories" value={status.counts.categories} />
          <Stat label="Chat messages" value={status.counts.chatMessages} />
          <Stat label="Admin configs" value={status.counts.adminConfigs} />
        </div>
        <div className="pt-3 border-t border-border mt-3">
          <p className="text-xs text-muted-foreground">Database provider: {status.database.provider}</p>
          <p className="text-xs text-muted-foreground">URL: <code className="text-foreground/80">{status.database.urlMasked}</code></p>
        </div>
        <div className="pt-2">
          <p className="text-xs text-muted-foreground">Env vars detected:</p>
          <ul className="text-xs mt-1 space-y-1">
            <li>ADMIN_USERNAME / ADMIN_PASSWORD: {status.env.hasAdminCreds ? "✓ set" : "✗ missing"}</li>
            <li>VAPID keys (public+private): {status.env.hasVapidKeys ? "✓ set" : "✗ missing (needed for push) — run `bun run gen-vapid`"}</li>
            <li>VAPID_SUBJECT: {status.env.hasVapidSubject ? "✓ set" : "— optional but recommended"}</li>
            <li>QSTASH_TOKEN: {status.env.hasQStash ? `✓ set (${status.env.qstashAccounts} account${status.env.qstashAccounts > 1 ? "s" : ""} pooled)` : "✗ missing (needed for scheduled reminders)"}</li>
            <li>RESEND_API_KEY: {status.env.hasResend ? "✓ set (email/OTP works)" : "✗ missing (signup emails won't send)"}</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex flex-col p-2.5 bg-muted/50 border border-border rounded-xl">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-lg font-mono tnum">{value}</span>
    </div>
  );
}
