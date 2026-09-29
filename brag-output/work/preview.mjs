// ASCII luminance preview of settled frames — lets composition be checked for
// balance/collisions without eyeballing images.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { CDP, evaluate, launchChrome, screenshot, sleep } from "./cdp.mjs";

const W = 160,
  H = 54;
const TIMES = process.argv[2]
  ? process.argv[2].split(",").map(Number)
  : [2.95, 5.9, 11.9, 15.9, 19.4];
const tmp = new URL("./frames/", import.meta.url).pathname;
mkdirSync(tmp, { recursive: true });

const RAMP = " .:-=+*#%@";
const { proc, targetUrl } = await launchChrome({
  width: 1920,
  height: 1080,
  port: 9338,
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

for (const t of TIMES) {
  const p = `${tmp}prev-${String(Math.round(t * 100)).padStart(4, "0")}.png`;
  await evaluate(cdp, `MG.render(${t}); 1`);
  await screenshot(cdp, p, { quality: 92 });
  const raw = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      p,
      "-vf",
      `scale=${W}:${H}:flags=area,format=gray`,
      "-f",
      "rawvideo",
      "-",
    ],
    {
      maxBuffer: 1 << 24,
    },
  );
  console.log(`\n=== t=${t.toFixed(2)}s  (luma preview, dark=@) ===`);
  for (let y = 0; y < H; y++) {
    let line = "";
    for (let x = 0; x < W; x++) {
      const v = raw[y * W + x] / 255; // 0 black .. 1 white
      const idx = Math.min(
        RAMP.length - 1,
        Math.max(0, Math.round((1 - v) * (RAMP.length - 1))),
      );
      line += RAMP[idx];
    }
    console.log(line);
  }
}
cdp.close();
proc.kill();
process.exit(0);
