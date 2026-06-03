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

## Low-memory host auth

The normal bot loop uses the saved Mangabuff cookies through HTTP and does not keep
Chromium running. On a 256 MB host, do Mangabuff login outside the host and upload
the saved storage state file.

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
- `MANGABUFF_LOGIN=...` and `MANGABUFF_PASSWORD=...` so the host can refresh an expired Mangabuff session by itself
- `MANGABUFF_AUTO_LOGIN_INTERVAL_HOURS=20` to refresh the saved session periodically
- `MANGA_TELEGRAM_BOT_TOKEN=...` (or `TELEGRAM_BOT_TOKEN` on hosts where that name is editable)
- `TELEGRAM_CHAT_ID=...`

Automatic re-login is available over plain HTTP when Mangabuff login/password
auth is enough:

```sh
MANGABUFF_LOGIN="email@example.com" \
MANGABUFF_PASSWORD="password" \
MANGABUFF_STORAGE_STATE_PATH=/app/data/mangabuff.json \
npm run auth:auto
```

For a long-running server, set `MANGABUFF_AUTO_LOGIN_INTERVAL_HOURS=20` with
`MANGABUFF_LOGIN` and `MANGABUFF_PASSWORD`. The server will fetch `/login`, send
the AJAX login POST with the page CSRF token, verify `/trades`, and save a fresh
storage state file. If the login check fails, the saved session file is left
untouched.

Avoid using the panel's manual login flow on a 256 MB host. It needs Chromium and can
exceed the memory limit. `npm run check-auth`, `/api/auth/status`, and bot startup use
the lightweight HTTP check.

The Docker image skips Chromium by default for low-memory deployments. If you really
need browser-based login inside the container, build with
`--build-arg INSTALL_PLAYWRIGHT=true`.

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
