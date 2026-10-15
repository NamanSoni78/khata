import { cookies } from "next/headers";
import type { SessionType } from "./session";

const COOKIE_NAMES: Record<SessionType, string> = {
  daily: "fin_track_daily",
  dashboard: "fin_track_dashboard",
  admin: "fin_track_admin",
};

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

export async function setSessionCookie(type: SessionType, token: string, maxAgeSeconds: number) {
  const c = await cookies();
  c.set(COOKIE_NAMES[type], token, {
    ...COOKIE_OPTS,
    maxAge: maxAgeSeconds,
  });
}

export async function clearSessionCookie(type: SessionType) {
  const c = await cookies();
  c.delete(COOKIE_NAMES[type]);
}

export async function getSessionToken(type: SessionType): Promise<string | undefined> {
  const c = await cookies();
  return c.get(COOKIE_NAMES[type])?.value;
}

export const SESSION_COOKIE_NAMES = COOKIE_NAMES;
