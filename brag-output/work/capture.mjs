// Capture the real MerchantGate UI with headless Chrome.
import { readFileSync } from "node:fs";
import {
  CDP,
  evaluate,
  launchChrome,
  screenshot,
  screenshotElement,
  sleep,
  waitFor,
} from "./cdp.mjs";

const BASE = "http://localhost:3000";
const OUT = new URL("./shots/", import.meta.url).pathname;
const W = 1920;
const H = 1080;

function envValue(key) {
  const line = readFileSync("/Users/RIDER/Projects/merchantgate/.env", "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : "";
}

const FREEZE = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
  .animate-pulse, .animate-spin { animation: none !important; }
`;

const { proc, targetUrl } = await launchChrome({
  width: W,
  height: H,
  port: 9333,
});
const cdp = await CDP.connect(targetUrl);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Network.enable");
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: W,
  height: H,
  deviceScaleFactor: 1,
  mobile: false,
});

async function goto(path, { settle = 1600 } = {}) {
  await cdp.send("Page.navigate", { url: `${BASE}${path}` });
  await waitFor(cdp, "document.readyState === 'complete'");
  await sleep(settle);
  await evaluate(
    cdp,
    `(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(FREEZE)}; document.head.appendChild(s); return 1; })()`,
  );
  await sleep(250);
}

async function scrollTo(sel) {
  await evaluate(
    cdp,
    `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.scrollIntoView({block:'start'}); return 1; })()`,
  );
  await sleep(500);
}

try {
  // ---- login -----------------------------------------------------------
  await goto("/", { settle: 900 });
  const pw = envValue("MERCHANT_ADMIN_PASSWORD");
  const ok = await evaluate(
    cdp,
    `fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:${JSON.stringify(pw)}})}).then(r=>r.status)`,
  );
  console.log("login status", ok);

  // ---- 1. landing page hero --------------------------------------------
  await goto("/", { settle: 1800 });
  await screenshot(cdp, `${OUT}01-landing-hero.png`);
  await scrollTo("main section:nth-of-type(2)");
  await screenshot(cdp, `${OUT}02-landing-how.png`);
  await scrollTo("main section:nth-of-type(4)");
  await screenshot(cdp, `${OUT}03-landing-protocol.png`);

  // ---- 2. dashboard overview ------------------------------------------
  await goto("/dashboard", { settle: 3200 });
  await screenshot(cdp, `${OUT}04-dashboard-top.png`);
  await scrollTo('[class*="grid-cols-3"]');
  await screenshot(cdp, `${OUT}05-dashboard-policy.png`);

  // element crops for use inside the video composition
  try {
    await scrollTo("main, body");
    const cards = await evaluate(
      cdp,
      `(() => {
        const all = [...document.querySelectorAll('div')];
        const m = all.find(d => d.className && typeof d.className === 'string' && d.className.includes('grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4'));
        return m ? (m.getAttribute('class') ? '.' + m.className.split(' ').slice(0,3).join('.') : null) : null;
      })()`,
    );
    if (cards) await screenshotElement(cdp, cards, `${OUT}crop-kpi-row.png`);
  } catch (e) {
    console.log("kpi crop skipped:", e.message);
  }

  // ---- 3. products -----------------------------------------------------
  await goto("/dashboard/products", { settle: 3000 });
  await screenshot(cdp, `${OUT}06-products.png`);

  // ---- 4. requests -----------------------------------------------------
  await goto("/dashboard/requests", { settle: 3000 });
  await screenshot(cdp, `${OUT}07-requests.png`);

  // ---- 5. policies -----------------------------------------------------
  await goto("/dashboard/policies", { settle: 3000 });
  await screenshot(cdp, `${OUT}08-policies.png`);

  // ---- 6. audit --------------------------------------------------------
  await goto("/dashboard/audit", { settle: 3000 });
  await screenshot(cdp, `${OUT}09-audit.png`);

  // ---- 7. webhook inspector -------------------------------------------
  await goto("/dashboard/webhook-inspector", { settle: 3000 });
  await screenshot(cdp, `${OUT}10-webhooks.png`);

  // ---- 8. analytics ----------------------------------------------------
  await goto("/dashboard/analytics", { settle: 3500 });
  await screenshot(cdp, `${OUT}11-analytics.png`);

  // ---- 9. sandbox: run a real scenario so the UI holds a real result ---
  await goto("/dashboard/sandbox", { settle: 3000 });
  await screenshot(cdp, `${OUT}12-sandbox-empty.png`);

  const ran = await evaluate(
    cdp,
    `fetch('/api/simulation/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scenarioId:'happyPath'})})
      .then(r=>r.json()).then(d=>d.traceId).catch(e=>'ERR:'+e.message)`,
  );
  console.log("sandbox warm-up run trace", ran);
  await goto("/dashboard/sandbox", { settle: 3000 });
  await screenshot(cdp, `${OUT}13-sandbox.png`);

  // ---- 10. simulate a real chat purchase in the sandbox ---------------
  // The chat planner needs an LLM; instead click the preset scenario tab and
  // run "Happy Path" from the UI so the result panel fills with live data.
  const clicked = await evaluate(
    cdp,
    `(() => {
      const t = [...document.querySelectorAll('button')].find(b => /preset|scenario/i.test(b.textContent||''));
      if (t) { t.click(); return t.textContent.trim(); }
      return null;
    })()`,
  );
  console.log("preset tab:", clicked);
  await sleep(600);
  await screenshot(cdp, `${OUT}14-sandbox-presets.png`);

  const runBtn = await evaluate(
    cdp,
    `(() => {
      const b = [...document.querySelectorAll('button')].find(x => /run scenario|run happy|happy path/i.test(x.textContent||''));
      if (b) { b.click(); return b.textContent.trim(); }
      return null;
    })()`,
  );
  console.log("run button:", runBtn);
  await sleep(7000);
  await screenshot(cdp, `${OUT}15-sandbox-result.png`);

  console.log("done");
} catch (err) {
  console.error("CAPTURE ERROR:", err);
  process.exitCode = 1;
} finally {
  cdp.close();
  proc.kill();
}
