// The screenshot half of bin/ui-evidence. Run by that script, never directly: it passes
// everything through the environment (UIE_*), already validated.
//
// For every route x width x theme it signs in through the repository's own login module,
// opens the route, plays the route's actions (open a panel, a popover), and saves a PNG
// plus what a reviewer should not have to measure by eye: horizontal overflow, browser
// console errors, and whether the focused element is one a user can interact with.
//
// The repository supplies Playwright (UIE_PLAYWRIGHT_DIR, its existing install) and a
// login module (UIE_LOGIN_MODULE) exporting:
//   export async function signIn(page, { baseUrl, persona }) { ... }   // required
// Optional exports: `personas` (an object naming them), `async function settle(page)`
// (waits for the app to finish rendering), and `async function assertSignedIn(page)`
// (throws when the page is a sign-in screen; checked before every shot), and
// `async function setTheme(page, theme)` for an app whose theme is not (only) the
// browser's prefers-color-scheme, which is always emulated.
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const env = (k, d) => process.env[k] ?? d;
const out = env("UIE_OUT");
const baseUrl = env("UIE_BASE_URL").replace(/\/$/, "");
const widths = env("UIE_WIDTHS", "1280,375").split(",").map(Number);
const themes = env("UIE_THEMES", "light,dark").split(",");
const apiPattern = env("UIE_API_PATTERN", "**/api/**");
const routes = JSON.parse(await readFile(env("UIE_ROUTES"), "utf8"));
const meta = JSON.parse(env("UIE_META", "{}"));

let chromium, login; // loaded inside the run's try, so a bad install still writes a manifest

const heightFor = (w) => (w < 600 ? 812 : 900);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function settle(page) {
  if (typeof login.settle === "function") return login.settle(page);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(300);
}

async function act(page, a) {
  if (a.click) await page.locator(a.click).first().click();
  else if (a.fill) await page.locator(a.fill[0]).first().fill(a.fill[1]);
  else if (a.press) await page.keyboard.press(a.press);
  else if (a.hover) await page.locator(a.hover).first().hover();
  else if (a.wait) await page.locator(a.wait).first().waitFor({ state: "visible", timeout: 10_000 });
  else if (a.sleep) await page.waitForTimeout(Number(a.sleep));
  else throw new Error(`unknown action ${JSON.stringify(a)}`);
}

// What the eye misses at a glance and a reviewer should be told outright.
async function probe(page) {
  return page.evaluate(() => {
    const se = document.scrollingElement || document.documentElement;
    const a = document.activeElement;
    const interactive = (el) =>
      !!el && (el.matches("a[href],button,input,select,textarea,summary,[contenteditable=true]") ||
        ["button", "link", "menuitem", "tab", "checkbox", "radio", "switch", "option", "combobox", "textbox", "slider"].includes(el.getAttribute("role") || ""));
    const focus = a && a !== document.body
      ? { tag: a.tagName.toLowerCase(), role: a.getAttribute("role") || "", text: (a.textContent || "").trim().slice(0, 60), interactive: interactive(a),
          focus_visible: (() => { try { return a.matches(":focus-visible"); } catch { return false; } })() }
      : null;
    return { horizontal_overflow: se.scrollWidth > window.innerWidth + 1, scroll_width: se.scrollWidth, viewport_width: window.innerWidth, focus };
  });
}

const shots = [];
const failures = [];
// Two route names that reduce to one file name would overwrite each other's PNG.
const used = new Set();
const fileFor = (name, width, theme) => {
  let base = `${slug(name) || "route"}-${width}-${theme}`, f = `${base}.png`, n = 2;
  while (used.has(f)) f = `${base}-${n++}.png`;
  used.add(f);
  return f;
};
const fileNames = new Map(); // route index -> width|theme -> file
routes.forEach((r, i) => {
  const m = new Map();
  for (const w of widths) for (const t of themes) m.set(`${w}|${t}`, fileFor(r.name, w, t));
  fileNames.set(r, m);
});
async function writeManifest() {
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "manifest.json"), JSON.stringify({ schema: "UI_EVIDENCE_MANIFEST", ...meta, base_url: baseUrl, widths, themes, shots, failures }, null, 2) + "\n");
}
let browser;
try {
({ chromium } = createRequire(join(env("UIE_PLAYWRIGHT_DIR"), "package.json"))("playwright"));
login = await import(pathToFileURL(env("UIE_LOGIN_MODULE")).href);
if (typeof login.signIn !== "function") throw new Error(`${env("UIE_LOGIN_MODULE")} exports no signIn(page, { baseUrl, persona })`);
browser = await chromium.launch();
// One context and one page per persona, signed in once. Width and theme change on that
// page (setViewportSize, emulateMedia) rather than in fresh contexts: a session the app
// keeps in sessionStorage, or in memory, does not survive a copied storage state, and a
// "signed in" context that is not would photograph the sign-in screen for every shot.
const byPersona = new Map();
for (const r of routes) {
  const p = r.as || "default";
  if (!byPersona.has(p)) byPersona.set(p, []);
  byPersona.get(p).push(r);
}
try {
  for (const [persona, list] of byPersona) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
    page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));
    try {
      await login.signIn(page, { baseUrl, persona });
    } catch (e) {
      for (const r of list) failures.push({ name: r.name, path: r.path, persona, error: `sign-in failed: ${String(e).slice(0, 300)}` });
      await ctx.close();
      continue;
    }
    for (const r of list) {
      for (const width of widths) {
        for (const theme of themes) {
          const file = fileNames.get(r).get(`${width}|${theme}`);
          const state = r.state || "populated";
          errors.length = 0;
          await page.setViewportSize({ width, height: heightFor(width) });
          await page.emulateMedia({ colorScheme: theme });
          if (typeof login.setTheme === "function") await login.setTheme(page, theme);
          // loading: the data requests never answer; error: they fail. Both simulated at
          // the network so the page's own loading and error rendering is photographed.
          // A route's own "api" narrows it to the page's data requests, so the app shell's
          // own bootstrap requests still answer and the page, not the shell, is what loads.
          const pattern = r.api || apiPattern;
          let intercepted = 0;
          if (state === "loading") await page.route(pattern, () => { intercepted++; });
          if (state === "error") await page.route(pattern, (route) => { intercepted++; return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"simulated by ui-evidence"}' }); });
          try {
            await page.goto(`${baseUrl}${r.path}`, { waitUntil: state === "loading" ? "domcontentloaded" : "load" });
            if (state === "loading") await page.waitForTimeout(800); else await settle(page);
            // Never photograph a sign-in screen as if it were the page.
            if (typeof login.assertSignedIn === "function") await login.assertSignedIn(page);
            for (const a of r.actions || []) await act(page, a);
            if ((r.actions || []).length) await page.waitForTimeout(250);
            // A loading or error shot whose glob caught nothing (after its actions, which
            // may be what starts the request) is the populated page under the wrong name.
            if ((state === "loading" || state === "error") && intercepted === 0) {
              throw new Error(`state ${state}: no request matched ${pattern}, so the page was not put in that state; set the route's "api" glob to its data requests`);
            }
            await page.screenshot({ path: join(out, file), fullPage: r.fullPage !== false });
            shots.push({ name: r.name, path: r.path, state, persona, width, theme, file, actions: r.actions || [], ...((state === "loading" || state === "error") ? { api: pattern, intercepted } : {}), console_errors: [...new Set(errors)], ...(await probe(page)) });
          } catch (e) {
            failures.push({ name: r.name, path: r.path, persona, width, theme, error: String(e).slice(0, 300) });
          }
          if (state === "loading" || state === "error") await page.unroute(pattern);
        }
      }
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
} catch (e) {
  // Whatever broke (the browser, the login module), the manifest says so: a run never
  // ends with no manifest and a raw stack trace.
  failures.push({ name: "(run)", path: "", error: `fatal: ${String(e).slice(0, 300)}` });
}
await writeManifest();
console.log(JSON.stringify({ schema: "UI_EVIDENCE_RESULT", ...meta, dir: out, shots: shots.length, failures: failures.length }));
process.exit(failures.length ? 1 : 0);
