import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { isWebPushConfigured, sendPushToUser, listDevices } from "@/lib/notifications/push";

/**
 * POST /api/notifications/test
 * Sends a test push notification to all of the current user's subscribed
 * devices. Accepts EITHER session type: the daily app's settings sheet and
 * the dashboard's reminders tab both use this — you should be able to
 * verify the pipeline from wherever you configure notifications.
 *
 * The response is HONEST about delivery: { sent, failed, error?, devices }.
 * The old version returned 200 + sent:0 and the client toasted "Sent!" —
 * hiding the fact that no device was subscribed (the actual root cause of
 * "test notification not working").
 *
 * V1.5 — why "Sent to 1 device" could still show nothing on screen:
 *   every notification shared the tag "khata-notif" with renotify:false, so
 *   consecutive notifications SILENTLY replaced each other (especially on
 *   Android Chrome). Tests now carry a UNIQUE tag + renotify:true, keep
 *   themselves on screen (requireInteraction), and go out with urgency
 *   "high" + a 2-minute TTL (deliver now or drop — never queue on a dead
 *   device). The response also lists the exact devices (browser + OS) that
 *   were targeted, so a stale subscription on a browser you're not looking
 *   at is visible at a glance.
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

  const result = await sendPushToUser(
    user.id,
    {
      title: "Khata · Test",
      body: message,
      url: "/",
      // Unique per test → never silently replaces a previous notification.
      tag: `khata-test-${Date.now()}`,
      // Stay on screen until dismissed — impossible to miss.
      requireInteraction: true,
    },
    { ttl: 120, urgency: "high" }
  );

  return NextResponse.json({
    sent: result.sent,
    failed: result.failed,
    // First failure reason (e.g. push-service 403/410) so the UI can show
    // WHY a device didn't receive the test instead of a vague "didn't work".
    error: result.errors?.[0] ?? null,
    // Which devices (browser + OS) were targeted — "Sent to 1 device" now
    // says WHICH device, exposing stale subscriptions instantly.
    devices: result.devices,
  });
}

/** GET — the user's subscribed devices (for settings UIs). */
export async function GET(req: NextRequest) {
  let user = await getSessionUser(await getSessionToken("daily"), "daily");
  if (!user || user.id === "admin") {
    user = await getSessionUser(await getSessionToken("dashboard"), "dashboard");
  }
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    configured: isWebPushConfigured(),
    devices: await listDevices(user.id),
  });
}
