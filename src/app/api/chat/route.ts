import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import {
  getFeatureFlags,
  getUxConfig,
} from "@/lib/admin-config";
import { resolveDailyAgentConfig, resolveDashboardAgentConfig } from "@/lib/user-config";
import { runAgent } from "@/lib/agent/loop";
import { DAILY_TOOLS, DASHBOARD_TOOLS } from "@/lib/agent/tools-defs";
import { extractChartMarker } from "@/lib/agent/chart-marker";
import { originFromRequest } from "@/lib/app-url";
import { db } from "@/lib/db";

async function getDailyUser() {
  const token = await getSessionToken("daily");
  return await getSessionUser(token, "daily");
}
async function getDashboardUser() {
  const token = await getSessionToken("dashboard");
  return await getSessionUser(token, "dashboard");
}

// Default page size for history. The home app shows the latest 50 messages
// (the full transcript is exportable from the dashboard). Older messages stay
// saved in the DB forever.
const HISTORY_PAGE_SIZE = 50;

// GET /api/chat?action=history — DAILY chat history (paginated, dashboard-
// agent turns excluded — that's a separate thread).
//   ?limit=N   page size (default 50)
//   ?before=ISO  cursor: return messages strictly older than this timestamp
//   Returns { messages: [...], hasMore: boolean }
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  if (action === "history") {
    const user = await getDailyUser();
    if (!user || user.id === "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? String(HISTORY_PAGE_SIZE), 10) || HISTORY_PAGE_SIZE, 200);
    const before = url.searchParams.get("before");

    const where: any = {
      userId: user.id,
      role: { in: ["user", "assistant"] },
      // only the DAILY thread — dashboard-agent turns never appear in the home app
      NOT: { metadata: { contains: '"source":"dashboard"' } },
    };
    if (before) {
      const d = new Date(before);
      if (!isNaN(d.getTime())) where.createdAt = { lt: d };
    }

    const rows = await db.chatMessage.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit + 1, // +1 to detect whether an older page exists
    });

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    page.reverse();

    return NextResponse.json({
      messages: page.map((r) => {
        let meta: any = {};
        try { meta = JSON.parse(r.metadata || "{}"); } catch { meta = {}; }
        // Strip raw [CHART:{...}] markers from stored content so history
        // bubbles never show the marker syntax (older rows were persisted
        // with it inline). If the marker carries a spec and metadata doesn't
        // already have one, promote the parsed spec so old chart replies
        // render as charts again after a reload.
        let content = r.content;
        let chartSpec = meta.chartSpec ?? null;
        if (r.role === "assistant" && content.includes("[CHAR")) {
          const parsed = extractChartMarker(content);
          content = parsed.cleanText;
          chartSpec = chartSpec ?? parsed.chartSpec;
        }
        return {
          role: r.role as "user" | "assistant",
          content,
          ts: r.createdAt.toISOString(),
          chartSpec,
        };
      }),
      hasMore,
    });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}

// POST /api/chat?action=daily|dashboard
// The DAILY agent now has the full analytical toolkit (query/aggregate/charts/
// reminders/exports) — the dashboard deep-dive powers live in the '/' chat too.
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
    config = await resolveDailyAgentConfig(user.id); // admin defaults + user's own key overrides
    tools = DAILY_TOOLS;
    agentType = "daily";
  } else if (action === "dashboard") {
    const user = await getDashboardUser();
    if (!user || user.id === "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    userId = user.id;
    config = await resolveDashboardAgentConfig(user.id);
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
    const startedAt = Date.now();
    // Request-derived origin → any reminder the agent creates via the
    // create_scheduled_notification tool registers its QStash schedule
    // against the REAL public host (x-forwarded-host/proto), immune to
    // stale/mangled NEXT_PUBLIC_APP_URL env values.
    const result = await runAgent({
      userId,
      userMessage: message,
      agentType,
      config,
      tools,
      origin: originFromRequest(req) ?? undefined,
    });

    // Optional admin-configurable minimum reply delay (uxConfig.replyDelayMs).
    // Keeps the typing indicator visible long enough on very fast models.
    const ux = await getUxConfig();
    const delayMs = Math.max(0, Math.min(5000, Number(ux.replyDelayMs ?? 0)));
    if (delayMs > 0) {
      const elapsed = Date.now() - startedAt;
      if (elapsed < delayMs) {
        await new Promise((r) => setTimeout(r, delayMs - elapsed));
      }
    }

    // If autoAppendTotals is on AND this is daily chat, append today + month totals
    let finalText = result.assistantText;
    if (action === "daily") {
      const flags = await getFeatureFlags();
      if (flags.autoAppendTotals) {
        const totals = await computeTotals(userId);
        finalText += `\n\n📊 Today: ₹${totals.todayIncome} in / ₹${totals.todayExpense} out\n📅 This month: ₹${totals.monthIncome} in / ₹${totals.monthExpense} out`;
      }
    }
    // Absolute last guard — the client renders `reply` verbatim, and an
    // empty string would paint an empty bubble.
    if (!finalText.trim()) finalText = "Done.";

    return NextResponse.json({
      reply: finalText,
      chartSpec: result.chartSpec,
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
