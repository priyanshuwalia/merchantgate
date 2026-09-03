import type { NextRequest } from "next/server";
import { GET as getCatalog } from "@/app/v1/agent/catalog/route";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return getCatalog(request);
}
