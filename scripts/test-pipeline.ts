/**
 * LIVE CHAT-PIPELINE TEST — proves the toolkit works through the REAL
 * API route + REAL database, with the mock LLM emitting DELIBERATELY
 * BROKEN tool-call arguments (the exact failures the SDK must heal):
 *
 *   Turn 1: native tool call, args as single-quoted string-number JSON
 *   Turn 2: final text reply
 *
 * Verifies: reply text, txn actually created in DB, chat history clean
 * (no leaked tool JSON), balances updated.
 */
const BASE = "http://localhost:3000";
const MOCK = "http://127.0.0.1:3999/v1";

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, extra?: string) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
};

// ---------- mock LLM with BROKEN args ----------
Bun.serve({
  port: 3999,
  async fetch(req) {
    const url = new URL(req.url);
    if (!url.pathname.endsWith("/chat/completions")) return new Response("nf", { status: 404 });
    const body = await req.json().catch(() => ({}));
    const sawToolResult = body.messages?.some((m: any) => m.role === "tool");
    if (!sawToolResult) {
      // DELIBERATELY BROKEN: single quotes + string amount with "rs" suffix + trailing comma
      return Response.json({
        choices: [{
          message: {
            content: "",
            tool_calls: [{
              id: "call_broken_1",
              type: "function",
              function: {
                name: "logExpense", // camelCase hallucination!
                arguments: "{'amount': '20rs', 'category': 'Transport', 'notes': 'rapido',}",
              },
            }],
          },
        }],
      });
    }
    return Response.json({
      choices: [{ message: { content: "Logged Rs 20 for Transport (rapido)." } }],
    });
  },
});
console.log("mock-llm (broken args) on :3999");
await new Promise((r) => setTimeout(r, 300));

// ---------- admin login + configure agent ----------
let cookie = "";
{
  const r = await fetch(`${BASE}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME ?? "admin", password: process.env.ADMIN_PASSWORD ?? "admin123" }),
  });
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  check("admin login", r.ok, String(r.status));
}

// save previous config, point daily agent at mock
let prev: any = null;
{
  const r = await fetch(`${BASE}/api/admin/config`, { headers: { cookie } });
  const j = await r.json();
  prev = j["agent.daily"];
  check("read admin config", r.ok);
}
{
  const r = await fetch(`${BASE}/api/admin/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({
      key: "agent.daily",
      value: {
        provider: "openai-compatible",
        baseUrl: MOCK,
        apiKey: "mock-key",
        model: "mock-model",
        temperature: 0.1,
        maxTokensMode: "max_tokens",
        maxTokens: 500,
        toolCallingSupported: true,
        systemPrompt: prev?.systemPrompt ?? "you are khata",
      },
    }),
  });
  check("point agent.daily at mock", r.ok, `${r.status} ${await r.text()}`);
}

// ---------- user signup flow ----------
const email = `pipetest${Date.now()}@gmail.com`;
const jar: string[] = [];
const track = (r: Response) => { const c = r.headers.get("set-cookie"); if (c) jar.push(c.split(";")[0]); };

{
  const r = await fetch(`${BASE}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123", agreed: true }),
  });
  const j = await r.json();
  check("signup", !!j.devCode, JSON.stringify(j));

  const v = await fetch(`${BASE}/api/auth/verify-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code: j.devCode }),
  });
  track(v);
  const vj = await v.json();
  check("OTP verify", v.ok, JSON.stringify(vj));

  const m = await fetch(`${BASE}/api/auth/mpin?action=setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: jar.join("; ") },
    body: JSON.stringify({ appMpin: "1234", dashboardMpin: "111222" }),
  });
  check("MPIN setup", m.ok, await m.text());
}

// ---------- the actual chat turn with broken tool args ----------
{
  const r = await fetch(`${BASE}/api/chat?action=daily`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: jar.join("; ") },
    body: JSON.stringify({ message: "aaj 20 rs rapido ke kharch hue" }),
  });
  const j = await r.json();
  check("chat 200", r.ok, String(r.status));
  check("reply text correct", j.reply?.includes("Logged Rs 20"), JSON.stringify(j).slice(0, 300));
  check("no leaked tool JSON in reply", !JSON.stringify(j).includes("tool_call"));
}

// ---------- verify DB state via dashboard stats ----------
{
  const d = await fetch(`${BASE}/api/dashboard/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, dashboardMpin: "111222" }),
  });
  const djar = (d.headers.get("set-cookie") ?? "").split(";")[0];
  check("dashboard login", d.ok);

  const s = await fetch(`${BASE}/api/dashboard/stats?range=month`, { headers: { cookie: djar } });
  const sj = await s.json();
  check("txn persisted (expense 20)", Math.abs((sj.currentPeriod?.expense ?? 0) - 20) < 0.01, JSON.stringify(sj.totals));
}

// ---------- verify chat history is clean ----------
{
  const h = await fetch(`${BASE}/api/chat?action=history`, { headers: { cookie: jar.join("; ") } });
  const hj = await h.json();
  const allText = (hj.messages ?? []).map((m: any) => m.content).join(" ");
  check("history: no leaked JSON", !allText.includes("tool_call") && !allText.includes("'amount'"));
  check("history: has user + assistant msgs", (hj.messages ?? []).length >= 2);
}

// ---------- restore admin config ----------
{
  const r = await fetch(`${BASE}/api/admin/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ key: "agent.daily", value: prev }),
  });
  check("restored agent.daily config", r.ok);
}

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
export {};
