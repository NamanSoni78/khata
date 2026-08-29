import { NextResponse } from "next/server";
import { isWebPushConfigured, getVapidPublicKey } from "@/lib/notifications/push";
import { getFeatureFlags } from "@/lib/admin-config";

export async function GET() {
  const flags = await getFeatureFlags();
  if (!flags.webPush || !isWebPushConfigured()) {
    return NextResponse.json({ enabled: false });
  }
  return NextResponse.json({
    enabled: true,
    publicKey: getVapidPublicKey(),
  });
}
