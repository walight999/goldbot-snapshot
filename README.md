# goldbot-snapshot

Hourly TradingView chart screenshots for GoldBot (LINE), captured with Playwright on
GitHub Actions. Free replacement for chart-img.

- `capture.mjs`: opens each layout logged in with the owner's TradingView session cookies,
  white theme, no grid, extra right margin on the YLG layouts, waits until every
  indicator has finished loading, screenshots the chart area. Read-only: TradingView
  settings/layout saves are blocked, so the account is never modified.
- `run.mjs`: picks what's due this hour (Asia/Bangkok, Mon-Fri; every hour → `stoch`,
  00/04/08/12/16/20 → `stoch` + `YLG_TRF` + `YLG_v2`), captures, POSTs the PNGs to
  GoldBot's Apps Script web app. GoldBot stores them in Drive and sends them in one LINE
  push, and it ignores a second upload in the same hour.

## Secrets (Settings → Secrets and variables → Actions)

| Secret | Value |
|---|---|
| `TV_SESSION_ID` / `TV_SESSION_ID_SIGN` | TradingView cookies `sessionid` / `sessionid_sign` |
| `GOLDBOT_URL` | GoldBot Apps Script web app URL (`…/exec`) |
| `SNAPSHOT_TOKEN` | shared secret, same value as GoldBot Script Property `SNAPSHOT_TOKEN` |

When the TradingView cookie expires, GoldBot sends a LINE alert to the 1:1 chat. Copy
new cookie values into the two `TV_SESSION_*` secrets.

## Trigger

cron-job.org calls `POST https://api.github.com/repos/walight999/goldbot-snapshot/actions/workflows/snapshot.yml/dispatches`
with body `{"ref":"main"}` at minute 1 of every hour. The workflow's own `schedule` is
only a backup, because GitHub often runs it late.

## GoldBot switch (LINE commands)

`run snapshadow` sends GitHub images to the 1:1 chat only (for comparison). `run snaplive`
sends GitHub images to the group and turns chart-img off. `run snapchartimg` goes back to
chart-img. `run snapsource` shows the current source.

## Local run

```
cp .env.example .env    # fill in the TV cookies
BROWSER_CHANNEL=msedge node capture.mjs    # images in out/
DRY_RUN=1 FORCE=1 node run.mjs             # full job without sending
```
