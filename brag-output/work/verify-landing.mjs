// Verify the landing page video section: assets serve, the section is present,
// the hero is untouched, and clicking the play overlay actually plays.
import {
  CDP,
  evaluate,
  launchChrome,
  screenshotElement,
  sleep,
} from "./cdp.mjs";

const W = 1440,
  H = 1200;
const { proc, targetUrl } = await launchChrome({
  width: W,
  height: H,
  port: 9341,
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

const statuses = new Map();
cdp.on("Network.responseReceived", (p) =>
  statuses.set(p.response.url, p.response.status),
);

await cdp.send("Page.navigate", { url: "http://localhost:3000/" });
for (let i = 0; i < 60; i++) {
  await sleep(250);
  const ready = await evaluate(cdp, `document.readyState`);
  if (ready === "complete") break;
}
await sleep(800);

let fail = 0;
const ok = (cond, label, extra = "") => {
  if (!cond) fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` ${extra}` : ""}`);
};

// 1. assets are served with sane status + content type
for (const [url, wantType] of [
  ["http://localhost:3000/media/merchantgate-launch.mp4", "video/mp4"],
  ["http://localhost:3000/media/merchantgate-launch.jpg", "image/jpeg"],
  ["http://localhost:3000/media/merchantgate-launch.vtt", null],
]) {
  const r = await fetch(url, { method: "HEAD" });
  ok(
    r.ok,
    `serves ${url.split("/").pop()}`,
    `status=${r.status} type=${r.headers.get("content-type")} len=${r.headers.get("content-length")}`,
  );
  if (wantType)
    ok(
      (r.headers.get("content-type") || "").includes(wantType),
      `  content-type is ${wantType}`,
    );
}

// 2. the section exists, with the video inside it
const info = await evaluate(
  cdp,
  `(() => {
    const v = document.querySelector("video");
    if (!v) return { found: false };
    const sec = v.closest("section");
    const h2 = sec?.querySelector("h2")?.textContent?.trim() ?? null;
    const hero = document.querySelector("main > section");
    return {
      found: true,
      sectionHeading: h2,
      isFirstSection: sec === hero,
      poster: v.getAttribute("poster"),
      preload: v.getAttribute("preload"),
      controls: v.hasAttribute("controls"),
      playsInline: v.hasAttribute("playsInline"),
      autoplay: v.hasAttribute("autoplay"),
      track: v.querySelector("track")?.getAttribute("src") ?? null,
      trackKind: v.querySelector("track")?.getAttribute("kind") ?? null,
      videoInHero: !!hero?.querySelector("video"),
      overlayPresent: !!sec?.querySelector("button"),
      sectionIndex: [...document.querySelectorAll("main > section")].indexOf(sec),
      sectionCount: document.querySelectorAll("main > section").length,
    };
  })()`,
);
console.log("\n" + JSON.stringify(info, null, 2) + "\n");

ok(info.found, "landing page has a <video>");
ok(
  !info.isFirstSection,
  "video section is NOT the hero",
  `sectionIndex=${info.sectionIndex}/${info.sectionCount}`,
);
ok(!info.videoInHero, "hero section contains no video");
ok(info.poster === "/media/merchantgate-launch.jpg", "poster set");
ok(info.preload === "none", "preload=none (2.8MB not fetched eagerly)");
ok(info.controls, "native controls present");
ok(info.playsInline, "playsInline set");
ok(!info.autoplay, "not autoplaying");
ok(info.trackKind === "captions", "captions track present", info.track ?? "");
ok(info.overlayPresent, "play overlay rendered before first play");

// 3. poster actually loads (poster frame is present, not a broken image)
const posterOk = await evaluate(
  cdp,
  `(async () => {
    const v = document.querySelector("video");
    const img = new Image();
    img.src = v.poster;
    try { await img.decode(); return img.naturalWidth === 1920 && img.naturalHeight === 1080; }
    catch { return false; }
  })()`,
);
ok(posterOk, "poster decodes at 1920x1080");

// 4. clicking the overlay plays the video.
// A synthetic .click() is NOT a user gesture, so the autoplay policy rejects
// the unmuted play() — we must dispatch a real trusted input event.
await evaluate(
  cdp,
  `document.querySelector("video").closest("section").scrollIntoView({block:"center"}); 1`,
);
await sleep(500);
const btnBox = await evaluate(
  cdp,
  `(() => {
    const b = document.querySelector("video").closest("section").querySelector("button");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`,
);
ok(
  btnBox !== null,
  "play button located for a real click",
  JSON.stringify(btnBox),
);
for (const type of ["mousePressed", "mouseReleased"]) {
  await cdp.send("Input.dispatchMouseEvent", {
    type,
    x: btnBox.x,
    y: btnBox.y,
    button: "left",
    clickCount: 1,
    buttons: type === "mousePressed" ? 1 : 0,
  });
}
const play = await evaluate(
  cdp,
  `(async () => {
    const v = document.querySelector("video");
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (!v.paused && v.currentTime > 0.1) break;
    }
    return { paused: v.paused, currentTime: v.currentTime, readyState: v.readyState,
             duration: v.duration, videoWidth: v.videoWidth,
             overlayGone: !v.closest("section").querySelector("button") };
  })()`,
);
console.log("play state:", JSON.stringify(play));
ok(
  !play.paused && play.currentTime > 0.1,
  "trusted click on overlay starts playback",
  `t=${play.currentTime?.toFixed(2)}s`,
);
ok(
  play.videoWidth === 1920,
  "video track is 1920 wide",
  `videoWidth=${play.videoWidth}`,
);
ok(
  Math.abs(play.duration - 20) < 0.2,
  "duration ~20s",
  `duration=${play.duration}`,
);
ok(play.overlayGone, "overlay removed once playing");

// 5. mute state — the soundtrack should be audible by default (not silently muted)
const muted = await evaluate(cdp, `document.querySelector("video").muted`);
ok(muted === false, "not muted (soundtrack preserved)");

// screenshots for the record
await evaluate(
  cdp,
  `document.querySelector("video").pause(); document.querySelector("video").currentTime = 0; 1`,
);
await sleep(400);
await screenshotElement(
  cdp,
  "main > section:nth-of-type(3)",
  "/tmp/mg-film-section.jpg",
  { padding: 0 },
);
await evaluate(cdp, `window.scrollTo(0,0); 1`);
await sleep(300);
await screenshotElement(cdp, "header + main > section", "/tmp/mg-hero.jpg", {
  padding: 0,
});
console.log("\nscreenshots: /tmp/mg-film-section.jpg, /tmp/mg-hero.jpg");

const missing = [...statuses.entries()].filter(([, s]) => s >= 400);
if (missing.length) {
  fail++;
  console.log("FAIL 4xx/5xx responses:", missing.slice(0, 8));
} else console.log("ok   no 4xx/5xx responses on the page");

console.log(
  fail === 0 ? "\nALL LANDING-PAGE CHECKS PASSED" : `\n${fail} CHECK(S) FAILED`,
);
cdp.close();
proc.kill();
process.exit(fail === 0 ? 0 : 1);
