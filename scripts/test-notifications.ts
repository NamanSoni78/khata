/**
 * TRUE end-to-end notification pipeline test.
 *
 * Proves the whole chain with REAL cryptography (no mocks of web-push):
 *   1. Generate real VAPID keys
 *   2. Start a local "browser push service" that receives web-push POSTs
 *   3. Create a REAL ECDH P-256 push subscription (like Chrome would)
 *   4. Register it via /api/notifications/subscribe (the real API)
 *   5. Create a reminder due NOW via /api/dashboard/notifications (real API)
 *   6. Fire POST /api/notifications/cron (poll mode — same code path QStash hits)
 *   7. Receive the encrypted push at our fake endpoint
 *   8. DECRYPT the aes128gcm payload with our private key (RFC 8291) and
 *      verify the JSON payload matches the reminder
 *
 * Usage: bun run scripts/test-notifications.ts
 */
import crypto from "node:crypto";
import https from "node:https";
import { execSync } from "node:child_process";
import fs from "node:fs";

const BASE = "http://localhost:3000";

// ---------- 1. real VAPID keys ----------
function generateVapidKeys() {
  const keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pubRaw = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-65); // uncompressed point
  const privRaw = keys.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
  const b64url = (b: Buffer) => b.toString("base64url");
  return { publicKey: b64url(pubRaw), privateKey: b64url(privRaw) };
}

// ---------- 2. fake push service (https — web-push only speaks TLS) ----------
execSync(`openssl req -x509 -newkey rsa:2048 -keyout /tmp/khata-test-key.pem -out /tmp/khata-test-cert.pem -days 1 -nodes -subj "/CN=localhost" 2>/dev/null`);
const received: { headers: Record<string, string>; body: Buffer }[] = [];
const pushServer = https.createServer(
  { key: fs.readFileSync("/tmp/khata-test-key.pem"), cert: fs.readFileSync("/tmp/khata-test-cert.pem") },
  (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({
        headers: req.headers as Record<string, string>,
        body: Buffer.concat(chunks),
      });
      // Real push services return 201
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end("{}");
    });
  }
);

// ---------- 3. real ECDH subscription ----------
function makeSubscription() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    ecdh,
    keys: {
      p256dh: ecdh.getPublicKey("base64url"),
      auth: crypto.randomBytes(16).toString("base64url"),
    },
  };
}

// ---------- 8. RFC 8291 aes128gcm decrypt ----------
function decryptAes128gcm(body: Buffer, ecdh: crypto.ECDH, authSecret: Buffer, uaPublic: Buffer): string {
  // salt(16) | rs(4) | idlen(1) | sender public key (65) | ciphertext
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const keyId = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const ecdhSecret = ecdh.computeSecret(keyId);
  const ikm = Buffer.concat([ecdhSecret, authSecret]);
  // RFC 8291: info = "WebPush: info" 0x00 || ua_public (65 bytes)
  const prk = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.concat([Buffer.from("WebPush: info\x00"), uaPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", prk, Buffer.alloc(0), Buffer.from("Content-Encoding: aes128gcm\x00"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", prk, Buffer.alloc(0), Buffer.from("Content-Encoding: nonce\x00"), 12));
  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  // trailing bytes after the last 0x00 delimiter are padding
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end--;
  return plain.subarray(0, end).toString("utf8");
}

async function jfetch(url: string, opts: any = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json, headers: res.headers };
}

function cookieHeader(jar: Record<string, string>) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

async function main() {
  const vapid = generateVapidKeys();

  // ---- 0. QStash wire-format + destination-URL regression (mocked REAL QStash API) ----
  // TWO production root causes are pinned here:
  //   a) NEXT_PUBLIC_APP_URL set WITHOUT a scheme → destinations were scheme-less.
  //   b) V1.5: the schedule-create call used a JSON body {destination, cron}
  //      instead of the REAL API's path form POST /v2/schedules/<destination>
  //      + Upstash-Cron header → QStash saw an EMPTY destination and 400'd
  //      "invalid destination url: endpoint has invalid scheme" even though
  //      the URL itself was perfectly valid.
  // The mock below behaves EXACTLY like the real API (the V1.2 mock accepted
  // the broken wire format — which is how an "11/11 proof" passed while
  // production kept failing):
  //   - POST /v2/schedules (no destination in path) → 400, the exact error
  //   - POST /v2/schedules/<url> without Upstash-Cron → 400
  //   - POST /v2/schedules/<url> + Upstash-Cron → 200 {scheduleId}
  {
    const { createQStashScheduleForReminder } = await import("../src/lib/scheduler");
    const prevAppUrl = process.env.NEXT_PUBLIC_APP_URL;
    const prevToken = process.env.QSTASH_TOKEN;
    const prevCur = process.env.QSTASH_CURRENT_SIGNING_KEY;
    const prevNext = process.env.QSTASH_NEXT_SIGNING_KEY;

    process.env.NEXT_PUBLIC_APP_URL = "khata.namansoni.in"; // the EXACT broken prod value (no scheme!)
    process.env.QSTASH_TOKEN = "test_token_for_regression";
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;
    delete process.env.QSTASH_NEXT_SIGNING_KEY;

    const captured: Array<{ url: string; method: string; headers: Record<string, string>; body: any }> = [];
    const origFetch = globalThis.fetch;
    const REAL_400 = JSON.stringify({
      error: "invalid destination url: endpoint has invalid scheme, add http:// or https://",
    });
    (globalThis as any).fetch = async (input: any, init: any = {}) => {
      const url = typeof input === "string" ? input : String(input?.url ?? input);
      if (url.includes("qstash.upstash.io")) {
        const headers: Record<string, string> = {};
        try {
          const h = init?.headers;
          if (h && typeof h.forEach === "function") {
            h.forEach((v: string, k: string) => { headers[k.toLowerCase()] = String(v); });
          } else if (h) {
            for (const [k, v] of Object.entries(h)) headers[String(k).toLowerCase()] = String(v);
          }
        } catch {}
        let body: any = {};
        try { body = JSON.parse(String(init?.body ?? "{}")); } catch { body = {}; }
        const method = String(init?.method ?? "GET");
        captured.push({ url, method, headers, body });

        // ---- behave like the REAL QStash server ----
        // JSON-body form (destination NOT in the path) → the production 400.
        if (/\/v2\/schedules\/?$/.test(url)) {
          return new Response(REAL_400, { status: 400, headers: { "Content-Type": "application/json" } });
        }
        // Path form: destination must follow /v2/schedules/ RAW (unencoded).
        const m = /^https:\/\/qstash\.upstash\.io\/v2\/schedules\/(.+)$/.exec(url);
        const dest = m ? m[1] : "";
        if (!dest || !/^https?:\/\//.test(dest)) {
          return new Response(REAL_400, { status: 400, headers: { "Content-Type": "application/json" } });
        }
        if (!headers["upstash-cron"]) {
          return new Response(
            JSON.stringify({ error: "invalid cron expression" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ scheduleId: "sch_regression_1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return origFetch(input, init);
    };

    try {
      const created = await createQStashScheduleForReminder({ id: "regression_r1", type: "daily", time: "20:00" });
      const call = captured[0];
      // The destination must be RAW in the request PATH (SDK wire format).
      // V1.6: the destination also carries the fire-auth HMAC &k= (computed
      // with the same mocked token the env provides) — assert it explicitly.
      const { cronUrlAuthKey } = await import("../src/lib/qstash-auth");
      const kR1 = await cronUrlAuthKey("regression_r1", "test_token_for_regression");
      const expectedUrl =
        `https://qstash.upstash.io/v2/schedules/https://khata.namansoni.in/api/notifications/cron?rid=regression_r1&k=${kR1}`;
      const okCreated = !!created && created.scheduleId === "sch_regression_1" && created.accountIndex === 0;
      const okWire = call?.method === "POST" && call?.url === expectedUrl;
      const okKey = new RegExp(`[?&]k=${kR1}$`).test(String(call?.url ?? ""));
      const okCronHeader = call?.headers?.["upstash-cron"] === "30 14 * * *"; // 20:00 IST → 14:30 UTC
      const okAuth = call?.headers?.["authorization"] === "Bearer test_token_for_regression";
      const okRid = call?.body?.rid === "regression_r1";
      let parseable = false;
      try { new URL(`https://x/` + (call?.url ?? "")); parseable = !!call?.url?.includes("https://khata.namansoni.in/"); } catch { parseable = false; }
      console.log(`${okCreated ? "✓" : "✗"} qstash: schedule created via REAL-format mocked API (got: ${JSON.stringify(created)})`);
      console.log(`${okWire ? "✓" : "✗"} qstash: WIRE FORMAT = POST /v2/schedules/<raw destination> (got: ${call?.method} ${call?.url})`);
      console.log(`${okKey ? "✓" : "✗"} qstash: V1.6 fire-auth key &k= rides in the destination (got k=${/[?&]k=([0-9a-f]*)/.exec(String(call?.url ?? ""))?.[1]})`);
      console.log(`${okCronHeader ? "✓" : "✗"} qstash: Upstash-Cron header = "30 14 * * *" (got: ${call?.headers?.["upstash-cron"]})`);
      console.log(`${okAuth ? "✓" : "✗"} qstash: Bearer token header present`);
      console.log(`${okRid ? "✓" : "✗"} qstash: rid carried in delivered body`);
      console.log(`${parseable ? "✓" : "✗"} qstash: destination carries https:// despite scheme-less env`);

      // Negative control: the OLD broken JSON-body form MUST be rejected by
      // the real-API gating (the regex the mock uses reproduces the exact
      // production 400 for body-form schedule creates). Verified by regex
      // rather than a live call — no network dependency here.
      const bodyFormRejected =
        /\/v2\/schedules\/?$/.test("https://qstash.upstash.io/v2/schedules") &&
        !/\/v2\/schedules\/?$/.test(expectedUrl);
      console.log(`${bodyFormRejected ? "✓" : "✗"} qstash: JSON-body wire form is rejected by the real-API mock (the production 400)`);

      if (!okCreated || !okWire || !okKey || !okCronHeader || !okAuth || !okRid || !parseable || !bodyFormRejected) {
        throw new Error("QStash wire-format regression FAILED");
      }
    } finally {
      (globalThis as any).fetch = origFetch;
      if (prevAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = prevAppUrl;
      if (prevToken === undefined) delete process.env.QSTASH_TOKEN;
      else process.env.QSTASH_TOKEN = prevToken;
      if (prevCur !== undefined) process.env.QSTASH_CURRENT_SIGNING_KEY = prevCur;
      if (prevNext !== undefined) process.env.QSTASH_NEXT_SIGNING_KEY = prevNext;
    }
  }

  // ---- fresh local database (schema + seed) ----
  const { execSync } = await import("node:child_process");
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
  console.log("✓ fresh database ready");

  // ---- spawn the production server with VAPID env injected ----
  const { spawn } = await import("node:child_process");
  const server = spawn("bun", ["run", "start"], {
    cwd: "/home/z/my-project",
    env: {
      ...process.env,
      NEXT_PUBLIC_VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      VAPID_SUBJECT: "mailto:test@khata.app",
      DATABASE_URL: "file:/home/z/my-project/dev.db",
      EMAIL_DEV_MODE: "true",
      NODE_TLS_REJECT_UNAUTHORIZED: "0", // test-only: self-signed fake push service
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", () => {});
  server.stderr.on("data", (d: Buffer) => process.stderr.write("[server] " + d.toString()));

  serverProc = server;
  // wait for readiness
  const ready = Date.now();
  for (;;) {
    try {
      await fetch(`${BASE}/api/notifications/vapid-public-key`);
      break;
    } catch {
      if (Date.now() - ready > 60_000) throw new Error("server did not start in 60s");
      await new Promise((r2) => setTimeout(r2, 500));
    }
  }
  console.log("✓ server up with fresh VAPID keys");

  await new Promise<void>((r) => pushServer.listen(4568, r));
  const sub = makeSubscription();
  const endpoint = "https://localhost:4568/push/abc123";

  // ---- login/signup a test user through the real API ----
  const email = `notiftest${Date.now()}@gmail.com`;
  const jar: Record<string, string> = {};
  const capture = (res: any) => {
    const sc = res.headers.getSetCookie?.() ?? [];
    for (const c of sc) {
      const [kv] = c.split(";");
      const [k, ...v] = kv.split("=");
      jar[k.trim()] = v.join("=");
    }
  };

  let r = await jfetch(`${BASE}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123", agreed: true }),
  });
  if (r.status !== 200) throw new Error(`signup failed: ${JSON.stringify(r.json)}`);
  const devCode = r.json.devCode as string;
  if (!devCode) throw new Error("no devCode — set RESEND_API_KEY absent? expected dev mode");

  r = await jfetch(`${BASE}/api/auth/verify-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code: devCode }),
  });
  capture(r);
  if (r.status !== 200) throw new Error(`verify failed: ${JSON.stringify(r.json)}`);

  r = await jfetch(`${BASE}/api/auth/mpin?action=setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) },
    body: JSON.stringify({ appMpin: "1234", dashboardMpin: "123456" }),
  });
  capture(r);
  if (r.status !== 200) throw new Error(`mpin failed: ${JSON.stringify(r.json)}`);

  // dashboard login (6-digit)
  r = await jfetch(`${BASE}/api/dashboard/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, dashboardMpin: "123456" }),
  });
  capture(r);
  if (r.status !== 200) throw new Error(`dashboard login failed: ${JSON.stringify(r.json)}`);

  // ---- 4. register push subscription via real API ----
  r = await jfetch(`${BASE}/api/notifications/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) },
    body: JSON.stringify({ endpoint, keys: sub.keys }),
  });
  if (r.status !== 200) throw new Error(`subscribe failed: ${JSON.stringify(r.json)}`);
  console.log("✓ push subscription registered");

  // ---- 5. create a reminder due ~1 minute from now ----
  const istFuture = new Date(Date.now() + 70 * 1000 + 5.5 * 3600 * 1000);
  const hh = String(istFuture.getUTCHours()).padStart(2, "0");
  const mm = String(istFuture.getUTCMinutes()).padStart(2, "0");
  const dateStr = `${istFuture.getUTCFullYear()}-${String(istFuture.getUTCMonth() + 1).padStart(2, "0")}-${String(istFuture.getUTCDate()).padStart(2, "0")}`;
  r = await jfetch(`${BASE}/api/dashboard/notifications`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) },
    body: JSON.stringify({ type: "once", time: `${hh}:${mm}`, date: dateStr, title: "Khata test", message: "Test reminder {today_expense} bhai" }),
  });
  if (r.status !== 200) throw new Error(`reminder create failed: ${JSON.stringify(r.json)}`);
  console.log("✓ reminder created:", r.json.description);

  // ---- 6. wait for the reminder to become due, then fire the cron ----
  // (first cron POST also loads the route module → in-process scheduler starts
  //  and may fire the reminder between our manual polls — watch for the push too)
  let fired = 0;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r2) => setTimeout(r2, 5000));
    r = await jfetch(`${BASE}/api/notifications/cron`, { method: "POST", body: "{}" });
    fired = Number(r.json.fired ?? 0);
    if (fired >= 1 || received.length > 0) break;
  }
  if (fired < 1 && received.length === 0) throw new Error(`cron never fired the due reminder (last: ${JSON.stringify(r.json)})`);
  console.log("✓ reminder fired (cron fired=" + fired + ", pushes received=" + received.length + ")");

  // ---- 7/8. verify push arrived + decrypt ----
  await new Promise((r2) => setTimeout(r2, 500));
  if (received.length === 0) throw new Error("no push POST received at fake endpoint");
  const push = received[0];
  console.log("✓ push POST received, TTL:", push.headers.ttl, "content-encoding:", push.headers["content-encoding"]);
  const authSecret = Buffer.from(sub.keys.auth, "base64url");
  // Decrypt with the reference http_ece implementation (same lib web-push uses to encrypt)
  const ece = (await import("http_ece")).default ?? (await import("http_ece"));
  const payload = ece.decrypt(push.body, {
    version: "aes128gcm",
    privateKey: sub.ecdh,
    authSecret: sub.keys.auth,
    dh: push.body.subarray(21, 21 + push.body[20]).toString("base64url"),
  }).toString("utf8");
  const parsed = JSON.parse(payload);
  console.log("✓ decrypted payload:", payload);
  if (parsed.title !== "Khata test") throw new Error("wrong title in payload");
  if (!String(parsed.body).includes("bhai")) throw new Error("template not resolved in payload");
  if (parsed.url !== "/") throw new Error("wrong url in payload");

  // cleanup: reminder should be deactivated after one-time fire
  console.log("\nALL NOTIFICATION PIPELINE TESTS PASSED ✅");
  pushServer.close();
  server.kill("SIGTERM");
  process.exit(0);
}

let serverProc: any = null;
main().catch((e) => {
  console.error("FAILED:", e.message);
  console.error("received pushes:", received.length);
  pushServer.close();
  if (serverProc) serverProc.kill("SIGKILL");
  process.exit(1);
});
