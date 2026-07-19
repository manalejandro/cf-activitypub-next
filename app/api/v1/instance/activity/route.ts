import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";

export async function GET(_request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const weeks: { week: string; statuses: string; logins: string; registrations: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const start = new Date();
    start.setDate(start.getDate() - start.getDay() - i * 7);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    end.setHours(23, 59, 59, 999);
    const weekStart = start.toISOString();
    const weekEnd = end.toISOString();
    const [statusRow, actorRow] = await Promise.all([
      env.DB
        .prepare("SELECT COUNT(*) as c FROM objects WHERE is_local = 1 AND published >= ? AND published <= ?")
        .bind(weekStart, weekEnd)
        .first<{ c: number }>(),
      env.DB
        .prepare("SELECT COUNT(*) as c FROM actors WHERE is_local = 1 AND created_at >= ? AND created_at <= ?")
        .bind(weekStart, weekEnd)
        .first<{ c: number }>(),
    ]);
    weeks.push({
      week: Math.floor(start.getTime() / 1000).toString(),
      statuses: (statusRow?.c ?? 0).toString(),
      logins: "0",
      registrations: (actorRow?.c ?? 0).toString(),
    });
  }
  return json(weeks);
}
