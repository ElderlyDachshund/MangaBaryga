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
- `TELEGRAM_BOT_TOKEN=...`
- `TELEGRAM_CHAT_ID=...`

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
