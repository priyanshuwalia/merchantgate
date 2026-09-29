// Fresh-load state of the film section: geometry, overlay, and no overflow.
import {
  CDP,
  evaluate,
  launchChrome,
  screenshotElement,
  sleep,
} from "./cdp.mjs";

const sizes = [
  { w: 1440, h: 1000, label: "desktop" },
  { w: 768, h: 1000, label: "tablet" },
  { w: 390, h: 900, label: "mobile" },
];

let fail = 0;
for (const { w, h, label } of sizes) {
  const { proc, targetUrl } = await launchChrome({
    width: w,
    height: h,
    port: 9342,
  });
  const cdp = await CDP.connect(targetUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: w,
    height: h,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Page.navigate", { url: "http://localhost:3000/" });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if ((await evaluate(cdp, `document.readyState`)) === "complete") break;
  }
  await sleep(700);

  const m = await evaluate(
    cdp,
    `(() => {
    const v = document.querySelector("video");
    const sec = v.closest("section");
    const btn = sec.querySelector("button");
    const vr = v.getBoundingClientRect();
    const br = btn ? btn.getBoundingClientRect() : null;
    const card = v.parentElement.getBoundingClientRect();
    const doc = document.documentElement;
    return {
      video: { w: Math.round(vr.width), h: Math.round(vr.height), ratio: +(vr.width / vr.height).toFixed(3) },
      card: { w: Math.round(card.width), h: Math.round(card.height) },
      overlay: br ? { w: Math.round(br.width), h: Math.round(br.height) } : null,
      overlayCoversVideo: br ? Math.abs(br.width - vr.width) < 2 && Math.abs(br.height - vr.height) < 2 : false,
      sectionTop: Math.round(sec.getBoundingClientRect().top + window.scrollY),
      heroHasVideo: !!document.querySelector("main > section").querySelector("video"),
      hScroll: doc.scrollWidth > doc.clientWidth ? doc.scrollWidth - doc.clientWidth : 0,
    };
  })()`,
  );

  const ok = (c, l) => {
    if (!c) fail++;
    console.log(`  ${c ? "ok  " : "FAIL"} ${l}`);
  };
  console.log(`\n=== ${label} ${w}x${h} ===`);
  console.log("  " + JSON.stringify(m));
  ok(
    Math.abs(m.video.ratio - 16 / 9) < 0.02,
    `video is 16:9 (got ${m.video.ratio})`,
  );
  ok(m.video.w > 200, `video has width (${m.video.w})`);
  ok(m.overlayCoversVideo, "overlay exactly covers the video");
  ok(!m.heroHasVideo, "hero has no video");
  ok(m.hScroll === 0, `no horizontal overflow (${m.hScroll}px)`);

  if (label === "desktop") {
    await evaluate(
      cdp,
      `document.querySelector("video").closest("section").scrollIntoView({block:"center"}); 1`,
    );
    await sleep(500);
    await screenshotElement(cdp, "video", "/tmp/mg-initial-state.jpg", {
      padding: 0,
    });
  }
  cdp.close();
  proc.kill();
  await sleep(300);
}
console.log(
  fail === 0 ? "\nALL LAYOUT CHECKS PASSED" : `\n${fail} CHECK(S) FAILED`,
);
process.exit(fail === 0 ? 0 : 1);
