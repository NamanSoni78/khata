import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { db } from "@/lib/db";
import DailyApp from "./DailyApp";

export default async function Home() {
  const token = await getSessionToken("daily");
  const user = await getSessionUser(token, "daily");

  if (!user || user.id === "admin") {
    // Not logged in — show login screen
    return <DailyApp initialStage="login" />;
  }

  // Logged in. Check if MPIN is set up.
  const mpin = await db.userMpin.findUnique({ where: { userId: user.id } });
  const webauthnCount = await db.userWebAuthnCredential.count({ where: { userId: user.id } });

  if (!mpin && webauthnCount === 0) {
    return <DailyApp initialStage="mpin-setup" username={user.username} userId={user.id} />;
  }

  // MPIN or WebAuthn exists — show unlock screen
  return <DailyApp initialStage="unlock" username={user.username} />;
}
