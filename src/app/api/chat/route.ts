import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { getDailyAgentConfig, getDashboardAgentConfig, getFeatureFlags } from "@/lib/admin-config";
import { runAgent } from "@/lib/agent/loop";
import { DAILY_TOOLS, DASHBOARD_TOOLS } from "@/lib/agent/tools-defs";
import { db } from "@/lib/db";

async function getDailyUser() {
  const token = await getSessionToken("daily");
  return await getSessionUser(token, "daily");
}
async function getDashboardUser() {
  const token = await getSessionToken("dashboard");
  return await getSessionUser(token, "dashboard");
}

// GET /api/chat?action=history — recent chat history for the daily app
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  if (action === "history") {
    const user = await getDailyUser();
    if (!user || user.id === "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "60", 10) || 60, 200);
    const rows = await db.chatMessage.findMany({
      where: { userId: user.id, role: { in: ["user", "assistant"] } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    rows.reverse();
    return NextResponse.json({
      messages: rows.map((r) => ({
        role: r.role as "user" | "assistant",
        content: r.content,
        ts: r.createdAt.toISOString(),
      })),
    });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}

// POST /api/chat?action=daily|dashboard
export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "daily";

  let userId: string;
  let config;
  let tools;
  let agentType: "daily" | "dashboard";

  if (action === "daily") {
    const user = await getDailyUser();
    if (!user || user.id === "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    userId = user.id;
    config = await getDailyAgentConfig();
    tools = DAILY_TOOLS;
    agentType = "daily";
  } else if (action === "dashboard") {
    const user = await getDashboardUser();
    if (!user || user.id === "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    userId = user.id;
    config = await getDashboardAgentConfig();
    tools = DASHBOARD_TOOLS;
    agentType = "dashboard";
  } else {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  if (!config.apiKey) {
    return NextResponse.json({
      error: "The assistant isn't set up yet. Please contact your administrator.",
    }, { status: 503 });
  }

  const { message } = await req.json();
  if (!message || typeof message !== "string") {
    return NextResponse.json({ error: "Missing message" }, { status: 400 });
  }

  try {
    const result = await runAgent({ userId, userMessage: message, agentType, config, tools });

    // If autoAppendTotals is on AND this is daily chat, append today + month totals
    let finalText = result.assistantText;
    if (action === "daily") {
      const flags = await getFeatureFlags();
      if (flags.autoAppendTotals) {
        const totals = await computeTotals(userId);
        finalText += `\n\n📊 Today: ₹${totals.todayIncome} in / ₹${totals.todayExpense} out\n📅 This month: ₹${totals.monthIncome} in / ₹${totals.monthExpense} out`;
      }
    }

    return NextResponse.json({
      reply: finalText,
      toolCalls: result.toolCalls,
    });
  } catch (e: any) {
    console.error("[chat]", e);
    const msg = e?.message ?? "unknown";
    // Don't leak provider/API details to clients — log them server-side only.
    if (msg.includes("API error") || msg.includes("API key") || msg.includes("fetch failed")) {
      return NextResponse.json({
        error: "The assistant is temporarily unavailable. Please try again in a moment.",
      }, { status: 502 });
    }
    return NextResponse.json({
      error: `Agent error: ${msg}`,
    }, { status: 500 });
  }
}

async function computeTotals(userId: string) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const txns = await db.transaction.findMany({
    where: { userId, timestamp: { gte: startOfMonth } },
  });
  let todayIncome = 0, todayExpense = 0, monthIncome = 0, monthExpense = 0;
  for (const t of txns) {
    const isIncome = t.type === "income" || t.type === "profit" || t.type === "loan_in";
    const isExpense = t.type === "expense" || t.type === "loss" || t.type === "fee" || t.type === "loan_out";
    if (t.timestamp >= startOfToday) {
      if (isIncome) todayIncome += t.amount;
      if (isExpense) todayExpense += t.amount;
    }
    if (isIncome) monthIncome += t.amount;
    if (isExpense) monthExpense += t.amount;
  }
  return { todayIncome, todayExpense, monthIncome, monthExpense };
}
