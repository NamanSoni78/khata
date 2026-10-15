/**
 * TOOLKIT · JSON REPAIR ENGINE
 * =============================
 *
 * The single most important module in the "never fail" tool-calling SDK.
 * LLMs emit broken JSON constantly:
 *   - truncated output (`{"amount": 200, "category"`)
 *   - single quotes (`{'amount': 200}`)
 *   - unquoted keys (`{amount: 200}`)
 *   - trailing commas, smart quotes, comments
 *   - Python-isms (`None`, `True`, `NaN`, `Infinity`)
 *   - unescaped newlines inside strings
 *   - markdown fences around the payload
 *
 * `repairJson` runs a progressive pipeline:
 *   1. native JSON.parse
 *   2. safe regex quick-fixes
 *   3. full state-machine tokenizer rebuild
 *
 * It NEVER throws. The result always tells you exactly which strategy
 * succeeded and what was repaired, so the SDK can log/diagnose failures.
 */

export interface RepairResult {
  ok: boolean;
  /** Parsed value — undefined when not ok. */
  value?: unknown;
  /** Which pipeline stage produced the final parse. */
  strategy: "native" | "regex" | "tokenizer" | "failed";
  /** Human-readable descriptions of every repair applied. */
  fixes: string[];
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export function repairJson(raw: string): RepairResult {
  if (typeof raw !== "string") {
    return { ok: false, strategy: "failed", fixes: ["input was not a string"] };
  }

  // 0. Normalize the envelope: BOM, fences, leading/trailing noise
  let text = stripEnvelope(raw);

  // 1. Native parse — the happy path
  const native = tryParse(text);
  if (native !== PARSE_FAILED) {
    return { ok: true, value: native, strategy: "native", fixes: [] };
  }

  // 2. Regex quick-fixes (safe, cheap, ordered least→most invasive)
  const { text: fixed, fixes } = applyRegexFixes(text);
  const regexValue = tryParse(fixed);
  if (regexValue !== PARSE_FAILED) {
    return { ok: true, value: regexValue, strategy: "regex", fixes };
  }

  // 3. Full tokenizer rebuild
  const rebuilt = tokenizerRepair(fixed);
  const tokenValue = tryParse(rebuilt.text);
  if (tokenValue !== PARSE_FAILED && isAcceptableValue(tokenValue, text)) {
    return { ok: true, value: tokenValue, strategy: "tokenizer", fixes: [...fixes, ...rebuilt.fixes] };
  }

  // 4. Last resort: extract the first balanced object and try again
  //    (handles payloads with prose around a valid object)
  const inner = firstBalancedObject(rebuilt.text);
  if (inner) {
    const innerValue = tryParse(inner);
    if (innerValue !== PARSE_FAILED && isAcceptableValue(innerValue, inner)) {
      return {
        ok: true,
        value: innerValue,
        strategy: "tokenizer",
        fixes: [...fixes, ...rebuilt.fixes, "extracted inner JSON object from surrounding text"],
      };
    }
  }

  return {
    ok: false,
    strategy: "failed",
    fixes: [...fixes, ...rebuilt.fixes, "unrecoverable — all repair strategies exhausted"],
  };
}

/** Convenience: repair + return the value (or undefined). */
export function repairJsonValue(raw: string): unknown | undefined {
  return repairJson(raw).value;
}

/* ------------------------------------------------------------------ */
/* Sentinel for parse failure (undefined is a valid JSON value)        */
/* ------------------------------------------------------------------ */

const PARSE_FAILED = Symbol("parse-failed");

function tryParse(text: string): unknown | typeof PARSE_FAILED {
  try {
    return JSON.parse(text);
  } catch {
    return PARSE_FAILED;
  }
}

/* ------------------------------------------------------------------ */
/* Envelope normalization                                              */
/* ------------------------------------------------------------------ */

/** Strip BOM, whitespace, markdown fences, and <json>-ish wrappers. */
function stripEnvelope(raw: string): string {
  let t = raw.replace(/^\uFEFF/, "").trim();
  // ```json ... ``` (or ``` ... ```) → inner content
  const fence = t.match(/^```[a-zA-Z0-9]*\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fence) {
    t = fence[1].trim();
  } else {
    // Leading fence only (truncated before the closing fence)
    const lead = t.match(/^```[a-zA-Z0-9]*\s*\n?([\s\S]*)$/);
    if (lead && lead[1].includes("{")) t = lead[1].trim();
  }
  return t;
}

/* ------------------------------------------------------------------ */
/* Regex quick-fix layer                                               */
/* ------------------------------------------------------------------ */

function applyRegexFixes(text: string): { text: string; fixes: string[] } {
  const fixes: string[] = [];
  let t = text;

  // Smart quotes used as string delimiters → straight quotes
  if (/[\u201c\u201d\u2018\u2019]/.test(t)) {
    t = t.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
    fixes.push("replaced smart quotes");
  }

  // Trailing commas before } or ]
  if (/,\s*([}\]])/.test(t)) {
    t = t.replace(/,\s*([}\]])/g, "$1");
    fixes.push("removed trailing commas");
  }

  // Python / JS constants that JSON rejects
  if (/\b(None|NaN|Infinity|undefined)\b/.test(t)) {
    t = t
      .replace(/\bNone\b/g, "null")
      .replace(/\bNaN\b/g, "null")
      .replace(/\bInfinity\b/g, "null")
      .replace(/\b-Infinity\b/g, "null")
      .replace(/\bundefined\b/g, "null");
    fixes.push("normalized Python/JS constants to null");
  }

  // Python-style booleans (True/False) — only when they look like bare values
  if (/\b(True|False)\b/.test(t)) {
    t = t.replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false");
    fixes.push("normalized Python booleans");
  }

  return { text: t, fixes };
}

/* ------------------------------------------------------------------ */
/* Tokenizer repair — the state machine                                */
/* ------------------------------------------------------------------ */

interface TokenizerState {
  out: string[];
  fixes: string[];
  // bracket stack: "{" or "["
  stack: string[];
  inString: boolean;
  quoteChar: "" | '"' | "'";
  escaped: boolean;
  // "expectValue" | "expectKey" | "afterValue" — what the NEXT significant token is
  expect: "expectValue" | "expectKey" | "afterValue";
  // track the last significant char emitted (for truncation cleanup)
  lastSig: string;
  // index of the output position where the current dangling key started
  // (so we can drop ` , "key"` when the object closes without a value)
  pendingKeyStart: number;
}

/**
 * Rebuild the JSON with a full character-level state machine.
 *
 * Guarantees:
 *   - single-quoted strings → double-quoted (inner `"` escaped)
 *   - unquoted barewords at value/key position → quoted
 *   - comments removed
 *   - raw control chars inside strings escaped
 *   - truncation at EOF auto-closed (strings closed, brackets balanced,
 *     dangling `,` / `:` / bare keys dropped)
 */
function tokenizerRepair(text: string): { text: string; fixes: string[] } {
  const S: TokenizerState = {
    out: [],
    fixes: [],
    stack: [],
    inString: false,
    quoteChar: "",
    escaped: false,
    expect: "expectValue",
    lastSig: "",
    pendingKeyStart: -1,
  };
  const emit = (s: string) => S.out.push(s);

  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];

    /* ---------- inside a string ---------- */
    if (S.inString) {
      if (S.escaped) {
        // Pass through the escaped char
        emit("\\" + c);
        S.escaped = false;
        i++;
        continue;
      }
      if (c === "\\") {
        emit("\\");
        S.escaped = true;
        i++;
        continue;
      }
      if (c === S.quoteChar) {
        // End of string. If it was single-quoted, we opened with `"` already.
        emit('"');
        S.inString = false;
        S.quoteChar = "";
        S.lastSig = '"';
        // After a key string we expect ':'; after a value string we expect
        // ',' or a closer. Both are "afterValue" in this simplified machine;
        // the colon/comma branches validate context.
        S.expect = "afterValue";
        i++;
        continue;
      }
      if (c === '"' && S.quoteChar === "'") {
        // double quote INSIDE a single-quoted string → escape it
        emit('\\"');
        i++;
        continue;
      }
      if (c === "\n") {
        emit("\\n");
        i++;
        continue;
      }
      if (c === "\r") {
        emit("\\r");
        i++;
        continue;
      }
      if (c === "\t") {
        emit("\\t");
        i++;
        continue;
      }
      emit(c);
      i++;
      continue;
    }

    /* ---------- comments ---------- */
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      if (!S.fixes.includes("removed // comments")) S.fixes.push("removed // comments");
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      if (!S.fixes.includes("removed /* */ comments")) S.fixes.push("removed /* */ comments");
      continue;
    }

    /* ---------- structural chars ---------- */
    if (c === "{") {
      S.stack.push("{");
      emit("{");
      S.expect = "expectKey";
      S.lastSig = "{";
      S.pendingKeyStart = -1;
      i++;
      continue;
    }
    if (c === "[") {
      S.stack.push("[");
      emit("[");
      S.expect = "expectValue";
      S.lastSig = "[";
      S.pendingKeyStart = -1;
      i++;
      continue;
    }
    if (c === "}") {
      const top = S.stack[S.stack.length - 1];
      if (top === "{") {
        trimDangling(S);
        S.stack.pop();
        emit("}");
        S.expect = "afterValue";
        S.lastSig = "}";
        S.pendingKeyStart = -1;
        i++;
        continue;
      } else if (top === "[") {
        // mismatched bracket: model used } where ] belonged
        trimDangling(S);
        S.stack.pop();
        emit("]");
        if (!S.fixes.includes("fixed mismatched closing bracket")) {
          S.fixes.push("fixed mismatched closing bracket");
        }
        S.expect = "afterValue";
        S.lastSig = "]";
        i++;
        continue;
      } else {
        if (!S.fixes.includes("dropped stray closing brace")) {
          S.fixes.push("dropped stray closing brace");
        }
        i++;
        continue;
      }
    }
    if (c === "]") {
      const top = S.stack[S.stack.length - 1];
      if (top === "[") {
        trimDangling(S);
        S.stack.pop();
        emit("]");
        S.expect = "afterValue";
        S.lastSig = "]";
        S.pendingKeyStart = -1;
        i++;
        continue;
      } else if (top === "{") {
        trimDangling(S);
        S.stack.pop();
        emit("}");
        if (!S.fixes.includes("fixed mismatched closing bracket")) {
          S.fixes.push("fixed mismatched closing bracket");
        }
        S.expect = "afterValue";
        S.lastSig = "}";
        i++;
        continue;
      } else {
        if (!S.fixes.includes("dropped stray closing bracket")) {
          S.fixes.push("dropped stray closing bracket");
        }
        i++;
        continue;
      }
    }
    if (c === ":") {
      // colon after a key — only meaningful inside an object after a key
      if (S.expect === "afterValue" && S.stack[S.stack.length - 1] === "{") {
        emit(":");
        S.expect = "expectValue";
        S.lastSig = ":";
        S.pendingKeyStart = -1;
        i++;
        continue;
      }
      // stray colon — drop
      i++;
      continue;
    }
    if (c === ",") {
      // comma: separates members. Only valid after a completed value.
      if (S.expect === "afterValue" && S.stack.length > 0) {
        emit(",");
        S.expect = S.stack[S.stack.length - 1] === "{" ? "expectKey" : "expectValue";
        S.lastSig = ",";
        i++;
        continue;
      }
      // stray comma (e.g., `[1,,2]` or leading comma) — drop
      i++;
      continue;
    }

    /* ---------- string starts ---------- */
    if (c === '"' || c === "'") {
      S.inString = true;
      S.quoteChar = c;
      if (c === "'") {
        if (!S.fixes.includes("converted single-quoted strings")) {
          S.fixes.push("converted single-quoted strings");
        }
      }
      if (S.expect === "expectKey") {
        S.pendingKeyStart = S.out.length;
      }
      emit('"');
      i++;
      continue;
    }

    /* ---------- whitespace ---------- */
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      let j = i;
      while (j < n && /\s/.test(text[j])) j++;
      if (S.out.length > 0 && S.out[S.out.length - 1] !== " " && j < n) {
        emit(" ");
      }
      i = j;
      continue;
    }

    /* ---------- barewords: numbers, true/false/null, unquoted keys/values ---------- */
    if (/[A-Za-z0-9_+\-.$@#%]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_+\-.$@#%*\/]/.test(text[j])) j++;
      const word = text.slice(i, j);

      // lone dots aren't tokens
      if (word === "." || word === "..") {
        i = j;
        continue;
      }

      const isNumberLike = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(word);
      const isBoolOrNull = word === "true" || word === "false" || word === "null";

      if (S.expect === "expectValue") {
        if (isNumberLike || isBoolOrNull) {
          emit(word);
        } else {
          emit('"' + word.replace(/"/g, '\\"') + '"');
          if (!S.fixes.includes("quoted unquoted bareword values")) {
            S.fixes.push("quoted unquoted bareword values");
          }
        }
        S.expect = "afterValue";
        S.lastSig = word.slice(-1);
        i = j;
        continue;
      }

      if (S.expect === "expectKey") {
        if (S.pendingKeyStart === -1) S.pendingKeyStart = S.out.length;
        emit('"' + word.replace(/"/g, '\\"') + '"');
        if (!S.fixes.includes("quoted unquoted keys")) {
          S.fixes.push("quoted unquoted keys");
        }
        S.expect = "afterValue"; // now expect ':'
        S.lastSig = word.slice(-1);
        i = j;
        continue;
      }

      // afterValue + bareword → the model forgot a comma between members.
      if (S.stack.length > 0) {
        emit(",");
        S.expect = S.stack[S.stack.length - 1] === "{" ? "expectKey" : "expectValue";
        if (!S.fixes.includes("inserted missing commas between values")) {
          S.fixes.push("inserted missing commas between values");
        }
        continue; // re-process the same char with the new expectation
      }
      i = j;
      continue;
    }

    /* ---------- anything else ---------- */
    i++;
  }

  /* ---------- EOF: close truncation ---------- */
  if (S.inString) {
    emit('"');
    if (!S.fixes.includes("closed truncated string")) {
      S.fixes.push("closed truncated string");
    }
  }
  const dropped = trimDangling(S);
  if (dropped && !S.fixes.includes("dropped dangling separator/key at end")) {
    S.fixes.push("dropped dangling separator/key at end");
  }
  if (S.stack.length > 0) {
    let closed = 0;
    while (S.stack.length > 0) {
      const open = S.stack.pop()!;
      emit(open === "{" ? "}" : "]");
      closed++;
    }
    if (!S.fixes.includes(`auto-closed ${closed} truncated bracket(s)`)) {
      S.fixes.push(`auto-closed ${closed} truncated bracket(s)`);
    }
  }

  let result = S.out.join("");
  result = result.replace(/\s+([}\],:])/g, "$1").replace(/([{\[:])\s+/g, "$1");

  return { text: result, fixes: S.fixes };
}

/**
 * Remove a trailing `,` or a dangling `"key"` (key emitted without a value)
 * from the output buffer — used just before closing a container or at EOF.
 * Returns true if something was trimmed.
 */
function trimDangling(S: TokenizerState): boolean {
  let trimmed = false;

  // Case 1: output ends with `,` (or `, `) → drop it
  while (S.out.length > 0) {
    const last = S.out[S.out.length - 1];
    if (last === ",") {
      S.out.pop();
      trimmed = true;
      continue;
    }
    if (last === " ") {
      const prev = S.out[S.out.length - 2];
      if (prev === ",") {
        S.out.pop();
        trimmed = true;
        continue;
      }
      break;
    }
    break;
  }

  // Case 2: dangling key — `... , "key"` with no `: value` following.
  if (S.pendingKeyStart !== -1 && S.out.length > S.pendingKeyStart) {
    const tail = S.out.slice(S.pendingKeyStart).join("");
    if (/^".*"$/.test(tail)) {
      S.out.length = S.pendingKeyStart;
      while (S.out.length > 0 && (S.out[S.out.length - 1] === "," || S.out[S.out.length - 1] === " ")) {
        S.out.pop();
      }
      S.pendingKeyStart = -1;
      trimmed = true;
    }
  }

  // Case 3: output ends with `:` (value missing entirely) → emit null value
  const joined = S.out.join("");
  if (/:\s*$/.test(joined)) {
    S.out.push("null");
    trimmed = true;
  }

  return trimmed;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Guard against garbage text that the tokenizer "repairs" into a bare
 * string (e.g. "no json here" → "no"). Tool arguments are objects, so a
 * repaired PRIMITIVE is only acceptable when the input plausibly was one.
 */
function isAcceptableValue(value: unknown, originalInput: string): boolean {
  if (value !== null && typeof value === "object") return true; // object/array — always fine
  // Primitive result: only when the ORIGINAL text looks like a bare primitive
  const t = originalInput.trim();
  if (
    /^(null|true|false)$/.test(t) ||
    /^["'][^"']*["']$/.test(t) ||
    /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)
  ) {
    return true;
  }
  return false;
}

/** Find the first balanced {...} (or [...]) object inside arbitrary text. */
export function firstBalancedObject(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start === -1) return null;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inStr) {
      if (c === "\\") escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  // Unbalanced (truncated) — return the rest; caller's repair will close it
  return text.slice(start);
}
