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
 *   - reply: string (assistant text; any [CHART:{...}] marker is stripped from the displayed reply)
 *   - chartSpec: object | null (parsed from the [CHART:{...}] marker if present)
 *   - toolCalls: array
 *
 * The dashboard agent knows (via system prompt) to offer charts by appending a
 * [CHART:{...}] line; we parse that out so the UI can render a "show as chart"
 * button alongside the textual reply.
 */

interface ChartSpec {
  type: "bar" | "line" | "pie";
  title: string;
  data: Array<{ label: string; value: number }>;
  xLabel?: string;
  yLabel?: string;
}

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

    // Extract [CHART:{...}] marker (if present)
    const { cleanText, chartSpec } = extractChartMarker(result.assistantText);

    return NextResponse.json({
      reply: cleanText,
      chartSpec,
      toolCalls: result.toolCalls,
    });
  } catch (e: any) {
    console.error("[deep-dive]", e);
    return NextResponse.json({
      error: `Agent error: ${e?.message ?? "unknown"}`,
    }, { status: 500 });
  }
}

/**
 * Parse [CHART:{...}] marker from the agent's reply.
 * We need balanced-brace matching because chart specs contain nested JSON
 * (e.g., data: [{ label: ..., value: ... }]). A simple non-greedy regex stops
 * at the first `}` (inside the data array) and breaks parsing.
 *
 * Strategy:
 * 1. Find the literal "[CHART:" prefix.
 * 2. From there, scan forward counting brace depth.
 * 3. When depth returns to 0, that's the end of the JSON object.
 * 4. Expect a closing "]" right after.
 */
function extractChartMarker(raw: string): { cleanText: string; chartSpec: ChartSpec | null } {
  const startIdx = raw.indexOf("[CHART:");
  if (startIdx === -1) {
    return { cleanText: raw.trim(), chartSpec: null };
  }
  const afterBracket = startIdx + "[CHART:".length;
  if (raw[afterBracket] !== "{") {
    // Malformed marker; strip just the literal "[CHART:" and continue.
    return { cleanText: raw.replace("[CHART:", "").trim(), chartSpec: null };
  }

  // Balanced-brace scan
  let depth = 0;
  let inString = false;
  let escape = false;
  let endIdx = -1;
  for (let i = afterBracket; i < raw.length; i++) {
    const c = raw[i];
    if (escape) { escape = false; continue; }
    if (c === "\\" && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) { endIdx = i; break; }
    }
  }
  if (endIdx === -1) {
    // Unbalanced — fall back to the whole tail; the JSON parse will likely fail.
    return { cleanText: raw.slice(0, startIdx).trim(), chartSpec: null };
  }

  // The full marker is raw.slice(startIdx, endIdx + 2)  →  "[CHART:{...}]"
  const fullMarker = raw.slice(startIdx, endIdx + 2);
  const jsonStr = raw.slice(afterBracket, endIdx + 1);

  try {
    const parsed = JSON.parse(jsonStr) as ChartSpec;
    if (!parsed || !Array.isArray(parsed.data) || !parsed.type) {
      return { cleanText: raw.replace(fullMarker, "").trim(), chartSpec: null };
    }
    return {
      cleanText: raw.replace(fullMarker, "").trim(),
      chartSpec: parsed,
    };
  } catch {
    return { cleanText: raw.replace(fullMarker, "").trim(), chartSpec: null };
  }
}
