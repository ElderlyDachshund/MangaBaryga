FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN test -f dist/index.js && test -f dist/web/index.html

FROM node:20-bookworm-slim AS runtime

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev
RUN node node_modules/playwright/cli.js install --with-deps --only-shell chromium

COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV AUTO_START_BOT=false
ENV DATABASE_PATH=/app/data/baryga-manga.sqlite
ENV MANGABUFF_STORAGE_STATE_PATH=/app/data/mangabuff.json

RUN mkdir -p /app/data && chmod 777 /app/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js", "serve"]
