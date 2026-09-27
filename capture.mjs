// Capture TradingView layouts as PNG using the owner's TV session (free replacement for chart-img).
// Usage: node capture.mjs [layoutId|label ...]   (defaults to the 3 GoldBot layouts)
// Env:   TV_SESSION_ID, TV_SESSION_ID_SIGN (required: private layouts + private indicators)
//        BROWSER_CHANNEL=msedge|chrome to use an installed browser instead of Playwright's Chromium
//        OUT_DIR (default ./out)
//
// Read-only by design: every write request to TradingView (e.g. /savesettings/ fired by the
// theme switch) is aborted, so the owner's account settings and layouts never change.
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
  // rightMargin = share of the plot width left empty on the right (chart-img's "moveLeft"):
  // the indicators' labels + tables live there. barSpacing 11.6px = TV default candle width
  // (White: bigger candles, same margin as before → last candle sits ~45% across)
  { id: '7PPIaw7q', label: 'YLG_TRF', interval: '60', rightMargin: 0.55, barSpacing: 11.6 },
  { id: 'gdi7WRyn', label: 'YLG_v2',  interval: '60', rightMargin: 0.55, barSpacing: 11.6 },
];

const WIDTH = 1920, HEIGHT = 1080;
const THEME = 'light';                // White's pick: white background (chart-img used dark)
const PANE_OVERRIDES = {               // no grid lines, on every chart of the layout
  'paneProperties.gridLinesMode': 'none',
  'paneProperties.vertGridProperties.color': 'rgba(0,0,0,0)',
  'paneProperties.horzGridProperties.color': 'rgba(0,0,0,0)',
};
const STUDY_TIMEOUT_MS = 60_000;      // Golden Zone Radar alone takes ~12s to compute
const SETTLE_MS = 1_500;              // repaint after the last study finishes
const BLOCK_HOSTS = /doubleclick\.net|google-analytics\.com|analytics\.google\.com|googletagmanager\.com|google\.com\/(g|ccm)\/collect|snowplow/;

function requireSession() {
  const sid = process.env.TV_SESSION_ID, sign = process.env.TV_SESSION_ID_SIGN;
  if (!sid || !sign) throw new Error('TV_SESSION_ID / TV_SESSION_ID_SIGN not set (see .env.example)');
  return { sid, sign };
}

// Resolves once the chart API is up, every chart's main series has data, and the number of
// studies attached has stopped changing for STABLE_POLLS polls (studies attach ~1-3s after
// the canvas appears — checking isLoading() before that sees an empty list and passes too early).
const STABLE_POLLS = 4;   // × 500ms
async function waitForChartReady(page) {
  const deadline = Date.now() + STUDY_TIMEOUT_MS;
  let prev = -1, stable = 0, last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const api = window.TradingViewApi;
      if (!api || typeof api.chartsCount !== 'function' || api.chartsCount() === 0) return { ok: false, why: 'api' };
      let studies = 0;
      for (let i = 0; i < api.chartsCount(); i++) {
        const ch = api.chart(i);
        if (typeof ch.dataReady === 'function' && !ch.dataReady()) return { ok: false, why: 'series data' };
        studies += ch.getAllStudies().length;
      }
      return { ok: true, studies };
    });
    if (last.ok) {
      stable = last.studies === prev ? stable + 1 : 0;
      prev = last.studies;
      if (stable >= STABLE_POLLS) return last.studies;
    }
    await page.waitForTimeout(500);
  }
  throw new Error('chart not ready after ' + STUDY_TIMEOUT_MS / 1000 + 's (' + (last && last.why) + ')');
}

// Resolves when every visible study on every chart of the layout reports isLoading() === false.
// Returns the names of studies that ended in error (rendered with "!" on the chart).
async function waitForStudies(page) {
  const deadline = Date.now() + STUDY_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const api = window.TradingViewApi;
      if (!api || typeof api.chartsCount !== 'function') return { ready: false, why: 'api' };
      const pending = [], errors = [];
      for (let i = 0; i < api.chartsCount(); i++) {
        const ch = api.chart(i);
        for (const s of ch.getAllStudies()) {
          const st = ch.getStudyById(s.id);
          if (!st.isVisible()) continue;
          if (st.hasError()) errors.push(s.name);
          else if (st.isLoading()) pending.push(s.name);
        }
      }
      return { ready: pending.length === 0, pending, errors };
    });
    if (last.ready) return last.errors;
    await page.waitForTimeout(500);
  }
  throw new Error('studies still loading after ' + STUDY_TIMEOUT_MS / 1000 + 's: ' + (last.pending || [last.why]).join(', '));
}

export async function captureAll(layouts, { outDir = process.env.OUT_DIR || 'out' } = {}) {
  const { sid, sign } = requireSession();
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || undefined });
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'Asia/Bangkok',
  });
  const cookie = { domain: '.tradingview.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' };
  await context.addCookies([
    { name: 'sessionid', value: sid, ...cookie },
    { name: 'sessionid_sign', value: sign, ...cookie },
  ]);
  await context.route('**/*', route => {
    const req = route.request(), url = req.url();
    if (BLOCK_HOSTS.test(url)) return route.abort();                                       // ads/analytics: faster load
    // never write to the account: settings/layout saves, telemetry, and any PUT/PATCH/DELETE.
    // (Blocking *all* non-GET breaks chart data loading, so this stays a targeted list.)
    if (req.method() !== 'GET' && /^https:\/\/([a-z0-9-]+\.)*tradingview\.com\//.test(url) &&
        (/^https:\/\/www\.tradingview\.com\/save/.test(url) || /telemetry\.|charts-storage\./.test(url) ||
         ['PUT', 'PATCH', 'DELETE'].includes(req.method()))) return route.abort();
    return route.continue();
  });

  const results = [];
  try {
    for (const L of layouts) {
      const page = await context.newPage();
      const t0 = Date.now();
      const url = `https://www.tradingview.com/chart/${L.id}/` + (L.interval ? `?interval=${L.interval}` : '');
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        // Private layout + dead cookie → TV serves a "Can't open this chart layout" page instead of a chart
        const chart = page.locator('.chart-container canvas').first();
        const denied = page.getByText("Can't open this chart layout");
        await chart.or(denied).first().waitFor({ timeout: 45_000 });
        const loggedIn = await page.evaluate(() => window.is_authenticated === true);
        if (!loggedIn) throw new Error('not logged in — TV session cookie expired or invalid (update TV_SESSION_ID / TV_SESSION_ID_SIGN)');
        if (await denied.isVisible()) throw new Error(`layout ${L.id} not accessible by this account`);

        await waitForChartReady(page);
        const theme = await page.evaluate(async ([theme, overrides]) => {
          const api = window.TradingViewApi;
          const themes = await api.themes();
          // always apply: getCurrentThemeName() can already say "dark" (app chrome) while the
          // layout's own saved chart colours are still light — only setStdTheme repaints the panes
          await themes.setStdTheme(theme);
          // after the theme (setStdTheme resets pane colours); session-only — saves are aborted
          for (let i = 0; i < api.chartsCount(); i++) api.chart(i).applyOverrides(overrides);
          return themes.getCurrentThemeName();
        }, [THEME, PANE_OVERRIDES]);
        if (theme !== THEME) throw new Error(`theme switch failed (still ${theme})`);
        await page.addStyleTag({ content: '.tv-floating-toolbar{display:none!important}' });
        await page.keyboard.press('Escape');      // dismiss any popup/dialog

        if (L.rightMargin) {
          await page.evaluate(([margin, spacing]) => {
            const api = window.TradingViewApi;
            // plot width = chart area minus the right price axis
            const area = document.querySelector('.layout__area--center');
            const axis = document.querySelector('.price-axis');
            const plotW = area.clientWidth - (axis ? axis.clientWidth : 70);
            for (let i = 0; i < api.chartsCount(); i++) {
              const ch = api.chart(i), ts = ch.getTimeScale();
              ts.setBarSpacing(spacing);
              ts.setRightOffset(Math.round(margin * plotW / spacing));
              // re-fit prices to the bars now on screen (otherwise candles clip at the top)
              for (const pane of ch.getPanes()) {
                const ps = pane.getMainSourcePriceScale && pane.getMainSourcePriceScale();
                if (ps && ps.setAutoScale) ps.setAutoScale(true);
              }
            }
          }, [L.rightMargin, L.barSpacing]);
        }
        const studyErrors = await waitForStudies(page);
        await page.waitForTimeout(SETTLE_MS);

        const file = path.join(outDir, `${L.label}.png`);
        await page.locator('.layout__area--center').first().screenshot({ path: file });
        results.push({ ...L, ok: true, file, studyErrors, ms: Date.now() - t0 });
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
  console.table(res.map(r => ({
    label: r.label, ok: r.ok, sec: (r.ms / 1000).toFixed(1), file: r.file,
    note: r.error || (r.studyErrors.length ? 'study error: ' + r.studyErrors.join(', ') : ''),
  })));
  if (res.some(r => !r.ok)) process.exitCode = 1;
}
