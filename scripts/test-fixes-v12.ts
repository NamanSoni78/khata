/**
 * V1.2 fix regressions — the four production bugs:
 *
 *  1. QStash "invalid destination url: endpoint has invalid scheme" that
 *     SURVIVED the V1.1 env-normalization fix, because:
 *       a. NEXT_PUBLIC_* vars are BUILD-TIME inlined by Next.js on Vercel —
 *          dashboard edits don't take effect until a redeploy;
 *       b. values pasted WITH quotes defeat naive normalization.
 *     → destinations are now request-derived (originFromRequest) with a
 *       validated env fallback chain.
 *  2. Test notifications dead: sw.js was never REGISTERED anywhere →
 *     serviceWorker.ready hung forever → no subscription could exist.
 *     (Client-side fix — asserted here by code-presence checks.)
 *  3. Permission prompt on enabling any notification (client-side flow).
 *  4. "No tool call found for function call output with call_id …" →
 *     history window cuts orphaning tool messages → rebuildHistoryMessages
 *     now guarantees pairing integrity.
 *
 * Run: bun run scripts/test-fixes-v12.ts
 */
import { normalizeAppUrl, originFromRequest, appBaseUrl } from "../src/lib/app-url";
import { rebuildHistoryMessages } from "../src/lib/agent/loop";
import { createQStashScheduleForReminder } from "../src/lib/scheduler";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    fail++;
    console.log(`✗ ${name}${detail ? ` — got: ${detail}` : ""}`);
  }
}

function eq(name: string, got: unknown, want: unknown) {
  const norm = (v: unknown) => (typeof v === "object" && v !== null ? JSON.stringify(v) : v);
  check(name, norm(got) === norm(want) || JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
}

/* ================================================================
 * 1. normalizeAppUrl — the hardened chain
 * ================================================================ */
console.log("\n--- normalizeAppUrl ---");
eq("scheme-full value kept", normalizeAppUrl("https://khata.namansoni.in"), "https://khata.namansoni.in");
eq("scheme-less gets https", normalizeAppUrl("khata.namansoni.in"), "https://khata.namansoni.in");
eq("DOUBLE-QUOTED value unwrapped (Vercel paste mistake)", normalizeAppUrl('"https://khata.namansoni.in"'), "https://khata.namansoni.in");
eq("single-quoted value unwrapped", normalizeAppUrl("'https://khata.namansoni.in'"), "https://khata.namansoni.in");
eq("protocol-relative normalized", normalizeAppUrl("//khata.namansoni.in"), "https://khata.namansoni.in");
eq("trailing slash stripped", normalizeAppUrl("https://khata.namansoni.in/"), "https://khata.namansoni.in");
eq("path stripped", normalizeAppUrl("https://khata.namansoni.in/some/path"), "https://khata.namansoni.in");
eq("localhost gets http", normalizeAppUrl("localhost:3000"), "http://localhost:3000");
eq("127.0.0.1 gets http", normalizeAppUrl("127.0.0.1:3000"), "http://127.0.0.1:3000");
eq("empty → null", normalizeAppUrl(""), null);
eq("whitespace → null", normalizeAppUrl("   "), null);
eq("garbage quotes → null (falls through chain)", normalizeAppUrl('"https:'), null);

/* ================================================================
 * 2. originFromRequest — the request-derived primary source
 * ================================================================ */
console.log("\n--- originFromRequest ---");
function fakeReq(headers: Record<string, string>, url = "http://localhost:3000/api/x") {
  return {
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    url,
  };
}
eq(
  "x-forwarded-host + proto (Vercel production)",
  originFromRequest(fakeReq({ "x-forwarded-host": "khata.namansoni.in", "x-forwarded-proto": "https" })),
  "https://khata.namansoni.in"
);
eq(
  "x-forwarded-host alone (proto inferred https)",
  originFromRequest(fakeReq({ "x-forwarded-host": "khata.namansoni.in" })),
  "https://khata.namansoni.in"
);
eq(
  "x-forwarded-host localhost preview stays http",
  originFromRequest(fakeReq({ "x-forwarded-host": "localhost:3000", "x-forwarded-proto": "https" })),
  "http://localhost:3000"
);
eq(
  "plain host header (dev server)",
  originFromRequest(fakeReq({ host: "localhost:3000" })),
  "http://localhost:3000"
);
eq(
  "comma-list forwarded host takes first",
  originFromRequest(fakeReq({ "x-forwarded-host": "khata.namansoni.in, proxy.internal", "x-forwarded-proto": "https" })),
  "https://khata.namansoni.in"
);
eq(
  "garbage headers fall through to req.url origin",
  originFromRequest(fakeReq({ "x-forwarded-host": '"https:', host: "!!bad!!" }, "https://real.example.com/api")),
  "https://real.example.com"
);

/* ================================================================
 * 3. appBaseUrl env chain — APP_URL (runtime) outranks the
 *    build-time-inlined NEXT_PUBLIC_APP_URL; quoted values fall through
 * ================================================================ */
console.log("\n--- appBaseUrl env chain ---");
{
  const saved = { ...process.env };
  try {
    process.env.APP_URL = "https://runtime.example.com";
    process.env.NEXT_PUBLIC_APP_URL = "https://stale-build.example.com";
    eq("APP_URL outranks NEXT_PUBLIC_APP_URL", appBaseUrl(), "https://runtime.example.com");

    delete process.env.APP_URL;
    eq("NEXT_PUBLIC_APP_URL used when APP_URL absent", appBaseUrl(), "https://stale-build.example.com");

    // HALF-quoted value (opening quote only — a genuinely broken paste)
    // must fall through to the next source. (A FULLY-quoted value is
    // valid input and gets unwrapped — asserted in the normalizeAppUrl block.)
    process.env.NEXT_PUBLIC_APP_URL = '"https://broken.example.com';
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "khata.namansoni.in";
    eq(
      "half-quoted NEXT_PUBLIC_APP_URL falls through to VERCEL_PROJECT_PRODUCTION_URL",
      appBaseUrl(),
      "https://khata.namansoni.in"
    );

    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    process.env.VERCEL_URL = "khata-git-abc.vercel.app";
    eq("VERCEL_URL (scheme-less, runtime) normalized", appBaseUrl(), "https://khata-git-abc.vercel.app");
  } finally {
    process.env = saved;
  }
}

/* ================================================================
 * 4. QStash destination — request-derived baseUrl beats broken env,
 *    and garbage env NEVER produces a garbage destination
 * ================================================================ */
console.log("\n--- QStash destination (mocked API) ---");
{
  const saved = { ...process.env };
  const captured: Array<{ url: string; body: any }> = [];
  const origFetch = globalThis.fetch;
  (globalThis as any).fetch = async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    if (url.includes("qstash.upstash.io")) {
      let body: any = {};
      try { body = JSON.parse(String(init?.body ?? "{}")); } catch { body = {}; }
      captured.push({ url, body });
      return new Response(JSON.stringify({ scheduleId: "sch_v12_test" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return origFetch(input, init);
  };

  try {
    // 4a. Request-derived baseUrl wins even when env is mangled.
    process.env.QSTASH_TOKEN = "t_v12";
    process.env.NEXT_PUBLIC_APP_URL = '"broken'; // quoted garbage
    delete process.env.APP_URL;
    delete process.env.VERCEL_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    captured.length = 0;
    const created = await createQStashScheduleForReminder(
      { id: "r_v12", type: "daily", time: "20:00" },
      "https://khata.namansoni.in" // what originFromRequest() would pass
    );
    eq(
      "request-derived destination used despite garbage env",
      captured[0]?.body?.destination,
      "https://khata.namansoni.in/api/notifications/cron?rid=r_v12"
    );
    check("schedule created with request-derived destination", !!created?.scheduleId);

    // 4b. NO baseUrl + garbage env (half-quoted NEXT_PUBLIC, nothing else)
    //     → localhost fallback is NOT a usable QStash destination → skip
    //     schedule registration entirely (dev relies on the in-process
    //     scheduler anyway).
    process.env.NEXT_PUBLIC_APP_URL = '"broken'; // half-quoted garbage
    captured.length = 0;
    const created2 = await createQStashScheduleForReminder({ id: "r_v12b", type: "daily", time: "20:00" });
    eq("garbage env → schedule skipped (null), no QStash call", created2, null);
    check("no destination ever sent to QStash with garbage env", captured.length === 0);

    // 4b2. Explicit localhost baseUrl (local dev request) also skipped —
    //      QStash can't reach the user's machine.
    captured.length = 0;
    const created2b = await createQStashScheduleForReminder(
      { id: "r_v12b2", type: "daily", time: "20:00" },
      "http://localhost:3000"
    );
    eq("localhost destination skipped (null)", created2b, null);
    check("no localhost destination sent to QStash", captured.length === 0);

    // 4c. Scheme-less env STILL normalized (V1.1 regression stays fixed).
    process.env.NEXT_PUBLIC_APP_URL = "khata.namansoni.in";
    captured.length = 0;
    await createQStashScheduleForReminder({ id: "r_v12c", type: "daily", time: "20:00" });
    eq(
      "scheme-less env normalized to https destination",
      captured[0]?.body?.destination,
      "https://khata.namansoni.in/api/notifications/cron?rid=r_v12c"
    );

    // 4d. APP_URL runtime fallback used when no baseUrl passed.
    process.env.NEXT_PUBLIC_APP_URL = '"still-broken';
    process.env.APP_URL = "https://runtime-fallback.example.com";
    captured.length = 0;
    await createQStashScheduleForReminder({ id: "r_v12d", type: "daily", time: "09:10" });
    eq(
      "APP_URL runtime fallback wins over quoted NEXT_PUBLIC",
      captured[0]?.body?.destination,
      "https://runtime-fallback.example.com/api/notifications/cron?rid=r_v12d"
    );
  } finally {
    (globalThis as any).fetch = origFetch;
    process.env = saved;
  }
}

/* ================================================================
 * 5. History pairing integrity — the "No tool call found for
 *    function call output" 400 killer
 * ================================================================ */
console.log("\n--- rebuildHistoryMessages (pairing integrity) ---");
{
  const SYS = "system-prompt";
  const NEW = "new user message";

  // 5a. Window cut BETWEEN tool results and their assistant: the leading
  //     tool rows are orphans (their assistant is beyond the window).
  const cutBottom = [
    { role: "tool", content: "result-1", metadata: JSON.stringify({ toolCallId: "call_A", toolName: "log_expense" }) },
    { role: "assistant", content: "Logged it.", metadata: "{}" },
    { role: "user", content: "thanks", metadata: "{}" },
  ];
  const m1 = rebuildHistoryMessages(cutBottom, SYS, NEW);
  check(
    "orphaned tool rows (assistant beyond window) dropped",
    m1.every((m) => m.role !== "tool"),
    JSON.stringify(m1.map((m) => m.role))
  );
  check("system + assistant + user + new message shape", m1.length === 4 && m1[0].role === "system" && m1[3].content === NEW);

  // 5b. Assistant with toolCalls whose RESULTS were cut off (window ended
  //     right after the assistant turn) → toolCalls stripped, text kept.
  const cutTop = [
    { role: "user", content: "log 20rs", metadata: "{}" },
    {
      role: "assistant",
      content: "One moment.",
      metadata: JSON.stringify({ toolCalls: [{ id: "call_B", name: "log_expense", arguments: {} }] }),
    },
  ];
  const m2 = rebuildHistoryMessages(cutTop, SYS, NEW);
  const danglingAssistant = m2.find((m) => m.role === "assistant");
  check(
    "unanswered toolCalls stripped from assistant",
    !danglingAssistant?.toolCalls,
    JSON.stringify(danglingAssistant?.toolCalls)
  );
  check("assistant text preserved when calls stripped", danglingAssistant?.content === "One moment.");

  // 5c. Well-formed pairs survive INTACT.
  const wellFormed = [
    { role: "user", content: "log 20rs", metadata: "{}" },
    {
      role: "assistant",
      content: "One moment.",
      metadata: JSON.stringify({ toolCalls: [{ id: "call_C", name: "log_expense", arguments: {} }] }),
    },
    { role: "tool", content: "Logged Rs 20", metadata: JSON.stringify({ toolCallId: "call_C", toolName: "log_expense" }) },
    { role: "assistant", content: "Done.", metadata: "{}" },
  ];
  const m3 = rebuildHistoryMessages(wellFormed, SYS, NEW);
  const toolMsg = m3.find((m) => m.role === "tool");
  const asstWithCalls = m3.find((m) => m.role === "assistant" && m.toolCalls?.length);
  check("well-formed tool message kept", !!toolMsg && (toolMsg as any).toolCallId === "call_C");
  check("well-formed assistant toolCalls kept", !!asstWithCalls && (asstWithCalls as any).toolCalls[0].id === "call_C");

  // 5d. Partial pair: assistant declared 2 calls, only 1 answered →
  //     unanswered one stripped, answered one kept.
  const partial = [
    {
      role: "assistant",
      content: "",
      metadata: JSON.stringify({
        toolCalls: [
          { id: "call_D", name: "log_expense", arguments: {} },
          { id: "call_E", name: "query_transactions", arguments: {} },
        ],
      }),
    },
    { role: "tool", content: "result-D", metadata: JSON.stringify({ toolCallId: "call_D", toolName: "log_expense" }) },
  ];
  const m4 = rebuildHistoryMessages(partial, SYS, NEW);
  const partialAssistant = m4.find((m) => m.role === "assistant");
  eq(
    "only the ANSWERED toolCall survives",
    (partialAssistant?.toolCalls ?? []).map((tc: any) => tc.id),
    ["call_D"]
  );

  // 5e. Empty assistant shell (no text, no live calls) dropped.
  const shell = [
    { role: "assistant", content: "", metadata: JSON.stringify({ toolCalls: [{ id: "call_F", name: "x", arguments: {} }] }) },
    // no tool result for call_F inside the window
  ];
  const m5 = rebuildHistoryMessages(shell, SYS, NEW);
  check("empty assistant shell dropped", m5.every((m) => m.role !== "assistant" || m.content || m.toolCalls?.length), "shells kept");
}

/* ================================================================
 * 6. Client-side fixes — code-presence assertions
 * ================================================================ */
console.log("\n--- client-side fix presence ---");
{
  const { readFileSync } = await import("node:fs");
  const pushClient = readFileSync("src/lib/push-client.ts", "utf8");
  const daily = readFileSync("src/app/DailyApp.tsx", "utf8");
  const dash = readFileSync("src/app/dashboard/DashboardApp.tsx", "utf8");

  check("push-client registers the service worker", pushClient.includes("navigator.serviceWorker.register"));
  check(
    "push-client requests permission BEFORE subscribing",
    pushClient.indexOf("await ensureNotificationPermission()") < pushClient.indexOf("reg.pushManager.subscribe({")
  );
  check("push-client bounds serviceWorker.ready with a timeout", pushClient.includes("SW_READY_TIMEOUT_MS"));
  check("DailyApp registers SW on mount", daily.includes("registerServiceWorker()"));
  check("DailyApp prompts on chat-created reminders", daily.includes("create_scheduled_notification"));
  check("Dashboard prompts on Schedule click", dash.includes("ensureDeviceNotified()"));
  check("Dashboard has Send test button", dash.includes("Send test"));
  const testRoute = readFileSync("src/app/api/notifications/test/route.ts", "utf8");
  check("test route accepts dashboard session too", testRoute.includes('"dashboard"'));
  const subRoute = readFileSync("src/app/api/notifications/subscribe/route.ts", "utf8");
  check("subscribe route accepts dashboard session too", subRoute.includes('"dashboard"'));
}

/* ================================================================ */
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
