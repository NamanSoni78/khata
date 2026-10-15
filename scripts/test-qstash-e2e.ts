/**
 * END-TO-END PROOF of the V1.5 QStash fix — the user's EXACT production bug:
 *
 *   [qstash] schedule create failed (acct 0): 400
 *   {"error":"invalid destination url: endpoint has invalid scheme, add http:// or https://"}
 *
 * ROOT CAUSE (V1.5, finally found): the schedule-create call POSTed a JSON
 * body {destination, cron} to /v2/schedules. The REAL QStash API takes the
 * destination URL RAW IN THE REQUEST PATH (POST /v2/schedules/<destination>)
 * with the cron in the Upstash-Cron HEADER — verified against the official
 * @upstash/qstash SDK's Schedules.create() (path: ["v2","schedules",
 * request.destination]). The JSON-body form makes QStash see an EMPTY
 * destination → "invalid scheme" 400 — regardless of how valid the URL
 * itself is. That's why V1.1/V1.2's URL-content fixes didn't help.
 *
 * Chain exercised over REAL HTTP against the REAL production server:
 *
 *   POST /api/dashboard/notifications with X-Forwarded-Host: khata.namansoni.in
 *     → createReminder(..., { baseUrl: originFromRequest(req) })
 *       → createQStashScheduleForReminder → fetch to qstash.upstash.io
 *         (intercepted by the preload hook → /tmp/qstash-captured.jsonl)
 *
 * The interceptor now behaves like the REAL QStash API — the V1.2 version
 * happily accepted the broken JSON-body form, which is exactly how an
 * "11/11 proof" passed while production kept 400ing. It now:
 *   - returns the EXACT production 400 for the body form (no destination in path)
 *   - demands the Upstash-Cron header on the path form
 *   - accepts only RAW (unencoded) destinations in the path
 *
 * Run: bun run scripts/test-qstash-e2e.ts
 *   (server must NOT be running — this script starts it with the intercept)
 */
import { spawn, execSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";

const BASE = "http://localhost:3000";
const CAPTURE = "/tmp/qstash-captured.jsonl";
const INTERCEPT = "/tmp/qstash-intercept.cjs";

// ---- 0. install the fetch interceptor (preloaded into the NODE server) ----
// Behaves like the REAL QStash schedules/publish API:
//   POST /v2/schedules            (JSON-body form) → 400 invalid destination
//   POST /v2/schedules/<raw-url>  + Upstash-Cron   → 200 {scheduleId}
//   POST /v2/publish/<raw-url>                      → 200 {messageId}
writeFileSync(INTERCEPT, `
const origFetch = globalThis.fetch;
const REAL_400 = JSON.stringify({ error: "invalid destination url: endpoint has invalid scheme, add http:// or https://" });
globalThis.fetch = async function (input, init) {
  const url = typeof input === "string" ? input : (input && input.url) || String(input);
  if (url && url.includes("qstash.upstash.io")) {
    const headers = {};
    try {
      const h = init && init.headers;
      if (h && typeof h.forEach === "function") h.forEach((v, k) => { headers[k.toLowerCase()] = String(v); });
      else if (h) for (const [k, v] of Object.entries(h)) headers[String(k).toLowerCase()] = String(v);
    } catch {}
    let body = "";
    try { body = String(init && init.body || ""); } catch {}
    require("fs").appendFileSync(${JSON.stringify(CAPTURE)}, JSON.stringify({ url, method: (init && init.method) || "GET", headers, body }) + "\\n");

    // --- real-API behavior: schedules ---
    if (/\\/v2\\/schedules\\/?$/.test(url)) {
      // JSON-body wire form (the production bug) → the EXACT 400.
      return new Response(REAL_400, { status: 400, headers: { "Content-Type": "application/json" } });
    }
    const m = /^https:\\/\\/qstash\\.upstash\\.io\\/v2\\/schedules\\/(.+)$/.exec(url);
    if (m) {
      const dest = m[1];
      if (!/^https?:\\/\\//.test(dest)) {
        return new Response(REAL_400, { status: 400, headers: { "Content-Type": "application/json" } });
      }
      if (!headers["upstash-cron"]) {
        return new Response(JSON.stringify({ error: "invalid cron expression" }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ scheduleId: "sch_e2e_proof_" + Date.now() }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // --- real-API behavior: publish (destination raw in path) ---
    const p = /^https:\\/\\/qstash\\.upstash\\.io\\/v2\\/publish\\/(.+)$/.exec(url);
    if (p) {
      if (!/^https?:\\/\\//.test(p[1])) {
        return new Response(REAL_400, { status: 400, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ messageId: "msg_e2e_" + Date.now() }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "unknown endpoint" }), { status: 404 });
  }
  return origFetch.apply(this, arguments);
};
`);
rmSync(CAPTURE, { force: true });

// ---- 1. fresh DB ----
execSync("bunx prisma db push --accept-data-loss", {
  cwd: "/home/z/my-project",
  env: { ...process.env, DATABASE_URL: "file:/home/z/my-project/dev.db" },
  stdio: "ignore",
});
execSync("bun run scripts/seed.ts", {
  cwd: "/home/z/my-project",
  env: { ...process.env, DATABASE_URL: "file:/home/z/my-project/dev.db" },
  stdio: "ignore",
});

// ---- 2. production server with the EXACT broken prod env + interceptor ----
// NEXT_PUBLIC_APP_URL carries the user's original scheme-less value; QStash
// token is set so the schedule-creation path actually runs.
const server = spawn("node", ["node_modules/next/dist/bin/next", "start"], {
  cwd: "/home/z/my-project",
  env: {
    ...process.env,
    DATABASE_URL: "file:/home/z/my-project/dev.db",
    EMAIL_DEV_MODE: "true",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "admin123",
    QSTASH_TOKEN: "e2e_fake_token",
    NEXT_PUBLIC_APP_URL: "khata.namansoni.in", // THE EXACT BROKEN PROD VALUE
    PORT: "3000",
    NODE_OPTIONS: `--require ${INTERCEPT}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => {
  // Server console.log lines (qstash success/failure paths) — forward so
  // debugging a silent bail is one glance.
  process.stderr.write(d);
});
server.stderr.on("data", (d) => process.stderr.write(d));

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: string) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
};

async function jfetch(url: string, opts: any = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json, headers: res.headers };
}

async function waitForServer(ms = 30000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

try {
  if (!(await waitForServer())) throw new Error("server did not start");
  console.log("✓ production server up (broken env + QStash token + fetch intercept)");

  // ---- 3. real signup → OTP → MPIN → dashboard login ----
  const email = `qstashe2e${Date.now()}@gmail.com`;
  const jar: string[] = [];
  const track = (r: any) => {
    const c = r.headers.get("set-cookie");
    if (c) jar.push(c.split(";")[0]);
  };

  const su = await jfetch(`${BASE}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123", agreed: true }),
  });
  check("signup (dev OTP)", !!su.json.devCode, JSON.stringify(su.json));

  const v = await jfetch(`${BASE}/api/auth/verify-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code: su.json.devCode }),
  });
  track(v);
  check("OTP verify", v.status === 200, JSON.stringify(v.json));

  const m = await jfetch(`${BASE}/api/auth/mpin?action=setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: jar.join("; ") },
    body: JSON.stringify({ appMpin: "1234", dashboardMpin: "111222" }),
  });
  check("MPIN setup", m.status === 200, JSON.stringify(m.json));

  const d = await jfetch(`${BASE}/api/dashboard/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, dashboardMpin: "111222" }),
  });
  const djar = (d.headers.get("set-cookie") ?? "").split(";")[0];
  check("dashboard login", d.status === 200, JSON.stringify(d.json));

  // ---- 4. THE TEST: create a reminder through the real route, arriving via
  //         the Vercel-style forwarded headers of the real public host ----
  const fwdHeaders = {
    "Content-Type": "application/json",
    cookie: djar,
    "X-Forwarded-Host": "khata.namansoni.in",
    "X-Forwarded-Proto": "https",
  };
  const cr = await jfetch(`${BASE}/api/dashboard/notifications`, {
    method: "POST",
    headers: fwdHeaders,
    body: JSON.stringify({ type: "daily", time: "20:00", message: "Log your day" }),
  });
  check("reminder created (200)", cr.status === 200, JSON.stringify(cr.json));
  check(
    "API reports delivery:exact (QStash schedule registered)",
    cr.json.delivery === "exact",
    JSON.stringify(cr.json)
  );

  // ---- 5. inspect what the server actually SENT to QStash ----
  await new Promise((r) => setTimeout(r, 300));
  const captured = existsSync(CAPTURE)
    ? readFileSync(CAPTURE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const schedCalls = captured.filter((c) => /\/v2\/schedules/.test(c.url));
  check("a QStash schedule-create call was made", schedCalls.length >= 1, `captured=${captured.length}`);
  const call = schedCalls[0];
  check(
    "WIRE FORMAT: destination RAW in path (POST /v2/schedules/<url>)",
    call?.method === "POST" &&
      call?.url === `https://qstash.upstash.io/v2/schedules/${expectDest(cr.json.id)}`,
    `got: ${call?.method} ${call?.url}`
  );
  check(
    "Upstash-Cron header present (20:00 IST → 30 14 * * *)",
    call?.headers?.["upstash-cron"] === "30 14 * * *",
    `got: ${call?.headers?.["upstash-cron"]}`
  );
  check(
    "Bearer authorization header present",
    call?.headers?.["authorization"] === "Bearer e2e_fake_token",
    `got: ${call?.headers?.["authorization"]}`
  );
  check(
    "rid carried in delivered body",
    (() => { try { return JSON.parse(call?.body ?? "{}").rid === cr.json.id; } catch { return false; } })(),
    `got: ${call?.body}`
  );
  check(
    "destination is https://khata.namansoni.in/... despite scheme-less env",
    String(call?.url ?? "").includes(expectDest(cr.json.id)),
    `got: ${call?.url}`
  );

  // ---- 6. negative control: same request via PLAIN localhost headers →
  //         localhost destinations are skipped (no dead QStash schedules) ----
  const before = captured.length;
  const cr2 = await jfetch(`${BASE}/api/dashboard/notifications`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: djar, Host: "localhost:3000" },
    body: JSON.stringify({ type: "daily", time: "21:00", message: "local reminder" }),
  });
  check("localhost reminder still created (poll delivery)", cr2.status === 200);
  check(
    "localhost request → NO QStash call (loopback skipped)",
    captured.length === before,
    `calls went from ${before} to ${captured.length}`
  );
  check("localhost reminder reports delivery:poll (no QStash)", cr2.json.delivery !== "exact", JSON.stringify(cr2.json));

  // ---- 7. one-time reminder → delayed publish with RAW path destination ----
  const readCaptured = () =>
    existsSync(CAPTURE)
      ? readFileSync(CAPTURE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
  const pubBefore = readCaptured().filter((c) => /\/v2\/publish/.test(c.url)).length;
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const cr3 = await jfetch(`${BASE}/api/dashboard/notifications`, {
    method: "POST",
    headers: fwdHeaders,
    body: JSON.stringify({ type: "once", time: "09:30", date: tomorrow, message: "one-time ping" }),
  });
  check("one-time reminder created", cr3.status === 200, JSON.stringify(cr3.json));
  await new Promise((r) => setTimeout(r, 300));
  // Re-read the capture file — the server process appends to it live; the
  // section-5 snapshot is stale by now.
  const pubCalls = readCaptured().filter((c) => /\/v2\/publish/.test(c.url));
  check("a QStash delayed publish was made", pubCalls.length > pubBefore, `publish calls: ${pubCalls.length}`);
  check(
    "publish destination RAW in path (POST /v2/publish/<url>) + Upstash-Delay header",
    pubCalls.length > 0 &&
      pubCalls[0]?.method === "POST" &&
      pubCalls[0]?.url === `https://qstash.upstash.io/v2/publish/${expectDest(cr3.json.id)}` &&
      !!pubCalls[0]?.headers?.["upstash-delay"],
    `got: ${pubCalls[0]?.method} ${pubCalls[0]?.url}`
  );

  function expectDest(id: string) {
    return `https://khata.namansoni.in/api/notifications/cron?rid=${id}`;
  }
} finally {
  server.kill("SIGTERM");
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
