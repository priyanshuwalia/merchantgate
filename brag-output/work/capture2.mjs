// Second capture pass: tightly-cropped real UI tiles for the video composition.
import { readFileSync, writeFileSync } from "node:fs";
import {
  CDP,
  clipShot,
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

const FREEZE = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important}.animate-pulse,.animate-spin{animation:none!important}`;

const { proc, targetUrl } = await launchChrome({
  width: W,
  height: H,
  port: 9334,
});
const cdp = await CDP.connect(targetUrl);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: W,
  height: H,
  deviceScaleFactor: 1,
  mobile: false,
});

async function goto(path, settle = 2600) {
  await cdp.send("Page.navigate", { url: `${BASE}${path}` });
  await waitFor(cdp, "document.readyState === 'complete'");
  await sleep(settle);
  await evaluate(
    cdp,
    `(()=>{const s=document.createElement('style');s.textContent=${JSON.stringify(FREEZE)};document.head.appendChild(s);return 1})()`,
  );
  await sleep(300);
}

const TAG = `
window.__tag = function(sel){
  const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
  return el;
};
// find a card root that contains the given text
window.__cardByText = function(txt){
  const all = [...document.querySelectorAll('h3,div,span')];
  const hit = all.find(e => (e.textContent||'').trim() === txt);
  if (!hit) return null;
  return hit.closest('div.rounded-xl') || hit.closest('div[class*="rounded-xl"]') || hit;
};
window.__measure = function(el){
  if(!el) return null;
  el.scrollIntoView({block:'center'});
  const r = el.getBoundingClientRect();
  return {x:r.x+window.scrollX,y:r.y+window.scrollY,w:r.width,h:r.height};
};
`;

try {
  await goto("/", 1500);
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
  await evaluate(
    cdp,
    `(()=>{const s=document.createElement('script');s.textContent=${JSON.stringify(TAG)};document.head.appendChild(s);return 1})()`,
  );

  // ---------------- landing hero (element crop) -------------------------
  await goto("/", 2000);
  const heroSel = await evaluate(
    cdp,
    `(()=>{const h=document.querySelector('h1'); return h? 'h1':null})()`,
  );
  if (heroSel) {
    const box = await evaluate(
      cdp,
      `(()=>{const s=document.querySelector('main section'); if(!s) return null; s.scrollIntoView({block:'start'}); const r=s.getBoundingClientRect(); return {x:r.x+window.scrollX,y:r.y+window.scrollY,w:r.width,h:r.height}})()`,
    );
    if (box) await screenshotElement(cdp, "main section", `${OUT}c-hero.png`);
  }
  await screenshotElement(cdp, "header", `${OUT}c-nav.png`).catch(() => {});
  await screenshotElement(
    cdp,
    "main section:nth-of-type(4)",
    `${OUT}c-protocol.png`,
  ).catch(() => {});

  // ---------------- dashboard tiles -------------------------------------
  await goto("/dashboard", 3600);
  await evaluate(
    cdp,
    `(()=>{const s=document.createElement('script');s.textContent=${JSON.stringify(TAG)};document.head.appendChild(s);return 1})()`,
  );

  const kpiInfo = await evaluate(
    cdp,
    `(()=>{
    const g=[...document.querySelectorAll('div')].find(d=>typeof d.className==='string' && d.className.includes('md:grid-cols-2 lg:grid-cols-4'));
    if(!g) return null; g.scrollIntoView({block:'center'});
    const r=g.getBoundingClientRect(); return {x:r.x+scrollX,y:r.y+scrollY,w:r.width,h:r.height};
  })()`,
  );
  if (kpiInfo) {
    await clipShot(cdp, kpiInfo, `${OUT}c-kpi.png`);
    console.log("kpi", kpiInfo);
  }

  await evaluate(
    cdp,
    `(()=>{const b=window.__cardByText('Policy Engine Verifications'); if(b) b.scrollIntoView({block:'center'}); return 1})()`,
  );
  await sleep(400);
  const polOk = await evaluate(
    cdp,
    `(()=>{const b=window.__cardByText('Policy Engine Verifications'); return b? 'ok':'no'})()`,
  );
  console.log("policy card:", polOk);
  if (polOk === "ok") {
    const r = await evaluate(
      cdp,
      `(()=>{const b=window.__cardByText('Policy Engine Verifications'); const r=b.getBoundingClientRect(); return {x:r.x+scrollX,y:r.y+scrollY,w:r.width,h:r.height}})()`,
    );
    await clipShot(cdp, r, `${OUT}c-policy.png`);
    console.log("policy box", r);
  }

  await evaluate(
    cdp,
    `(()=>{const b=window.__cardByText('Append-Only Audit Trail'); if(b) b.scrollIntoView({block:'center'}); return 1})()`,
  );
  await sleep(400);
  const audOk = await evaluate(
    cdp,
    `(()=>{const b=window.__cardByText('Append-Only Audit Trail'); return b? 'ok':'no'})()`,
  );
  console.log("audit card:", audOk);
  if (audOk === "ok") {
    const r = await evaluate(
      cdp,
      `(()=>{const b=window.__cardByText('Append-Only Audit Trail'); const r=b.getBoundingClientRect(); return {x:r.x+scrollX,y:r.y+scrollY,w:r.width,h:r.height}})()`,
    );
    await clipShot(cdp, r, `${OUT}c-audit.png`);
    console.log("audit box", r);
  }

  // control bar (AI Sales + Surge toggles)
  const barOk = await evaluate(
    cdp,
    `(()=>{const e=[...document.querySelectorAll('div')].find(d=>d.className&&typeof d.className==='string'&&d.className.includes('Live Agent Commerce Gateway')); if(!e) return null; const p=e.parentElement; p.scrollIntoView({block:'center'}); const r=p.getBoundingClientRect(); return {x:r.x+scrollX,y:r.y+scrollY,w:r.width,h:r.height}})()`,
  );
  if (barOk) {
    await clipShot(cdp, barOk, `${OUT}c-controlbar.png`);
    console.log("controlbar", barOk);
  }

  // full dashboard viewport (hero-ish shot)
  await evaluate(cdp, `window.scrollTo(0,0); 1`);
  await sleep(400);
  await screenshot(cdp, `${OUT}c-dash-top.png`);

  // sidebar
  const sideOk = await evaluate(
    cdp,
    `(()=>{const e=document.querySelector('aside')||document.querySelector('nav[class*="w-6"]')||document.querySelector('[class*="fixed"][class*="w-64"]'); if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.x+scrollX,y:r.y+scrollY,w:r.width,h:r.height}})()`,
  );
  console.log("sidebar", sideOk);
  if (sideOk) {
    await clipShot(cdp, sideOk, `${OUT}c-sidebar.png`);
  }

  // ---------------- products / catalog ----------------------------------
  await goto("/dashboard/products", 3000);
  const prod = await evaluate(
    cdp,
    `(()=>{const t=[...document.querySelectorAll('h3,td,span,div,p')].filter(e=>e.children.length===0 && /Nimbus|Keyboard/i.test(e.textContent||''))[0]; if(!t) return null; const row=t.closest('tr')||t.closest('div.rounded-xl')||t.closest('div[class*="rounded-lg"]')||t.parentElement; if(!row) return null; row.scrollIntoView({block:'center'}); const r=row.getBoundingClientRect(); return {x:r.x+scrollX,y:r.y+scrollY,w:r.width,h:r.height}})()`,
  );
  console.log("product row", prod);
  if (prod) {
    await clipShot(cdp, prod, `${OUT}c-product.png`);
  }
  await evaluate(cdp, `window.scrollTo(0,0);1`);
  await sleep(300);
  await screenshot(cdp, `${OUT}c-products-page.png`);

  // ---------------- webhook inspector -----------------------------------
  await goto("/dashboard/webhook-inspector", 3200);
  await screenshot(cdp, `${OUT}c-webhooks.png`);

  // ---------------- policies --------------------------------------------
  await goto("/dashboard/policies", 3000);
  await screenshot(cdp, `${OUT}c-policies.png`);

  console.log("done");
} catch (e) {
  console.error("ERR", e);
  process.exitCode = 1;
} finally {
  cdp.close();
  proc.kill();
}
