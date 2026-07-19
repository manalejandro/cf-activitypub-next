import { type NextRequest } from "next/server";
import { json } from "@/lib/cf";

export async function GET(_request: NextRequest): Promise<Response> {
  return json([
    { code: "en", name: "English", native_name: "English" },
    { code: "es", name: "Spanish", native_name: "Español" },
  ]);
}
