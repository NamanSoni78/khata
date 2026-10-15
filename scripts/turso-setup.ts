/**
 * Turso database setup — creates the full Khata schema + seeds defaults
 * on a remote Turso (libSQL) database.
 *
 * Usage (env vars required):
 *   TURSO_DATABASE_URL="libsql://your-db.turso.io" \
 *   TURSO_AUTH_TOKEN="eyJ..." \
 *   bun run scripts/turso-setup.ts
 *
 * (Also accepts DATABASE_URL / DATABASE_AUTH_TOKEN.)
 *
 * What it does:
 *   1. Generates the DDL from prisma/schema.prisma via `prisma migrate diff`
 *      (guaranteed schema parity — no hand-maintained SQL).
 *   2. Executes every statement on the remote DB through @libsql/client.
 *   3. Runs the AdminConfig seed (agent defaults, feature flags, glossary…).
 *   4. Prints table row counts as a sanity check.
 *
 * Safe to re-run: tables use IF NOT EXISTS-style idempotent creates from
 * prisma migrate diff? (No — CREATE TABLE is plain.) Existing tables are
 * detected and skipped, so re-running only re-seeds config.
 */
import { createClient } from "@libsql/client";
import { execSync } from "child_process";

function env(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

const url = env("TURSO_DATABASE_URL", "DATABASE_URL");
const token = env("TURSO_AUTH_TOKEN", "DATABASE_AUTH_TOKEN");

if (!url || !/^libsql:|^wss:|^https:/i.test(url)) {
  console.error(
    "✗ TURSO_DATABASE_URL missing or not a libsql:// URL.\n" +
      "   Create a database at https://turso.tech and paste its URL + token,\n" +
      "   e.g. libsql://my-khata-db-myuser.turso.io"
  );
  process.exit(1);
}
if (!token) {
  console.error("✗ TURSO_AUTH_TOKEN missing. Generate one with `turso db tokens create <db>`.");
  process.exit(1);
}

console.log("→ Target:", url.replace(/\/\/.*@/, "//***@"));

const client = createClient({ url, authToken: token });

// ---------- 1. Generate DDL from the Prisma schema ----------
console.log("→ Generating DDL from prisma/schema.prisma…");
let ddl: string;
try {
  ddl = execSync(
    "bunx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script",
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
} catch (e: any) {
  console.error("✗ prisma migrate diff failed:\n", e.stderr ?? e.message);
  process.exit(1);
}

// ---------- 2. Execute statements ----------
const statements = ddl
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n")
  .split(/;\s*\n/)
  .map((s) => s.trim())
  .filter(Boolean);

console.log(`→ ${statements.length} DDL statements to run`);

async function tableExists(name: string): Promise<boolean> {
  try {
    const r = await client.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='${name}'`
    );
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

const CORE_TABLES = [
  "User", "UserMpin", "OtpCode", "UserSession", "UserConfig", "Account",
  "Contact", "Category", "Tag", "TransactionTag", "Transaction",
  "TransactionGroup", "PendingQuestion", "ChatMessage", "PushSubscription",
  "ScheduledNotification", "Mindmap", "AdminConfig",
];

const existing = new Set<string>();
for (const t of CORE_TABLES) {
  if (await tableExists(t)) existing.add(t);
}

if (existing.size === CORE_TABLES.length) {
  console.log("✓ All tables already exist — skipping DDL (re-run / migration refresh only).");
} else {
  let done = 0;
  for (const stmt of statements) {
    // Skip statements for tables that already exist (idempotent re-runs)
    const m = /CREATE\s+TABLE\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/i.exec(stmt);
    if (m && existing.has(m[1])) continue;
    try {
      await client.execute(stmt);
      done++;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/already exists/i.test(msg)) continue; // index/table races
      console.error("✗ Statement failed:", stmt.slice(0, 90), "→", msg.slice(0, 200));
      process.exit(1);
    }
  }
  console.log(`✓ Applied ${done} statements.`);
}

// ---------- 3. Seed AdminConfig defaults ----------
console.log("→ Seeding AdminConfig defaults…");
// Set env BEFORE the dynamic import: src/lib/db builds the Prisma client
// (bound to DATABASE_URL) at module-load time.
process.env.DATABASE_URL = url;
process.env.DATABASE_AUTH_TOKEN = token;
const { seed } = await import("./seed");
await seed();

// ---------- 4. Sanity check ----------
console.log("→ Verifying…");
for (const t of ["User", "Transaction", "AdminConfig", "ScheduledNotification"]) {
  try {
    const r = await client.execute(`SELECT COUNT(*) AS n FROM "${t}"`);
    console.log(`   ${t}: ${r.rows[0]?.n ?? 0} rows`);
  } catch {
    console.log(`   ${t}: (not found)`);
  }
}

await client.close();
console.log("\n✅ Turso database is ready.");
console.log("   Set these in Vercel → Settings → Environment Variables:");
console.log("   DATABASE_URL     = " + url);
console.log("   DATABASE_AUTH_TOKEN = " + token.slice(0, 8) + "…");
process.exit(0);
