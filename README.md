# MangaBaryga

## Deploy

This app is not a static Vite site. It must run the Node server from `dist/index.js`,
which also serves the built React UI from `dist/web`.

Use the Dockerfile when the hosting platform supports it. Otherwise set:

- Build command: `npm ci && npm run build`
- Start command: `npm start`
- Health check path: `/health`

Do not use a generated wrapper such as `node /app/http-wrapper.js`, and do not start
the app before the build command has created `dist/index.js`.

## Browser workflow

The Mangabuff worker uses Playwright for the whole site workflow. It keeps one browser
session open and behaves like the normal UI flow:

1. Open the `Предложения` index and collect visible trade IDs.
2. Compare them with the local SQLite history and open only new or retryable trades.
3. Open the trade, click the requested card, then click `Хотят получить`.
4. Read the visible pagination, recognize ranks from images loaded by the page, and
   apply the existing accept/drop rules.
5. Return to the offers index before processing the next trade.

Acceptance and card locking are also done with visible page buttons. The production
worker does not call Mangabuff endpoints through Node `fetch`, `request.get`, or a
hand-built form POST.

The offers index is the canonical signal source. A numeric ID is new only when it is
visible there and `INSERT OR IGNORE` creates a local SQLite row. The notification page is not polled,
because opening it can change unread state and it is less reliable than the complete
offers list. The worker opens at most five due details per pass, waits 10–15 seconds
between them, and cools unchanged details down for 24 hours. `discovered_at` means
“first observed locally”, not “sent by MangaBuff”.

The same single page visits `/feed` every 3 minutes, the home page every 10 minutes,
and `/manga` every 20 minutes. Away-navigation is limited to 8 per minute and 80 per
hour; refresh polling of an already open `/trades` index remains on the configured
5–15 second cadence.

The browser needs more memory than the old HTTP worker. Use at least 512 MB; 1 GB is
recommended for the server, Chromium, SQLite, and the control panel together.

## Browser authentication

Log in locally and save Playwright storage state:

Local machine:

```sh
npm run auth
npm run check-auth
```

Then copy `playwright/.auth/mangabuff.json` to the host path used by
`MANGABUFF_STORAGE_STATE_PATH`.

Recommended host environment:

- `MANGABUFF_STORAGE_STATE_PATH=/app/data/mangabuff.json`
- `DATABASE_PATH=/app/data/baryga-manga.sqlite`
- `AUTO_START_BOT=true` if the bot should start with the server
- `MANGABUFF_LOGIN=...` and `MANGABUFF_PASSWORD=...` so the host can refresh an expired Mangabuff session through the login page
- `MANGABUFF_PROXY_URL=socks5://user:pass@proxy-host:proxy-port` if this bot should use its own proxy/IP
- `MANGABUFF_AUTO_LOGIN_INTERVAL_HOURS=20` to refresh the saved session periodically
- `MANGA_TELEGRAM_BOT_TOKEN=...` (or `TELEGRAM_BOT_TOKEN` on hosts where that name is editable)
- `TELEGRAM_CHAT_ID=...`

Automatic re-login uses the browser login form:

```sh
MANGABUFF_LOGIN="email@example.com" \
MANGABUFF_PASSWORD="password" \
MANGABUFF_STORAGE_STATE_PATH=/app/data/mangabuff.json \
npm run auth:auto
```

For a long-running server, set `MANGABUFF_AUTO_LOGIN_INTERVAL_HOURS=20` with
`MANGABUFF_LOGIN` and `MANGABUFF_PASSWORD`. The server opens `/login`, fills the
visible fields, submits the form, verifies `/trades`, and saves refreshed storage
state. `npm run check-auth`, `/api/auth/status`, bot startup, trade processing, and
card locking all use Chromium.

The Docker image installs Playwright Chromium by default. Set
`--build-arg INSTALL_PLAYWRIGHT=false` only for a web-panel-only image that will never
run the bot.

## Vercel web panel

Vercel can host the React/Vite web panel as a static frontend. The bot API still needs
to run on a separate long-running Node host because it uses SQLite, Playwright, and a
background loop.

In Vercel, use the included `vercel.json`:

- Build command: `npm run build:web`
- Output directory: `dist/web`
- Environment variable: `VITE_API_BASE_URL=https://your-api-host.example.com`

On the Node API host, set:

- `WEB_ORIGIN=https://your-vercel-project.vercel.app`
- `HOST=0.0.0.0`
- `PORT=3000` or the port required by the host

`WEB_ORIGIN` may contain multiple allowed frontend origins separated by commas.

If the API host supports Docker, deploy this repo with the included `Dockerfile`.

## Bothost checklist

`http://127.0.0.1:3017` is only the server running on the current computer. Stopping or
starting the bot there does not control the Bothost process. To keep the bot alive when
the local computer is off, open the Bothost app URL and make sure that app runs the Node
server with `AUTO_START_BOT=true`.

The host also needs its own Mangabuff session. Upload the local
`data/mangabuff.json`/`playwright/.auth/mangabuff.json` to the host path from
`MANGABUFF_STORAGE_STATE_PATH`, or set `MANGABUFF_LOGIN` and `MANGABUFF_PASSWORD` and
run `npm run auth:auto` on the host once. If the session expires later, the server will
try to refresh it and restart the bot automatically when those credentials are present.

If the web panel is deployed separately as a static Vite/Vercel site, build it with
`VITE_API_BASE_URL` pointing to the Bothost API URL, not to `127.0.0.1`.

## Bothost пошаговый запуск

1. Открой `https://bothost.ru/dashboard.php` и создай новое приложение/бота.
2. Если в панели есть режим Docker, выбери Docker и загрузи этот репозиторий целиком.
   В проекте уже есть `Dockerfile`, он собирает сервер и веб-панель.
3. Если Docker-режима нет, выбери Node.js и укажи команды:

   ```sh
   npm ci && npm run build
   npm start
   ```

4. В переменных окружения Bothost укажи:

   ```env
   HOST=0.0.0.0
   PORT=3000
   NODE_ENV=production
   AUTO_START_BOT=true
   DATABASE_PATH=/app/data/baryga-manga.sqlite
   MANGABUFF_STORAGE_STATE_PATH=/app/data/mangabuff.json
   MANGABUFF_LOGIN=your_mangabuff_login
   MANGABUFF_PASSWORD=your_mangabuff_password
   MANGABUFF_PROXY_URL=socks5://user:pass@proxy-host:proxy-port
   MANGABUFF_AUTO_LOGIN_INTERVAL_HOURS=20
   MANGA_TELEGRAM_BOT_TOKEN=your_telegram_bot_token
   TELEGRAM_CHAT_ID=your_telegram_chat_id
   SAFE_MODE=false
   AUTO_ACCEPT_ENABLED=true
   ```

   Если запускаешь не через Docker и Bothost не даёт доступ к `/app/data`, замени
   `DATABASE_PATH` на `data/baryga-manga.sqlite`, а `MANGABUFF_STORAGE_STATE_PATH` на
   `data/mangabuff.json`.

   `SAFE_MODE=false` и `AUTO_ACCEPT_ENABLED=true` включают автоматическое принятие
   подходящих обменов через переменные окружения. Если их не указывать, режим берётся из
   сохранённых настроек веб-панели.

5. Запусти или перезапусти приложение в Bothost.
6. Открой публичный URL приложения из Bothost. Это и будет веб-версия панели. Не используй
   `http://127.0.0.1:3017` для Bothost: этот адрес относится только к локальному компьютеру.
7. Проверь `/health` на публичном адресе приложения. Если приложение доступно, endpoint
   должен отвечать без ошибки.
8. В панели проверь статус Mangabuff-авторизации и Telegram. Если Mangabuff-сессия не
   подтянулась, сервер попробует выполнить автологин по `MANGABUFF_LOGIN` и
   `MANGABUFF_PASSWORD`.

После этого бот должен стартовать сам при запуске Bothost-приложения и продолжать работать,
когда локальный компьютер выключен.

## Proxy per bot

If you want different bots to use different IPs, run them as separate Bothost apps and assign a separate `MANGABUFF_PROXY_URL` to each one.

Each bot should still keep its own:

- `DATABASE_PATH`
- `MANGABUFF_STORAGE_STATE_PATH`
- `MANGABUFF_LOGIN`
- `MANGABUFF_PASSWORD`
- `MANGA_TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

`MANGABUFF_PROXY_URL` is used by Playwright browser sessions. Supported formats are
`http://...`, `https://...`, and `socks5://...`.
