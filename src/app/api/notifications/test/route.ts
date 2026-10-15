import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { isWebPushConfigured, sendPushToUser } from "@/lib/notifications/push";

/**
 * POST /api/notifications/test
 * Sends a test push notification to all of the current user's subscribed
 * devices. Accepts EITHER session type: the daily app's settings sheet and
 * the dashboard's reminders tab both use this — you should be able to
 * verify the pipeline from wherever you configure notifications.
 *
 * The response is HONEST about delivery: { sent, failed, error? }. The old
 * version returned 200 + sent:0 and the client toasted "Sent!" — hiding the
 * fact that no device was subscribed (the actual root cause of "test
 * notification not working").
 */
export async function POST(req: NextRequest) {
  // Daily session first (the classic caller), then dashboard session.
  let user = await getSessionUser(await getSessionToken("daily"), "daily");
  if (!user || user.id === "admin") {
    user = await getSessionUser(await getSessionToken("dashboard"), "dashboard");
  }
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isWebPushConfigured()) {
    return NextResponse.json(
      { error: "Notifications aren't available on this deployment yet (missing VAPID keys)." },
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

  return NextResponse.json({
    sent: result.sent,
    failed: result.failed,
    // First failure reason (e.g. push-service 403/410) so the UI can show
    // WHY a device didn't receive the test instead of a vague "didn't work".
    error: result.errors?.[0] ?? null,
  });
}
