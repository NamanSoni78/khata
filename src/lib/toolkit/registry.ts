/**
 * TOOLKIT · TOOL REGISTRY + FUZZY NAME RESOLUTION
 * ================================================
 *
 * Models hallucinate tool names constantly:
 *   - camelCase:   `logExpense`      → log_expense
 *   - kebab-case:  `log-expense`     → log_expense
 *   - typos:       `log_expenss`     → log_expense
 *   - prefix junk: `functions.log_expense` → log_expense
 *   - wrappers:    `tool_use: log_expense` → log_expense
 *
 * The registry normalizes names on lookup and applies Levenshtein fuzzy
 * matching with a tight cutoff, so hallucinations self-heal instead of
 * erroring with "unknown tool".
 */

import { levenshtein } from "./schema";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface ToolSpec {
  /** Canonical snake_case name the LLM is told about. */
  name: string;
  /** What the tool does (shown to the LLM). */
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  /** The implementation. Receives already-validated + coerced args. */
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string> | string;
}

export interface ToolContext {
  userId: string;
  [k: string]: unknown;
}

export interface ResolvedName {
  /** Canonical tool found. */
  tool: ToolSpec;
  /** true when the model used the exact canonical name. */
  exact: boolean;
  /** The (cleaned) name the model actually used, when different. */
  usedName?: string;
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export class ToolRegistry {
  private tools = new Map<string, ToolSpec>();
  /** alias → canonical (e.g. camelCase forms registered up front) */
  private aliases = new Map<string, string>();

  register(...specs: ToolSpec[]): this {
    for (const spec of specs) {
      this.tools.set(spec.name, spec);
      // Pre-register camelCase / kebab-case aliases
      for (const alias of nameAliases(spec.name)) {
        if (!this.aliases.has(alias)) this.aliases.set(alias, spec.name);
      }
    }
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(normalizeName(name));
  }

  list(): ToolSpec[] {
    return [...this.tools.values()];
  }

  /** Names only (for error messages / prompts). */
  names(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * Resolve whatever name the model emitted to a registered tool.
   * Never throws — returns null when nothing credible matches.
   */
  resolve(rawName: string): ResolvedName | null {
    if (!rawName || typeof rawName !== "string") return null;

    const cleaned = cleanName(rawName);
    const canonical = normalizeName(cleaned);

    // 1. Exact canonical name
    if (this.tools.has(canonical)) {
      return { tool: this.tools.get(canonical)!, exact: cleaned === canonical };
    }

    // 2. Registered alias (camelCase / kebab variants)
    const aliasTarget = this.aliases.get(canonical);
    if (aliasTarget && this.tools.has(aliasTarget)) {
      return { tool: this.tools.get(aliasTarget)!, exact: false, usedName: cleaned };
    }

    // 3. Fuzzy: closest canonical name within cutoff
    let best: string | null = null;
    let bestDist = Infinity;
    for (const name of this.tools.keys()) {
      const d = levenshtein(canonical, name, 3);
      if (d < bestDist) {
        bestDist = d;
        best = name;
      }
    }
    // Tight cutoff — accept only clearly-intended matches
    const cutoff = Math.max(2, Math.floor(canonical.length / 4));
    if (best && bestDist <= cutoff) {
      return { tool: this.tools.get(best)!, exact: false, usedName: cleaned };
    }

    // 4. Substring containment (model prefixed/suffixed the real name)
    for (const name of this.tools.keys()) {
      if (canonical.length >= 5 && (canonical.includes(name) || name.includes(canonical))) {
        return { tool: this.tools.get(name)!, exact: false, usedName: cleaned };
      }
    }

    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Name normalization helpers                                          */
/* ------------------------------------------------------------------ */

/** Strip wrapper junk models add around tool names. */
function cleanName(raw: string): string {
  return raw
    .trim()
    .replace(/^(tool_use|function|functions|tool|tools|fn|call)\s*[:.\-]\s*/i, "")
    .replace(/^(<|`|\[|\{)+/, "")
    .replace(/(>|`|\]|\})+$/, "")
    .trim();
}

/** Lowercase snake_case normalization: logExpense/log-expense/log expense → logexpense. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[\s\-]+/g, "_").replace(/[^a-z0-9_]/g, "");
}

/** All plausible spellings of a canonical name that should resolve to it. */
function nameAliases(canonical: string): string[] {
  const snake = canonical.toLowerCase();
  const camel = snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  const kebab = snake.replace(/_/g, "-");
  const spaced = snake.replace(/_/g, " ");
  const pascal = camel.charAt(0).toUpperCase() + camel.slice(1);
  return [snake, camel, kebab, spaced, pascal].filter((a) => a && a !== canonical);
}

/* ------------------------------------------------------------------ */
/* Shared tool-call shape                                              */
/* ------------------------------------------------------------------ */

/** A tool call extracted from any provider, pre-validation. */
export interface RawToolCall {
  /** Provider-supplied id (or synthesized for JSON mode). */
  id: string;
  /** Name exactly as the model emitted it (may need fuzzy resolution). */
  name: string;
  /**
   * Arguments — one of:
   *  - raw JSON string (native OpenAI style — repair applies)
   *  - pre-parsed object (Anthropic style — coercion applies)
   */
  rawArgs: string | Record<string, unknown>;
  /** Where this call came from — for diagnostics. */
  source: "native" | "inline-json";
}
