// Render the time-driven composition to PNG frames, with layout diagnostics.
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { CDP, evaluate, launchChrome, screenshot, sleep } from "./cdp.mjs";

const W = 1920,
  H = 1080;
const framesDir = new URL("./frames/", import.meta.url).pathname;
const only = process.argv[2];
const keep = process.argv.includes("--keep");
const skipDiag = process.argv.includes("--no-diag");

if (!keep) rmSync(framesDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });

const { proc, targetUrl } = await launchChrome({
  width: W,
  height: H,
  port: 9335,
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
await cdp.send("Page.navigate", {
  url: `file://${new URL("./brag.html", import.meta.url).pathname}`,
});
await sleep(500);
await evaluate(cdp, "document.fonts.ready.then(()=>1)");
await evaluate(
  cdp,
  `Promise.all([...document.images].map(i => i.complete ? 1 : new Promise(r => { i.onload = i.onerror = r; }))).then(()=>1)`,
);
await sleep(400);

if (!skipDiag) {
  const diag = await evaluate(
    cdp,
    `(() => {
      const frame = document.getElementById('frame');
      const out = [];
      const report = (t) => {
        MG.render(t);
        // neutralise our own entrance/exit transforms so only real layout
        // overflow is reported
        const stashed = [];
        for (const el of frame.querySelectorAll('*')) {
          if (el.style.transform) { stashed.push([el, el.style.transform]); el.style.transform = 'none'; }
        }
        const bad = [];
        for (const el of frame.querySelectorAll('*')) {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue;
          if (r.left < -1 || r.top < -1 || r.right > 1921 || r.bottom > 1081) {
            bad.push({
              tag: el.tagName + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ').slice(0, 2).join('.') : ''),
              box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
              text: (el.textContent || '').trim().slice(0, 36),
            });
          }
        }
        for (const [el, tr] of stashed) el.style.transform = tr;
        return bad.length ? { t, bad } : null;
      };
      for (let i = 0; i <= 600; i++) { const r = report(i / 30); if (r) out.push(r); }
      return out;
    })()`,
  );
  if (!diag || diag.length === 0)
    console.log("LAYOUT: clean across 601 sampled frames");
  else {
    const seen = new Set();
    console.log(`LAYOUT: overflow at ${diag.length}/601 sampled frames`);
    for (const d of diag)
      for (const b of d.bad) {
        const k = `${b.tag}|${b.box.join(",")}`;
        if (seen.has(k)) continue;
        seen.add(k);
        console.log(
          `  t=${d.t.toFixed(2)} ${b.tag} [${b.box.join(", ")}] "${b.text}"`,
        );
      }
  }
}

const list = only
  ? only.split(",").map(Number)
  : Array.from({ length: 600 }, (_, i) => i);
console.log(`rendering ${list.length} frames`);
const t0 = Date.now();
for (const i of list) {
  await evaluate(cdp, `MG.render(${i / 30}); 1`);
  await screenshot(cdp, `${framesDir}f${String(i).padStart(4, "0")}.jpg`, {
    quality: 95,
  });
  if (i % 120 === 0)
    console.log(
      `  ${i} (t=${(i / 30).toFixed(1)}s) ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
}
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// The delivered poster doubles as video frame 0, so a platform thumbnail and
// the first frame of playback show the same settled-quote hero.
const poster = new URL("./poster.jpg", import.meta.url).pathname;
if (existsSync(poster)) {
  copyFileSync(poster, `${framesDir}f0000.jpg`);
  console.log("frame 0 <- poster.jpg");
}
cdp.close();
proc.kill();
process.exit(0);
