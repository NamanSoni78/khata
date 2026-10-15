/**
 * Admin authentication — purely env-var based.
 * Set ADMIN_USERNAME and ADMIN_PASSWORD in Vercel env vars.
 *
 * ADMIN_PASSWORD can be either:
 *   - plain text (dev convenience)
 *   - bcrypt hash starting with $2a$, $2b$, or $2y$ (prod recommended)
 *
 * Returns a session with userId="admin".
 */
import { verifyPassword } from "./credentials";
import { createSession } from "./session";
import { db } from "@/lib/db";

export async function verifyAdminCredentials(username: string, password: string): Promise<boolean> {
  const adminUser = process.env.ADMIN_USERNAME;
  const adminPass = process.env.ADMIN_PASSWORD;
  if (!adminUser || !adminPass) return false;
  if (username !== adminUser) return false;
  if (/^\$2[aby]\$\d+\$.*/.test(adminPass)) {
    return verifyPassword(password, adminPass);
  }
  return password === adminPass;
}

export async function createAdminSession() {
  // Ensure the admin pseudo-user exists in DB (FK constraint on UserSession requires it).
  // We use a fixed id "admin" so admin sessions are isolated.
  await db.user.upsert({
    where: { id: "admin" },
    update: {},
    create: {
      id: "admin",
      email: "admin@khata.internal",
      username: "__admin__",
      passwordHash: "__env_managed__",
      emailVerified: true,
      isActive: false, // not a regular login user
    },
  });
  return createSession("admin", "admin");
}

/**
 * Check if a user is the admin pseudo-user (don't show in user management list).
 */
export function isAdminPseudoUser(user: { id: string; username: string }): boolean {
  return user.id === "admin" || user.username === "__admin__";
}
