FROM node:20-bookworm-slim

WORKDIR /opt/baryga-manga
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN test -f /opt/baryga-manga/dist/index.js && test -f /opt/baryga-manga/dist/web/index.html
RUN npm prune --omit=dev
ARG INSTALL_PLAYWRIGHT=true
RUN if [ "$INSTALL_PLAYWRIGHT" = "true" ]; then node node_modules/playwright/cli.js install --with-deps chromium; fi

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV AUTO_START_BOT=true
ENV DATABASE_PATH=/app/data/baryga-manga.sqlite
ENV MANGABUFF_STORAGE_STATE_PATH=/app/data/mangabuff.json

RUN mkdir -p /app/data && chmod 777 /app/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "/opt/baryga-manga/dist/index.js", "serve"]
