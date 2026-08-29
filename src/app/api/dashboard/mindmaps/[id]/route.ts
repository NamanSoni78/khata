import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { db } from "@/lib/db";

/**
 * GET /api/dashboard/mindmaps/[id] — full mindmap (nodes + edges)
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken("dashboard");
  const user = await getSessionUser(token, "dashboard");
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const map = await db.mindmap.findFirst({ where: { id, userId: user.id } });
  if (!map) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    id: map.id,
    name: map.name,
    nodes: JSON.parse(map.nodes || "[]"),
    edges: JSON.parse(map.edges || "[]"),
    createdAt: map.createdAt,
    updatedAt: map.updatedAt,
    metadata: JSON.parse(map.metadata || "{}"),
  });
}
