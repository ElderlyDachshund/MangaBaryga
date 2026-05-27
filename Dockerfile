FROM node:22-bookworm

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci
RUN npx playwright install --with-deps chromium

COPY . .
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV AUTO_START_BOT=false
ENV DATABASE_PATH=/app/data/baryga-manga.sqlite
ENV MANGABUFF_STORAGE_STATE_PATH=/app/data/mangabuff.json

RUN mkdir -p /app/data && chmod 777 /app/data

EXPOSE 3000

CMD ["node", "dist/index.js", "serve"]
