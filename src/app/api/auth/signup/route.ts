import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { merchants } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { rateLimitRequest } from "@/lib/auth/rate-limit";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

function generateApiKey(): string {
  return `mg_secret_${crypto.randomBytes(24).toString("hex")}`;
}

function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

/**
 * POST /api/auth/signup
 * Create a new merchant account with email + password.
 * Returns a signed session cookie on success.
 */
export async function POST(request: NextRequest) {
  const limited = rateLimitRequest(request, {
    namespace: "auth-signup",
    limit: Number(process.env.RATE_LIMIT_SIGNUP) || 5,
    windowSeconds: 60 * 15,
  });
  if (limited) return limited;

  try {
    const body = await request.json().catch(() => ({}));
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const storeName =
      typeof body.storeName === "string" ? body.storeName.trim() : "";

    // Self-service signup was completely open, so anyone on the internet could
    // mint a merchant tenant. Rate limiting only slows that down; it does not
    // prevent it. `ALLOWED_SIGNUP_EMAILS` turns it into an invite-only list.
    //
    // Unset => open, preserving local dev and any deliberately self-serve
    // deployment. Set => exact (case-insensitive) match against the list. The
    // check runs after the body is parsed so the address is known and is placed
    // before any DB write.
    const allowlistRaw = process.env.ALLOWED_SIGNUP_EMAILS?.trim();
    if (allowlistRaw) {
      const allowed = new Set(
        allowlistRaw
          .split(",")
          .map((e) => e.trim().toLowerCase())
          .filter(Boolean),
      );
      if (!allowed.has(email)) {
        return NextResponse.json(
          {
            error: "SIGNUP_NOT_INVITED",
            message:
              "Signups are invite-only on this deployment. Contact the platform operator for an invitation.",
          },
          { status: 403 },
        );
      }
    }

    if (!email || !email.includes("@") || email.length > 255) {
      return NextResponse.json(
        {
          error: "INVALID_EMAIL",
          message: "Please provide a valid email address.",
        },
        { status: 400 },
      );
    }

    if (password.length < 8 || password.length > 128) {
      return NextResponse.json(
        {
          error: "INVALID_PASSWORD",
          message: "Password must be between 8 and 128 characters.",
        },
        { status: 400 },
      );
    }

    if (!storeName || storeName.length > 200) {
      return NextResponse.json(
        {
          error: "INVALID_STORE_NAME",
          message: "Please provide a store name (max 200 characters).",
        },
        { status: 400 },
      );
    }

    const existing = await db
      .select({ id: merchants.id })
      .from(merchants)
      .where(eq(merchants.email, email))
      .limit(1);

    if (existing.length > 0) {
      return NextResponse.json(
        {
          error: "EMAIL_TAKEN",
          message: "An account with this email already exists.",
        },
        { status: 409 },
      );
    }

    const passwordHash = await hashPassword(password);
    const apiKey = generateApiKey();
    const apiKeyHashVal = hashApiKey(apiKey);
    const webhookSecret = crypto.randomBytes(24).toString("hex");

    const [merchant] = await db
      .insert(merchants)
      .values({
        name: storeName,
        email,
        password_hash: passwordHash,
        api_key_hash: apiKeyHashVal,
        webhook_secret: webhookSecret,
        onboarding_completed: false,
        config: {
          currency: "INR",
          aiSalesEnabled: true,
          autoProcessAgentOrders: false,
          agentRequiresApproval: true,
          maxAgentTransactionAmount: 5000000,
          priceSlippageToleranceBps: 200,
        },
      })
      .returning({ id: merchants.id });

    const merchantId = merchant.id;
    const { token, maxAge } = createSessionToken(merchantId);
    const isProd = process.env.NODE_ENV === "production";

    const response = NextResponse.json({
      success: true,
      merchantId,
      apiKey,
    });

    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: isProd,
      sameSite: "strict",
      path: "/",
      maxAge,
    });

    return response;
  } catch (error) {
    console.error("Signup error:", error);
    return NextResponse.json(
      { error: "SIGNUP_ERROR", message: "Signup failed." },
      { status: 500 },
    );
  }
}
