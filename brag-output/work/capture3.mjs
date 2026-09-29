// Third pass: native-resolution crops of the console's most legible regions.
import { readFileSync } from "node:fs";
import {
  CDP,
  clipShot,
  evaluate,
  launchChrome,
  sleep,
  waitFor,
} from "./cdp.mjs";

const BASE = "http://localhost:3000";
const OUT = new URL("./shots/", import.meta.url).pathname;
const FREEZE = `*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important}.animate-pulse,.animate-spin{animation:none!important}`;

const { proc, targetUrl } = await launchChrome({
  width: 1920,
  height: 1080,
  port: 9337,
});
const cdp = await CDP.connect(targetUrl);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: 1920,
  height: 1080,
  deviceScaleFactor: 1,
  mobile: false,
});
await cdp.send("Page.navigate", { url: `${BASE}/` });
await waitFor(cdp, "document.readyState === 'complete'");
await sleep(1200);
const pw = readFileSync("/Users/RIDER/Projects/merchantgate/.env", "utf8")
  .split("\n")
  .find((l) => l.startsWith("MERCHANT_ADMIN_PASSWORD="))
  .split("=")
  .slice(1)
  .join("=")
  .trim();
await evaluate(
  cdp,
  `fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:${JSON.stringify(pw)}})}).then(r=>r.status)`,
);

await cdp.send("Page.navigate", { url: `${BASE}/dashboard` });
await waitFor(cdp, "document.readyState === 'complete'");
await sleep(4000);
await evaluate(
  cdp,
  `(()=>{const s=document.createElement('style');s.textContent=${JSON.stringify(FREEZE)};document.head.appendChild(s);return 1})()`,
);
await sleep(400);

const boxes = await evaluate(
  cdp,
  `(() => {
    const rect = (el) => { if(!el) return null; const r = el.getBoundingClientRect(); return {x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height}; };
    const barSpan = [...document.querySelectorAll('span')].find(s => (s.textContent||'').trim() === 'Live Agent Commerce Gateway');
    const barRoot = barSpan ? barSpan.closest('div.rounded-xl') : null;
    const cardByText = (txt) => {
      const hit = [...document.querySelectorAll('h3,div,span')].find(e => (e.textContent||'').trim() === txt);
      return hit ? (hit.closest('div.rounded-xl') || hit) : null;
    };
    const policy = cardByText('Policy Engine Verifications');
    const kpi = [...document.querySelectorAll('div')].find(d => typeof d.className === 'string' && d.className.includes('md:grid-cols-2 lg:grid-cols-4'));
    window.scrollTo(0, 0);
    const b = rect(barRoot), p = rect(policy), k = rect(kpi);
    return { bar: b, policy: p, kpi: k, console: b && p ? { x: b.x, y: b.y, w: b.w, h: (p.y + p.h) - b.y } : null };
  })()`,
);
console.log(JSON.stringify(boxes, null, 1));

if (boxes.console) await clipShot(cdp, boxes.console, `${OUT}c-console.png`);
if (boxes.bar) await clipShot(cdp, boxes.bar, `${OUT}c-controlbar.png`);
if (boxes.kpi) await clipShot(cdp, boxes.kpi, `${OUT}c-kpi.png`);

cdp.close();
proc.kill();
process.exit(0);
