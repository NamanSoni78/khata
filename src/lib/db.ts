/**
 * Prisma client bound to libSQL (Turso) via the official driver adapter.
 *
 * - Production (Turso):  DATABASE_URL="libsql://…" + DATABASE_AUTH_TOKEN
 * - Local dev:           DATABASE_URL="file:/abs/path.db" (or unset → ./db/khata.db)
 *
 * The same adapter path is used in both cases, so dev and prod behave
 * identically (including PRAGMA foreign_keys behavior).
 */
import { PrismaClient } from "@prisma/client";
import { PrismaLibSQL } from "@prisma/adapter-libsql";
import { createClient, type Client } from "@libsql/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function resolveDbConfig(): { url: string; authToken?: string } {
  const rawUrl = (process.env.DATABASE_URL ?? "").trim() || "file:./db/khata.db";
  const isRemote = /^(libsql|wss|https|http|tls):/i.test(rawUrl);
  const authToken = process.env.DATABASE_AUTH_TOKEN ?? undefined;
  // Auth token only matters for remote Turso URLs.
  return { url: rawUrl, ...(isRemote && authToken ? { authToken } : {}) };
}

export const db: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaLibSQL(resolveDbConfig()),
    log: ["error", "warn"],
  });

// Ensure the engine connects eagerly (fixes "Engine is not yet connected"
// when the first query happens deep inside a request handler).
if (!globalForPrisma.prisma) {
  globalForPrisma.prisma = db;
  db.$connect().catch((e) => {
    console.error("[db] $connect() failed:", e);
  });
}

/** Raw libSQL client for maintenance scripts (schema DDL, seeding) — not request hot paths. */
export const rawDb: Client = (() => {
  const g = globalThis as unknown as { __khataLibsql?: Client };
  if (!g.__khataLibsql) g.__khataLibsql = createClient(resolveDbConfig());
  return g.__khataLibsql;
})();
