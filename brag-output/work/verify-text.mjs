// Assert the rendered DOM text at specific frames (no image inspection needed).
import { CDP, evaluate, launchChrome, sleep } from "./cdp.mjs";

const W = 1920,
  H = 1080;
const { proc, targetUrl } = await launchChrome({
  width: W,
  height: H,
  port: 9339,
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
await sleep(300);

let fail = 0;
const check = async (label, t, sel, want) => {
  const got = await evaluate(
    cdp,
    `(() => { MG.render(${t}); const el = document.querySelector(${JSON.stringify(sel)}); return el ? el.textContent : null; })()`,
  );
  const ok =
    typeof got === "string" &&
    got.includes(want) &&
    !got.includes("Nimbus Gate");
  if (!ok) fail++;
  console.log(
    `${ok ? "ok  " : "FAIL"} t=${t}s ${label} ${JSON.stringify(sel)} -> ${JSON.stringify(got)}`,
  );
};

await check("scene 1 chat header", 1.0, ".t2", "Nimbus Gear & Electronics");
await check(
  "scene 3 quote panel",
  9.0,
  "#s3 .sub",
  "Nimbus Gear & Electronics",
);
await check("scene 1 injection", 2.0, "#s1-type", "SYSTEM OVERRIDE");
await check("scene 1 deny", 3.0, "#s1-stamp", "DENY");
await check("scene 3 total", 11.0, "#s3-total", "4,128.82");
await check(
  "scene 3 trace",
  11.0,
  "#s3-foot",
  "trace_01m3pw8f82s9tvnywgn2ehsehc",
);
await check("scene 4 limits", 14.0, "#s4-deny", "1,53,398.82");
await check("scene 5 gmv", 19.0, "#s5-stats", "7,35,412.21");
await check("wordmark", 19.5, "#s5-end .word", "Gate");

// sweep every frame for the stale string
const stale = await evaluate(
  cdp,
  `(() => {
    const hits = [];
    const targets = ['.t2', '#s3 .sub', '#s1-type', '#s1-stamp', '#s3-total', '#s4-deny', '#s5-stats', '#s5-end .word'];
    for (let i = 0; i <= 600; i++) {
      MG.render(i / 30);
      for (const sel of targets) {
        const el = document.querySelector(sel);
        if (el && /Nimbus Gate|placeholder|lorem|TODO/i.test(el.textContent)) hits.push({ t: +(i/30).toFixed(2), sel });
      }
    }
    return hits;
  })()`,
);
if (stale.length) {
  fail++;
  console.log(
    `FAIL stale/placeholder text in ${stale.length} places, e.g.`,
    stale.slice(0, 5),
  );
} else
  console.log("ok   no 'Nimbus Gate' / placeholder text across all 601 frames");

console.log(
  fail === 0 ? "\nALL DOM ASSERTIONS PASSED" : `\n${fail} ASSERTION(S) FAILED`,
);
cdp.close();
proc.kill();
process.exit(fail === 0 ? 0 : 1);
