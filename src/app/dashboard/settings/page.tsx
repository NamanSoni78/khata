import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { db } from "@/lib/db";
import DashboardLogin from "../DashboardLogin";
import SettingsApp from "./SettingsApp";

export default async function SettingsPage() {
  const token = await getSessionToken("dashboard");
  const user = await getSessionUser(token, "dashboard");
  if (!user || user.id === "admin") {
    return <DashboardLogin />;
  }
  const creds = await db.userWebAuthnCredential.findMany({
    where: { userId: user.id },
    select: { id: true, credentialId: true, deviceType: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  return (
    <SettingsApp
      username={user.username}
      passkeys={creds.map((c) => ({
        id: c.id,
        deviceType: c.deviceType ?? "Unknown device",
        createdAt: c.createdAt.toISOString(),
        credentialIdShort: c.credentialId.slice(0, 12) + "...",
      }))}
    />
  );
}
