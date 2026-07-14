import { clearAuthCookie } from "@/lib/auth";
import { json } from "@/lib/cf";

export async function POST(): Promise<Response> {
  return new Response(JSON.stringify({}), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": clearAuthCookie(),
    },
  });
}
