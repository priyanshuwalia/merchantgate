import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.execute(sql`SELECT 1`);
    return NextResponse.json({
      status: "ready",
      db: "up",
      time: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: "not_ready",
        db: "down",
        error: error instanceof Error ? error.message : "Unknown error",
        time: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
