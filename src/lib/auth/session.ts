import { db } from "@/lib/db";
import { generateSessionToken } from "./credentials";

export type SessionType = "daily" | "dashboard" | "admin";

const DAILY_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const DASHBOARD_IDLE_TIMEOUT_MS = 1000 * 60 * 15; // 15 min idle
const DASHBOARD_HARD_TTL_MS = 1000 * 60 * 60 * 4; // 4 hours hard max
const ADMIN_SESSION_TTL_MS = 1000 * 60 * 60 * 2; // 2 hours

export interface SessionPayload {
  userId: string;
  type: SessionType;
  token: string;
  expiresAt: Date;
  lastActivityAt: Date;
}

/**
 * Create a new session for a user.
 * - daily: long-lived (30 days), used by `/` PWA route.
 * - dashboard: 15-min idle timeout + 4h hard cap, requires password re-entry after expiry.
 * - admin: 2h hard cap, env-var authenticated (userId is "admin").
 */
export async function createSession(userId: string, type: SessionType): Promise<SessionPayload> {
  const token = generateSessionToken();
  const now = new Date();
  const ttl = type === "daily" ? DAILY_SESSION_TTL_MS : type === "dashboard" ? DASHBOARD_HARD_TTL_MS : ADMIN_SESSION_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttl);

  const session = await db.userSession.create({
    data: {
      userId,
      type,
      token,
      expiresAt,
      lastActivityAt: now,
    },
  });

  return {
    userId: session.userId,
    type: session.type as SessionType,
    token: session.token,
    expiresAt: session.expiresAt,
    lastActivityAt: session.lastActivityAt,
  };
}

/**
 * Validate a session token. Returns the session if valid (and refreshes idle timeout for dashboard).
 * Returns null if invalid, expired, or hard-cap reached.
 */
export async function validateSession(token: string | undefined, type: SessionType): Promise<SessionPayload | null> {
  if (!token) return null;

  const session = await db.userSession.findUnique({
    where: { token },
  });
  if (!session) return null;
  if (session.type !== type) return null;

  const now = new Date();

  // Hard cap check
  if (session.expiresAt < now) {
    await db.userSession.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  // Dashboard: idle timeout check
  if (type === "dashboard") {
    const idleMs = now.getTime() - session.lastActivityAt.getTime();
    if (idleMs > DASHBOARD_IDLE_TIMEOUT_MS) {
      await db.userSession.delete({ where: { id: session.id } }).catch(() => {});
      return null;
    }
    // Bump activity
    await db.userSession.update({
      where: { id: session.id },
      data: { lastActivityAt: now },
    });
  }

  return {
    userId: session.userId,
    type: session.type as SessionType,
    token: session.token,
    expiresAt: session.expiresAt,
    lastActivityAt: type === "dashboard" ? now : session.lastActivityAt,
  };
}

export async function destroySession(token: string): Promise<void> {
  await db.userSession.delete({ where: { token } }).catch(() => {});
}

/**
 * Get the user from a session. Returns null if session invalid OR user inactive.
 */
export async function getSessionUser(token: string | undefined, type: SessionType) {
  const session = await validateSession(token, type);
  if (!session) return null;

  if (type === "admin") {
    // Admin is env-authenticated; userId stored as "admin"
    return { id: "admin", username: "admin", isActive: true };
  }

  const user = await db.user.findUnique({ where: { id: session.userId } });
  if (!user || !user.isActive) return null;
  return user;
}
