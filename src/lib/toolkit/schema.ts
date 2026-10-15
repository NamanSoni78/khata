/**
 * TOOLKIT · SCHEMA VALIDATION + TYPE COERCION
 * ============================================
 *
 * Even after JSON repair, tool arguments often carry type errors:
 *   - `"amount": "200"`          (string, schema wants number)
 *   - `"amount": "20rs"`         (string with currency suffix)
 *   - `"amount": "1,200"`        (Indian-style thousands separator)
 *   - `"include_food": "true"`   (string, schema wants boolean)
 *   - `"tags": "food, travel"`   (comma string, schema wants array)
 *   - `"nested": "{\"a\":1}"`    (JSON-in-string, schema wants object)
 *   - `"category": 20`           (number, schema wants string)
 *
 * `validateAndCoerce` walks the tool's JSON Schema, coerces what it safely
 * can, and collects PRECISE error messages written FOR THE MODEL so the
 * agent loop can feed them back for self-correction.
 *
 * It never throws. Unknown properties are kept (liquid schema philosophy —
 * tools may accept extra context), but flagged in `warnings`.
 */

import { repairJsonValue } from "./json-repair";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface ValidationOutcome {
  /** true when args are usable (after coercion). */
  ok: boolean;
  /** The coerced arguments object. */
  value: Record<string, unknown>;
  /** Errors the MODEL should see (empty when ok). */
  errors: string[];
  /** Non-fatal notes (coercions applied, unknown fields, etc.). */
  warnings: string[];
}

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: Array<string | number>;
  description?: string;
  [k: string]: unknown;
};

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export function validateAndCoerce(
  args: Record<string, unknown>,
  schema: JsonSchema
): ValidationOutcome {
  const errors: string[] = [];
  const warnings: string[] = [];
  const value = coerceObject(args, schema, "", errors, warnings);

  // Required-field check (top level; nested objects checked recursively too)
  for (const req of schema.required ?? []) {
    if (value[req] === undefined || value[req] === null) {
      errors.push(
        `Missing required field "${req}".${fieldHint(schema, req)}`
      );
    }
  }

  return { ok: errors.length === 0, value, errors, warnings };
}

/* ------------------------------------------------------------------ */
/* Coercion core                                                       */
/* ------------------------------------------------------------------ */

function coerceObject(
  obj: Record<string, unknown>,
  schema: JsonSchema,
  path: string,
  errors: string[],
  warnings: string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const props = schema.properties ?? {};

  for (const [key, rawVal] of Object.entries(obj)) {
    const fieldPath = path ? `${path}.${key}` : key;
    const fieldSchema = props[key];

    if (!fieldSchema) {
      // Unknown property — keep it (liquid schema), warn
      warnings.push(`Unknown field "${fieldPath}" (kept as-is)`);
      out[key] = rawVal;
      continue;
    }

    out[key] = coerceValue(rawVal, fieldSchema, fieldPath, errors, warnings);
  }
  return out;
}

function coerceValue(
  raw: unknown,
  schema: JsonSchema,
  path: string,
  errors: string[],
  warnings: string[]
): unknown {
  if (raw === undefined || raw === null) return raw;

  const expected = schema.type;

  // Enum check (after any coercion below)
  const checkEnum = (v: unknown): unknown => {
    if (schema.enum && !schema.enum.includes(v as string | number)) {
      const suggestion = fuzzyEnumPick(String(v), schema.enum);
      if (suggestion !== undefined) {
        warnings.push(`"${path}": "${v}" not in enum — corrected to "${suggestion}"`);
        return suggestion;
      }
      errors.push(
        `Field "${path}" must be one of: ${schema.enum.map((e) => JSON.stringify(e)).join(", ")} (got ${JSON.stringify(v)})`
      );
    }
    return v;
  };

  switch (expected) {
    case "number":
    case "integer": {
      const n = coerceNumber(raw);
      if (n === null) {
        errors.push(
          `Field "${path}" must be a${expected === "integer" ? "n integer" : " number"} (got ${JSON.stringify(raw)}). Write it as a plain number, e.g. 200`
        );
        return raw;
      }
      if (expected === "integer" && !Number.isInteger(n)) {
        const rounded = Math.round(n);
        warnings.push(`"${path}": ${n} rounded to integer ${rounded}`);
        return checkEnum(rounded);
      }
      if (typeof raw !== "number") warnings.push(`"${path}": ${JSON.stringify(raw)} → ${n}`);
      return checkEnum(n);
    }

    case "string": {
      const s = coerceString(raw);
      if (s === null) {
        errors.push(`Field "${path}" must be a string (got ${JSON.stringify(raw)})`);
        return raw;
      }
      if (typeof raw !== "string") warnings.push(`"${path}": ${JSON.stringify(raw)} → "${s}"`);
      return checkEnum(s);
    }

    case "boolean": {
      const b = coerceBoolean(raw);
      if (b === null) {
        errors.push(`Field "${path}" must be a boolean (got ${JSON.stringify(raw)}). Use true or false`);
        return raw;
      }
      if (typeof raw !== "boolean") warnings.push(`"${path}": ${JSON.stringify(raw)} → ${b}`);
      return b;
    }

    case "array": {
      const arr = coerceArray(raw, path, errors, warnings);
      if (schema.items && Array.isArray(arr)) {
        return arr.map((item, idx) =>
          coerceValue(item, schema.items as JsonSchema, `${path}[${idx}]`, errors, warnings)
        );
      }
      return arr;
    }

    case "object": {
      const obj = coerceObjectValue(raw, path, errors, warnings);
      if (obj !== null && schema.properties) {
        return coerceObject(obj, schema, path, errors, warnings);
      }
      return obj ?? raw;
    }

    default:
      // No type constraint (or unsupported type) — accept as-is
      return raw;
  }
}

/* ------------------------------------------------------------------ */
/* Per-type coercers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Coerce almost anything numeric-looking to a number.
 *   "200" → 200 · "20rs" → 20 · "₹1,200" → 1200 · "2.5k"→ 2.5? no —
 *   "2k"/"2 hazar" style suffix math belongs to the LLM, not here.
 *   We only accept: pure numeric strings, numbers, strings with
 *   currency symbols / thousand separators / surrounding whitespace.
 */
export function coerceNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;

  let s = raw.trim();
  if (!s) return null;

  // Strip currency symbols
  s = s.replace(/[₹$€£]/g, "").trim();

  // Strip leading/trailing currency words/suffixes:
  //   "rs 20" · "rs. 20" · "inr 20"  · "20 rs" · "20rs" · "20 rupees" · "20 paise"
  s = s
    .replace(/^(rs\.?|inr\.?)\s*/i, "")
    .replace(/\s*(rs\.?|inr\.?|rupees?|paise)$/i, "")
    .trim();

  // If what remains is purely digits + separators (Western 1,200 · Indian
  // 12,00,000 · spaced 1 200), strip ALL commas/spaces between digits.
  if (/^[\d][\d,\s]*[\d]$/.test(s) || /^[\d]$/.test(s)) {
    s = s.replace(/[\s,]/g, "");
  }

  // Must now be a plain number (allow leading +/-, decimals, exponent)
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function coerceString(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return null;
}

export function coerceBoolean(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") {
    if (raw === 1) return true;
    if (raw === 0) return false;
    return null;
  }
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    if (["true", "yes", "y", "1", "on"].includes(s)) return true;
    if (["false", "no", "n", "0", "off"].includes(s)) return false;
    return null;
  }
  return null;
}

function coerceArray(
  raw: unknown,
  path: string,
  errors: string[],
  warnings: string[]
): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    // JSON array in a string → repair-parse
    const trimmed = raw.trim();
    if (/^\[.*\]$/.test(trimmed) || trimmed.startsWith("[")) {
      const repaired = repairArrayString(trimmed);
      if (repaired) {
        warnings.push(`"${path}": JSON-in-string parsed into an array`);
        return repaired;
      }
    }
    // Comma-separated → split
    if (trimmed.includes(",")) {
      warnings.push(`"${path}": comma-separated string split into an array`);
      return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
    }
    // Single value → single-element array
    if (trimmed) {
      warnings.push(`"${path}": single value wrapped into an array`);
      return [trimmed];
    }
    return [];
  }
  // Single non-string value → wrap
  warnings.push(`"${path}": single value wrapped into an array`);
  return [raw];
}

function coerceObjectValue(
  raw: unknown,
  path: string,
  errors: string[],
  warnings: string[]
): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^\{.*\}$/.test(trimmed) || trimmed.startsWith("{")) {
      const v = repairJsonValue(trimmed);
      if (v && typeof v === "object" && !Array.isArray(v)) {
        warnings.push(`"${path}": JSON-in-string parsed into an object`);
        return v as Record<string, unknown>;
      }
    }
    // key=value,key2=value2 style
    if (/^[^={}]+=[^=]+/.test(trimmed) && trimmed.includes(",")) {
      const obj: Record<string, unknown> = {};
      for (const pair of trimmed.split(",")) {
        const idx = pair.indexOf("=");
        if (idx > 0) obj[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
      }
      if (Object.keys(obj).length > 0) {
        warnings.push(`"${path}": key=value string parsed into an object`);
        return obj;
      }
    }
  }
  errors.push(`Field "${path}" must be an object (got ${JSON.stringify(raw)})`);
  return null;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function repairArrayString(s: string): unknown[] | null {
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v)) return v;
  } catch {
    /* fall through */
  }
  // Try light repair: strip quotes artifacts, split elements
  const inner = s.replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!inner) return [];
  try {
    const v = JSON.parse(`[${inner}]`);
    if (Array.isArray(v)) return v;
  } catch {
    /* fall through */
  }
  return null;
}

function fieldHint(schema: JsonSchema, field: string): string {
  const p = schema.properties?.[field];
  if (!p) return "";
  const type = p.type ? ` (type: ${p.type})` : "";
  const desc = p.description ? ` — ${p.description}` : "";
  const enumHint = p.enum ? ` — must be one of: ${p.enum.join(", ")}` : "";
  return `${type}${enumHint}${desc}`;
}

function fuzzyEnumPick(input: string, en: Array<string | number>): string | number | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
  const target = norm(input);
  let best: string | number | undefined;
  let bestDist = Infinity;
  for (const candidate of en) {
    const d = levenshtein(target, norm(String(candidate)));
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }
  // Accept only close matches (relative to length)
  if (best !== undefined && bestDist <= Math.max(2, Math.floor(target.length / 3))) {
    return best;
  }
  return undefined;
}

/** Classic Levenshtein distance with early length cutoff. */
export function levenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n];
}
