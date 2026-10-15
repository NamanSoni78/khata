import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { db } from "@/lib/db";

/**
 * GET /api/auth/prefs — the user's saved UI preferences
 *   { wallpaper: string, ... }
 * POST /api/auth/prefs — merge-update prefs (partial JSON body OK)
 */
export async function GET() {
  const token = await getSessionToken("daily");
  const user = await getSessionUser(token, "daily");
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let prefs: Record<string, unknown> = {};
  try { prefs = JSON.parse(user.prefs || "{}"); } catch { prefs = {}; }
  return NextResponse.json({ prefs });
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken("daily");
  const user = await getSessionUser(token, "daily");
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid prefs" }, { status: 400 });
  }

  // Whitelisted preference keys (defensive — nothing arbitrary gets stored)
  const ALLOWED = ["wallpaper", "voiceLang"];
  const patch: Record<string, unknown> = {};
  for (const k of ALLOWED) {
    if (k in body) patch[k] = body[k];
  }

  let prefs: Record<string, unknown> = {};
  try { prefs = JSON.parse(user.prefs || "{}"); } catch { prefs = {}; }
  const merged = { ...prefs, ...patch };

  await db.user.update({
    where: { id: user.id },
    data: { prefs: JSON.stringify(merged) },
  });

  return NextResponse.json({ ok: true, prefs: merged });
}
