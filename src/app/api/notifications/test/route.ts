import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { isWebPushConfigured, sendPushToUser } from "@/lib/notifications/push";

/**
 * POST /api/notifications/test
 * Sends a test push notification to all of the current user's subscribed devices.
 * Requires a daily session.
 */
export async function POST(req: NextRequest) {
  const token = await getSessionToken("daily");
  const user = await getSessionUser(token, "daily");
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isWebPushConfigured()) {
    return NextResponse.json(
      { error: "Notifications aren't available on this deployment yet." },
      { status: 503 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const message = (body.message as string) ?? "Test notification";

  const result = await sendPushToUser(user.id, {
    title: "Khata",
    body: message,
    url: "/",
  });

  return NextResponse.json({ sent: result.sent, failed: result.failed });
}
