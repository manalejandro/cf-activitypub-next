import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { deleteCustomEmoji, disableCustomEmoji } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-auth";

// DELETE /api/admin/emojis/:id — Permanently delete a custom emoji
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const { id } = await params;
  await deleteCustomEmoji(env.DB, id);
  return json({ success: true });
}

// PATCH /api/admin/emojis/:id — Disable or update a custom emoji
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const { id } = await params;
  const body = await request.json() as Record<string, unknown>;

  if (body.disabled === true) {
    await disableCustomEmoji(env.DB, id);
  } else if (body.disabled === false) {
    // Re-enable
    await env.DB
      .prepare("UPDATE custom_emojis SET disabled = 0, updated_at = datetime('now') WHERE id = ?")
      .bind(id)
      .run();
  }

  return json({ success: true });
}
