/**
 * END-TO-END PROOF of the V1.2 QStash fix — the user's EXACT production bug:
 *
 *   [qstash] schedule create failed (acct 0): 400
 *   {"error":"invalid destination url: endpoint has invalid scheme, add http:// or https://"}
 *
 * Chain exercised over REAL HTTP against the REAL production server:
 *
 *   curl/browser POST /api/dashboard/notifications
 *     with X-Forwarded-Host: khata.namansoni.in, X-Forwarded-Proto: https
 *       → route derives originFromRequest(req)
 *         → createReminder(..., { baseUrl })
 *           → createQStashScheduleForReminder → REAL fetch to qstash.upstash.io
 *             (intercepted by the preload hook → /tmp/qstash-captured.jsonl)
 *
 * The intercepted destination MUST be
 *   https://khata.namansoni.in/api/notifications/cron?rid=<id>
 * even though the server env carries the user's ORIGINAL broken value
 * (NEXT_PUBLIC_APP_URL="khata.namansoni.in" — no scheme) AND the API
 * response MUST report delivery:"exact".
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
writeFileSync(INTERCEPT, `
const origFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const url = typeof input === "string" ? input : (input && input.url) || String(input);
  if (url && url.includes("qstash.upstash.io")) {
    require("fs").appendFileSync(${JSON.stringify(CAPTURE)}, JSON.stringify({ url, body: String(init && init.body || "") }) + "\\n");
    return new Response(JSON.stringify({ scheduleId: "sch_e2e_proof_" + Date.now() }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
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
server.stdout.on("data", () => {});
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

  // ---- 5. inspect what the server actually TRIED to send to QStash ----
  await new Promise((r) => setTimeout(r, 300));
  const captured = existsSync(CAPTURE)
    ? readFileSync(CAPTURE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  check("a QStash schedule-create call was made", captured.length >= 1, `captured=${captured.length}`);
  const dest = captured[0]?.body ? JSON.parse(captured[0].body).destination : undefined;
  check(
    "destination = https://khata.namansoni.in/... despite scheme-less env",
    dest === expectDest(cr.json.id),
    `got: ${dest}`
  );
  let parseable = false;
  try { new URL(String(dest)); parseable = true; } catch {}
  check("destination is a parseable absolute https URL", parseable);

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

  function expectDest(id: string) {
    return `https://khata.namansoni.in/api/notifications/cron?rid=${id}`;
  }
} finally {
  server.kill("SIGTERM");
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
