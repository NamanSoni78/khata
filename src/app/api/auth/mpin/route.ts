import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { createSession } from "@/lib/auth/session";
import { setSessionCookie } from "@/lib/auth/cookies";
import { hashMpin, verifyMpin, verifyPassword } from "@/lib/auth/credentials";
import { validateGmail } from "@/lib/email";
import { DEFAULT_CATEGORIES } from "@/lib/agent/default-categories";

const DAILY_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_ATTEMPTS = 5;
const LOCK_MS = 10 * 60 * 1000;

async function getUser() {
  const token = await getSessionToken("daily");
  return await getSessionUser(token, "daily");
}

/** Seed default categories once, on first MPIN setup. */
async function seedCategories(userId: string) {
  const existingCats = await db.category.count({ where: { userId } });
  if (existingCats === 0) {
    await db.category.createMany({
      data: DEFAULT_CATEGORIES.map((c) => ({ userId, name: c.name, type: c.type })),
    });
  }
}

async function startDailySession(userId: string) {
  const session = await createSession(userId, "daily");
  await setSessionCookie("daily", session.token, DAILY_TTL_SECONDS);
}

/**
 * POST /api/auth/mpin?action=setup|unlock|reset|set-dashboard
 *
 *  setup          (session)  { appMpin, dashboardMpin? }  — first-time setup
 *  unlock         (public)   { email, mpin }              — returning user, app 4-digit MPIN
 *  reset          (public)   { email, password, appMpin, dashboardMpin? } — forgot-MPIN flow
 *  set-dashboard  (session)  { dashboardMpin }            — set/change 6-digit dashboard MPIN
 */
export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const body = await req.json().catch(() => ({}));

  // ---------- setup (authenticated) ----------
  if (action === "setup") {
    const user = await getUser();
    if (!user || user.id === "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const appMpin = String(body.appMpin ?? "");
    if (!/^\d{4}$/.test(appMpin)) {
      return NextResponse.json({ error: "App MPIN must be exactly 4 digits" }, { status: 400 });
    }
    const dashboardMpin = body.dashboardMpin ? String(body.dashboardMpin) : "";
    if (dashboardMpin && !/^\d{6}$/.test(dashboardMpin)) {
      return NextResponse.json({ error: "Dashboard MPIN must be exactly 6 digits" }, { status: 400 });
    }

    const existing = await db.userMpin.findUnique({ where: { userId: user.id } });
    const data = {
      appMpinHash: await hashMpin(appMpin),
      ...(dashboardMpin ? { dashboardMpinHash: await hashMpin(dashboardMpin) } : {}),
      appFailedAttempts: 0,
      dashFailedAttempts: 0,
      lockedUntil: null,
    };
    if (existing) {
      await db.userMpin.update({ where: { userId: user.id }, data });
    } else {
      await db.userMpin.create({ data: { userId: user.id, ...data } });
    }
    await seedCategories(user.id);
    return NextResponse.json({ ok: true, message: "MPIN set" });
  }

  // ---------- set-dashboard (authenticated) ----------
  if (action === "set-dashboard") {
    const user = await getUser();
    if (!user || user.id === "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const dashboardMpin = String(body.dashboardMpin ?? "");
    if (!/^\d{6}$/.test(dashboardMpin)) {
      return NextResponse.json({ error: "Dashboard MPIN must be exactly 6 digits" }, { status: 400 });
    }
    const existing = await db.userMpin.findUnique({ where: { userId: user.id } });
    if (existing) {
      await db.userMpin.update({
        where: { userId: user.id },
        data: { dashboardMpinHash: await hashMpin(dashboardMpin), dashFailedAttempts: 0 },
      });
    } else {
      await db.userMpin.create({
        data: { userId: user.id, appMpinHash: "", dashboardMpinHash: await hashMpin(dashboardMpin) },
      });
    }
    return NextResponse.json({ ok: true });
  }

  // ---------- unlock (public: remembered email + 4-digit MPIN) ----------
  if (action === "unlock") {
    const g = validateGmail(body.email ?? "");
    if (!g.ok) return NextResponse.json({ error: g.reason }, { status: 400 });
    const user = await db.user.findUnique({ where: { email: g.email! } });
    if (!user || !user.isActive || !user.emailVerified) {
      return NextResponse.json({ error: "Account not found — sign in with your password" }, { status: 404 });
    }
    const row = await db.userMpin.findUnique({ where: { userId: user.id } });
    if (!row?.appMpinHash) {
      return NextResponse.json({ error: "No MPIN set — sign in with your password" }, { status: 400 });
    }
    if (row.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
      const waitMin = Math.ceil((row.lockedUntil.getTime() - Date.now()) / 60000);
      return NextResponse.json(
        { error: `MPIN locked — try again in ${waitMin} minute${waitMin > 1 ? "s" : ""} or reset it with your password` },
        { status: 423 }
      );
    }
    const ok = await verifyMpin(String(body.mpin ?? ""), row.appMpinHash);
    if (!ok) {
      const fails = row.appFailedAttempts + 1;
      await db.userMpin.update({
        where: { userId: user.id },
        data: {
          appFailedAttempts: fails,
          lockedUntil: fails >= MAX_ATTEMPTS ? new Date(Date.now() + LOCK_MS) : row.lockedUntil,
          ...(fails >= MAX_ATTEMPTS ? { appFailedAttempts: 0 } : {}),
        },
      });
      const left = MAX_ATTEMPTS - fails;
      return NextResponse.json(
        { error: left > 0 ? `Wrong MPIN — ${left} ${left === 1 ? "try" : "tries"} left` : "MPIN locked for 10 minutes" },
        { status: 401 }
      );
    }
    if (row.appFailedAttempts !== 0 || row.lockedUntil) {
      await db.userMpin.update({
        where: { userId: user.id },
        data: { appFailedAttempts: 0, lockedUntil: null },
      });
    }
    await startDailySession(user.id);
    return NextResponse.json({ ok: true, username: user.username, email: user.email });
  }

  // ---------- reset (public: forgot-MPIN — gmail + password) ----------
  if (action === "reset") {
    const g = validateGmail(body.email ?? "");
    if (!g.ok) return NextResponse.json({ error: g.reason }, { status: 400 });
    const user = await db.user.findUnique({ where: { email: g.email! } });
    if (!user || !user.emailVerified) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }
    const pwOk = await verifyPassword(String(body.password ?? ""), user.passwordHash);
    if (!pwOk) return NextResponse.json({ error: "Wrong password" }, { status: 401 });

    const appMpin = String(body.appMpin ?? "");
    if (!/^\d{4}$/.test(appMpin)) {
      return NextResponse.json({ error: "App MPIN must be exactly 4 digits" }, { status: 400 });
    }
    const dashboardMpin = body.dashboardMpin ? String(body.dashboardMpin) : "";
    if (dashboardMpin && !/^\d{6}$/.test(dashboardMpin)) {
      return NextResponse.json({ error: "Dashboard MPIN must be exactly 6 digits" }, { status: 400 });
    }
    const existing = await db.userMpin.findUnique({ where: { userId: user.id } });
    const data = {
      appMpinHash: await hashMpin(appMpin),
      ...(dashboardMpin ? { dashboardMpinHash: await hashMpin(dashboardMpin) } : {}),
      appFailedAttempts: 0,
      dashFailedAttempts: 0,
      lockedUntil: null,
    };
    if (existing) {
      await db.userMpin.update({ where: { userId: user.id }, data });
    } else {
      await db.userMpin.create({ data: { userId: user.id, ...data } });
    }
    await seedCategories(user.id);
    await startDailySession(user.id);
    return NextResponse.json({ ok: true, username: user.username, email: user.email });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
