// Minimal Chrome DevTools Protocol client built on Node's global WebSocket.
// Used to drive headless Chrome for deterministic frame capture.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export async function launchChrome({ width, height, port = 9333 }) {
  const profile = mkdtempSync(join(tmpdir(), "mg-brag-"));
  const proc = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--force-color-profile=srgb",
      "--font-render-hinting=none",
      "--disable-lcd-text",
      "--disable-background-timer-throttling",
      "--force-device-scale-factor=1",
      "--allow-insecure-localhost",
      "about:blank",
    ],
    { stdio: "ignore", detached: false },
  );

  let target = null;
  for (let i = 0; i < 120; i++) {
    await sleep(150);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      target = list.find((t) => t.type === "page");
      if (target?.webSocketDebuggerUrl) break;
    } catch {
      /* not up yet */
    }
  }
  if (!target)
    throw new Error("Chrome did not expose a debuggable page target");
  return { proc, port, targetUrl: target.webSocketDebuggerUrl };
}

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.sessionId = null;
    this.events = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error)
          reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method) {
        const key = msg.sessionId
          ? `${msg.sessionId}:${msg.method}`
          : msg.method;
        const handlers = this.events.get(key) || [];
        for (const h of handlers) h(msg.params);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}, sessionId = this.sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 120000);
    });
  }

  on(method, handler) {
    const key = this.sessionId ? `${this.sessionId}:${method}` : method;
    this.events.set(key, [...(this.events.get(key) || []), handler]);
  }

  close() {
    this.ws.close();
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function evaluate(cdp, expression) {
  const res = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error(
      `evaluate failed: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`,
    );
  }
  return res.result?.value;
}

export async function waitFor(
  cdp,
  expression,
  { timeout = 30000, poll = 200 } = {},
) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const ok = await evaluate(
      cdp,
      `(() => { try { return !!(${expression}); } catch { return false; } })()`,
    );
    if (ok) return true;
    await sleep(poll);
  }
  throw new Error(`waitFor timed out: ${expression}`);
}

export async function clipShot(cdp, box, path, { padding = 0 } = {}) {
  const x = Math.max(0, Math.round((box.x ?? 0) - padding));
  const y = Math.max(0, Math.round((box.y ?? 0) - padding));
  const width = Math.max(
    1,
    Math.min(19200, Math.round((box.w ?? 0) + padding * 2)),
  );
  const height = Math.max(
    1,
    Math.min(19200, Math.round((box.h ?? 0) + padding * 2)),
  );
  if (!Number.isFinite(x) || !Number.isFinite(y) || !width || !height) {
    throw new Error(`clipShot: bad box ${JSON.stringify(box)}`);
  }
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { x, y, width, height, scale: 1 },
    captureBeyondViewport: true,
  });
  writeFileSync(path, Buffer.from(data, "base64"));
  return { x, y, width, height, path };
}

export async function screenshot(cdp, path, { quality } = {}) {
  const params = {
    format: "png",
    captureBeyondViewport: false,
    optimizeForSpeed: false,
  };
  if (quality) {
    params.format = "jpeg";
    params.quality = quality;
  }
  const { data } = await cdp.send("Page.captureScreenshot", params);
  writeFileSync(path, Buffer.from(data, "base64"));
  return path;
}

export async function screenshotElement(
  cdp,
  selector,
  path,
  { padding = 0 } = {},
) {
  const box = await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height };
    })()`,
  );
  if (!box) throw new Error(`selector not found: ${selector}`);
  const clip = {
    x: Math.max(0, box.x - padding),
    y: Math.max(0, box.y - padding),
    width: box.w + padding * 2,
    height: box.h + padding * 2,
    scale: 1,
  };
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip,
    captureBeyondViewport: true,
  });
  writeFileSync(path, Buffer.from(data, "base64"));
  return { ...box, path };
}
