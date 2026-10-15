import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { testAgentConnection, testSttConnection } from "@/lib/llm/client";
import type { AgentConfig } from "@/lib/admin-config";

export async function POST(req: NextRequest) {
  const token = await getSessionToken("admin");
  const user = await getSessionUser(token, "admin");
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json();
  const { which, ...config } = body;
  if (!config?.baseUrl) {
    return NextResponse.json({ error: "Missing baseUrl" }, { status: 400 });
  }

  if (which === "stt" || config.engine !== undefined) {
    const result = await testSttConnection(config as AgentConfig);
    return NextResponse.json(result);
  }

  if (!config?.model) {
    return NextResponse.json({ error: "Missing model" }, { status: 400 });
  }
  const result = await testAgentConnection(config as AgentConfig);
  return NextResponse.json(result);
}
