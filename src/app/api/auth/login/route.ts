import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { merchants } from "@/db/schema";
import { verifyPassword } from "@/lib/auth/password";
import { rateLimitRequest } from "@/lib/auth/rate-limit";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import { DEFAULT_MERCHANT_ID as MERCHANT_ID } from "@/lib/merchant/tenant";

export const dynamic = "force-dynamic";

function getAdminPassword(): string {
  const pw = process.env.MERCHANT_ADMIN_PASSWORD;
  if (!pw || pw.length < 8) return "";
  return pw;
}

/**
 * POST /api/auth/login
 * Authenticate a merchant and issue a signed session cookie.
 *
 * Two authentication paths:
 * 1. Email + password: looks up the merchant by email and verifies the password hash.
 * 2. Password-only fallback (demo): if no email is provided, falls back to the
 *    MERCHANT_ADMIN_PASSWORD env var for backward compatibility.
 */
export async function POST(request: NextRequest) {
  const limited = rateLimitRequest(request, {
    namespace: "auth-login",
    limit: Number(process.env.RATE_LIMIT_LOGIN) || 10,
    windowSeconds: 60 * 15,
  });
  if (limited) return limited;

  try {
    const body = await request.json().catch(() => ({}));
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (email) {
      const rows = await db
        .select({
          id: merchants.id,
          password_hash: merchants.password_hash,
        })
        .from(merchants)
        .where(eq(merchants.email, email))
        .limit(1);

      const merchant = rows[0];

      if (!merchant || !merchant.password_hash) {
        return NextResponse.json(
          { error: "INVALID_CREDENTIALS", message: "Invalid credentials." },
          { status: 401 },
        );
      }

      const passwordOk = await verifyPassword(password, merchant.password_hash);
      if (!passwordOk) {
        return NextResponse.json(
          { error: "INVALID_CREDENTIALS", message: "Invalid credentials." },
          { status: 401 },
        );
      }

      const { token, maxAge } = createSessionToken(merchant.id);
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
    }

    const expected = getAdminPassword();
    if (!expected) {
      return NextResponse.json(
        {
          error: "AUTH_UNAVAILABLE",
          message:
            "Authentication is not configured on the server. Please provide an email to log in.",
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
