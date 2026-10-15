/**
 * TOOLKIT ADVERSARIAL TEST SUITE
 * ================================
 *
 * Run: bun run scripts/test-toolkit.ts
 *
 * Proves the "never fail in tool calling" claim end-to-end:
 *   1. JSON repair — 30 adversarial malformed payloads
 *   2. Schema validation + coercion — currency strings, bools, arrays
 *   3. Registry fuzzy resolution — camelCase, typos, wrapper junk
 *   4. Full agent loop vs a MOCK HTTP server:
 *        a. native tool calls with broken args       → repaired + executed
 *        b. endpoint rejects `tools` param           → auto-degrade to JSON mode
 *        c. model emits inline JSON in text         → mined + executed
 *        d. provider 500s twice then succeeds       → retried transparently
 *        e. model loops duplicate calls             → dedup guard stops it
 *        f. model hallucinates tool name            → fuzzy-corrected
 *        g. tool implementation throws              → error envelope, no crash
 *        h. self-correction: bad args → feedback → fixed call → success
 */

import { repairJson } from "../src/lib/toolkit/json-repair";
import { validateAndCoerce } from "../src/lib/toolkit/schema";
import { ToolRegistry, type ToolSpec } from "../src/lib/toolkit/registry";
import { runToolLoop } from "../src/lib/toolkit/agent-loop";
import { extractInlineToolCalls, sanitizeAssistantText } from "../src/lib/toolkit/parse";
import { normalizeAppUrl, appBaseUrl } from "../src/lib/app-url";
import type { AgentConfig } from "../src/lib/admin-config";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, extra?: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

/* ================================================================
   1. JSON REPAIR
   ================================================================ */
console.log("\n── 1. JSON repair ──────────────────────────────");

{
  const cases: Array<[string, string, unknown]> = [
    ["valid json", `{"a":1}`, { a: 1 }],
    ["single quotes", `{'amount': 200, 'category': 'Food'}`, { amount: 200, category: "Food" }],
    ["unquoted keys", `{amount: 200, category: "Food"}`, { amount: 200, category: "Food" }],
    ["trailing comma", `{"a":1,}`, { a: 1 }],
    ["smart quotes", `{“a”: “b”}`, { a: "b" }],
    ["python None", `{"a": None}`, { a: null }],
    ["python True/False", `{"a": True, "b": False}`, { a: true, b: false }],
    ["JS undefined", `{"a": undefined}`, { a: null }],
    ["comments //", `{"a": 1 // note\n}`, { a: 1 }],
    ["comments /* */", `{"a": /* hey */ 1}`, { a: 1 }],
    ["truncated string", `{"a": "hello`, { a: "hello" }],
    ["truncated object", `{"amount": 200, "category"`, { amount: 200 }],
    ["truncated nested", `{"a": {"b": [1, 2`, { a: { b: [1, 2] } }],
    ["dangling colon", `{"a":`, { a: null }],
    ["dangling comma+key", `{"a":1, "b"`, { a: 1 }],
    ["unescaped newline in string", `{"a": "line1\nline2"}`, { a: "line1\nline2" }],
    ["fenced json", "```json\n{\"a\":1}\n```", { a: 1 }],
    ["unbalanced closer", `{"a":1}}`, { a: 1 }],
    ["mismatched brackets", `{"a": [1, 2]}`, { a: [1, 2] }],
    ["bareword value", `{"category": Food}`, { category: "Food" }],
    ["negative number", `{"amount": -50.5}`, { amount: -50.5 }],
    ["exponent number", `{"amount": 2e3}`, { amount: 2000 }],
    ["prose around json", `Here you go: {"a":1} hope that helps`, { a: 1 }],
    ["double quotes in single-quoted string", `{'note': 'he said "hi"'}`, { note: 'he said "hi"' }],
    ["array root", `[1, 2, 3]`, [1, 2, 3]],
    ["nested deep", `{"a":{"b":{"c":[{"d":1}]}}}`, { a: { b: { c: [{ d: 1 }] } } }],
    ["NaN", `{"a": NaN}`, { a: null }],
    ["escaped unicode passthrough", `{"a":"\\u00e9"}`, { a: "é" }],
    ["empty object", `{}`, {}],
    ["whitespace heavy", `{  "a"  :  1  }`, { a: 1 }],
  ];

  for (const [name, input, expected] of cases) {
    const r = repairJson(input);
    eq(name, r.ok ? r.value : "(failed)", expected);
  }

  // Genuinely unrecoverable
  const bad = repairJson("no json here at all");
  check("garbage input → ok:false (never throws)", !bad.ok);
  const bad2 = repairJson("");
  check("empty input → ok:false", !bad2.ok);
}

/* ================================================================
   2. SCHEMA VALIDATION + COERCION
   ================================================================ */
console.log("\n── 2. Schema validation + coercion ─────────────");

{
  const logSchema = {
    type: "object",
    properties: {
      amount: { type: "number", description: "INR amount" },
      category: { type: "string" },
      verified: { type: "boolean" },
      tags: { type: "array", items: { type: "string" } },
      meta: { type: "object", properties: { src: { type: "string" } } },
      mode: { type: "string", enum: ["auto", "manual"] },
    },
    required: ["amount", "category"],
  };

  // currency-string → number
  let v = validateAndCoerce({ amount: "200", category: "Food" }, logSchema);
  check('"200" → 200', v.ok && v.value.amount === 200);
  v = validateAndCoerce({ amount: "₹1,200", category: "Food" }, logSchema);
  check('"₹1,200" → 1200', v.ok && v.value.amount === 1200);
  v = validateAndCoerce({ amount: "20rs", category: "Food" }, logSchema);
  check('"20rs" → 20', v.ok && v.value.amount === 20);
  v = validateAndCoerce({ amount: "12,00,000", category: "Loan" }, logSchema);
  check('"12,00,000" → 1200000 (Indian separators)', v.ok && v.value.amount === 1200000);

  // bool coercion
  v = validateAndCoerce({ amount: 5, category: "X", verified: "true" }, logSchema);
  check('"true" → true', v.ok && v.value.verified === true);
  v = validateAndCoerce({ amount: 5, category: "X", verified: "no" }, logSchema);
  check('"no" → false', v.ok && v.value.verified === false);

  // string coercion
  v = validateAndCoerce({ amount: 5, category: 20 }, logSchema);
  check('number 20 → "20" string', v.ok && v.value.category === "20");

  // array coercion
  v = validateAndCoerce({ amount: 5, category: "X", tags: "food, travel" }, logSchema);
  check('comma-string → array', v.ok && JSON.stringify(v.value.tags) === JSON.stringify(["food", "travel"]));
  v = validateAndCoerce({ amount: 5, category: "X", tags: '["a","b"]' }, logSchema);
  check('JSON-in-string → array', v.ok && JSON.stringify(v.value.tags) === JSON.stringify(["a", "b"]));

  // object coercion
  v = validateAndCoerce({ amount: 5, category: "X", meta: '{"src":"chat"}' }, logSchema);
  check('JSON-in-string → object', v.ok && (v.value.meta as Record<string, unknown>).src === "chat");

  // enum fuzzy
  v = validateAndCoerce({ amount: 5, category: "X", mode: "Auto" }, logSchema);
  check('enum "Auto" → "auto"', v.ok && v.value.mode === "auto");

  // integer rounding
  const intSchema = { type: "object", properties: { n: { type: "integer" } }, required: ["n"] };
  v = validateAndCoerce({ n: 3.0000001 }, intSchema);
  check("3.0000001 → 3 (integer)", v.ok && v.value.n === 3);

  // required missing → precise error
  v = validateAndCoerce({ category: "Food" }, logSchema);
  check("missing required → error mentioning 'amount'", !v.ok && v.errors.some((e) => e.includes("amount")));

  // uncoercable number
  v = validateAndCoerce({ amount: "totally broken", category: "Food" }, logSchema);
  check('totally broken string → model-readable error', !v.ok && v.errors.length > 0);

  // unknown fields kept
  v = validateAndCoerce({ amount: 5, category: "Food", extra_note: "hi" }, logSchema);
  check("unknown field kept (liquid schema)", v.ok && v.value.extra_note === "hi");
}

/* ================================================================
   3. REGISTRY FUZZY NAME RESOLUTION
   ================================================================ */
console.log("\n── 3. Registry fuzzy resolution ─────────────────");

{
  const registry = new ToolRegistry().register(
    { name: "log_expense", description: "", parameters: { type: "object" }, execute: () => "ok" },
    { name: "log_income", description: "", parameters: { type: "object" }, execute: () => "ok" },
    { name: "query_transactions", description: "", parameters: { type: "object" }, execute: () => "ok" },
    { name: "get_account_summary", description: "", parameters: { type: "object" }, execute: () => "ok" }
  );

  check("exact name", registry.resolve("log_expense")?.exact === true);
  check("camelCase logExpense", registry.resolve("logExpense")?.tool.name === "log_expense");
  check("PascalCase LogExpense", registry.resolve("LogExpense")?.tool.name === "log_expense");
  check("kebab log-expense", registry.resolve("log-expense")?.tool.name === "log_expense");
  check("typo log_expenss", registry.resolve("log_expenss")?.tool.name === "log_expense");
  check("typo query_transaction (missing s)", registry.resolve("query_transaction")?.tool.name === "query_transactions");
  check("wrapper 'functions.log_expense'", registry.resolve("functions.log_expense")?.tool.name === "log_expense");
  check("garbage name → null", registry.resolve("zzzzzzz") === null);
  check("empty name → null", registry.resolve("") === null);
  check("spaced 'log expense'", registry.resolve("log expense")?.tool.name === "log_expense");
}

/* ================================================================
   4. INLINE EXTRACTION + SANITIZER
   ================================================================ */
console.log("\n── 4. Inline extraction + sanitizer ─────────────");

{
  const r = extractInlineToolCalls(
    `Sure! Logging that now.\n{"tool_call":{"name":"log_expense","arguments":{"amount":50,"category":"Food"}}}`
  );
  check("wrapper extracted", r.calls.length === 1 && r.calls[0].name === "log_expense");
  check("content cleaned", !r.content.includes("tool_call") && r.content.includes("Logging"));

  const flat = extractInlineToolCalls(`{"name":"log_income","arguments":{"amount":900}}`);
  check("flat shape extracted", flat.calls.length === 1 && flat.calls[0].name === "log_income");

  const batch = extractInlineToolCalls(
    `{"tool_call":{"name":"log_expense","arguments":{"amount":50}}}\n{"tool_call":{"name":"log_expense","arguments":{"amount":20}}}`
  );
  check("batched two-per-line", batch.calls.length === 2);

  const fenced = extractInlineToolCalls(
    "```json\n{\"tool_call\":{\"name\":\"log_expense\",\"arguments\":{\"amount\":5}}}\n```"
  );
  check("fenced extraction", fenced.calls.length === 1);

  const chart = extractInlineToolCalls(`Analysis:\n[CHART:{"type":"bar","title":"spend"}]`);
  check("chart marker NOT swallowed", chart.calls.length === 0 && chart.content.includes("[CHART:"));

  const repaired = extractInlineToolCalls(
    `{"tool_call":{"name":"log_expense","arguments":{'amount': '20rs'}}}`
  );
  check("single-quoted args extracted", repaired.calls.length === 1);

  const clean = sanitizeAssistantText(
    `Here's your summary.\n{"tool_call":{"name":"aggregate","arguments":{"group_by":"category"}}}\nDone!`
  );
  check("sanitizer strips leaked tool JSON", !clean.includes("tool_call") && clean.includes("summary"));
  const untouched = sanitizeAssistantText("Normal text with {braces} but no tool call");
  check("sanitizer leaves normal text alone", untouched.includes("{braces}"));
}

/* ================================================================
   5. FULL AGENT LOOP vs MOCK HTTP SERVER
   ================================================================ */
console.log("\n── 5. Agent loop e2e (mock server) ─────────────");

// ---- mock tools ----
const mockTools: ToolSpec[] = [
  {
    name: "log_expense",
    description: "Log an expense",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number" },
        category: { type: "string" },
      },
      required: ["amount", "category"],
    },
    execute: (args) => `Logged Rs ${args.amount} for ${args.category}. Txn ID: T123`,
  },
  {
    name: "boom",
    description: "Always throws",
    parameters: { type: "object", properties: {} },
    execute: () => {
      throw new Error("kaboom");
    },
  },
];

const registry = new ToolRegistry().register(...mockTools);
const config: AgentConfig = {
  provider: "openai-compatible",
  baseUrl: "http://127.0.0.1:4123/v1",
  apiKey: "test",
  model: "mock",
  temperature: 0.1,
  maxTokensMode: "max_tokens",
  maxTokens: 500,
  toolCallingSupported: true,
  systemPrompt: "you are a test",
};

// Scripted provider responses. Each entry: how the server should behave
// for one POST /chat/completions request.
interface Scripted {
  status?: number;
  body?: string;
  toolCalls?: Array<{ id: string; name: string; args: string }>;
  content?: string;
}
let script: Scripted[] = [];
let scriptIdx = 0;
let requestsSeen: Array<Record<string, unknown>> = [];

const server = Bun.serve({
  port: 4123,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/chat/completions") {
      const body = await req.json();
      requestsSeen.push(body);
      const step = script[Math.min(scriptIdx, script.length - 1)];
      scriptIdx++;

      if (step?.status && step.status >= 400) {
        return new Response(step.body ?? "error", { status: step.status });
      }
      if (step?.status === 200 && step.body) {
        return new Response(step.body, { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // Build a proper OpenAI-format response
      const message: Record<string, unknown> = { content: step?.content ?? "" };
      if (step?.toolCalls?.length) {
        message.tool_calls = step.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.args },
        }));
      }
      return Response.json({
        id: "mock",
        choices: [{ index: 0, message, finish_reason: step?.toolCalls?.length ? "tool_calls" : "stop" }],
      });
    }
    return new Response("not found", { status: 404 });
  },
});

async function freshRun(msgs?: Array<{ role: "user"; content: string }>) {
  const messages: any[] = [{ role: "system", content: "sys" }, ...(msgs ?? [{ role: "user", content: "I spent 200 on food" }])];
  const result = await runToolLoop({
    config,
    messages,
    registry,
    ctx: { userId: "u1" },
  });
  return { result, messages };
}

// ---- a. native tool call with BROKEN args (single quotes + string number) ----
{
  script = [
    { toolCalls: [{ id: "call_1", name: "log_expense", args: `{'amount': '200', 'category': 'Food'}` }] },
    { content: "Logged your Rs 200 food expense." },
  ];
  scriptIdx = 0;
  const { result } = await freshRun();
  check("a. broken native args → repaired + executed", result.toolCalls.length === 1 && result.toolCalls[0].executed);
  check("a. amount coerced to 200", result.toolCalls[0].args.amount === 200);
  check("a. final text surfaced", result.finalContent.includes("200"));
}

// ---- b. endpoint rejects tools → auto-degrade to JSON mode ----
{
  script = [
    { status: 400, body: '{"error":{"message":"tools is not supported by this model"}}' },
    {
      content: `{"tool_call":{"name":"log_expense","arguments":{"amount":75,"category":"Transport"}}}`,
    },
    { content: "Logged Rs 75 for transport." },
  ];
  scriptIdx = 0;
  const { result } = await freshRun([{ role: "user", content: "75 rs metro" }]);
  check("b. auto-degraded to json mode", result.degraded === true && result.mode === "json");
  check("b. tool still executed after degradation", result.toolCalls.length === 1 && result.toolCalls[0].executed);
  // After degradation, subsequent requests must NOT carry the tools param
  const laterReq = requestsSeen[requestsSeen.length - 1];
  check("b. degraded requests drop the tools param", !laterReq.tools);
}

// ---- c. model emits inline JSON in native mode ----
{
  script = [
    { content: `Let me log that.\n{"tool_call":{"name":"log_expense","arguments":{"amount":10,"category":"Snacks"}}}` },
    { content: "Done, Rs 10 snacks logged." },
  ];
  scriptIdx = 0;
  const { result } = await freshRun([{ role: "user", content: "10 rs chips" }]);
  check("c. inline JSON mined in native mode", result.toolCalls.length === 1 && result.toolCalls[0].executed);
}

// ---- d. provider 500s twice, then succeeds (retry transparency) ----
{
  script = [
    { status: 500, body: "boom" },
    { status: 503, body: "cold start" },
    { content: "I'm alive. No tools needed." },
  ];
  scriptIdx = 0;
  // use a fast backoff config via retries: default 3 attempts is enough
  const { result } = await freshRun([{ role: "user", content: "hello" }]);
  check("d. 500+503 → retried → success", result.finalContent.includes("alive"));
  check("d. requests hit 3 times", requestsSeen.length >= 3);
}

// ---- e. duplicate call loop → dedup guard ----
{
  const dup = { toolCalls: [{ id: "c1", name: "log_expense", args: `{"amount":20,"category":"Food"}` }] };
  script = [dup, dup, dup, dup, dup, dup, dup, { content: "stopped" }];
  scriptIdx = 0;
  const { result } = await freshRun([{ role: "user", content: "20 rs food" }]);
  check("e. duplicates deduped (only 1 execution)", result.toolCalls.length === 1);
}

// ---- f. hallucinated tool name → fuzzy-corrected ----
{
  script = [
    { toolCalls: [{ id: "c1", name: "logExpense", args: `{"amount":30,"category":"Taxi"}` }] },
    { content: "Logged Rs 30 taxi." },
  ];
  scriptIdx = 0;
  const { result } = await freshRun([{ role: "user", content: "30 rs taxi" }]);
  check("f. logExpense → log_expense corrected + executed", result.toolCalls[0]?.name === "log_expense" && result.toolCalls[0].executed);
}

// ---- g. tool throws → error envelope, loop survives ----
{
  script = [
    { toolCalls: [{ id: "c1", name: "boom", args: `{}` }] },
    { content: "The tool failed, sorry." },
  ];
  scriptIdx = 0;
  const { result } = await freshRun([{ role: "user", content: "break it" }]);
  check("g. throwing tool → executed:false, no crash", result.toolCalls[0]?.executed === false);
  check("g. model saw the failure + answered", result.finalContent.includes("failed"));
}

// ---- h. self-correction: invalid args → feedback → model fixes call ----
{
  script = [
    { toolCalls: [{ id: "c1", name: "log_expense", args: `{"category":"Food"}` }] }, // missing amount
    { toolCalls: [{ id: "c2", name: "log_expense", args: `{"amount":99,"category":"Food"}` }] }, // fixed
    { content: "Logged Rs 99 food." },
  ];
  scriptIdx = 0;
  const { result } = await freshRun([{ role: "user", content: "99 rs food" }]);
  check("h. first call rejected (validation feedback)", result.toolCalls[0]?.executed === false);
  check("h. model self-corrected on retry", result.toolCalls[1]?.executed === true && result.toolCalls[1].args.amount === 99);
}

// ---- i. truncated native args (max_tokens cut mid-JSON) ----
{
  script = [
    { toolCalls: [{ id: "c1", name: "log_expense", args: `{"amount": 200, "category"` }] },
    { toolCalls: [{ id: "c2", name: "log_expense", args: `{"amount":200,"category":"Food"}` }] },
    { content: "Recovered and logged." },
  ];
  scriptIdx = 0;
  const { result } = await freshRun();
  check("i. truncated args → feedback → retry succeeded", result.toolCalls.some((c) => c.executed && c.args.amount === 200));
}

// ---- j. empty first response → nudge → real answer ----
{
  script = [{ content: "" }, { content: "Sorry — yes, I can help with that." }];
  scriptIdx = 0;
  const { result } = await freshRun([{ role: "user", content: "hi?" }]);
  check("j. empty response nudged → answer", result.finalContent.includes("help"));
}

// ---- k. native mode request shape sanity ----
{
  script = [{ content: "plain answer" }];
  scriptIdx = 0;
  requestsSeen = [];
  await freshRun();
  const req = requestsSeen[0];
  check("k. native request includes tools array", Array.isArray(req.tools) && req.tools.length === 2);
  check("k. tool_choice=auto", req.tool_choice === "auto");
}

// ---- l. model goes SILENT after tool results → nudge recovers (user's prod bug) ----
{
  script = [
    { toolCalls: [{ id: "c1", name: "log_expense", args: `{"amount":150,"category":"Groceries"}` }] },
    { content: "" }, // model silent after receiving tool result
    { content: "Logged Rs 150 for groceries." }, // nudge recovers it
  ];
  scriptIdx = 0;
  requestsSeen = [];
  const { result } = await freshRun([{ role: "user", content: "150 rs groceries" }]);
  check("l. post-tool silence → nudged → answer surfaced", result.finalContent.includes("150"));
  check("l. nudge diagnostic present", result.diagnostics.some((d) => d.includes("nudging")));
  // the nudge message must be tool-aware (tell the model to answer, not call tools)
  const nudgeReq = requestsSeen[2]?.messages as Array<{ role: string; content: string }> | undefined;
  const nudgeMsg = nudgeReq?.find((m) => m.role === "user" && m.content.startsWith("("));
  check("l. nudge is tool-aware", !!nudgeMsg && nudgeMsg.content.includes("Reply to the user"));
}

// ---- m. model silent even AFTER nudge → reply synthesized from tool results ----
{
  script = [
    { toolCalls: [{ id: "c1", name: "log_expense", args: `{"amount":90,"category":"Tea"}` }] },
    { content: "" }, // silent
    { content: "" }, // still silent after nudge
  ];
  scriptIdx = 0;
  const { result } = await freshRun([{ role: "user", content: "90 rs chai" }]);
  check("m. silent model → synthesized from tool result", result.finalContent.includes("Logged Rs 90"));
  check("m. synthesized reply is non-empty", result.finalContent.trim().length > 0);
}

// ---- n. EXACT production sequence: native 400 'No tool call found for function
//       call output' → JSON degrade → silent → synthesized (never empty) ----
{
  script = [
    { toolCalls: [{ id: "call_nc63HNuqyQn", name: "log_expense", args: `{"amount":200,"category":"Zomato"}` }] },
    { status: 400, body: '{"success":false,"error":{"message":"No tool call found for function call output with call_id call_nc63HNuqyQn"}}' },
    { content: `{"tool_call":{"name":"log_expense","arguments":{"amount":200,"category":"Zomato"}}}` },
    { content: "" }, // silent
    { content: "" }, // still silent
  ];
  scriptIdx = 0;
  const { result } = await freshRun([{ role: "user", content: "200 rs zomato" }]);
  check("n. degraded after 400 tool-output rejection", result.degraded === true && result.mode === "json");
  check("n. tool executed post-degradation", result.toolCalls.some((c) => c.executed));
  check("n. final reply NEVER empty (synthesized)", result.finalContent.trim().length > 0);
  check("n. synthesized reply shows the tool outcome", /Logged Rs 200/.test(result.finalContent));
}

/* ================================================================
   6. APP URL NORMALIZATION (QStash invalid-scheme root cause)
   ================================================================ */
console.log("\n── 6. App URL normalization (QStash fix) ──────");

{
  eq("url: bare domain gets https", normalizeAppUrl("khata.namansoni.in"), "https://khata.namansoni.in");
  eq("url: protocol-relative fixed", normalizeAppUrl("//khata.namansoni.in"), "https://khata.namansoni.in");
  eq("url: trailing slash stripped", normalizeAppUrl("https://khata.namansoni.in/"), "https://khata.namansoni.in");
  eq("url: path stripped to origin", normalizeAppUrl("https://khata.namansoni.in/some/path"), "https://khata.namansoni.in");
  eq("url: query+hash stripped", normalizeAppUrl("khata.namansoni.in?a=1#x"), "https://khata.namansoni.in");
  eq("url: whitespace trimmed", normalizeAppUrl("  https://khata.namansoni.in  "), "https://khata.namansoni.in");
  eq("url: localhost gets http", normalizeAppUrl("localhost:3000"), "http://localhost:3000");
  eq("url: 127.0.0.1 gets http", normalizeAppUrl("127.0.0.1:3000"), "http://127.0.0.1:3000");
  eq("url: explicit http scheme kept", normalizeAppUrl("http://10.0.0.5:3000"), "http://10.0.0.5:3000");
  eq("url: empty → null", normalizeAppUrl(""), null);
  eq("url: only slashes → null", normalizeAppUrl("//"), null);
  eq("url: scheme + host case normalized", normalizeAppUrl("HTTPS://KHATA.NAMANSONI.IN"), "https://KHATA.NAMANSONI.IN");
  // appBaseUrl resolves to a valid absolute URL under ANY env configuration
  const prev = process.env.NEXT_PUBLIC_APP_URL;
  process.env.NEXT_PUBLIC_APP_URL = "khata.namansoni.in"; // the EXACT broken prod value
  const base = appBaseUrl();
  let parsedOk = false;
  try { new URL(`${base}/api/notifications/cron?rid=x`); parsedOk = true; } catch { parsedOk = false; }
  check("url: appBaseUrl(scheme-less env) yields a QStash-valid destination", parsedOk && base === "https://khata.namansoni.in");
  process.env.NEXT_PUBLIC_APP_URL = prev;
}

server.stop(true);

/* ================================================================
   RESULTS
   ================================================================ */
console.log(`\n═══════════════════════════════════════════════`);
console.log(`  ${passed} passed · ${failed} failed`);
console.log(`═══════════════════════════════════════════════\n`);
process.exit(failed > 0 ? 1 : 0);
