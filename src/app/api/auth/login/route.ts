import crypto from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { rateLimitRequest } from "@/lib/auth/rate-limit";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const MERCHANT_ID = "mch_nimbus_gear_001";

function getAdminPassword(): string {
  const pw = process.env.MERCHANT_ADMIN_PASSWORD;
  if (!pw || pw.length < 8) return "";
  return pw;
}

/**
 * POST /api/auth/login
 * Verify the merchant admin password and issue a signed, HttpOnly, SameSite=Strict
 * session cookie. A generic error is returned on any failure to avoid user-
 * enumeration / oracle leaks. Password comparison is timing-safe.
 */
export async function POST(request: NextRequest) {
  // Throttle password attempts per IP to frustrate brute-force / credential
  // stuffing before the timing-safe comparison even runs.
  const limited = rateLimitRequest(request, {
    namespace: "auth-login",
    limit: Number(process.env.RATE_LIMIT_LOGIN) || 10,
    windowSeconds: 60 * 15,
  });
  if (limited) return limited;

  try {
    const body = await request.json().catch(() => ({}));
    const password = typeof body.password === "string" ? body.password : "";

    const expected = getAdminPassword();
    if (!expected) {
      return NextResponse.json(
        {
          error: "AUTH_UNAVAILABLE",
          message: "Authentication is not configured on the server.",
        },
        { status: 500 },
      );
    }

    const expectedBuf = Buffer.from(expected, "utf8");
    const providedBuf = Buffer.from(password, "utf8");
    const passwordOk =
      providedBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(providedBuf, expectedBuf);

    if (!passwordOk) {
      return NextResponse.json(
        { error: "INVALID_CREDENTIALS", message: "Invalid credentials." },
        { status: 401 },
      );
    }

    const { token, maxAge } = createSessionToken(MERCHANT_ID);
    const isProd = process.env.NODE_ENV === "production";
    const response = NextResponse.json({ success: true });
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: isProd,
      sameSite: "strict",
      path: "/",
      maxAge,
    });
    return response;
  } catch (error) {
    console.error("Login error:", error);
    return NextResponse.json(
      { error: "LOGIN_ERROR", message: "Login failed." },
      { status: 500 },
    );
  }
}
