import { type NextRequest, NextResponse } from "next/server";
import { getCloudflareContext, getBaseUrl } from "@/lib/cf";
import {
  getEmailVerificationByToken,
  deleteEmailVerification,
  markEmailVerified,
} from "@/lib/db";

/**
 * GET /api/auth/verify-email?token=...
 *
 * Verifies the email address associated with the token.
 * On success redirects to /login?verified=true.
 * On failure redirects to /login?error=verify_failed.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const token = request.nextUrl.searchParams.get("token");

  const { env } = getCloudflareContext();
  const baseUrl = getBaseUrl(env);

  if (!token) {
    return NextResponse.redirect(new URL("/login?error=verify_failed", baseUrl));
  }

  const record = await getEmailVerificationByToken(env.DB, token);
  if (!record) {
    return NextResponse.redirect(new URL("/login?error=verify_failed", baseUrl));
  }

  // Check expiry
  if (new Date(record.expiresAt) < new Date()) {
    await deleteEmailVerification(env.DB, token);
    return NextResponse.redirect(new URL("/login?error=verify_expired", baseUrl));
  }

  await markEmailVerified(env.DB, record.actorId);
  await deleteEmailVerification(env.DB, token);

  return NextResponse.redirect(new URL("/login?verified=true", baseUrl));
}
