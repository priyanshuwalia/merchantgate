import { EventEmitter } from "events";

export interface WebhookInspectionLog {
  id: string;
  timestamp: string;
  provider: string;
  providerEventId: string;
  eventType: string;
  rawBody: string;
  receivedSignature: string;
  computedHmac: string;
  signatureMatch: boolean;
  dedupeCheck: "NEW_EVENT" | "DUPLICATE_SKIPPED";
  action: string;
  status: "PROCESSED" | "REJECTED_SIGNATURE" | "SKIPPED_DUPLICATE" | "ERROR";
  metadata?: Record<string, unknown>;
}

class WebhookInspectorStore {
  private logs: WebhookInspectionLog[] = [];
  private emitter = new EventEmitter();
  private maxLogs = 100;

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  addLog(
    log: Omit<WebhookInspectionLog, "id" | "timestamp">,
  ): WebhookInspectionLog {
    const fullLog: WebhookInspectionLog = {
      id: `wlog_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      ...log,
    };

    this.logs.unshift(fullLog);
    if (this.logs.length > this.maxLogs) {
      this.logs.pop();
    }

    this.emitter.emit("new_log", fullLog);
    return fullLog;
  }

  getLogs(limit = 50): WebhookInspectionLog[] {
    return this.logs.slice(0, limit);
  }

  clearLogs(): void {
    this.logs = [];
  }

  subscribe(callback: (log: WebhookInspectionLog) => void): () => void {
    this.emitter.on("new_log", callback);
    return () => {
      this.emitter.off("new_log", callback);
    };
  }
}

// Global singleton for Next.js hot-reloading
const globalForInspector = globalThis as unknown as {
  webhookInspectorStore?: WebhookInspectorStore;
};

export const webhookInspectorStore =
  globalForInspector.webhookInspectorStore || new WebhookInspectorStore();

if (process.env.NODE_ENV !== "production") {
  globalForInspector.webhookInspectorStore = webhookInspectorStore;
}
