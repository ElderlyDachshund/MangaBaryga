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
