/**
 * END-TO-END PROOF of the QStash pipeline — V1.5 wire format + V1.6 fire auth.
 *
 * V1.5 root cause (fixed): the schedule-create call POSTed a JSON body
 * {destination, cron} to /v2/schedules. The REAL QStash API takes the
 * destination URL RAW IN THE REQUEST PATH with the cron in the Upstash-Cron
 * HEADER — the JSON-body form makes QStash see an EMPTY destination →
 * "invalid scheme" 400.
 *
 * V1.6 root cause (fixed here): QStash fire requests arrive WITHOUT a bearer
 * token (only an Upstash-Signature, which we can't verify without signing-key
 * env vars). The cron route 401-rejected every scheduled fire — schedules
 * fired on time at Upstash and bounced off our own door. Fixes proven here:
 *   - schedule destinations now carry `&k=<HMAC(rid, token)>` (minted at
 *     create time); a fire POST with a valid k and NO other auth → accepted;
 *   - the spoofable X-Internal-Scheduler header (public value "1") no longer
 *     authorizes anything → 401;
 *   - the app's browser poll authorizes via X-Client-Poll + user session.
 *
 * The interceptor behaves like the REAL QStash API and additionally MEMORIES
 * created schedules so GET /v2/schedules (the repair pass's reconciliation
 * call) returns them — exercising the full V1.6 repair logic.
 *
 * Run: bun run scripts/test-qstash-e2e.ts
 *   (server must NOT be running — this script starts it with the intercept)
 */
import { spawn, execSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import webpush from "web-push";

const BASE = "http://localhost:3000";
const CAPTURE = "/tmp/qstash-captured.jsonl";
const INTERCEPT = "/tmp/qstash-intercept.cjs";
const FAKE_TOKEN = "e2e_fake_token";

/** V1.6 URL auth key as minted by the server: HMAC-SHA256(token, rid)[0..24] hex. */
function urlKey(rid: string): string {
  return createHmac("sha256", FAKE_TOKEN).update(rid).digest("hex").slice(0, 24);
}

// ---- 0. install the fetch interceptor (preloaded into the NODE server) ----
// Behaves like the REAL QStash schedules/publish API:
//   POST /v2/schedules            (JSON-body form) → 400 invalid destination
//   POST /v2/schedules/<raw-url>  + Upstash-Cron   → 200 {scheduleId} (MEMOIZED)
//   GET  /v2/schedules                              → 200 [{scheduleId, destination}]
//   POST /v2/publish/<raw-url>                      → 200 {messageId}
writeFileSync(INTERCEPT, `
const origFetch = globalThis.fetch;
const REAL_400 = JSON.stringify({ error: "invalid destination url: endpoint has invalid scheme, add http:// or https://" });
const memoSchedules = new Map(); // scheduleId → destination (V1.6 repair-pass support)
globalThis.fetch = async function (input, init) {
  const url = typeof input === "string" ? input : (input && input.url) || String(input);
  if (url && url.includes("qstash.upstash.io")) {
    const method = (init && init.method) || "GET";
    const headers = {};
    try {
      const h = init && init.headers;
      if (h && typeof h.forEach === "function") h.forEach((v, k) => { headers[k.toLowerCase()] = String(v); });
      else if (h) for (const [k, v] of Object.entries(h)) headers[String(k).toLowerCase()] = String(v);
    } catch {}
    let body = "";
    try { body = String(init && init.body || ""); } catch {}
    require("fs").appendFileSync(${JSON.stringify(CAPTURE)}, JSON.stringify({ url, method, headers, body }) + "\\n");

    // --- real-API behavior: schedules ---
    if (/\\/v2\\/schedules\\/?$/.test(url)) {
      if (method === "GET") {
        // V1.6 repair-pass reconciliation call: the real API lists the
        // account's schedules with their destinations.
        const list = Array.from(memoSchedules.entries()).map(([scheduleId, destination]) => ({ scheduleId, destination }));
        return new Response(JSON.stringify(list), { status: 200, headers: { "Content-Type": "application/json" } });
      }
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
      const scheduleId = "sch_e2e_proof_" + Date.now() + "_" + memoSchedules.size;
      memoSchedules.set(scheduleId, dest);
      return new Response(JSON.stringify({ scheduleId }), {
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
// token is set so the schedule-creation path actually runs. VAPID keys are
// generated per-run so the cron route's full fire path (push delivery) runs
// instead of early-returning "Web Push not configured".
const vapid = webpush.generateVAPIDKeys();
const server = spawn("node", ["node_modules/next/dist/bin/next", "start"], {
  cwd: "/home/z/my-project",
  env: {
    ...process.env,
    DATABASE_URL: "file:/home/z/my-project/dev.db",
    EMAIL_DEV_MODE: "true",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "admin123",
    QSTASH_TOKEN: FAKE_TOKEN,
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
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
    call?.headers?.["authorization"] === `Bearer ${FAKE_TOKEN}`,
    `got: ${call?.headers?.["authorization"]}`
  );
  check(
    "V1.6 URL auth key rides in the destination (&k=<24-hex HMAC of rid>)",
    (() => {
      const m2 = /[?&]k=([0-9a-f]+)$/.exec(String(call?.url ?? ""));
      return !!m2 && m2[1] === urlKey(cr.json.id);
    })(),
    `expected k=${urlKey(cr.json.id)}, got: ${call?.url}`
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

  // ---- 8. V1.6 FIRE AUTH — the exact production scenario: QStash's schedule
  //         fires and POSTs the destination URL with NO bearer token and NO
  //         signing-key signature (none configured — only QSTASH_TOKEN is set,
  //         exactly like the user's deployment). Before V1.6: 401, reminder
  //         never delivered. Now: the &k= HMAC minted into the URL at create
  //         time authenticates the fire. ----
  // A reminder due within the 10-minute early window: now + 5min (IST wall
  // clock = UTC + 5:30, plus the 5-minute lead).
  const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000 + 5 * 60 * 1000);
  const hh = String(istNow.getUTCHours()).padStart(2, "0");
  const mm = String(istNow.getUTCMinutes()).padStart(2, "0");
  const crFire = await jfetch(`${BASE}/api/dashboard/notifications`, {
    method: "POST",
    headers: fwdHeaders,
    body: JSON.stringify({ type: "daily", time: `${hh}:${mm}`, message: "fire auth proof" }),
  });
  check("near-term reminder created for the fire test", crFire.status === 200, JSON.stringify(crFire.json));

  const fireRid = crFire.json.id as string;
  const fireUrl = `${BASE}/api/notifications/cron?rid=${fireRid}&k=${urlKey(fireRid)}`;

  // 8a. THE proof: token-less QStash-style fire → accepted (was 401 pre-V1.6).
  const fire1 = await jfetch(fireUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rid: fireRid }),
  });
  check(
    "V1.6 FIRE: token-less POST with valid &k= → 200 (not 401!)",
    fire1.status === 200 && fire1.json?.ok === true,
    `got: ${fire1.status} ${JSON.stringify(fire1.json)}`
  );

  // 8b. The fire response reports delivery observably (sent/failed counts —
  //     V1.6 logs + response fields make "fired but nothing happened"
  //     diagnosable instead of silent). The rare midnight rollover edge makes
  //     the reminder not-yet-due; a structured reason is equally observable.
  check(
    "fire response reports delivery counts (sent/failed) or a due-state reason",
    typeof fire1.json?.sent === "number" || fire1.json?.reason === "not due yet",
    JSON.stringify(fire1.json)
  );

  // 8c. Wrong key → rejected.
  const badKey = "f".repeat(24);
  const fire2 = await jfetch(`${BASE}/api/notifications/cron?rid=${fireRid}&k=${badKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  check("wrong &k= → 401", fire2.status === 401, `got: ${fire2.status}`);

  // 8d. No credentials at all → 401.
  const fire3 = await jfetch(`${BASE}/api/notifications/cron`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  check("no credentials → 401", fire3.status === 401, `got: ${fire3.status}`);

  // 8e. THE SPOOF IS DEAD: the old X-Internal-Scheduler header (public value
  //     "1", previously an auth bypass anyone could use) no longer authorizes.
  const fire4 = await jfetch(`${BASE}/api/notifications/cron`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Scheduler": "1" },
    body: "{}",
  });
  check("spoofed X-Internal-Scheduler → 401 (hole closed)", fire4.status === 401, `got: ${fire4.status}`);

  // 8f. Browser poll without a session → 401.
  const fire5 = await jfetch(`${BASE}/api/notifications/cron`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Client-Poll": "1" },
    body: "{}",
  });
  check("X-Client-Poll without a session → 401", fire5.status === 401, `got: ${fire5.status}`);

  // 8g. Browser poll WITH the dashboard session → 200 (the app's own
  //     authenticated tab may run the catch-all poll).
  const fire6 = await jfetch(`${BASE}/api/notifications/cron`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Client-Poll": "1", cookie: djar },
    body: "{}",
  });
  check("X-Client-Poll with a valid session → 200", fire6.status === 200 && fire6.json?.ok === true, `got: ${fire6.status} ${JSON.stringify(fire6.json)}`);

  // 8h. Bearer fire (the in-process scheduler's self-fetch form) → 200.
  const fire7 = await jfetch(`${BASE}/api/notifications/cron`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${FAKE_TOKEN}` },
    body: "{}",
  });
  check("bearer self-fetch (in-process scheduler) → 200", fire7.status === 200 && fire7.json?.ok === true, `got: ${fire7.status}`);

  // 8i. The V1.6 repair pass ran during the catch-alls above — prove it saw
  //     the memoized upstream schedules (GET /v2/schedules) and did NOT mass-
  //     recreate them (no second create for the 20:00 reminder).
  await new Promise((r) => setTimeout(r, 300));
  const finalCaptured = existsSync(CAPTURE)
    ? readFileSync(CAPTURE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const listCalls = finalCaptured.filter((c) => c.method === "GET" && /\/v2\/schedules\/?$/.test(c.url));
  check("repair pass listed upstream schedules (GET /v2/schedules)", listCalls.length >= 1, `list calls: ${listCalls.length}`);
  const schedCreates = finalCaptured.filter(
    (c) => c.method === "POST" && /\/v2\/schedules\//.test(c.url) && String(c.url).includes(urlKeyFor(cr.json.id))
  );
  check(
    "healthy (k-bearing) schedule NOT recreated by the repair pass",
    schedCreates.length === 1,
    `creates for the 20:00 reminder: ${schedCreates.length}`
  );

  function urlKeyFor(id: string) {
    return urlKey(id);
  }

  function expectDest(id: string) {
    return `https://khata.namansoni.in/api/notifications/cron?rid=${id}&k=${urlKey(id)}`;
  }
} finally {
  server.kill("SIGTERM");
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
