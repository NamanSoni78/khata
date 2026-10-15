"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip,
} from "recharts";
import {
  TrendingUp, Download, LogOut, ArrowLeft, Users,
  RefreshCw, Bell, Plus, Trash2, FileText, Moon, Sun, Settings as SettingsIcon,
  Loader2, Upload, Copy, CalendarDays, MessageSquareText,
} from "lucide-react";
import { MultiPeriodChart } from "@/components/dashboard/MultiPeriodChart";
import DeepDiveChat from "@/components/dashboard/DeepDiveChat";
import MindmapEditor from "@/components/mindmap/MindmapEditor";
import ImportDialog from "@/components/dashboard/ImportDialog";

const PIE_COLORS = [
  "#00a884", "#f0a500", "#ff6b6b", "#7c8696", "#25d366", "#d97706", "#db2777",
];

type Period = "day" | "week" | "month" | "3m" | "6m" | "1y" | "custom";

interface Stats {
  period: Period;
  periodLabel: string;
  range: { from: string; to: string };
  currentPeriod: {
    income: number; expense: number; net: number; byCategory: Record<string, number>;
  };
  previousPeriod: {
    income: number; expense: number; net: number; byCategory: Record<string, number>;
  };
  buckets: Array<{ date?: string; hour?: string; weekLabel?: string; monthLabel?: string; income: number; expense: number }>;
  accounts: Array<{ id: string; name: string; type: string; institution: string | null; balance: number }>;
  contacts: Array<{ id: string; name: string; type: string; balance: number }>;
  recentTransactions: Array<{
    id: string; type: string; amount: number; category?: string;
    fromAccount?: string; toAccount?: string; contact?: string;
    timestamp: string; notes?: string;
  }>;
}

export default function DashboardApp({ username }: { username: string }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<Period>("month");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [chatFromDate, setChatFromDate] = useState("");
  const [chatToDate, setChatToDate] = useState("");
  const [exportingPdf, setExportingPdf] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [copyingPrompt, setCopyingPrompt] = useState(false);
  const [showCustom, setShowCustom] = useState(false);

  // Theme toggle — icon visibility handled via CSS dark: variants (no state → no hydration issues)
  const toggleTheme = () => {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("khata-theme", next ? "dark" : "light");
    } catch { /* private mode */ }
  };

  const load = async (p: Period = period, fromStr?: string, toStr?: string) => {
    setLoading(true);
    const params = new URLSearchParams();
    params.set("period", p);
    if (p === "custom") {
      if (fromStr ?? fromDate) params.set("from", (fromStr ?? fromDate) || "");
      if (toStr ?? toDate) params.set("to", (toStr ?? toDate) || "");
    }
    const res = await fetch(`/api/dashboard/stats?${params.toString()}`);
    if (res.ok) setStats(await res.json());
    setLoading(false);
  };

  useEffect(() => {
    let active = true;
    (async () => {
      const res = await fetch(`/api/dashboard/stats?period=month`);
      if (active && res.ok) {
        setStats(await res.json());
      }
      if (active) setLoading(false);
    })();
    return () => { active = false; };
  }, []);

  const changePeriod = (p: Period) => {
    setPeriod(p);
    load(p);
  };

  const applyCustomRange = () => {
    if (!fromDate || !toDate) {
      toast.error("Pick both From and To dates for a custom range");
      return;
    }
    setPeriod("custom");
    load("custom", fromDate, toDate);
  };

  const exportFile = (format: "csv" | "pdf") => {
    const params = new URLSearchParams();
    params.set("format", format);
    if (fromDate) params.set("from", fromDate);
    if (toDate) params.set("to", toDate);
    if (format === "pdf") setExportingPdf(true);
    window.open(`/api/dashboard/export?${params.toString()}`, "_blank");
    setTimeout(() => setExportingPdf(false), 1500);
  };

  const copySetupPrompt = async () => {
    setCopyingPrompt(true);
    try {
      const res = await fetch("/addingaccountsprompt.md");
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      toast.success("Setup prompt copied — paste it into any AI chatbot");
    } catch {
      toast.error("Couldn't copy — open /addingaccountsprompt.md manually");
    } finally {
      setCopyingPrompt(false);
    }
  };

  const logout = async () => {
    await fetch("/api/dashboard/logout", { method: "POST" });
    location.href = "/dashboard";
  };

  if (loading || !stats) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading your dashboard…
        </div>
      </div>
    );
  }

  const granularity: "hour" | "day" | "week" | "month" =
    stats.period === "day" ? "hour" :
    stats.period === "week" || stats.period === "month" ? "day" :
    stats.period === "3m" || stats.period === "6m" ? "week" : "month";

  const pieData = Object.entries(stats.currentPeriod.byCategory).map(([name, value]) => ({ name, value }));
  const pieTotal = pieData.reduce((s, d) => s + d.value, 0);
  const cp = stats.currentPeriod;
  const pp = stats.previousPeriod;

  return (
    <div className="min-h-screen bg-background">
      {/* Header — WhatsApp green */}
      <header className="px-4 py-3 sticky top-0 bg-[var(--header)] text-[var(--header-foreground)] z-10 safe-top shadow-sm">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <a
              href="/"
              className="press h-9 w-9 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors"
              title="Back to daily app"
            >
              <ArrowLeft className="w-5 h-5" />
            </a>
            <div>
              <p className="font-medium text-[15px]">Dashboard</p>
              <p className="text-[11px] opacity-75">{username}</p>
            </div>
          </div>
          <div className="flex items-center gap-0.5">
            <button
              onClick={toggleTheme}
              className="press h-9 w-9 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors"
              title="Toggle theme"
            >
              <Moon className="w-4 h-4 dark:hidden" />
              <Sun className="w-4 h-4 hidden dark:block" />
            </button>
            <a
              href="/dashboard/settings"
              className="press h-9 px-3 rounded-full flex items-center gap-1.5 text-xs font-medium hover:bg-white/10 transition-colors"
            >
              <SettingsIcon className="w-4 h-4" />
              <span className="hidden sm:inline">Settings</span>
            </a>
            <button
              onClick={() => load(period)}
              className="press h-9 w-9 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors"
              title="Refresh"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              onClick={logout}
              className="press h-9 w-9 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors"
              title="Sign out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-5 space-y-5">
        {/* Period chips — compact, horizontal; Custom expands inline */}
        <div className="anim-fade-up">
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1 py-0.5">
            {(["day", "week", "month", "3m", "6m", "1y", "custom"] as Period[]).map((p) => {
              const active = period === p;
              return (
                <button
                  key={p}
                  onClick={() => {
                    if (p === "custom") {
                      setShowCustom((s) => !s);
                      if (!showCustom && fromDate && toDate) { setPeriod("custom"); load("custom", fromDate, toDate); }
                      else setPeriod("custom");
                    } else {
                      setShowCustom(false);
                      changePeriod(p);
                    }
                  }}
                  className={`press shrink-0 text-[12.5px] px-3.5 h-9 rounded-full font-semibold font-display tracking-[-0.01em] border transition-all ${
                    active
                      ? "border-transparent bg-[var(--primary)] text-white shadow-[var(--shadow-green)]"
                      : "border-input text-muted-foreground hover:text-foreground hover:border-[var(--primary)]/50"
                  }`}
                >
                  {labelFor(p)}
                </button>
              );
            })}
            <span className="shrink-0 text-[11.5px] text-muted-foreground ml-1 hidden sm:inline">{stats.periodLabel}</span>
          </div>
          {showCustom && (
            <div className="mt-2.5 card-v4 p-3.5 flex flex-wrap items-center gap-2 anim-fade-in">
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="field !h-10 !w-[150px] !px-3 text-[13px]"
                aria-label="From date"
              />
              <span className="text-muted-foreground text-xs">→</span>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="field !h-10 !w-[150px] !px-3 text-[13px]"
                aria-label="To date"
              />
              <button onClick={applyCustomRange} className="btn-main !h-10 !w-auto px-5 !text-[13.5px]">
                Apply range
              </button>
            </div>
          )}
        </div>

        {/* Unified summary — one card, three stats */}
        <div className="card-v4 p-5 anim-fade-up-d1">
          <div className="flex items-center justify-between mb-4">
            <p className="eyebrow">{stats.periodLabel}</p>
            <div className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
              <TrendingUp className="w-3.5 h-3.5 text-success" />
              <span className="tnum">vs {labelFor(period === "custom" ? "month" : period).toLowerCase()} before</span>
            </div>
          </div>
          <div className="grid grid-cols-3 divide-x divide-border">
            <Stat
              label="Income"
              num={cp.income}
              delta={cp.income - pp.income}
              tone="success"
            />
            <Stat
              label="Expense"
              num={cp.expense}
              delta={pp.expense - cp.expense}
              tone="danger"
              invert
            />
            <Stat
              label="Net"
              num={cp.net}
              delta={cp.net - pp.net}
              tone="auto"
            />
          </div>
        </div>

        {/* Multi-period trend chart */}
        <div className="anim-fade-up">
          <MultiPeriodChart
            title={`Income vs Expense — ${stats.periodLabel}`}
            buckets={stats.buckets}
            granularity={granularity}
          />
        </div>

        {/* Pie chart by category */}
        <div className="bg-card border border-border rounded-2xl anim-fade-up" style={{ boxShadow: "var(--shadow-2)" }}>
          <div className="px-5 pt-5 pb-3">
            <h2 className="font-semibold text-sm text-foreground">Expense breakdown — {stats.periodLabel}</h2>
          </div>
          <div className="px-5 pb-5">
            {pieData.length === 0 ? (
              <p className="text-muted-foreground text-sm py-8 text-center">No expenses in this period.</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="relative">
                  <ResponsiveContainer width="100%" height={280}>
                    <PieChart>
                      <Pie
                        data={pieData}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        innerRadius={55}
                        outerRadius={95}
                        paddingAngle={2}
                        labelLine={false}
                      >
                        {pieData.map((_, i) => (
                          <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} strokeWidth={0} />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(v: number) => `₹${v.toLocaleString("en-IN")}`}
                        contentStyle={{
                          background: "var(--card)",
                          border: "1px solid var(--border)",
                          borderRadius: 12,
                          color: "var(--card-foreground)",
                          fontSize: 12,
                        }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  {/* Center total */}
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total</p>
                    <p className="text-xl font-semibold text-foreground tnum">
                      ₹{pieTotal.toLocaleString("en-IN")}
                    </p>
                  </div>
                </div>
                <div className="space-y-2 text-sm">
                  {pieData
                    .slice()
                    .sort((a, b) => b.value - a.value)
                    .map((d, i) => (
                      <div key={d.name} className="flex items-center justify-between px-1">
                        <div className="flex items-center gap-2">
                          <div
                            className="w-2.5 h-2.5 rounded-full"
                            style={{ background: PIE_COLORS[i % PIE_COLORS.length] }}
                          />
                          <span className="text-foreground/90">{d.name}</span>
                          <span className="text-[10px] text-muted-foreground tnum">
                            {pieTotal > 0 ? Math.round((d.value / pieTotal) * 100) : 0}%
                          </span>
                        </div>
                        <span className="font-mono text-foreground tnum">₹{d.value.toLocaleString("en-IN")}</span>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Accounts + Contacts */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-card border border-border rounded-2xl anim-fade-up">
            <div className="px-5 pt-5 pb-2 flex items-start justify-between gap-2">
              <h2 className="font-semibold text-sm text-foreground">Accounts ({stats.accounts.length})</h2>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={copySetupPrompt}
                  disabled={copyingPrompt}
                  className="press h-7 px-2.5 rounded-lg border border-input text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors flex items-center gap-1 disabled:opacity-60"
                  title="Copy addingaccountsprompt.md — paste it into any AI chatbot to generate import data"
                >
                  {copyingPrompt ? <Loader2 className="w-3 h-3 animate-spin" /> : <Copy className="w-3 h-3" />}
                  Copy AI prompt
                </button>
                <button
                  onClick={() => setShowImport(true)}
                  className="press h-7 px-2.5 rounded-lg bg-primary text-primary-foreground text-[11px] font-medium flex items-center gap-1"
                  title="Import accounts, contacts and categories from a markdown/JSON block"
                >
                  <Upload className="w-3 h-3" /> Import data
                </button>
              </div>
            </div>
            <div className="px-5 pb-4">
              <div className="divide-y divide-border">
                {stats.accounts.length === 0 && (
                  <p className="text-muted-foreground text-sm py-6 text-center">No accounts yet — mention one in the daily chat.</p>
                )}
                {stats.accounts.map((a) => (
                  <div key={a.id} className="flex items-center justify-between py-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">{a.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {a.type}{a.institution ? ` · ${a.institution}` : ""}
                      </p>
                    </div>
                    <p className="font-mono text-sm text-foreground tnum">₹{a.balance.toLocaleString("en-IN")}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="bg-card border border-border rounded-2xl anim-fade-up">
            <div className="px-5 pt-5 pb-2">
              <h2 className="font-semibold text-sm text-foreground flex items-center gap-2">
                <Users className="w-4 h-4 text-muted-foreground" /> Contacts ({stats.contacts.length})
              </h2>
            </div>
            <div className="px-5 pb-4">
              <div className="divide-y divide-border">
                {stats.contacts.length === 0 && (
                  <p className="text-muted-foreground text-sm py-6 text-center">No contacts yet.</p>
                )}
                {stats.contacts.map((c) => (
                  <div key={c.id} className="flex items-center justify-between py-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">{c.name}</p>
                      <p className="text-xs text-muted-foreground">{c.type}</p>
                    </div>
                    <p className={`font-mono text-sm tnum ${c.balance >= 0 ? "text-success" : "text-destructive"}`}>
                      {c.balance >= 0 ? "+" : "−"}₹{Math.abs(c.balance).toLocaleString("en-IN")}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Deep-dive chat */}
        <div className="anim-fade-up">
          <DeepDiveChat />
        </div>

        {/* Mindmap editor */}
        <div className="anim-fade-up">
          <MindmapEditor />
        </div>

        {/* Export */}
        <div className="bg-card border border-border rounded-2xl anim-fade-up">
          <div className="px-5 pt-5 pb-3">
            <h2 className="font-semibold text-sm text-foreground">Export transactions</h2>
          </div>
          <div className="px-5 pb-5 flex flex-wrap items-end gap-2">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">From date</label>
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="h-10 rounded-xl border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">To date</label>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="h-10 rounded-xl border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
            </div>
            <button
              onClick={() => exportFile("csv")}
              className="press h-10 px-4 rounded-xl bg-primary text-primary-foreground text-sm font-medium flex items-center gap-2 hover:opacity-95 transition-opacity"
            >
              <Download className="w-4 h-4" /> CSV
            </button>
            <button
              onClick={() => exportFile("pdf")}
              disabled={exportingPdf}
              className="press h-10 px-4 rounded-xl border border-input text-sm font-medium text-foreground flex items-center gap-2 hover:bg-accent/50 transition-colors disabled:opacity-60"
            >
              <FileText className="w-4 h-4" /> {exportingPdf ? "Generating…" : "PDF"}
            </button>
          </div>
          <p className="px-5 pb-5 text-xs text-muted-foreground">
            Leave dates empty to export everything. You can also ask the assistant to export a range for you.
          </p>
        </div>

        {/* Export chat history (both threads — everyday chat + this analysis agent) */}
        <div className="bg-card border border-border rounded-2xl anim-fade-up">
          <div className="px-5 pt-5 pb-3 flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <MessageSquareText className="w-4 h-4" />
            </span>
            <div>
              <h2 className="font-semibold text-sm text-foreground">Export chat history</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Downloads your complete archive — the everyday app shows only the last 50 messages.
              </p>
            </div>
          </div>
          <div className="px-5 pb-5 flex flex-wrap items-end gap-2">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">From date</label>
              <input
                type="date"
                value={chatFromDate}
                onChange={(e) => setChatFromDate(e.target.value)}
                className="h-10 rounded-xl border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">To date</label>
              <input
                type="date"
                value={chatToDate}
                onChange={(e) => setChatToDate(e.target.value)}
                className="h-10 rounded-xl border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
            </div>
            <button
              onClick={() => {
                const params = new URLSearchParams({ type: "chat" });
                if (chatFromDate) params.set("from", chatFromDate);
                if (chatToDate) params.set("to", chatToDate);
                window.open(`/api/dashboard/export?${params.toString()}`, "_blank");
              }}
              className="press h-10 px-4 rounded-xl bg-primary text-primary-foreground text-sm font-medium flex items-center gap-2 hover:opacity-95 transition-opacity"
            >
              <Download className="w-4 h-4" /> Chat transcript (.txt)
            </button>
          </div>
          <p className="px-5 pb-5 text-xs text-muted-foreground">
            Both conversations are included, clearly sectioned: your everyday chat and this analysis agent's chat.
          </p>
        </div>

        {/* Notifications */}
        <div className="anim-fade-up">
          <NotificationsCard />
        </div>

        {/* Import dialog */}
        {showImport && (
          <ImportDialog
            onClose={() => setShowImport(false)}
            onDone={() => load(period)}
          />
        )}

        {/* Recent transactions */}
        <div className="bg-card border border-border rounded-2xl anim-fade-up">
          <div className="px-5 pt-5 pb-3">
            <h2 className="font-semibold text-sm text-foreground">Recent transactions</h2>
          </div>
          <div className="px-5 pb-5">
            {stats.recentTransactions.length === 0 ? (
              <p className="text-muted-foreground text-sm py-8 text-center">
                Nothing logged yet — try &quot;aaj 20rs rapido&quot; in the daily chat.
              </p>
            ) : (
              <div className="overflow-x-auto -mx-5 px-5">
                <table className="w-full text-sm min-w-[520px]">
                  <thead>
                    <tr className="text-muted-foreground border-b border-border">
                      <th className="text-left py-2 pr-3 font-medium">When</th>
                      <th className="text-right py-2 pr-3 font-medium">Amount</th>
                      <th className="text-left py-2 pr-3 font-medium">Category</th>
                      <th className="text-left py-2 pr-3 font-medium">Accounts</th>
                      <th className="text-left py-2 font-medium">Contact</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.recentTransactions.map((t) => {
                      const isIncome = t.type === "income" || t.type === "profit" || t.type === "loan_in";
                      return (
                        <tr key={t.id} className="border-b border-border/60 last:border-0">
                          <td className="py-2.5 pr-3 text-xs text-muted-foreground whitespace-nowrap">
                            {new Date(t.timestamp).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                          </td>
                          <td className={`py-2.5 pr-3 text-right font-mono tnum whitespace-nowrap ${isIncome ? "text-success" : "text-foreground"}`}>
                            {isIncome ? "+" : "−"}₹{t.amount.toLocaleString("en-IN")}
                          </td>
                          <td className="py-2.5 pr-3 text-foreground/90">{t.category ?? "—"}</td>
                          <td className="py-2.5 pr-3 text-xs text-muted-foreground">
                            {t.fromAccount ? `→ ${t.fromAccount}` : ""}
                            {t.toAccount ? ` ← ${t.toAccount}` : ""}
                          </td>
                          <td className="py-2.5 text-xs text-muted-foreground">{t.contact ?? "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function labelFor(p: Period) {
  switch (p) {
    case "day": return "Today";
    case "week": return "This week";
    case "month": return "This month";
    case "3m": return "3 months";
    case "6m": return "6 months";
    case "1y": return "1 year";
    case "custom": return "Custom";
  }
}

/** Animated count-up for money figures (ease-out, reduced-motion aware). */
function useCountUp(target: number, durationMs = 700): number {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);
  useEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const from = reduced ? target : fromRef.current;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = reduced ? 1 : Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(from + (target - from) * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return display;
}

/** One stat cell inside the unified summary card. */
function Stat({
  label, num, delta, tone = "auto", invert = false,
}: {
  label: string; num: number; delta: number; tone?: "success" | "danger" | "auto"; invert?: boolean;
}) {
  const animated = useCountUp(num);
  const isPositive = delta >= 0;
  const showGood = invert ? !isPositive : isPositive;
  const numColor =
    tone === "success" ? "text-success" :
    tone === "danger" ? "text-destructive" :
      num >= 0 ? "text-foreground" : "text-destructive";
  return (
    <div className="px-3 first:pl-0 last:pr-0 text-center sm:text-left">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
      <p className={`money text-[21px] sm:text-[24px] font-bold mt-1.5 ${numColor}`}>
        {num < 0 ? "−" : ""}₹{Math.abs(animated).toLocaleString("en-IN")}
      </p>
      {delta !== 0 && (
        <span
          className={`inline-flex items-center gap-0.5 mt-1 text-[10.5px] font-semibold tnum ${
            showGood ? "text-success" : "text-destructive"
          }`}
        >
          {isPositive ? "↑" : "↓"}₹{Math.abs(delta).toLocaleString("en-IN")}
        </span>
      )}
    </div>
  );
}

function NotificationsCard() {
  // Calendar-style reminder builder — NO cron syntax exposed anywhere.
  interface Notif {
    id: string;
    description: string;
    message: string;
    isActive: boolean;
    nextRunAt: string | null;
    lastFiredAt: string | null;
  }
  const [notifs, setNotifs] = useState<Notif[]>([]);
  const [repeat, setRepeat] = useState<"once" | "daily" | "weekly" | "monthly">("daily");
  const [time, setTime] = useState("20:00");
  const [date, setDate] = useState("");
  const [days, setDays] = useState<number[]>([1]);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [message, setMessage] = useState("Time to log your transactions!");
  const [loading, setLoading] = useState(false);

  const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

  const load = async () => {
    const res = await fetch("/api/dashboard/notifications");
    if (res.ok) {
      const j = await res.json();
      setNotifs(j.notifications ?? []);
    }
  };
  useEffect(() => {
    let active = true;
    (async () => {
      const res = await fetch("/api/dashboard/notifications");
      if (active && res.ok) {
        const j = await res.json();
        setNotifs(j.notifications ?? []);
      }
    })();
    return () => { active = false; };
  }, []);

  const create = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/dashboard/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: repeat,
          time,
          date: repeat === "once" ? date : undefined,
          days: repeat === "weekly" ? days : undefined,
          day_of_month: repeat === "monthly" ? dayOfMonth : undefined,
          message,
        }),
      });
      const j = await res.json();
      if (res.ok) {
        toast.success(`Reminder scheduled — ${j.description ?? ""}`);
        setMessage("Time to log your transactions!");
        load();
      } else {
        toast.error(j.error ?? "Couldn't schedule");
      }
    } finally {
      setLoading(false);
    }
  };

  const toggle = async (id: string, isActive: boolean) => {
    await fetch("/api/dashboard/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, isActive }),
    });
    load();
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this reminder?")) return;
    await fetch(`/api/dashboard/notifications?id=${id}`, { method: "DELETE" });
    load();
  };

  const insertPlaceholder = (p: string) =>
    setMessage((m) => (m.includes(p) ? m : `${m}${m.endsWith(" ") || m.length === 0 ? "" : " "}${p}`));

  return (
    <div className="bg-card border border-border rounded-2xl">
      <div className="px-5 pt-5 pb-3">
        <h2 className="font-semibold text-sm text-foreground flex items-center gap-2">
          <Bell className="w-4 h-4 text-primary" /> Reminders
        </h2>
        <p className="text-xs text-muted-foreground mt-1.5">
          Push notifications at times you choose — daily summaries, logging nudges, one-offs.
        </p>
      </div>
      <div className="px-5 pb-5 space-y-3">
        <div className="space-y-3 p-4 bg-muted/50 border border-border rounded-xl">
          {/* Repeat type */}
          <div className="flex items-center gap-1.5">
            <CalendarDays className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <div className="flex flex-wrap gap-1">
              {(["once", "daily", "weekly", "monthly"] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setRepeat(r)}
                  className={`press text-xs px-3 h-8 rounded-lg font-medium border transition-colors ${
                    repeat === r
                      ? "border-primary bg-accent text-accent-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/40"
                  }`}
                >
                  {r === "once" ? "Once" : r[0].toUpperCase() + r.slice(1)}
                </button>
              ))
              }
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {/* Date (once) */}
            {repeat === "once" && (
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Date</label>
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="w-full h-9 rounded-lg border border-input bg-background px-2.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
                />
              </div>
            )}
            {/* Time */}
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Time</label>
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="w-full h-9 rounded-lg border border-input bg-background px-2.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
            </div>
            {/* Day of month (monthly) */}
            {repeat === "monthly" && (
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Day of month</label>
                <input
                  type="number"
                  min={1}
                  max={31}
                  value={dayOfMonth}
                  onChange={(e) => setDayOfMonth(Math.max(1, Math.min(31, Number(e.target.value) || 1)))}
                  className="w-full h-9 rounded-lg border border-input bg-background px-2.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
                />
              </div>
            )}
          </div>

          {/* Weekday chips (weekly) */}
          {repeat === "weekly" && (
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Repeat on</label>
              <div className="flex gap-1">
                {DAY_LABELS.map((d, i) => (
                  <button
                    key={i}
                    onClick={() =>
                      setDays((ds) => (ds.includes(i) ? ds.filter((x) => x !== i) : [...ds, i].sort()))
                    }
                    className={`press w-8 h-8 rounded-full text-xs font-medium border transition-colors ${
                      days.includes(i)
                        ? "border-primary bg-accent text-accent-foreground"
                        : "border-input text-muted-foreground hover:border-ring/50"
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Message + placeholders */}
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Message</label>
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Today: {today_income} in / {today_expense} out"
              className="w-full h-9 rounded-lg border border-input bg-background px-2.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
            <div className="flex flex-wrap gap-1 mt-1.5">
              {["{today_income}", "{today_expense}", "{month_income}", "{month_expense}"].map((p) => (
                <button
                  key={p}
                  onClick={() => insertPlaceholder(p)}
                  className="press text-[10px] font-mono px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          <div className="flex justify-end">
            <button
              onClick={create}
              disabled={loading || !message.trim() || (repeat === "once" && !date) || (repeat === "weekly" && days.length === 0)}
              className="press h-8 px-3 rounded-lg bg-primary text-primary-foreground text-xs font-medium flex items-center gap-1.5 disabled:opacity-60"
            >
              {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} Schedule
            </button>
          </div>
        </div>

        <div className="space-y-2">
          {notifs.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No reminders yet.</p>
          ) : (
            notifs.map((n) => (
              <div key={n.id} className="flex items-start justify-between p-3.5 bg-muted/50 border border-border rounded-xl">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-primary">{n.description}</p>
                  <p className="text-sm text-foreground truncate mt-0.5">{n.message}</p>
                  <p className="text-[11px] text-muted-foreground/70 mt-1">
                    {n.isActive
                      ? `next ${n.nextRunAt ? new Date(n.nextRunAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"}`
                      : "Paused"}
                    {n.lastFiredAt ? ` · last sent ${new Date(n.lastFiredAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-1 ml-2 shrink-0">
                  <button
                    onClick={() => toggle(n.id, !n.isActive)}
                    className="press text-xs px-2.5 h-7 rounded-lg border border-input text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
                  >
                    {n.isActive ? "Pause" : "Resume"}
                  </button>
                  <button
                    onClick={() => remove(n.id)}
                    className="press text-destructive/80 hover:text-destructive p-1.5 rounded-lg transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
        <p className="text-[11px] text-muted-foreground/70 pt-1">
          Reminders arrive as push notifications on devices where you&apos;ve enabled them (daily app → Settings). You can also ask the assistant — e.g. &quot;remind me at 9:10pm daily with today&apos;s totals&quot;.
        </p>
      </div>
    </div>
  );
}
