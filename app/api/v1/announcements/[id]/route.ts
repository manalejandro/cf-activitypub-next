import { type NextRequest } from "next/server";
import { json, unauthorized } from "@/lib/cf";
import { getAdminRole } from "@/lib/admin-auth";
import { env } from "cloudflare:workers";

// DELETE /api/v1/announcements/:id — Delete an announcement (admin/moderator only).
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {

  const role = await getAdminRole(request, env);
  if (role === null) return unauthorized();

  const { id } = await params;
  const existing = await env.DB
    .prepare("SELECT id FROM announcements WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();
  if (!existing) return json({ error: "Announcement not found" }, 404);

  await env.DB.prepare("DELETE FROM announcements WHERE id = ?").bind(id).run();
  return json({ success: true });
}