import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { testAgentConnection } from "@/lib/llm/client";
import type { AgentConfig } from "@/lib/admin-config";

export async function POST(req: NextRequest) {
  const token = await getSessionToken("admin");
  const user = await getSessionUser(token, "admin");
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const config = (await req.json()) as AgentConfig;
  if (!config?.baseUrl || !config?.model) {
    return NextResponse.json({ error: "Missing baseUrl or model" }, { status: 400 });
  }
  const result = await testAgentConnection(config);
  return NextResponse.json(result);
}
