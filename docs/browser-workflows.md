# Browser workflows

## Incoming trades

The worker keeps one Playwright context alive for the bot loop.

1. Open `Предложения`.
2. Verify that the active tab is `Предложения`, then read visible numeric
   `/trades/{id}` links from the rendered page and its pagination.
3. Insert unseen IDs into SQLite with `status = новое`. This insert, rather than a
   notification badge, is the incoming-trade signal.
4. Update `last_seen_at` for old visible IDs without reopening their detail pages.
5. Open every due detail URL in the pass. A detail that has not changed is
   cooled down for 24 hours; an ID that disappeared from a complete scan and later
   reappeared bypasses the cooldown but is not emitted as a new discovery.
6. For each processable trade:
   - open it through its visible link when possible;
   - read offered and requested cards;
   - click the requested card;
   - click `Хотят получить`;
   - read the last visible pagination number;
   - classify ranks from card images loaded inside the browser page;
   - apply the existing wanted-pages and rank rules;
   - return to `Предложения` through browser history (`goBack` up to five steps until
     the path is `/trades` and trade links are visible), falling back to the visible
     `Предложения` tab link and only then to a direct navigation.
7. In auto mode, record the attempt, step back to the trade page (direct load only
   when history cannot reach it), click `Принять обмен`, click the confirmation
   dialog, and write `принят` only after the page contains `Обмен принят`. That last
   check reloads the trade page, so a stale restored DOM cannot fake an acceptance.
   Missing confirmation or final status becomes `ошибка_проверки`. Safe mode never
   clicks acceptance.
8. After the last processed trade — and only then — reload the offers index once,
   re-read the visible IDs, and mark the offers that disappeared as stale.
9. Leave the offers index for a background page and spend the pause there.

This mirrors how a person works the tab: open the list once, open a trade, act, press
back, take the next one from the still-stale list, and refresh at the very end so the
finished offers disappear. Within a pass the index is never re-fetched.

SQLite trade rows are the local `seen_ids` state. `discovered_at` is the first local
observation, not a claimed site send time. `last_seen_at`, `last_detail_checked_at`,
`missing_at`, `status`, parsed cards, ranks, and attempt counters provide the change
and retry state.

## Collection locking

Two category-index workflows remain available:

- `all`: walk collection pages until the visible collection count is exhausted.
- `recent`: open the new-first collection index and stop after the configured first
  N physical card instances.

For an unlocked card, the browser opens its card view, clicks `Хотят получить`,
reads pagination, returns to the collection index, and clicks the instance lock
control only when the configured threshold passes. Duplicate card IDs share the
same wanted-pages result during one run.

## Signal-source decisions

- `Предложения` is the canonical exchange index.
- `Уведомления` is intentionally not polled: opening it can consume unread state,
  and it can be empty even while active offers remain.
- `/feed`, `/`, and `/manga` are passive background visits only. They never emit
  trade IDs. Each next interval is randomized by ±25% around 3, 10, and 20 minutes:
  2:15–3:45, 7:30–12:30, and 15:00–25:00 respectively. When several routes are due,
  only one is selected at random during a pass.
- One background page is opened after every pass, not only when a route is due: the
  worker must not sit on `Предложения` between checks. When nothing is due, the route
  with the closest `nextVisitAt` is pulled forward, which makes `/feed` the usual idle
  page and keeps `/manga` rare. Ties are broken at random. The worker remains on that
  page until the next offers check, so it does not follow a fixed background route or
  chain several passive navigations together.
- Idle time on a background page includes randomized scrolling and pointer movement
  and never includes a click, so no link on a passive page is ever followed.
- Sitemap and JSON/API routes are not used for authenticated bot actions, because
  the required workflow is browser-only.
- Direct detail navigation is only a fallback when a visible link is missing after
  a page refresh. Reads and mutations still happen inside Playwright.

## Operational limits

- `MANGABUFF_TRADE_LIST_MAX_PAGES` caps offers pagination.
- `MANGABUFF_TRADE_PAUSE_MIN_MS` and `MANGABUFF_TRADE_PAUSE_MAX_MS` control the
  pause between processed trades; defaults are 10 and 15 seconds.
- `loopPauseMs` controls the minimum pause between offers-index passes and must be
  between 5 and 180 seconds (30 seconds by default). The actual pause is a random
  value between that minimum and twice the minimum, so the default cadence is 30–60
  seconds; `MANGABUFF_OFFERS_PAUSE_JITTER_FRACTION` (default `1`) changes the upper
  bound and the configured minimum is never shortened. A sub-minute cadence is a
  deliberate stealth trade-off: sustained live tests triggered CAPTCHA at both
  5-second and 40-second minimum pauses. Raise `loopPauseMs` to back off.
- A database that still stores the previous default (`120000`) is rewritten to the
  current default once on open, because a stored value always wins over the code
  default. The `loopPauseMsLegacyDefaultMigratedAt` settings row marks the migration
  as done, so a `120000` chosen deliberately afterwards is kept.
- Every due trade detail URL is opened in the same pass. The 10–15 second pause
  between processed trades and the 24-hour unchanged-detail cooldown still apply, and
  `MANGABUFF_TRADE_DETAILS_PER_PASS` can restore a cap (`0`, the default, means none).
- Navigations away from an already open canonical `/trades` index are serialized
  through rolling limits of 20 per minute and 300 per hour
  (`MANGABUFF_NAVIGATIONS_PER_MINUTE`, `MANGABUFF_NAVIGATIONS_PER_HOUR`). The budget
  has to cover one away visit plus one return per pass and roughly four navigations
  per processed trade. Refresh polling of the already open index does not consume this
  away-navigation budget.
- A `429` navigation response pauses all subsequent Mangabuff navigation for the
  server-provided `Retry-After` duration, or 60 seconds when absent. `502`, `503`,
  and `504` use the same header or a 15-second fallback.
- CAPTCHA keeps the visible Chromium window and its existing browser context open.
  The bot does not click the challenge; it checks every two seconds and resumes the
  next pass in the same session after the challenge disappears. Stopping the bot
  cancels this wait normally. Telegram receives one alert when waiting starts and
  one confirmation after the bot resumes; a Telegram delivery error is logged but
  does not close the browser or interrupt the wait.
- Browser-security challenges, rate-limit pages, and access-denied pages still stop
  the bot loop and require manual inspection.
- UI mutations use actionability-checked clicks: the exact target must be visible,
  enabled, scrolled into view, and pass Playwright's trial click before the real
  click is issued.
- Clicks are humanized: the point is drawn at random from the central 60% of the
  target box, the pointer moves there in 6–18 steps, the bot hesitates 80–320 ms, and
  the button is held for 40–140 ms. The trial click uses the same point, so a target
  covered at that spot still fails before the real click. `clickVerified` accepts
  `humanize: false` for tests and for controls that must be hit dead center.
- One bot loop owns one browser context and one page. Trade scanning and card
  locking cannot run concurrently. A crashed context is closed and recreated from
  saved storage state.
