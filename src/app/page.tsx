import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { db } from "@/lib/db";
import DailyApp from "./DailyApp";

export default async function Home() {
  const token = await getSessionToken("daily");
  const user = await getSessionUser(token, "daily");

  if (!user || user.id === "admin") {
    // Not logged in — landing (client checks localStorage for a remembered
    // email and shows the MPIN unlock screen when one exists).
    return <DailyApp initialAuthStage="landing" />;
  }

  // Session exists. If MPIN isn't set up yet, finish setup; otherwise lock.
  const mpin = await db.userMpin.findUnique({ where: { userId: user.id } });
  if (!mpin?.appMpinHash) {
    return <DailyApp initialAuthStage="mpin-setup" username={user.username} email={user.email} />;
  }

  return <DailyApp initialAuthStage="unlock" username={user.username} email={user.email} />;
}
