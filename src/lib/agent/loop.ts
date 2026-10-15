/**
 * Agent conversation orchestrator — persistence layer on top of the
 * toolkit's runToolLoop.
 *
 *  1. Build system prompt (time + schema + recent txns + user instructions)
 *  2. Load last N chat messages from DB (N admin-configurable)
 *  3. Persist the user's new message
 *  4. runToolLoop (the SDK): tool calls, repairs, retries, self-correction
 *  5. Persist every assistant/tool turn the SDK appended, then the final
 *     assistant message
 *  6. Post-process: chart markers, multi-leg auto-linking
 *
 * If the provider is genuinely unreachable (transport exhausted), the
 * orphan user message is removed so history never shows unanswered mail.
 */
import { db } from "@/lib/db";
import type { ToolDefinition, ToolCall } from "@/lib/llm/client";
import { sanitizeAssistantText } from "@/lib/toolkit/parse";
import { runToolLoop, registryFromDefs, type ToolkitMessage } from "@/lib/toolkit";
import { extractChartMarker, type ChartSpec } from "@/lib/agent/chart-marker";
import type { AgentConfig } from "@/lib/admin-config";
import { getSchemaMode } from "@/lib/admin-config";
import { getUserInstructions } from "@/lib/user-config";
import { dispatchTool } from "./tools";
import { buildDailySystemPrompt, buildDashboardSystemPrompt } from "./prompt-builder";

const DEFAULT_HISTORY_LIMIT = 24; // last N chat messages fed to the LLM

export interface AgentRunResult {
  assistantText: string;
  chartSpec: ChartSpec | null;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; result: string }>;
  tokensUsed: number;
  /** SDK-level notes (repairs applied, degradations) — for admin logs. */
  diagnostics?: string[];
}

type ChatHistoryRow = Awaited<ReturnType<typeof db.chatMessage.findMany>>;

export async function runAgent(opts: {
  userId: string;
  userMessage: string;
  agentType: "daily" | "dashboard";
  config: AgentConfig;
  tools: ToolDefinition[];
  /** Request-derived public origin — used for QStash reminder destinations. */
  origin?: string;
}): Promise<AgentRunResult> {
  const { userId, userMessage, agentType, config, tools } = opts;

  // 1. Build system prompt (+ the user's own custom instructions, if any)
  const basePrompt = config.systemPrompt || "";
  let systemPrompt =
    agentType === "daily"
      ? await buildDailySystemPrompt(userId, basePrompt)
      : await buildDashboardSystemPrompt(userId, basePrompt);
  try {
    const ins = await getUserInstructions(userId);
    const custom = (agentType === "daily" ? ins.daily : ins.dashboard)?.trim();
    if (custom) {
      systemPrompt += `\n\n=== USER CUSTOM INSTRUCTIONS (set by the user — follow faithfully) ===\n${custom}`;
    }
  } catch { /* instructions are best-effort */ }

  // 2. Load history (admin-configurable window; older turns stay reachable
  //    via the search_chat_history tool — effectively infinite context).
  //    Each agent only sees ITS OWN conversation: the daily chat and the
  //    dashboard analysis chat are separate threads (home app never shows
  //    dashboard-agent history and vice versa).
  const schemaMode = await getSchemaMode();
  const historyLimit =
    typeof (schemaMode as { chatHistoryLimit?: number }).chatHistoryLimit === "number"
      ? Math.max(4, Math.min(80, (schemaMode as { chatHistoryLimit: number }).chatHistoryLimit))
      : DEFAULT_HISTORY_LIMIT;
  const sourceFilter =
    agentType === "dashboard"
      ? { metadata: { contains: '"source":"dashboard"' } } // dashboard agent: only its own thread
      : { NOT: { metadata: { contains: '"source":"dashboard"' } } }; // daily: everything except dashboard turns (legacy rows default to daily)
  const history = await db.chatMessage.findMany({
    where: { userId, ...sourceFilter },
    orderBy: { createdAt: "desc" },
    take: historyLimit,
  });
  history.reverse();

  // 3. Persist the new user message (tagged with its source thread)
  const userMsg = await db.chatMessage.create({
    data: { userId, role: "user", content: userMessage, metadata: JSON.stringify({ source: agentType }) },
  });

  // If the LLM call fails (bad key, provider down after retries, network),
  // remove the orphan user message so history doesn't show unanswered messages.
  try {
    return await runAgentInner({ userId, userMessage, agentType, config, tools, history, systemPrompt, origin: opts.origin });
  } catch (e) {
    await db.chatMessage.delete({ where: { id: userMsg.id } }).catch(() => {});
    throw e;
  }
}

/** Shape of a DB chat row as far as history rebuilding cares. */
export interface HistoryRowLike {
  role: string;
  content: string;
  metadata?: string | null;
}

/**
 * Rebuild the LLM conversation from history rows — with PAIRING INTEGRITY.
 *
 * The history window (last N rows) can cut BETWEEN an assistant tool-call
 * turn and its tool results. Replayed naively, that produces orphaned
 * `tool` messages ("function call output" with a call_id the endpoint never
 * saw) or assistant tool_calls with no results — either one makes strict
 * endpoints 400:
 *   "No tool call found for function call output with call_id …"
 * which used to force a silent degrade to JSON-mode tool calling.
 *
 * Two-pass rebuild: (a) collect the call_ids declared by assistant messages
 * AND the call_ids that have tool results in this window; (b) emit tool
 * messages only when their id was declared by an assistant message INSIDE
 * the window, and strip toolCall entries whose results were cut off.
 * Empty assistant shells get dropped.
 */
export function rebuildHistoryMessages(
  history: HistoryRowLike[],
  systemPrompt: string,
  userMessage: string
): ToolkitMessage[] {
  const declared = new Set<string>(); // ids declared by in-window assistant messages
  const answered = new Set<string>(); // ids with an in-window tool result
  for (const h of history) {
    let meta: any = {};
    try { meta = JSON.parse(h.metadata || "{}"); } catch { meta = {}; }
    if (h.role === "assistant" && Array.isArray(meta.toolCalls)) {
      for (const tc of meta.toolCalls) {
        if (tc && typeof tc.id === "string") declared.add(tc.id);
      }
    } else if (h.role === "tool" && typeof meta.toolCallId === "string") {
      answered.add(meta.toolCallId);
    }
  }

  const messages: ToolkitMessage[] = [{ role: "system", content: systemPrompt }];
  for (const h of history) {
    if (h.role === "tool") {
      let meta: any = {};
      try { meta = JSON.parse(h.metadata || "{}"); } catch { meta = {}; }
      // Orphaned by the window cut → its declaring assistant message is
      // outside the window. Replaying it is exactly what 400s the endpoint.
      if (typeof meta.toolCallId !== "string" || !declared.has(meta.toolCallId)) continue;
      messages.push({ role: "tool", content: h.content, toolCallId: meta.toolCallId, name: meta.toolName });
    } else if (h.role === "assistant") {
      let meta: any = {};
      try { meta = JSON.parse(h.metadata || "{}"); } catch { meta = {}; }
      let toolCalls = Array.isArray(meta.toolCalls) ? meta.toolCalls : undefined;
      if (toolCalls && toolCalls.length > 0) {
        // Keep only the calls whose results made it into the window;
        // strict endpoints require every tool_call_id to be answered.
        const answeredCalls = toolCalls.filter(
          (tc: any) => tc && typeof tc.id === "string" && answered.has(tc.id)
        );
        toolCalls = answeredCalls.length > 0 ? answeredCalls : undefined;
      }
      // Drop empty shells (no text AND no live tool calls) — some endpoints
      // reject blank assistant messages too.
      if (!h.content && !toolCalls) continue;
      messages.push({
        role: "assistant",
        content: h.content,
        toolCalls,
      });
    } else {
      messages.push({ role: h.role as "user" | "system", content: h.content });
    }
  }
  messages.push({ role: "user", content: userMessage });
  return messages;
}

async function runAgentInner(opts: {
  userId: string;
  userMessage: string;
  agentType: "daily" | "dashboard";
  config: AgentConfig;
  tools: ToolDefinition[];
  history: ChatHistoryRow;
  systemPrompt: string;
  origin?: string;
}): Promise<AgentRunResult> {
  const { userId, config, tools, history, systemPrompt, userMessage } = opts;

  // 4. Build the conversation in toolkit shape (pairing-integrity rebuild —
  //    see rebuildHistoryMessages for why this can't be a naive loop).
  const messages = rebuildHistoryMessages(history, systemPrompt, userMessage);

  const runStart = messages.length; // everything appended after this = this run

  // 5. Run the SDK loop — tool calling that can't fail the turn
  const registry = registryFromDefs(tools, dispatchTool);
  const result = await runToolLoop({
    config,
    messages,
    registry,
    // agentType scopes search_chat_history to this thread; origin lets
    // reminder tools register QStash schedules against the real public host.
    ctx: { userId, agentType: opts.agentType, origin: opts.origin },
  });

  // 6. Persist the turns the SDK appended (assistant tool-call turns and
  //    tool results — synthetic nudge user messages are skipped)
  for (const m of messages.slice(runStart)) {
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      await db.chatMessage.create({
        data: {
          userId,
          role: "assistant",
          content: m.content, // already sanitized by the SDK
          metadata: JSON.stringify({ toolCalls: m.toolCalls, source: opts.agentType }),
        },
      });
    } else if (m.role === "tool") {
      await db.chatMessage.create({
        data: {
          userId,
          role: "tool",
          content: m.content,
          metadata: JSON.stringify({ toolCallId: m.toolCallId, toolName: m.name, source: opts.agentType }),
        },
      });
    }
    // user-role synthetic nudges: intentionally not persisted
  }

  // 7. Extract the chart marker BEFORE persisting so the stored bubble text
  //    is already clean (raw [CHART:{...}] markers used to leak into history
  //    bubbles after a reload); the spec rides in message metadata.
  //    (finalContent is guaranteed non-empty by the SDK's post-loop
  //    synthesis, but we still keep local fallbacks — belt and suspenders.)
  const finalText = result.finalContent;
  const { cleanText, chartSpec } = extractChartMarker(finalText);
  // Never persist an empty body: a chart-only reply still gets a caption,
  // and a truly empty model output falls back to the last tool result so
  // the user always sees what the agent actually did.
  const persistedText =
    cleanText ||
    (chartSpec ? "Here's the chart:" : "") ||
    synthesizeFromToolCalls(result.toolCalls) ||
    "Done.";
  await persistFinalAssistantMessage(userId, persistedText, {
    toolCalls: [],
    source: opts.agentType,
  });

  // 8. Post-processing: auto-link multi-leg txns
  await autoLinkTurnTxnsToGroup(userId, result.toolCalls);

  // 9. Attach the chart spec (if any) to the message we just persisted
  if (chartSpec) {
    await attachChartSpecToLastMessage(userId, opts.agentType, chartSpec);
  }

  if (result.diagnostics.length > 0) {
    console.log(`[agent:${opts.agentType}] ${result.diagnostics.join(" | ")}`);
  }

  return {
    assistantText: persistedText,
    chartSpec,
    toolCalls: result.toolCalls.map((c) => ({ name: c.name, args: c.args, result: c.result })),
    tokensUsed: 0,
    diagnostics: result.diagnostics,
  };
}

/** Persist the final assistant message for this turn. */
async function persistFinalAssistantMessage(
  userId: string,
  content: string,
  meta: Record<string, unknown>
): Promise<void> {
  await db.chatMessage.create({
    data: {
      userId,
      role: "assistant",
      content,
      metadata: JSON.stringify(meta),
    },
  });
}

/** Last-resort user-visible text built from this turn's tool results. */
function synthesizeFromToolCalls(
  toolCalls: Array<{ name: string; result: string; executed?: boolean }>
): string | null {
  const done = toolCalls.filter((c) => c.executed !== false);
  const last = done[done.length - 1];
  if (!last) return null;
  const line = last.result.split("\n").map((l) => l.trim()).filter(Boolean)[0];
  if (!line) return null;
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}

/** Attach a parsed chart spec to the most recent assistant message of the SAME thread. */
async function attachChartSpecToLastMessage(userId: string, source: "daily" | "dashboard", chartSpec: ChartSpec): Promise<void> {
  const sourceFilter =
    source === "dashboard"
      ? { metadata: { contains: '"source":"dashboard"' } }
      : { NOT: { metadata: { contains: '"source":"dashboard"' } } };
  const last = await db.chatMessage.findFirst({
    where: { userId, role: "assistant", ...sourceFilter },
    orderBy: { createdAt: "desc" },
  });
  if (!last) return;
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(last.metadata || "{}"); } catch { meta = {}; }
  meta.chartSpec = chartSpec;
  await db.chatMessage.update({
    where: { id: last.id },
    data: { metadata: JSON.stringify(meta) },
  });
}

/**
 * If any tool call in this turn had a `group_label`, find all txns created
 * in this turn (by parsing their result strings for "Txn ID: xxx") and link
 * any unlinked ones to that group. This makes multi-leg grouping robust even
 * if the LLM forgets group_label on some legs.
 */
async function autoLinkTurnTxnsToGroup(
  userId: string,
  executedToolCalls: Array<{ name: string; args: Record<string, unknown>; result: string }>
): Promise<void> {
  const groupLabel = executedToolCalls
    .map((c) => c.args.group_label as string | undefined)
    .find((l) => l);
  if (!groupLabel) return;

  const txnIds: string[] = [];
  for (const call of executedToolCalls) {
    const matches = call.result.match(/Txn ID: (\w+)/g);
    if (matches) {
      for (const m of matches) {
        const id = m.replace("Txn ID: ", "");
        if (!txnIds.includes(id)) txnIds.push(id);
      }
    }
  }
  if (txnIds.length < 2) return;

  let group = await db.transactionGroup.findFirst({
    where: { userId, label: { contains: groupLabel } },
  });
  if (!group) {
    group = await db.transactionGroup.create({
      data: { userId, label: groupLabel },
    });
  }

  await db.transaction.updateMany({
    where: { id: { in: txnIds }, userId, groupId: null },
    data: { groupId: group.id },
  });
}

// Re-export for callers that imported it from loop.ts previously
export { sanitizeAssistantText };
export type { ToolCall };
