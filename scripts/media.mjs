#!/usr/bin/env node
// Regenerates the README logo, screenshots and GIFs from the browser preview,
// which runs on generated demo data (no real files are shown).
//
//   npm run dev                     # in another terminal
//   npm run media [-- name …]       # all, or e.g. `npm run media -- scan cleanup`
//
// Needs Google Chrome and ffmpeg (brew install ffmpeg). Drives headless Chrome
// over the DevTools protocol directly, so no npm packages are required.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "docs/media");
const APP = process.env.APP_URL ?? "http://localhost:1420/?shot";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const W = 1240;
const H = 800;
const GIF_WIDTH = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

// ------------------------------------------------------------------ CDP ----

class CDP {
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, fail) => {
      ws.onopen = ok;
      ws.onerror = fail;
    });
    return new CDP(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p?.resolve(msg.result);
      } else {
        for (const h of this.handlers.get(msg.method) ?? []) h(msg.params, msg.sessionId);
      }
    };
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  on(method, fn) {
    const list = this.handlers.get(method) ?? [];
    list.push(fn);
    this.handlers.set(method, list);
    return () => list.splice(list.indexOf(fn), 1);
  }
}

const CURSOR_SVG =
  '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M4 2.6v16.6l4.4-4.2 2.9 6.6 2.8-1.2-2.8-6.5h6.2z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';

class Page {
  constructor(cdp, session) {
    this.cdp = cdp;
    this.session = session;
    this.mouse = { x: W * 0.62, y: H * 0.55 };
  }

  send(method, params) {
    return this.cdp.send(method, params, this.session);
  }

  waitFor(event) {
    return new Promise((resolve) => {
      const off = this.cdp.on(event, (p, s) => {
        if (s === this.session) {
          off();
          resolve(p);
        }
      });
    });
  }

  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${expression}: ${r.exceptionDetails.exception?.description}`);
    return r.result.value;
  }

  async navigate(url) {
    const loaded = this.waitFor("Page.loadEventFired");
    await this.send("Page.navigate", { url });
    await loaded;
    await sleep(400);
  }

  /** The demo app in a fresh state. */
  async open({ dark = true, dpr = 1, lang = "en" } = {}) {
    await this.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: dpr, mobile: false });
    await this.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }],
    });
    await this.navigate(APP);
    await this.eval(`localStorage.setItem("storagelyzer.lang", ${JSON.stringify(lang)})`);
    await this.navigate(APP);
    await this.eval(`(() => {
      const c = document.createElement("div");
      c.className = "shot-cursor";
      c.innerHTML = ${JSON.stringify(CURSOR_SVG)};
      c.style.transform = "translate(${this.mouse.x}px, ${this.mouse.y}px)";
      document.body.appendChild(c);
      const move = (e) => (c.style.transform = "translate(" + e.clientX + "px," + e.clientY + "px)");
      addEventListener("mousemove", move, true);
      addEventListener("mousedown", () => c.classList.add("is-down"), true);
      addEventListener("mouseup", () => c.classList.remove("is-down"), true);
    })()`);
    await this.cursor(false);
  }

  cursor(visible) {
    return this.eval(`document.querySelector(".shot-cursor").style.visibility = "${visible ? "visible" : "hidden"}"`);
  }

  /** Center of the first element matching `selector` (and containing `text`). */
  async center(selector, text = "") {
    const p = await this.eval(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((e) => e.textContent.includes(${JSON.stringify(text)}));
      if (!el) return null;
      el.scrollIntoView({ block: "nearest" });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!p) throw new Error(`not found: ${selector} ${text}`);
    return p;
  }

  async waitUntil(expression, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await this.eval(expression)) return;
      await sleep(100);
    }
    throw new Error(`timeout: ${expression}`);
  }

  /** Moves the pointer along an eased path (the page sees every step). */
  async moveTo(x, y, ms = 550) {
    const from = { ...this.mouse };
    const steps = Math.max(1, Math.round(ms / 16));
    for (let i = 1; i <= steps; i++) {
      const t = ease(i / steps);
      this.mouse = { x: from.x + (x - from.x) * t, y: from.y + (y - from.y) * t };
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: this.mouse.x, y: this.mouse.y });
      if (ms > 0) await sleep(16);
    }
  }

  async click(p, ms = 550) {
    await this.moveTo(p.x, p.y, ms);
    await sleep(120);
    const base = { x: p.x, y: p.y, button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
    await sleep(90);
    await this.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
  }

  async key(key, code = key, keyCode = 0) {
    for (const type of ["keyDown", "keyUp"]) {
      await this.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode });
    }
  }

  async wheel(p, deltaY) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: p.x, y: p.y, deltaX: 0, deltaY });
  }

  async screenshot() {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    return Buffer.from(data, "base64");
  }

  /** Records what `scenario` does into docs/media/<name>.gif. */
  async record(name, scenario) {
    const dir = mkdtempSync(join(tmpdir(), `storagelyzer-${name}-`));
    const frames = [];
    const off = this.cdp.on("Page.screencastFrame", (p, s) => {
      if (s !== this.session) return;
      const file = join(dir, `f${String(frames.length).padStart(5, "0")}.jpg`);
      writeFileSync(file, Buffer.from(p.data, "base64"));
      frames.push({ file, t: p.metadata.timestamp });
      void this.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
    });
    await this.cursor(true);
    await this.send("Page.startScreencast", { format: "jpeg", quality: 95, maxWidth: W, maxHeight: H });
    await scenario();
    const end = Date.now() / 1000;
    await this.send("Page.stopScreencast");
    off();
    await this.cursor(false);
    if (frames.length === 0) throw new Error(`${name}: no frames captured`);

    let list = "";
    frames.forEach((f, i) => {
      const next = i + 1 < frames.length ? frames[i + 1].t : end;
      list += `file '${f.file}'\nduration ${Math.max(0.001, next - f.t).toFixed(4)}\n`;
    });
    list += `file '${frames.at(-1).file}'\n`;
    writeFileSync(join(dir, "list.txt"), list);
    const out = join(OUT, `${name}.gif`);
    execFileSync("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      join(dir, "list.txt"),
      "-vf",
      `fps=20,scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`,
      "-loop",
      "0",
      out,
    ]);
    rmSync(dir, { recursive: true, force: true });
    console.log(`  ${name}.gif  (${frames.length} frames)`);
  }

  // --------------------------------------------------------- app steps ----

  async scanDisk({ wait = true } = {}) {
    await this.click(await this.center(".location", "Macintosh HD"));
    if (wait) await this.waitUntil(`!!document.querySelector(".statusbar .status-size")`);
  }

  /** Point on the chart: `ring` 1 = innermost ring, `turn` 0…1 clockwise from 12 o'clock. */
  async chartPoint(ring, turn) {
    const g = await this.eval(`(() => {
      const r = document.querySelector(".ring-canvas").getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })()`);
    const R = Math.max(60, Math.min(g.w, g.h) / 2 - 18);
    const r0 = R * 0.25;
    const ringW = (R - r0) / 6;
    const rad = r0 + (ring - 0.5) * ringW;
    const a = turn * Math.PI * 2 - Math.PI / 2;
    return { x: g.x + g.w / 2 + Math.cos(a) * rad, y: g.y + g.h / 2 + Math.sin(a) * rad };
  }

  chartCenter() {
    return this.eval(`(() => {
      const r = document.querySelector(".ring-canvas").getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
  }

  /** Where on `ring` the segment called `name` is (probes the tooltip). */
  async findSegment(ring, name) {
    const hits = [];
    for (let i = 0; i < 180; i++) {
      const turn = i / 180;
      const p = await this.chartPoint(ring, turn);
      await this.moveTo(p.x, p.y, 0);
      // Read it after React has rendered the hover.
      const title = await this.eval(
        `new Promise((r) => requestAnimationFrame(() => r(document.querySelector(".ring-tip.is-visible .tip-title")?.textContent ?? "")))`,
      );
      if (title.trim() === name) hits.push(turn);
    }
    if (!hits.length) throw new Error(`segment not found: ${name}`);
    return this.chartPoint(ring, hits[Math.floor(hits.length / 2)]);
  }
}

// ------------------------------------------------------------- outputs ----

async function framed(page, png, file, { dark }) {
  // The raw capture inside a window frame with a soft shadow, on transparency.
  const dir = mkdtempSync(join(tmpdir(), "storagelyzer-frame-"));
  writeFileSync(join(dir, "shot.png"), png);
  writeFileSync(
    join(dir, "frame.html"),
    `<!doctype html><html><body style="margin:0;background:transparent">
      <div style="margin:56px;width:${W}px;height:${H}px;border-radius:12px;overflow:hidden;
        box-shadow:0 0 0 1px ${dark ? "rgba(255,255,255,.14)" : "rgba(0,0,0,.14)"},0 26px 70px rgba(0,0,0,${dark ? 0.5 : 0.28}),0 6px 18px rgba(0,0,0,.18)">
        <img src="shot.png" style="display:block;width:${W}px;height:${H}px"></div></body></html>`,
  );
  await page.send("Emulation.setDeviceMetricsOverride", { width: W + 112, height: H + 112, deviceScaleFactor: 2, mobile: false });
  await page.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  await page.navigate(`file://${join(dir, "frame.html")}`);
  writeFileSync(join(OUT, file), await page.screenshot());
  await page.send("Emulation.setDefaultBackgroundColorOverride", {});
  rmSync(dir, { recursive: true, force: true });
  console.log(`  ${file}`);
}

async function logo(page) {
  const icon = readFileSync(join(ROOT, "app-icon.svg"), "utf8");
  const html = (color, sub) => `<!doctype html><html><body style="margin:0;background:transparent">
    <div style="display:inline-flex;align-items:center;gap:26px;padding:12px 18px 12px 6px;font-family:system-ui,BlinkMacSystemFont,'SF Pro Display',sans-serif">
      <div style="width:132px;height:132px">${icon.replace("<svg ", '<svg style="width:132px;height:132px" ')}</div>
      <div><div style="font-size:64px;font-weight:700;letter-spacing:-1.6px;color:${color}">Storagelyzer</div>
      <div style="font-size:21px;color:${sub};margin-top:2px">Disk usage analyzer for macOS</div></div></div></body></html>`;
  const dir = mkdtempSync(join(tmpdir(), "storagelyzer-logo-"));
  await page.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  for (const [file, color, sub] of [
    ["logo-light.png", "#1d1d1f", "#6e6e73"],
    ["logo-dark.png", "#f5f5f7", "#a1a1a6"],
  ]) {
    writeFileSync(join(dir, "logo.html"), html(color, sub));
    await page.send("Emulation.setDeviceMetricsOverride", { width: 700, height: 160, deviceScaleFactor: 2, mobile: false });
    await page.navigate(`file://${join(dir, "logo.html")}`);
    const box = await page.eval(`(() => { const r = document.body.firstElementChild.getBoundingClientRect(); return { x: 0, y: 0, width: Math.ceil(r.width), height: Math.ceil(r.height), scale: 2 }; })()`);
    const { data } = await page.send("Page.captureScreenshot", { format: "png", clip: box });
    writeFileSync(join(OUT, file), Buffer.from(data, "base64"));
    console.log(`  ${file}`);
  }
  // The app icon on its own (README header, social preview).
  writeFileSync(join(dir, "icon.html"), `<!doctype html><html><body style="margin:0;background:transparent">${icon.replace("<svg ", '<svg style="display:block;width:256px;height:256px" ')}</body></html>`);
  await page.send("Emulation.setDeviceMetricsOverride", { width: 256, height: 256, deviceScaleFactor: 2, mobile: false });
  await page.navigate(`file://${join(dir, "icon.html")}`);
  writeFileSync(join(OUT, "icon.png"), await page.screenshot());
  console.log("  icon.png");
  await page.send("Emulation.setDefaultBackgroundColorOverride", {});
  rmSync(dir, { recursive: true, force: true });
}

const JOBS = {
  async logo(page) {
    await logo(page);
  },

  async screenshots(page) {
    for (const dark of [true, false]) {
      await page.open({ dark, dpr: 2 });
      await page.scanDisk();
      await sleep(900);
      // Show a tooltip: the user's home folder.
      const home = await page.findSegment(2, "alex");
      await page.moveTo(home.x, home.y, 0);
      await sleep(300);
      await framed(page, await page.screenshot(), `main-${dark ? "dark" : "light"}.png`, { dark });
    }

    await page.open({ dark: true, dpr: 2 });
    await page.scanDisk();
    await page.click(await page.center(".tb-button-label"), 0);
    await page.waitUntil(`!document.querySelector(".cl-analyzing")`);
    await sleep(600);
    await framed(page, await page.screenshot(), "cleanup.png", { dark: true });

    await page.open({ dark: true, dpr: 2 });
    await page.scanDisk();
    await page.click(await page.center(".segmented button", "Size"), 0);
    await sleep(900);
    await page.click(await page.center(".chart-note .link-button"), 0);
    await sleep(900);
    await framed(page, await page.screenshot(), "size-explained.png", { dark: true });

    await page.open({ dark: false, dpr: 2 });
    await sleep(300);
    await framed(page, await page.screenshot(), "start.png", { dark: false });
  },

  async scan(page) {
    await page.open({ dark: true });
    await page.record("scan", async () => {
      await sleep(500);
      await page.scanDisk({ wait: false });
      await page.waitUntil(`!!document.querySelector(".statusbar .status-size")`);
      await sleep(900);
      const p = await page.chartPoint(1, 0.18);
      await page.moveTo(p.x, p.y, 700);
      await sleep(1500);
    });
  },

  async explore(page) {
    await page.open({ dark: true });
    await page.scanDisk();
    await sleep(500);
    const users = await page.findSegment(1, "Users");
    const home = await page.findSegment(2, "alex");
    await page.moveTo(W * 0.3, H * 0.75, 0);
    await sleep(600); // let the probe's tooltip fade out
    await page.record("explore", async () => {
      await sleep(400);
      await page.moveTo(users.x, users.y, 800);
      await sleep(900);
      await page.moveTo(home.x, home.y, 500);
      await sleep(900);
      await page.click(home, 200); // zoom into the home folder
      await sleep(1100);
      const movies = await page.chartPoint(1, 0.2);
      await page.moveTo(movies.x, movies.y, 700);
      await sleep(1100);
      const c = await page.chartCenter();
      await page.click(c, 700); // centre = one level up
      await sleep(1000);
      await page.click(c, 200);
      await sleep(1300);
    });
  },

  async tree(page) {
    await page.open({ dark: true });
    await page.scanDisk();
    await sleep(400);
    await page.moveTo(W * 0.5, H * 0.5, 0);
    await page.record("tree", async () => {
      await sleep(300);
      for (const name of ["Users", "Applications", "Library", "System"]) {
        const p = await page.center(".tree-row", name);
        await page.moveTo(p.x - 120, p.y, 450);
        await sleep(650);
      }
      const users = await page.center(".tree-row", "Users");
      await page.click({ x: users.x - 120, y: users.y }, 400);
      await sleep(300);
      await page.key("Enter", "Enter", 13); // open in the chart
      await sleep(1200);
      await page.key("ArrowDown", "ArrowDown", 40);
      await sleep(500);
      await page.key("ArrowDown", "ArrowDown", 40);
      await sleep(700);
      await page.key("ArrowUp", "ArrowUp", 38);
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowUp", code: "ArrowUp", modifiers: 4, windowsVirtualKeyCode: 38 });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowUp", code: "ArrowUp", modifiers: 4, windowsVirtualKeyCode: 38 });
      await sleep(1400);
    });
  },

  async size(page) {
    await page.open({ dark: true });
    await page.scanDisk();
    await sleep(400);
    await page.moveTo(W * 0.7, H * 0.2, 0);
    await page.record("size", async () => {
      await sleep(500);
      await page.click(await page.center(".segmented button", "Size"), 700);
      await sleep(1600);
      await page.click(await page.center(".chart-note .link-button"), 800);
      await sleep(2800);
    });
  },

  async cleanup(page) {
    await page.open({ dark: true });
    await page.scanDisk();
    await sleep(300);
    await page.moveTo(W * 0.4, H * 0.3, 0);
    await page.record("cleanup", async () => {
      await sleep(400);
      await page.click(await page.center(".tb-button-label"), 700);
      await page.waitUntil(`!document.querySelector(".cl-analyzing")`);
      await sleep(900);
      const body = await page.center(".cleanup-body");
      await page.moveTo(body.x, body.y + 80, 500);
      for (let i = 0; i < 8; i++) {
        await page.wheel(body, 60);
        await sleep(40);
      }
      await sleep(600);
      await page.click(await page.center(".cl-cat[data-flip='apps'] .cl-title"), 600);
      await sleep(1600);
      await page.click(await page.center(".cl-cat[data-flip='apps'] .cl-title"), 300);
      await sleep(500);
      await page.click(await page.center(".cl-cat[data-flip='appData'] .cl-title"), 500);
      await sleep(1300);
      await page.click(await page.center(".cl-entry", "com.microsoft.teams"), 600);
      await sleep(1500);
    });
  },
};

async function main() {
  const wanted = process.argv.slice(2);
  const jobs = wanted.length ? wanted : Object.keys(JOBS);
  try {
    await fetch(APP.replace("?shot", ""));
  } catch {
    console.error(`The preview is not running at ${APP} — start it with: npm run dev`);
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "storagelyzer-chrome-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--lang=en-US",
      "--allow-file-access-from-files",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  try {
    let version;
    for (let i = 0; i < 50 && !version; i++) {
      await sleep(200);
      version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).catch(() => null);
    }
    const cdp = await CDP.connect(version.webSocketDebuggerUrl);
    for (const name of jobs) {
      if (!JOBS[name]) throw new Error(`unknown: ${name} (have: ${Object.keys(JOBS).join(", ")})`);
      console.log(name);
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      const page = new Page(cdp, sessionId);
      await page.send("Page.enable");
      await page.send("Runtime.enable");
      await JOBS[name](page);
      await cdp.send("Target.closeTarget", { targetId });
    }
    cdp.ws.close();
  } finally {
    const exited = new Promise((r) => chrome.once("exit", r));
    chrome.kill();
    await Promise.race([exited, sleep(5000)]);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

await main();
