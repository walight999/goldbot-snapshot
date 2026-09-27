// Hourly job: capture the layouts due this hour, then hand them to GoldBot (Apps Script),
// which stores them in Drive and pushes them to LINE as ONE push.
//
// Schedule (Asia/Bangkok, same as GoldBot's old masterSnapshotTrigger):
//   every hour Mon-Fri → stoch;  00/04/08/12/16/20 → stoch + YLG_TRF + YLG_v2
// GoldBot de-duplicates per hour, so a second trigger in the same hour sends nothing.
//
// Env: TV_SESSION_ID, TV_SESSION_ID_SIGN  (TradingView cookies)
//      GOLDBOT_URL                         (Apps Script web app /exec URL)
//      SNAPSHOT_TOKEN                      (shared secret, = Script Property SNAPSHOT_TOKEN)
//      FORCE=1                             (ignore weekend + send all 3 layouts — manual test)
//      DRY_RUN=1                           (capture only, don't send)
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { captureAll, LAYOUTS } from './capture.mjs';

const TZ = 'Asia/Bangkok';
const INDICATOR_HOURS = [0, 4, 8, 12, 16, 20];

export function bangkokNow(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(date).map(p => [p.type, p.value]));
  const hour = Number(parts.hour);
  return {
    hour,
    weekend: parts.weekday === 'Sat' || parts.weekday === 'Sun',
    hourKey: `${parts.year}${parts.month}${parts.day}-${parts.hour}`,   // = GoldBot's "yyyyMMdd-HH"
  };
}

// kind: 'stoch' | 'ind' — GoldBot tracks the two separately (LAST_STOCH_HOUR / LAST_IND_HOUR)
export function layoutsDue(hour, force) {
  return LAYOUTS
    .map(l => ({ ...l, kind: l.label === 'stoch' ? 'stoch' : 'ind' }))
    .filter(l => force || l.kind === 'stoch' || INDICATOR_HOURS.includes(hour));
}

async function main() {
  const force = process.env.FORCE === '1';
  const now = bangkokNow();
  if (now.weekend && !force) { console.log(`[${now.hourKey}] weekend (Bangkok) — skip`); return; }

  const due = layoutsDue(now.hour, force);
  console.log(`[${now.hourKey}] capturing: ${due.map(l => l.label).join(', ')}`);
  const results = await captureAll(due);
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label} ${(r.ms / 1000).toFixed(1)}s ${r.error || ''}`);

  const images = results.filter(r => r.ok).map(r => ({
    label: r.label, kind: r.kind, png: fs.readFileSync(r.file).toString('base64'),
  }));
  const errors = results.filter(r => !r.ok).map(r => `${r.label}: ${r.error}`);

  if (process.env.DRY_RUN === '1') { console.log('DRY_RUN — not sending'); }
  else {
    const url = process.env.GOLDBOT_URL, token = process.env.SNAPSHOT_TOKEN;
    if (!url || !token) throw new Error('GOLDBOT_URL / SNAPSHOT_TOKEN not set');
    // Apps Script answers POST with a 302 to the result page; fetch follows it (as GET) by default
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'goldbot_snapshot', token, hourKey: now.hourKey, images, errors }),
    });
    const text = await res.text();
    console.log(`GoldBot → HTTP ${res.status}: ${text.slice(0, 300)}`);
    if (!res.ok || !text.startsWith('OK')) throw new Error('GoldBot did not accept the upload');
  }
  // capture errors were reported to GoldBot (→ LINE alert); still fail the run so it shows red
  if (errors.length) { console.error('capture errors:\n  ' + errors.join('\n  ')); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
