import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { db } from "@/lib/db";

/**
 * GET /api/dashboard/stats?period=<day|week|month|3m|6m|1y|custom>&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Returns aggregated data for the requested period + the previous comparable period
 * (used for delta cards) + daily/weekly bucketed totals (used for trend charts).
 *
 * `period=month` (default) preserves the original v1 response shape so the existing
 * UI keeps working unchanged.
 */

type Period = "day" | "week" | "month" | "3m" | "6m" | "1y" | "custom";

interface Range { from: Date; to: Date; label: string; }

function getRange(period: Period, fromStr?: string | null, toStr?: string | null): Range {
  const now = new Date();
  const to = new Date(now);
  to.setHours(23, 59, 59, 999);

  let from = new Date(now);
  switch (period) {
    case "day":
      from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case "week": {
      // ISO week starts Monday
      const day = (now.getDay() + 6) % 7;
      from = new Date(now);
      from.setDate(now.getDate() - day);
      from.setHours(0, 0, 0, 0);
      break;
    }
    case "month":
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case "3m":
      from = new Date(now);
      from.setMonth(now.getMonth() - 3);
      from.setHours(0, 0, 0, 0);
      break;
    case "6m":
      from = new Date(now);
      from.setMonth(now.getMonth() - 6);
      from.setHours(0, 0, 0, 0);
      break;
    case "1y":
      from = new Date(now);
      from.setFullYear(now.getFullYear() - 1);
      from.setHours(0, 0, 0, 0);
      break;
    case "custom":
      if (fromStr) from = new Date(fromStr);
      from.setHours(0, 0, 0, 0);
      if (toStr) {
        to.setTime(new Date(toStr).getTime());
        to.setHours(23, 59, 59, 999);
      }
      break;
    default:
      from = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  return { from, to, label: periodLabel(period) };
}

function previousRange(period: Period, current: Range): Range {
  const spanMs = current.to.getTime() - current.from.getTime();
  const prevTo = new Date(current.from.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - spanMs);
  return { from: prevFrom, to: prevTo, label: `previous ${periodLabel(period)}` };
}

function periodLabel(period: Period): string {
  switch (period) {
    case "day": return "Today";
    case "week": return "This week";
    case "month": return "This month";
    case "3m": return "Last 3 months";
    case "6m": return "Last 6 months";
    case "1y": return "Last year";
    case "custom": return "Custom range";
  }
}

function summarize(txns: any[]) {
  const byCategory: Record<string, number> = {};
  let income = 0, expense = 0;
  for (const t of txns) {
    const cat = t.category?.name ?? "Uncategorized";
    if (t.type === "income" || t.type === "profit" || t.type === "loan_in") {
      income += t.amount;
    } else if (t.type === "expense" || t.type === "loss" || t.type === "fee" || t.type === "loan_out") {
      expense += t.amount;
      byCategory[cat] = (byCategory[cat] ?? 0) + t.amount;
    }
  }
  return { income, expense, net: income - expense, byCategory };
}

/** Bucket txns into daily buckets. Returns [{ date: "YYYY-MM-DD", income, expense }] */
function bucketByDay(txns: any[], from: Date, to: Date) {
  const buckets: Record<string, { income: number; expense: number }> = {};
  const cur = new Date(from);
  cur.setHours(0, 0, 0, 0);
  while (cur <= to) {
    const key = cur.toISOString().slice(0, 10);
    buckets[key] = { income: 0, expense: 0 };
    cur.setDate(cur.getDate() + 1);
  }
  for (const t of txns) {
    const key = t.timestamp.toISOString().slice(0, 10);
    if (!buckets[key]) buckets[key] = { income: 0, expense: 0 };
    const isIncome = t.type === "income" || t.type === "profit" || t.type === "loan_in";
    const isExpense = t.type === "expense" || t.type === "loss" || t.type === "fee" || t.type === "loan_out";
    if (isIncome) buckets[key].income += t.amount;
    if (isExpense) buckets[key].expense += t.amount;
  }
  return Object.entries(buckets).map(([date, v]) => ({ date, ...v }));
}

/** Bucket txns into weekly buckets. Returns [{ weekLabel: "W1", weekStart: "YYYY-MM-DD", income, expense }] */
function bucketByWeek(txns: any[], from: Date, _to: Date) {
  const buckets: Record<string, { weekStart: Date; income: number; expense: number }> = {};
  for (const t of txns) {
    const d = new Date(t.timestamp);
    const day = (d.getDay() + 6) % 7; // Monday=0
    const weekStart = new Date(d);
    weekStart.setDate(d.getDate() - day);
    weekStart.setHours(0, 0, 0, 0);
    const key = weekStart.toISOString().slice(0, 10);
    if (!buckets[key]) buckets[key] = { weekStart, income: 0, expense: 0 };
    const isIncome = t.type === "income" || t.type === "profit" || t.type === "loan_in";
    const isExpense = t.type === "expense" || t.type === "loss" || t.type === "fee" || t.type === "loan_out";
    if (isIncome) buckets[key].income += t.amount;
    if (isExpense) buckets[key].expense += t.amount;
  }
  return Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => ({
      weekStart: key,
      weekLabel: `${v.weekStart.getDate()}/${v.weekStart.getMonth() + 1}`,
      income: v.income,
      expense: v.expense,
    }));
}

/** Bucket by month. Returns [{ monthLabel: "Aug 2026", monthStart: "YYYY-MM", income, expense }] */
function bucketByMonth(txns: any[], _from: Date, _to: Date) {
  const buckets: Record<string, { income: number; expense: number }> = {};
  for (const t of txns) {
    const d = new Date(t.timestamp);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!buckets[key]) buckets[key] = { income: 0, expense: 0 };
    const isIncome = t.type === "income" || t.type === "profit" || t.type === "loan_in";
    const isExpense = t.type === "expense" || t.type === "loss" || t.type === "fee" || t.type === "loan_out";
    if (isIncome) buckets[key].income += t.amount;
    if (isExpense) buckets[key].expense += t.amount;
  }
  return Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => {
      const [y, m] = key.split("-").map(Number);
      const label = new Date(y, m - 1, 1).toLocaleString("en-IN", { month: "short", year: "numeric" });
      return { monthStart: key, monthLabel: label, income: v.income, expense: v.expense };
    });
}

export async function GET(req: NextRequest) {
  const token = await getSessionToken("dashboard");
  const user = await getSessionUser(token, "dashboard");
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = user.id;

  const url = new URL(req.url);
  const period = (url.searchParams.get("period") ?? "month") as Period;
  const fromStr = url.searchParams.get("from");
  const toStr = url.searchParams.get("to");

  const range = getRange(period, fromStr, toStr);
  const prevRange = previousRange(period, range);

  const [currentTxns, prevTxns, accounts, contacts, recentTxns] = await Promise.all([
    db.transaction.findMany({
      where: { userId, timestamp: { gte: range.from, lte: range.to } },
      include: { category: true },
    }),
    db.transaction.findMany({
      where: { userId, timestamp: { gte: prevRange.from, lte: prevRange.to } },
      include: { category: true },
    }),
    db.account.findMany({ where: { userId, isActive: true }, orderBy: { type: "asc" } }),
    db.contact.findMany({ where: { userId } }),
    db.transaction.findMany({
      where: { userId },
      orderBy: { timestamp: "desc" },
      take: 10,
      include: { fromAccount: true, toAccount: true, contact: true, category: true },
    }),
  ]);

  // Choose bucket granularity based on period
  let buckets: any[];
  if (period === "day") buckets = bucketByHour(currentTxns, range.from, range.to);
  else if (period === "week" || period === "month") buckets = bucketByDay(currentTxns, range.from, range.to);
  else if (period === "3m" || period === "6m") buckets = bucketByWeek(currentTxns, range.from, range.to);
  else buckets = bucketByMonth(currentTxns, range.from, range.to);

  return NextResponse.json({
    period,
    periodLabel: range.label,
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    currentPeriod: summarize(currentTxns),
    previousPeriod: summarize(prevTxns),
    buckets,
    accounts: accounts.map((a) => ({
      id: a.id, name: a.name, type: a.type, institution: a.institution, balance: a.balance,
    })),
    contacts: contacts.map((c) => ({
      id: c.id, name: c.name, type: c.type, balance: c.balance,
    })),
    recentTransactions: recentTxns.map((t) => ({
      id: t.id, type: t.type, amount: t.amount,
      category: t.category?.name,
      fromAccount: t.fromAccount?.name,
      toAccount: t.toAccount?.name,
      contact: t.contact?.name,
      timestamp: t.timestamp.toISOString(),
      notes: t.notes,
    })),
  });
}

/** For period=day, bucket by hour */
function bucketByHour(txns: any[], from: Date, _to: Date) {
  const buckets: Record<string, { income: number; expense: number }> = {};
  for (let h = 0; h < 24; h++) {
    const key = `${String(h).padStart(2, "0")}:00`;
    buckets[key] = { income: 0, expense: 0 };
  }
  for (const t of txns) {
    const d = new Date(t.timestamp);
    const key = `${String(d.getHours()).padStart(2, "0")}:00`;
    if (!buckets[key]) buckets[key] = { income: 0, expense: 0 };
    const isIncome = t.type === "income" || t.type === "profit" || t.type === "loan_in";
    const isExpense = t.type === "expense" || t.type === "loss" || t.type === "fee" || t.type === "loan_out";
    if (isIncome) buckets[key].income += t.amount;
    if (isExpense) buckets[key].expense += t.amount;
  }
  return Object.entries(buckets).map(([hour, v]) => ({ hour, income: v.income, expense: v.expense }));
}
