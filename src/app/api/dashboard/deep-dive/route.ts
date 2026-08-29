import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { getDashboardAgentConfig } from "@/lib/admin-config";
import { runAgent } from "@/lib/agent/loop";
import { DASHBOARD_TOOLS } from "@/lib/agent/tools-defs";

/**
 * POST /api/dashboard/deep-dive
 * Body: { message: string }
 * Runs the dashboard agent on the user's message and returns:
 *   - reply: string (assistant text; the [CHART:{...}] marker is extracted by
 *     the agent loop before persisting, so the displayed reply is always clean)
 *   - chartSpec: object | null (parsed from the [CHART:{...}] marker if present)
 *   - toolCalls: array
 */

export async function POST(req: NextRequest) {
  const token = await getSessionToken("dashboard");
  const user = await getSessionUser(token, "dashboard");
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const config = await getDashboardAgentConfig();
  if (!config.apiKey) {
    return NextResponse.json({
      error: "The assistant isn't set up yet. Please contact your administrator.",
    }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const message = body.message as string | undefined;
  if (!message || typeof message !== "string") {
    return NextResponse.json({ error: "Missing message" }, { status: 400 });
  }

  try {
    const result = await runAgent({
      userId: user.id,
      userMessage: message,
      agentType: "dashboard",
      config,
      tools: DASHBOARD_TOOLS,
    });

    return NextResponse.json({
      reply: result.assistantText,
      chartSpec: result.chartSpec,
      toolCalls: result.toolCalls,
    });
  } catch (e: any) {
    console.error("[deep-dive]", e);
    const msg = e?.message ?? "unknown";
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
