# Browser workflows

## Incoming trades

The worker keeps one Playwright context alive for the bot loop.

1. Open `Предложения`.
2. Verify that the active tab is `Предложения`, then read visible numeric
   `/trades/{id}` links from the rendered page and its pagination.
3. Insert unseen IDs into SQLite with `status = новое`. This insert, rather than a
   notification badge, is the incoming-trade signal.
4. Update `last_seen_at` for old visible IDs without reopening their detail pages.
5. Open at most five due detail URLs per pass. A detail that has not changed is
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
   - return to `Предложения`.
7. In auto mode, record the attempt, reopen the trade, click `Принять обмен`, click
   the confirmation dialog, and write `принят` only after the page contains
   `Обмен принят`. Missing confirmation or final status becomes
   `ошибка_проверки`. Safe mode never clicks acceptance.

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
  trade IDs and are scheduled for 3, 10, and 20 minute intervals respectively.
- Sitemap and JSON/API routes are not used for authenticated bot actions, because
  the required workflow is browser-only.
- Direct detail navigation is only a fallback when a visible link is missing after
  a page refresh. Reads and mutations still happen inside Playwright.

## Operational limits

- `MANGABUFF_TRADE_LIST_MAX_PAGES` caps offers pagination.
- `MANGABUFF_TRADE_PAUSE_MIN_MS` and `MANGABUFF_TRADE_PAUSE_MAX_MS` control the
  pause between processed trades; defaults are 10 and 15 seconds.
- `loopPauseMs` controls the minimum pause between offers-index passes and must be
  between 5 and 15 seconds (10 seconds by default). Up to 20% positive jitter is
  added to spread load; the configured minimum is never shortened.
- At most five new/due trade detail URLs are opened per pass.
- Navigations away from an already open canonical `/trades` index are serialized
  through rolling limits of 8 per minute and 80 per hour. Refresh polling of the
  already open index does not consume this away-navigation budget.
- A `429` navigation response pauses all subsequent Mangabuff navigation for the
  server-provided `Retry-After` duration, or 60 seconds when absent. `502`, `503`,
  and `504` use the same header or a 15-second fallback.
- CAPTCHA, browser-security challenges, rate-limit pages, and access-denied pages
  stop the bot loop and require manual inspection. They are not clicked through.
- UI mutations use actionability-checked clicks: the exact target must be visible,
  enabled, scrolled into view, and pass Playwright's trial click before the real
  click is issued.
- One bot loop owns one browser context and one page. Trade scanning and card
  locking cannot run concurrently. A crashed context is closed and recreated from
  saved storage state.
