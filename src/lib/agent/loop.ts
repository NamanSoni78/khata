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
  //    via the search_chat_history tool — effectively infinite context)
  const schemaMode = await getSchemaMode();
  const historyLimit =
    typeof (schemaMode as { chatHistoryLimit?: number }).chatHistoryLimit === "number"
      ? Math.max(4, Math.min(80, (schemaMode as { chatHistoryLimit: number }).chatHistoryLimit))
      : DEFAULT_HISTORY_LIMIT;
  const history = await db.chatMessage.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: historyLimit,
  });
  history.reverse();

  // 3. Persist the new user message
  const userMsg = await db.chatMessage.create({
    data: { userId, role: "user", content: userMessage, metadata: "{}" },
  });

  // If the LLM call fails (bad key, provider down after retries, network),
  // remove the orphan user message so history doesn't show unanswered messages.
  try {
    return await runAgentInner({ userId, userMessage, agentType, config, tools, history, systemPrompt });
  } catch (e) {
    await db.chatMessage.delete({ where: { id: userMsg.id } }).catch(() => {});
    throw e;
  }
}

async function runAgentInner(opts: {
  userId: string;
  userMessage: string;
  agentType: "daily" | "dashboard";
  config: AgentConfig;
  tools: ToolDefinition[];
  history: ChatHistoryRow;
  systemPrompt: string;
}): Promise<AgentRunResult> {
  const { userId, config, tools, history, systemPrompt, userMessage } = opts;

  // 4. Build the conversation in toolkit shape
  const messages: ToolkitMessage[] = [{ role: "system", content: systemPrompt }];
  for (const h of history) {
    if (h.role === "tool") {
      const meta = JSON.parse(h.metadata || "{}");
      messages.push({ role: "tool", content: h.content, toolCallId: meta.toolCallId, name: meta.toolName });
    } else if (h.role === "assistant") {
      const meta = JSON.parse(h.metadata || "{}");
      messages.push({
        role: "assistant",
        content: h.content,
        toolCalls: meta.toolCalls,
      });
    } else {
      messages.push({ role: h.role as "user" | "system", content: h.content });
    }
  }
  messages.push({ role: "user", content: userMessage });

  const runStart = messages.length; // everything appended after this = this run

  // 5. Run the SDK loop — tool calling that can't fail the turn
  const registry = registryFromDefs(tools, dispatchTool);
  const result = await runToolLoop({
    config,
    messages,
    registry,
    ctx: { userId },
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
          metadata: JSON.stringify({ toolCalls: m.toolCalls }),
        },
      });
    } else if (m.role === "tool") {
      await db.chatMessage.create({
        data: {
          userId,
          role: "tool",
          content: m.content,
          metadata: JSON.stringify({ toolCallId: m.toolCallId, toolName: m.name }),
        },
      });
    }
    // user-role synthetic nudges: intentionally not persisted
  }

  // 7. Persist the final assistant message
  const finalText = result.finalContent || "(no response)";
  await persistFinalAssistantMessage(userId, finalText, {
    toolCalls: [],
  });

  // 8. Post-processing: auto-link multi-leg txns
  await autoLinkTurnTxnsToGroup(userId, result.toolCalls);

  // 9. Extract chart marker (if the agent offered a chart)
  const { cleanText, chartSpec } = extractChartMarker(finalText);
  if (chartSpec) {
    await attachChartSpecToLastMessage(userId, chartSpec);
  }

  if (result.diagnostics.length > 0) {
    console.log(`[agent:${opts.agentType}] ${result.diagnostics.join(" | ")}`);
  }

  return {
    assistantText: cleanText,
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

/** Attach a parsed chart spec to the most recent assistant message. */
async function attachChartSpecToLastMessage(userId: string, chartSpec: ChartSpec): Promise<void> {
  const last = await db.chatMessage.findFirst({
    where: { userId, role: "assistant" },
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
