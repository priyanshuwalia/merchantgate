import type { NextRequest } from "next/server";
import { getSessionMerchantFromRequest } from "@/lib/auth/guard";
import { webhookInspectorStore } from "@/lib/webhooks/inspector-store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const merchantId = getSessionMerchantFromRequest(request);
  if (!merchantId) {
    return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Send initial snapshot
      const initialLogs = webhookInspectorStore.getLogs(20);
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: "init", logs: initialLogs })}\n\n`,
        ),
      );

      // Subscribe to real-time events
      const unsubscribe = webhookInspectorStore.subscribe((log) => {
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "new_log", log })}\n\n`,
            ),
          );
        } catch (_err) {
          unsubscribe();
        }
      });

      // Keepalive heartbeat every 15s
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          clearInterval(heartbeat);
          unsubscribe();
        }
      }, 15000);

      request.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
