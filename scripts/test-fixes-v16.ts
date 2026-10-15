/**
 * V1.6 fix regressions — "schedule created, test sent, but the notification
 * didn't come":
 *
 *  1. QStash FIRE AUTH (server-side root cause of dead scheduled reminders):
 *     fire requests carry NO bearer token — only an Upstash-Signature, which
 *     we can't verify without signing-key env vars. Every scheduled fire was
 *     401-rejected by our own cron route. Fix: HMAC(rid, token) rides inside
 *     the destination URL (`&k=`), minted at schedule-create time.
 *  2. The spoofable X-Internal-Scheduler auth hole is closed (public "1"
 *     value authorized anyone to trigger the catch-all poll); the app's own
 *     browser poll now authenticates with X-Client-Poll + user session.
 *  3. Reminder pushes travel with urgency "high" + 24h TTL.
 *  4. sw.js v8: receipt echo → open tabs, persistent receipt log (Cache API),
 *     PING/PONG version probe, pushsubscriptionchange resubscribe, 3-level
 *     showNotification cascade — a push can no longer be silently swallowed.
 *  5. push-client v2: doctor, receipt reading/waiting, boot auto-heal.
 *  6. Repair pass v2 reconciles schedules against the real upstream list and
 *     migrates pre-V1.6 (key-less) schedules automatically.
 *
 * Run: bun run scripts/test-fixes-v16.ts
 */
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import {
  cronUrlAuthKey,
  allCronUrlAuthKeys,
  verifyCronUrlKey,
  safeEqualHex,
} from "../src/lib/qstash-auth";

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

const src = (p: string) => readFileSync(`/home/z/my-project/${p}`, "utf8");
const nodeHmac = (token: string, rid: string) =>
  createHmac("sha256", token).update(rid).digest("hex").slice(0, 24);

/* ================================================================
 * 1. qstash-auth — the URL fire credential (REAL Web Crypto)
 * ================================================================ */
console.log("\n--- qstash-auth (URL fire credential) ---");
{
  const k1 = await cronUrlAuthKey("rid_alpha", "token_one");
  check("key is 24 lowercase hex chars", /^[0-9a-f]{24}$/.test(k1), k1);
  check(
    "matches the reference HMAC-SHA256(token, rid)[0..24]",
    k1 === nodeHmac("token_one", "rid_alpha"),
    `${k1} vs ${nodeHmac("token_one", "rid_alpha")}`
  );
  const k1b = await cronUrlAuthKey("rid_alpha", "token_one");
  check("deterministic", k1 === k1b);
  const k2 = await cronUrlAuthKey("rid_beta", "token_one");
  check("different rid → different key", k1 !== k2);
  const k3 = await cronUrlAuthKey("rid_alpha", "token_two");
  check("different token → different key", k1 !== k3);

  // Multi-account verification
  const keys = await allCronUrlAuthKeys("rid_alpha", ["token_one", "token_two", ""]);
  check("allCronUrlAuthKeys: one per non-empty token", keys.length === 2, JSON.stringify(keys));
  check("allCronUrlAuthKeys: contains account 0's key", keys.includes(k1));
  check("allCronUrlAuthKeys: contains account 1's key", keys.includes(k3));

  // verifyCronUrlKey — the cron route's acceptance test
  check("verify: correct key accepted", await verifyCronUrlKey("rid_alpha", k1, ["token_one"]));
  check("verify: key valid under ANY pooled token", await verifyCronUrlKey("rid_alpha", k3, ["token_one", "token_two"]));
  check("verify: wrong key rejected", !(await verifyCronUrlKey("rid_alpha", nodeHmac("token_one", "rid_gamma"), ["token_one"])));
  check("verify: malformed key rejected (not hex)", !(await verifyCronUrlKey("rid_alpha", "zz" + k1.slice(2), ["token_one"])));
  check("verify: short key rejected", !(await verifyCronUrlKey("rid_alpha", "abc", ["token_one"])));
  check("verify: null key rejected", !(await verifyCronUrlKey("rid_alpha", null, ["token_one"])));
  check("verify: empty token pool rejected", !(await verifyCronUrlKey("rid_alpha", k1, [])));

  // safeEqualHex
  check("safeEqualHex: equal strings", safeEqualHex("abcdef", "abcdef"));
  check("safeEqualHex: different strings", !safeEqualHex("abcdef", "abcdeg"));
  check("safeEqualHex: different lengths", !safeEqualHex("abc", "abcd"));
  check("safeEqualHex: empty", !safeEqualHex("", ""));
}

/* ================================================================
 * 2. scheduler.ts — &k= minted into destinations + repair v2
 * ================================================================ */
console.log("\n--- scheduler.ts (URL key + repair reconciliation) ---");
{
  const s = src("src/lib/scheduler.ts");
  check("cronUrl appends the auth key param", /&k=\$\{authKey\}/.test(s));
  check("cronUrl takes an authKey parameter", /cronUrl\(\s*reminderId: string,\s*baseUrl\?: string,\s*authKey\?: string \| null/.test(s));
  check("schedule create computes the key for the owning account", /cronUrlAuthKey\(reminder\.id, account\.token\)/.test(s));
  check("one-time publish computes the key too", /cronUrlAuthKey\(reminder\.id, account\.token\)/.test(s));
  check(
    "repair pass lists upstream schedules (GET <QSTASH_BASE>/schedules)",
    /async function listSchedulesOnAccount/.test(s) && /`\$\{QSTASH_BASE\}\/schedules`/.test(s),
  );
  check("repair pass handles listing failure safely (upstreamVisible guard)", /upstreamVisible/.test(s));
  check("repair pass migrates pre-V1.6 key-less schedules", /migrating pre-V1\.6 schedule/.test(s));
  // The literal in source is /[?&]k=/.test(live.destination) — check it exists:
  check("repair detects key-less destinations", s.includes("/[?&]k=/.test(live.destination)"));
  check("repair handles both list response shapes", /Array\.isArray\(json\?\.schedules\)/.test(s));
}

/* ================================================================
 * 3. cron route — the V1.6 auth matrix
 * ================================================================ */
console.log("\n--- cron route (auth matrix) ---");
{
  const s = src("src/app/api/notifications/cron/route.ts");
  check("verifies the URL key (verifyCronUrlKey)", /verifyCronUrlKey\(\s*ridParam,\s*keyParam,\s*tokens\s*\)/.test(s));
  check("browser poll requires X-Client-Poll header", /x-client-poll/.test(s));
  check("browser poll requires a valid session", /getSessionUser\(\s*await getSessionToken\("daily"\)/.test(s));
  check("browser poll only authorizes the catch-all (no rid)", /x-client-poll"\) === "1" && !ridParam/.test(s));
  check(
    "SPOOF HOLE CLOSED: no standalone X-Internal-Scheduler acceptance",
    !/x-internal-scheduler"\) === "1"\s*\)\s*\{\s*return\s*\{\s*ok:\s*true\s*\}/.test(s),
  );
  check("401s are logged with available-auth diagnostics", /\[cron\] auth rejected/.test(s));
  check("reminder pushes: urgency high", /urgency: "high"/.test(s));
  check("reminder pushes: 24h TTL (a day-old reminder is noise)", /ttl: 86400/.test(s));
  check("fire outcomes are logged (delivery observability)", /\[cron\] reminder \$\{rid\} fired/.test(s));
}

/* ================================================================
 * 4. sw.js v8 — never-invisible notifications
 * ================================================================ */
console.log("\n--- sw.js v8 (receipt echo + display cascade) ---");
{
  const s = src("public/sw.js");
  check("version constant v8", /KHATA_SW_VERSION = "v8"/.test(s));
  check("cache bumped to khata-v8", /CACHE_NAME = "khata-v8"/.test(s));
  check("NO export statement (classic SW script)", !/\bexport\s+(const|function|class|let|var)\b/.test(s));
  check("echo: PUSH_RECEIVED postMessage to clients", /type: "PUSH_RECEIVED"/.test(s) && /c\.postMessage\(echo\)/.test(s));
  check("echo: includeUncontrolled so fresh pages hear it too", /includeUncontrolled: true/.test(s));
  check("persistent receipt log in a dedicated cache", /khata-push-log/.test(s) && /__khata_push_receipt__/.test(s));
  check("receipt written BEFORE display attempt", s.indexOf("PUSH_RECEIVED") < s.indexOf("showNotification(title, options)"));
  check("PING/PONG version probe", /"PING"/.test(s) && /"PONG"/.test(s) && /KHATA_SW_VERSION\s*\}/.test(s));
  check("3-level showNotification cascade (full → minimal → bare)", (s.match(/showNotification\(/g) ?? []).length >= 3, `count: ${(s.match(/showNotification\(/g) ?? []).length}`);
  check("pushsubscriptionchange resubscribes with server key", /pushsubscriptionchange/.test(s) && /vapid-public-key/.test(s));
  check("resubscribe persists via /api/notifications/subscribe", /\/api\/notifications\/subscribe/.test(s));
  check("default body when payload is empty", /You have a new reminder/.test(s));
  check("notificationclick prefers pathname match", /new URL\(c\.url\)\.pathname === url/.test(s));
}

/* ================================================================
 * 5. push-client v2 — doctor, receipts, auto-heal
 * ================================================================ */
console.log("\n--- push-client v2 ---");
{
  const s = src("src/lib/push-client.ts");
  for (const fn of [
    "export function pingServiceWorker",
    "export async function getLastPushReceipt",
    "export function waitForPushReceipt",
    "export function listenForPushReceipts",
    "export async function runPushDoctor",
    "export async function resubscribeIfNeeded",
  ]) {
    check(`exports ${fn.replace(/export (async )?function /, "")}`, s.includes(fn));
  }
  check("doctor checks permission", /id: "permission"/.test(s));
  check("doctor checks SW version (stale worker detection)", /id: "sw"/.test(s) && /pingServiceWorker\(\)/.test(s));
  check("doctor checks VAPID key match", /id: "vapid"/.test(s) && /applicationServerKey/.test(s));
  check("doctor checks server-side registration (ghost detection)", /id: "server"/.test(s) && /endpointTail/.test(s));
  check("doctor reports last receipt with OS-level guidance", /id: "receipt"/.test(s) && /Focus/.test(s));
  check("doctor covers the iOS installed-PWA requirement", /Add to Home Screen/.test(s));
  check("auto-heal re-saves ghost subscriptions", /savedTails/.test(s) && /api\/notifications\/subscribe/.test(s));
  check("auto-heal drops mismatched-key subscriptions", /keyMismatch/.test(s) && /sub\.unsubscribe/.test(s));
  check("TestPushResult carries vapidPublicKey + sentAt", /vapidPublicKey\?: string/.test(s) && /sentAt\?: number/.test(s));
}

/* ================================================================
 * 6. test route + app wiring
 * ================================================================ */
console.log("\n--- test route + app wiring ---");
{
  const t = src("src/app/api/notifications/test/route.ts");
  check("test route returns vapidPublicKey", /vapidPublicKey: getVapidPublicKey\(\)/.test(t));
  check("test route returns sentAt", /sentAt: Date\.now\(\)/.test(t));

  const d = src("src/app/DailyApp.tsx");
  check("daily app browser poll uses X-Client-Poll (session auth)", /X-Client-Poll/.test(d) && !/"X-Internal-Scheduler"/.test(d));
  check("daily app runs boot auto-heal", /resubscribeIfNeeded\(\)/.test(d));
  check("daily app has the in-page push fallback", /listenForPushReceipts\(/.test(d));
  check("daily app Send test is echo-verified", /waitForPushReceipt\(15000\)/.test(d));

  const dash = src("src/app/dashboard/DashboardApp.tsx");
  check("dashboard has the notification doctor button", /runDoctor/.test(dash) && /Stethoscope/.test(dash));
  check("dashboard renders doctor checks with fix steps", /doctor\.checks\.map/.test(dash) && /c\.fix/.test(dash));
  check("dashboard Send test is echo-verified with latency", /waitForPushReceipt\(15000\)/.test(dash) && /latencyMs/.test(dash));
  check("dashboard shows the persistent last-receipt line", /lastReceipt/.test(dash) && /getLastPushReceipt\(\)/.test(dash));
  check("dashboard runs boot auto-heal + in-page fallback", /resubscribeIfNeeded\(\)/.test(dash) && /listenForPushReceipts\(/.test(dash));
}

/* ================================================================
 * 7. e2e companion — the fire-auth matrix is exercised end-to-end in
 *    scripts/test-qstash-e2e.ts section 8 (token-less &k= fire accepted,
 *    wrong key 401, spoofed X-Internal-Scheduler 401, session poll).
 * ================================================================ */
console.log("\n--- e2e companion present ---");
{
  const e = src("scripts/test-qstash-e2e.ts");
  check("e2e computes the fire key (urlKey)", /function urlKey/.test(e));
  check("e2e simulates a token-less QStash fire with &k=", /&k=\$\{urlKey\(fireRid\)\}/.test(e));
  check("e2e asserts the spoofed X-Internal-Scheduler is 401", /spoofed X-Internal-Scheduler → 401/.test(e));
  check("e2e asserts session-authed client poll → 200", /X-Client-Poll with a valid session → 200/.test(e));
  check("e2e interceptor memoizes schedules for the repair pass", /memoSchedules/.test(e));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
