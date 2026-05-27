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
