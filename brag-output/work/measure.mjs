// Report geometry + ink density for key elements at settled times, and an
// ASCII luminance preview of a frame (so composition can be sanity-checked
// without eyeballing).
import { CDP, evaluate, launchChrome, sleep } from "./cdp.mjs";

const W = 1920,
  H = 1080;
const { proc, targetUrl } = await launchChrome({
  width: W,
  height: H,
  port: 9336,
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
await sleep(400);
await evaluate(cdp, "document.fonts.ready.then(()=>1)");
await evaluate(
  cdp,
  `Promise.all([...document.images].map(i => i.complete ? 1 : new Promise(r => { i.onload = i.onerror = r; }))).then(()=>1)`,
);
await sleep(200);

const TIMES = process.argv[2]
  ? process.argv[2].split(",").map(Number)
  : [2.9, 5.6, 10.9, 15.6, 19.4];
const out = await evaluate(
  cdp,
  `(() => {
    const IDS = ["s1","s2","s3","s4","s5","s1-chat","s1-caption","s1-reply","s2-browser","s2-h1","s2-h1b","s2-h1c","s2-h2","s2-tags","s3-term","s3-sticker","s3-freeze","s3-clock","s4-shot","s4-deny","s4-controls","s4-cap","s5-punch","s5-end","s5-console","s5-l1","s5-l2","s5-stats","s3-foot","urlpill","brandmark"];
    const res = {};
    for (const t of [${TIMES.join(",")}]) {
      MG.render(t);
      const rows = [];
      for (const id of IDS) {
        const el = document.getElementById(id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        if (getComputedStyle(el).display === 'none') continue;
        rows.push({ id, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bot: Math.round(r.bottom), right: Math.round(r.right) });
      }
      res[t] = rows;
    }
    return res;
  })()`,
);

for (const t of TIMES) {
  console.log(`\n=== t=${t.toFixed(2)}s ===`);
  for (const r of out[t] || []) {
    const flag =
      r.x < 0 || r.y < 0 || r.right > 1920 || r.bot > 1080 ? "  <-- OUT" : "";
    console.log(
      `  ${r.id.padEnd(12)} x${String(r.x).padStart(5)} y${String(r.y).padStart(5)}  ${String(r.w).padStart(5)}x${String(r.h).padStart(5)}  bottom=${String(r.bot).padStart(5)} right=${String(r.right).padStart(5)}${flag}`,
    );
  }
}

cdp.close();
proc.kill();
process.exit(0);
