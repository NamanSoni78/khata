import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { db } from "@/lib/db";

/**
 * Mindmap CRUD.
 * GET    /api/dashboard/mindmaps           — list user's mindmaps (id/name/createdAt/updatedAt)
 * POST   /api/dashboard/mindmaps           — create new mindmap (body: { name, nodes?, edges? })
 * PUT    /api/dashboard/mindmaps?id=xxx     — replace nodes + edges (the SAVE button)
 * PATCH  /api/dashboard/mindmaps?id=xxx     — partial update (e.g., rename)
 * DELETE /api/dashboard/mindmaps?id=xxx     — delete mindmap
 */
export async function GET() {
  const token = await getSessionToken("dashboard");
  const user = await getSessionUser(token, "dashboard");
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const maps = await db.mindmap.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, createdAt: true, updatedAt: true },
  });
  return NextResponse.json({ mindmaps: maps });
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken("dashboard");
  const user = await getSessionUser(token, "dashboard");
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const name = (body.name as string)?.trim() || `Mindmap ${new Date().toLocaleString("en-IN")}`;
  const nodes = Array.isArray(body.nodes) ? body.nodes : [];
  const edges = Array.isArray(body.edges) ? body.edges : [];

  const created = await db.mindmap.create({
    data: {
      userId: user.id,
      name,
      nodes: JSON.stringify(nodes),
      edges: JSON.stringify(edges),
      metadata: JSON.stringify({ lastEditedBy: "user" }),
    },
  });
  return NextResponse.json({
    id: created.id,
    name: created.name,
    nodes,
    edges,
    createdAt: created.createdAt,
    updatedAt: created.updatedAt,
  });
}

export async function PUT(req: NextRequest) {
  const token = await getSessionToken("dashboard");
  const user = await getSessionUser(token, "dashboard");
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const existing = await db.mindmap.findFirst({ where: { id, userId: user.id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const nodes = Array.isArray(body.nodes) ? body.nodes : JSON.parse(existing.nodes || "[]");
  const edges = Array.isArray(body.edges) ? body.edges : JSON.parse(existing.edges || "[]");
  const name = (body.name as string | undefined)?.trim() || existing.name;

  const updated = await db.mindmap.update({
    where: { id },
    data: {
      name,
      nodes: JSON.stringify(nodes),
      edges: JSON.stringify(edges),
      metadata: JSON.stringify({ lastEditedBy: body.lastEditedBy ?? "user" }),
    },
  });
  return NextResponse.json({
    id: updated.id,
    name: updated.name,
    nodes,
    edges,
    updatedAt: updated.updatedAt,
  });
}

export async function PATCH(req: NextRequest) {
  const token = await getSessionToken("dashboard");
  const user = await getSessionUser(token, "dashboard");
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const existing = await db.mindmap.findFirst({ where: { id, userId: user.id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const updateData: any = {};
  if (typeof body.name === "string") updateData.name = body.name.trim();
  if (Array.isArray(body.nodes)) updateData.nodes = JSON.stringify(body.nodes);
  if (Array.isArray(body.edges)) updateData.edges = JSON.stringify(body.edges);
  if (body.lastEditedBy) updateData.metadata = JSON.stringify({ lastEditedBy: body.lastEditedBy });

  const updated = await db.mindmap.update({ where: { id }, data: updateData });
  return NextResponse.json({
    id: updated.id,
    name: updated.name,
    nodes: JSON.parse(updated.nodes || "[]"),
    edges: JSON.parse(updated.edges || "[]"),
    updatedAt: updated.updatedAt,
  });
}

export async function DELETE(req: NextRequest) {
  const token = await getSessionToken("dashboard");
  const user = await getSessionUser(token, "dashboard");
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const existing = await db.mindmap.findFirst({ where: { id, userId: user.id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await db.mindmap.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
