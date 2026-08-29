import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import AdminPanel from "./AdminPanel";
import AdminLogin from "./AdminLogin";

export default async function AdminPage() {
  const token = await getSessionToken("admin");
  const user = await getSessionUser(token, "admin");
  if (!user) {
    return <AdminLogin />;
  }
  return <AdminPanel />;
}
