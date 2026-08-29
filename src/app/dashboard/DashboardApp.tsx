"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip,
} from "recharts";
import {
  TrendingUp, TrendingDown, Wallet, Download, LogOut, ArrowLeft, Users,
  RefreshCw, Bell, Plus, Trash2, FileText, Moon, Sun, Settings as SettingsIcon,
  Loader2,
} from "lucide-react";
import { MultiPeriodChart } from "@/components/dashboard/MultiPeriodChart";
import DeepDiveChat from "@/components/dashboard/DeepDiveChat";
import MindmapEditor from "@/components/mindmap/MindmapEditor";

const PIE_COLORS = [
  "#059669", "#d97706", "#e11d48", "#8b5cf6", "#0891b2", "#65a30d", "#db2777",
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
  const [exportingPdf, setExportingPdf] = useState(false);

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
  const cp = stats.currentPeriod;
  const pp = stats.previousPeriod;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border px-4 py-3 sticky top-0 bg-background/90 backdrop-blur-sm z-10 safe-top">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <a
              href="/"
              className="press h-9 w-9 rounded-xl flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
              title="Back to daily app"
            >
              <ArrowLeft className="w-5 h-5" />
            </a>
            <div>
              <p className="font-semibold text-sm text-foreground">Dashboard</p>
              <p className="text-[11px] text-muted-foreground">{username}</p>
            </div>
          </div>
          <div className="flex items-center gap-0.5">
            <button
              onClick={toggleTheme}
              className="press h-9 w-9 rounded-xl flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
              title="Toggle theme"
            >
              <Moon className="w-4 h-4 dark:hidden" />
              <Sun className="w-4 h-4 hidden dark:block" />
            </button>
            <a
              href="/dashboard/settings"
              className="press h-9 px-3 rounded-xl flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            >
              <SettingsIcon className="w-4 h-4" />
              <span className="hidden sm:inline">Settings</span>
            </a>
            <button
              onClick={() => load(period)}
              className="press h-9 w-9 rounded-xl flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
              title="Refresh"
            >
              <RefreshCw className="w-4 h-4" />
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

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* Period selector */}
        <div className="anim-fade-up">
          <div className="bg-card border border-border rounded-2xl p-4 flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {(["day", "week", "month", "3m", "6m", "1y"] as Period[]).map((p) => (
                <button
                  key={p}
                  onClick={() => changePeriod(p)}
                  className={`press text-xs px-3 h-8 rounded-lg font-medium border transition-colors ${
                    period === p
                      ? "border-primary bg-accent text-accent-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/40"
                  }`}
                >
                  {labelFor(p)}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5 sm:ml-auto flex-wrap">
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="h-8 rounded-lg border border-input bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40 w-[136px]"
              />
              <span className="text-muted-foreground text-xs">→</span>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="h-8 rounded-lg border border-input bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40 w-[136px]"
              />
              <button
                onClick={applyCustomRange}
                className="press h-8 px-3 rounded-lg border border-input text-xs font-medium text-foreground hover:bg-accent/50 transition-colors"
              >
                Apply
              </button>
            </div>
            <span className="w-full sm:w-auto text-xs text-muted-foreground">{stats.periodLabel}</span>
          </div>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="anim-fade-up-d1">
            <SummaryCard
              title="Income"
              value={`₹${cp.income.toLocaleString("en-IN")}`}
              delta={cp.income - pp.income}
              icon={<TrendingUp className="w-4 h-4 text-success" />}
            />
          </div>
          <div className="anim-fade-up-d2">
            <SummaryCard
              title="Expense"
              value={`₹${cp.expense.toLocaleString("en-IN")}`}
              delta={pp.expense - cp.expense}
              icon={<TrendingDown className="w-4 h-4 text-destructive" />}
              invertDeltaColor
            />
          </div>
          <div className="anim-fade-up-d3">
            <SummaryCard
              title="Net"
              value={`₹${cp.net.toLocaleString("en-IN")}`}
              delta={cp.net - pp.net}
              icon={<Wallet className="w-4 h-4 text-muted-foreground" />}
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
        <div className="bg-card border border-border rounded-2xl anim-fade-up">
          <div className="px-5 pt-5 pb-3">
            <h2 className="font-semibold text-sm text-foreground">Expense breakdown — {stats.periodLabel}</h2>
          </div>
          <div className="px-5 pb-5">
            {pieData.length === 0 ? (
              <p className="text-muted-foreground text-sm py-8 text-center">No expenses in this period.</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                      label={(entry: any) => `${entry.name} (₹${entry.value})`}
                      labelLine={false}
                    >
                      {pieData.map((_, i) => (
                        <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
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
            <div className="px-5 pt-5 pb-2">
              <h2 className="font-semibold text-sm text-foreground">Accounts ({stats.accounts.length})</h2>
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

        {/* Notifications */}
        <div className="anim-fade-up">
          <NotificationsCard />
        </div>

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
                <table className="w-full text-sm min-w-[640px]">
                  <thead>
                    <tr className="text-muted-foreground border-b border-border">
                      <th className="text-left py-2 pr-3 font-medium">When</th>
                      <th className="text-left py-2 pr-3 font-medium">Type</th>
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
                          <td className="py-2.5 pr-3 text-xs">
                            <span className={`px-2 py-0.5 rounded-full font-medium ${isIncome ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
                              {t.type.replace(/_/g, " ")}
                            </span>
                          </td>
                          <td className={`py-2.5 pr-3 text-right font-mono tnum ${isIncome ? "text-success" : "text-foreground"}`}>
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

function SummaryCard({
  title, value, delta, icon, invertDeltaColor,
}: {
  title: string; value: string; delta: number; icon: React.ReactNode; invertDeltaColor?: boolean;
}) {
  const isPositive = delta >= 0;
  const showColor = invertDeltaColor ? !isPositive : isPositive;
  return (
    <div className="bg-card border border-border rounded-2xl p-5 h-full">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{title}</p>
        {icon}
      </div>
      <p className="text-2xl font-semibold mt-2.5 text-foreground tnum">{value}</p>
      {delta !== 0 && (
        <p className={`text-xs mt-1.5 tnum ${showColor ? "text-success" : "text-destructive"}`}>
          {isPositive ? "↑" : "↓"} ₹{Math.abs(delta).toLocaleString("en-IN")} vs previous period
        </p>
      )}
    </div>
  );
}

function NotificationsCard() {
  const [notifs, setNotifs] = useState<Array<{ id: string; schedule: string; message: string; isActive: boolean; lastFiredAt: string | null }>>([]);
  const [newSchedule, setNewSchedule] = useState("0 20 * * *");
  const [newMessage, setNewMessage] = useState("Time to log your transactions!");
  const [loading, setLoading] = useState(false);

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
        body: JSON.stringify({ schedule: newSchedule, message: newMessage }),
      });
      if (res.ok) {
        toast.success("Reminder scheduled");
        setNewSchedule("0 20 * * *");
        setNewMessage("Time to log your transactions!");
        load();
      } else {
        const e = await res.json();
        toast.error(e.error ?? "Couldn't schedule");
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

  return (
    <div className="bg-card border border-border rounded-2xl">
      <div className="px-5 pt-5 pb-3">
        <h2 className="font-semibold text-sm text-foreground flex items-center gap-2">
          <Bell className="w-4 h-4 text-primary" /> Reminders
        </h2>
        <p className="text-xs text-muted-foreground mt-1.5">
          Schedule nudges to log transactions or daily/weekly summaries. Use{" "}
          <code className="bg-muted px-1 py-0.5 rounded text-[10px]">{`{today_income}`}</code>,{" "}
          <code className="bg-muted px-1 py-0.5 rounded text-[10px]">{`{today_expense}`}</code>,{" "}
          <code className="bg-muted px-1 py-0.5 rounded text-[10px]">{`{month_income}`}</code>,{" "}
          <code className="bg-muted px-1 py-0.5 rounded text-[10px]">{`{month_expense}`}</code>{" "}
          in the message to include your totals.
        </p>
      </div>
      <div className="px-5 pb-5 space-y-3">
        <div className="space-y-2 p-4 bg-muted/50 border border-border rounded-xl">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Schedule</label>
              <input
                value={newSchedule}
                onChange={(e) => setNewSchedule(e.target.value)}
                placeholder="0 20 * * * (daily 8pm)"
                className="w-full h-9 rounded-lg border border-input bg-background px-2.5 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Message</label>
              <input
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                placeholder="Today: {today_income} in / {today_expense} out"
                className="w-full h-9 rounded-lg border border-input bg-background px-2.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
            </div>
          </div>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-[11px] text-muted-foreground/80">
              Cron e.g. <code className="bg-muted px-1 rounded">0 20 * * *</code> daily 8pm · <code className="bg-muted px-1 rounded">0 9 * * 1</code> Mondays 9am · or a one-time <code className="bg-muted px-1 rounded">2026-09-01T20:00:00</code>
            </p>
            <button
              onClick={create}
              disabled={loading}
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
                  <p className="text-xs font-mono text-muted-foreground">{n.schedule}</p>
                  <p className="text-sm text-foreground truncate mt-0.5">{n.message}</p>
                  <p className="text-[11px] text-muted-foreground/70 mt-1">
                    {n.isActive ? "Active" : "Paused"} · last sent {n.lastFiredAt ? new Date(n.lastFiredAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "never"}
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
          Reminders arrive as push notifications on devices where you&apos;ve enabled them (daily app → Settings).
        </p>
      </div>
    </div>
  );
}
