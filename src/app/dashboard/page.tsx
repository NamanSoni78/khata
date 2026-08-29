import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import DashboardApp from "./DashboardApp";
import DashboardLogin from "./DashboardLogin";

export default async function DashboardPage() {
  const token = await getSessionToken("dashboard");
  const user = await getSessionUser(token, "dashboard");
  if (!user || user.id === "admin") {
    return <DashboardLogin />;
  }
  return <DashboardApp username={user.username} />;
}
