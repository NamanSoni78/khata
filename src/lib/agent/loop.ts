/**
 * Agent conversation loop:
 * 1. Build system prompt (with time + schema + recent txns)
 * 2. Load last N chat messages from DB
 * 3. Call LLM with user's new message
 * 4. If LLM returned tool calls, dispatch them, append results, call LLM again
 * 5. Repeat until no more tool calls (or 5 iterations max)
 * 6. Persist final assistant message + return to caller
 */
import { db } from "@/lib/db";
import { chatComplete, type LLMMessage, type ToolDefinition } from "@/lib/llm/client";
import type { AgentConfig } from "@/lib/admin-config";
import { dispatchTool } from "./tools";
import { buildDailySystemPrompt, buildDashboardSystemPrompt } from "./prompt-builder";

const MAX_TOOL_ITERATIONS = 5;
const HISTORY_LIMIT = 12; // last N chat messages to load into context

export interface AgentRunResult {
  assistantText: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; result: string }>;
  tokensUsed: number;
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

  // 1. Build system prompt
  const basePrompt = config.systemPrompt || "";
  const systemPrompt =
    agentType === "daily"
      ? await buildDailySystemPrompt(userId, basePrompt)
      : await buildDashboardSystemPrompt(userId, basePrompt);

  // 2. Load history
  const history = await db.chatMessage.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
  });
  history.reverse();

  // 3. Persist the new user message
  const userMsg = await db.chatMessage.create({
    data: { userId, role: "user", content: userMessage, metadata: "{}" },
  });

  // If the LLM call fails (bad key, provider down, network), remove the orphan
  // user message so the chat history doesn't show unanswered messages.
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

  // 4. Build the message list
  const messages: LLMMessage[] = [{ role: "system", content: systemPrompt }];
  for (const h of history) {
    if (h.role === "tool") {
      const meta = JSON.parse(h.metadata || "{}");
      messages.push({ role: "tool", content: h.content, toolCallId: meta.toolCallId });
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

  // 5. Tool-calling loop
  const executedToolCalls: AgentRunResult["toolCalls"] = [];
  // Track tool calls dispatched in this turn (name + arg hash) so we can
  // detect duplicates. Without this, an over-eager model that keeps emitting
  // the same call (e.g., "log 200rs zomato" repeated 5x) hits the iteration
  // limit AND creates 5 duplicate txns before stopping.
  const dispatchedKeys = new Set<string>();
  let iteration = 0;
  let lastAssistantText = "";

  while (iteration < MAX_TOOL_ITERATIONS) {
    iteration++;
    const res = await chatComplete(config, messages, tools);

    // If model returned tool calls, dispatch and continue
    if (res.toolCalls.length > 0) {
      // Filter out duplicate calls — same (name + args) already dispatched
      const uniqueToolCalls = res.toolCalls.filter((tc) => {
        const key = `${tc.name}::${JSON.stringify(tc.arguments)}`;
        if (dispatchedKeys.has(key)) return false;
        dispatchedKeys.add(key);
        return true;
      });

      // If ALL the calls in this turn are duplicates of calls we already
      // dispatched, the model is stuck in a loop. Stop here with the text
      // it produced, rather than re-dispatching + hitting the iteration limit.
      if (uniqueToolCalls.length === 0) {
        lastAssistantText = res.content || lastAssistantText;
        await db.chatMessage.create({
          data: {
            userId,
            role: "assistant",
            content: res.content,
            metadata: JSON.stringify({ toolCalls: [], duplicateSkipped: res.toolCalls.length }),
          },
        });
        break;
      }

      // Append the assistant's tool-call message (use the UNIQUE subset —
      // otherwise the model sees its own duplicate calls echoed back and
      // gets even more confused about whether to stop)
      messages.push({
        role: "assistant",
        content: res.content,
        toolCalls: uniqueToolCalls,
      });
      // Persist this assistant turn (with the unique tool calls) to DB
      await db.chatMessage.create({
        data: {
          userId,
          role: "assistant",
          content: res.content,
          metadata: JSON.stringify({ toolCalls: uniqueToolCalls }),
        },
      });

      // Dispatch each unique tool call and append tool result message
      for (const tc of uniqueToolCalls) {
        const result = await dispatchTool(tc.name, userId, tc.arguments);
        executedToolCalls.push({ name: tc.name, args: tc.arguments, result });
        messages.push({
          role: "tool",
          content: result,
          toolCallId: tc.id,
          name: tc.name,
        });
        // Persist tool result to chat history
        await db.chatMessage.create({
          data: {
            userId,
            role: "tool",
            content: result,
            metadata: JSON.stringify({ toolCallId: tc.id, toolName: tc.name }),
          },
        });
      }
      // Continue the loop to let the model summarize the tool results
      lastAssistantText = res.content;
      continue;
    }

    // No tool calls — final text response
    lastAssistantText = res.content;
    await db.chatMessage.create({
      data: {
        userId,
        role: "assistant",
        content: res.content,
        metadata: JSON.stringify({ toolCalls: [] }),
      },
    });
    break;
  }

  if (iteration >= MAX_TOOL_ITERATIONS) {
    lastAssistantText = lastAssistantText || "(agent hit tool-call limit; stopping)";
  }

  // === POST-PROCESSING: AUTO-LINK MULTI-LEG TXNS ===
  // If the agent called multiple log_* / mark_event tools in this turn
  // and at least one had group_label, link all txns from this turn to that
  // group (covers cases where the LLM forgot group_label on some legs).
  await autoLinkTurnTxnsToGroup(userId, executedToolCalls);

  return {
    assistantText: lastAssistantText,
    toolCalls: executedToolCalls,
    tokensUsed: 0, // Phase 1: not tracked precisely
  };
}

/**
 * If any tool call in this turn had a `group_label`, find all txns created
 * in this turn (by parsing their result strings for "Txn ID: xxx") and link
 * any unlinked ones to that group. This makes multi-leg grouping robust even
 * if the LLM forgets group_label on some legs.
 */
async function autoLinkTurnTxnsToGroup(
  userId: string,
  executedToolCalls: AgentRunResult["toolCalls"]
): Promise<void> {
  // Find the first group_label among the calls
  const groupLabel = executedToolCalls
    .map((c) => c.args.group_label as string | undefined)
    .find((l) => l);
  if (!groupLabel) return;

  // Collect all txn IDs created in this turn (from result strings containing "Txn ID: ...")
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

  // Find or create the group
  let group = await db.transactionGroup.findFirst({
    where: { userId, label: { contains: groupLabel } },
  });
  if (!group) {
    group = await db.transactionGroup.create({
      data: { userId, label: groupLabel },
    });
  }

  // Link any unlinked txns from this turn to this group
  await db.transaction.updateMany({
    where: { id: { in: txnIds }, userId, groupId: null },
    data: { groupId: group.id },
  });
}
