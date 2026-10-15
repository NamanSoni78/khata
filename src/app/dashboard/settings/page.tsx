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
  const mpin = await db.userMpin.findUnique({ where: { userId: user.id } });
  return (
    <SettingsApp
      username={user.username}
      email={user.email}
      hasDashboardMpin={!!mpin?.dashboardMpinHash}
    />
  );
}
