/**
 * TOOLKIT · PUBLIC API
 * =====================
 *
 * Khata's internal tool-calling SDK. Purpose: agents NEVER fail at tool
 * calling. Layered defense:
 *
 *   transport   — timeout + retry/backoff (429, 5xx, network)
 *   providers   — OpenAI-compat + Anthropic, raw args preserved
 *   json-repair — state-machine repair of malformed tool arguments
 *   schema      — validation + smart type coercion
 *   registry    — fuzzy tool-name resolution (hallucination healing)
 *   executor    — timeout-wrapped, never-throw execution envelopes
 *   agent-loop  — self-correction feedback, dedup, auto-degradation
 *
 * Typical use:
 *   const registry = registryFromDefs(DAILY_TOOLS, dispatchTool);
 *   const result = await runToolLoop({ config, messages, registry, ctx });
 */

import { ToolRegistry, type ToolSpec, type ToolContext } from "./registry";
import type { ToolDefinition } from "@/lib/llm/client";

export { repairJson, repairJsonValue } from "./json-repair";
export { validateAndCoerce, coerceNumber, coerceBoolean, levenshtein } from "./schema";
export { ToolRegistry } from "./registry";
export type { ToolSpec, ToolContext, RawToolCall, ResolvedName } from "./registry";
export { fetchWithRetry, TransportError, sleep } from "./transport";
export {
  callProvider,
  buildJsonModeConversation,
  isToolUnsupportedError,
  parseExtraHeaders,
  ProviderError,
} from "./providers";
export type { ToolkitMessage, ToolkitToolCall, ProviderResult } from "./providers";
export { executeToolCall, mineInlineCalls } from "./executor";
export type { ToolOutcome } from "./executor";
export { runToolLoop } from "./agent-loop";
export type { LoopResult, LoopOptions, ExecutedCall } from "./agent-loop";
export {
  extractInlineToolCalls,
  parseNativeArgs,
  sanitizeAssistantText,
} from "./parse";

/* ------------------------------------------------------------------ */
/* Bridge: legacy ToolDefinition[] + dispatcher → ToolRegistry        */
/* ------------------------------------------------------------------ */

/**
 * Build a ToolRegistry from the legacy `ToolDefinition[]` catalogs
 * (tools-defs.ts) and the legacy dispatcher (tools.ts). Each tool's
 * `execute` delegates to `dispatch(name, userId, args)`.
 */
export function registryFromDefs(
  defs: ToolDefinition[],
  dispatch: (
    name: string,
    userId: string,
    args: Record<string, unknown>,
    ctx?: ToolContext
  ) => Promise<string>
): ToolRegistry {
  const registry = new ToolRegistry();
  const specs: ToolSpec[] = defs.map((d) => ({
    name: d.function.name,
    description: d.function.description,
    parameters: d.function.parameters as Record<string, unknown>,
    execute: (args, ctx: ToolContext) => dispatch(d.function.name, ctx.userId, args, ctx),
  }));
  registry.register(...specs);
  return registry;
}
