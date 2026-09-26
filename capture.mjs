// Capture TradingView layouts as PNG using the owner's TV session (free replacement for chart-img).
// Usage: node capture.mjs [layoutId ...]   (defaults to the 3 GoldBot layouts)
// Env:   TV_SESSION_ID, TV_SESSION_ID_SIGN (optional: without them TV loads as a guest)
//        BROWSER_CHANNEL=msedge|chrome to use an installed browser instead of Playwright's Chromium
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

// Minimal .env loader (no dependency)
if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// Same layouts/options as GoldBot_ALL_IN_ONE.gs (chart-img calls)
export const LAYOUTS = [
  { id: 'FmF4WHeh', label: 'stoch' },                   // multi-chart, layout's own interval
  { id: '7PPIaw7q', label: 'YLG_TRF', interval: '60' }, // chart-img: interval 1h, moveLeft 50
  { id: 'gdi7WRyn', label: 'YLG_v2',  interval: '60' },
];

const WIDTH = 1920, HEIGHT = 1080;
const OUT_DIR = process.env.OUT_DIR || 'out';

export async function captureAll(layouts, { outDir = OUT_DIR } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.BROWSER_CHANNEL || undefined,
  });
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    locale: 'en-US',
    timezoneId: 'Asia/Bangkok',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  });
  const sid = process.env.TV_SESSION_ID, sign = process.env.TV_SESSION_ID_SIGN;
  if (sid && sign) {
    const base = { domain: '.tradingview.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' };
    await context.addCookies([
      { name: 'sessionid', value: sid, ...base },
      { name: 'sessionid_sign', value: sign, ...base },
    ]);
  }

  const results = [];
  try {
    for (const L of layouts) {
      const page = await context.newPage();
      const t0 = Date.now();
      const url = `https://www.tradingview.com/chart/${L.id}/` + (L.interval ? `?interval=${L.interval}` : '');
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        // chart canvas present = chart engine booted
        await page.waitForSelector('.chart-container canvas', { timeout: 45_000 });
        // let series + indicators finish loading (TV keeps websockets open, so no networkidle)
        await page.waitForTimeout(8_000);
        await page.keyboard.press('Escape');   // dismiss any popup/dialog
        await page.waitForTimeout(500);

        const loggedIn = await page.evaluate(() => {
          // guests: window.is_authenticated === false, window.user.username === "Guest"
          return window.is_authenticated === true;
        });
        // Crop to the chart area (drop top toolbar, side drawing bar, right widget panel)
        const area = page.locator('.layout__area--center').first();
        const file = path.join(outDir, `${L.label}.png`);
        if (await area.count()) await area.screenshot({ path: file });
        else await page.screenshot({ path: file });
        results.push({ ...L, ok: true, file, loggedIn, ms: Date.now() - t0 });
      } catch (e) {
        const file = path.join(outDir, `${L.label}.ERROR.png`);
        await page.screenshot({ path: file }).catch(() => {});
        results.push({ ...L, ok: false, error: String(e).split('\n')[0], file, ms: Date.now() - t0 });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  return results;
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const ids = process.argv.slice(2);
  const layouts = ids.length ? LAYOUTS.filter(l => ids.includes(l.id) || ids.includes(l.label)) : LAYOUTS;
  const res = await captureAll(layouts);
  console.table(res.map(r => ({ label: r.label, ok: r.ok, loggedIn: r.loggedIn, sec: (r.ms / 1000).toFixed(1), file: r.file, error: r.error || '' })));
  if (res.some(r => !r.ok)) process.exitCode = 1;
}
