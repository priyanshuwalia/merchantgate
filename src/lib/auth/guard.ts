import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { type NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";

/**
 * Extract the authenticated merchant id from a web Request / NextRequest by
 * validating the signed session cookie. Returns null when unauthenticated.
 */
export function getSessionMerchantFromRequest(
  request: Request | NextRequest,
): string | null {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)ap_merchant_session=([^;]+)/);
  if (!match) return null;
  try {
    return verifySessionToken(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

/**
 * Throw a 401 JSON response for API routes. Should be used as an early return
 * (this returns a NextResponse, not a thrown error).
 */
export function unauthorizedJson(): NextResponse {
  return NextResponse.json(
    { error: "UNAUTHORIZED", message: "Merchant authentication required." },
    { status: 401 },
  );
}

/**
 * Require a valid merchant session for an API route handler. Returns the
 * merchant id if authenticated, otherwise a 401 NextResponse (which the caller
 * must return).
 *
 * State-changing routes should also pass `requireCsrf=true` so a custom header
 * must be present, defending against cross-site request forgery even though the
 * session cookie is SameSite=Strict.
 */
export function requireMerchantAuth(
  request: Request | NextRequest,
  opts: { requireCsrf?: boolean } = {},
): { merchantId: string } | NextResponse {
  const merchantId = getSessionMerchantFromRequest(request);
  if (!merchantId) return unauthorizedJson();

  if (opts.requireCsrf) {
    const csrfHeader = request.headers.get("x-merchant-csrf");
    if (!csrfHeader || csrfHeader !== "1") {
      return NextResponse.json(
        {
          error: "CSRF_VALIDATION_FAILED",
          message: "Missing or invalid CSRF protection header.",
        },
        { status: 403 },
      );
    }
  }

  return { merchantId };
}

/**
 * Require a valid merchant session in a Server Component or Layout. Redirects
 * to the login page when unauthenticated. Must be awaited since `cookies()` is
 * async in App Router.
 */
export async function requirePageAuth(): Promise<string> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const merchantId = verifySessionToken(token);
  if (!merchantId) {
    redirect("/login");
  }
  return merchantId;
}
