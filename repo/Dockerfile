FROM node:20-bookworm AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY tsconfig.json tsconfig.build.json drizzle.config.ts vitest.config.ts ./
COPY src ./src
COPY tests ./tests
COPY drizzle ./drizzle
COPY init_db.sh run_tests.sh ./
RUN npm run build

FROM deps AS test
WORKDIR /app
COPY tsconfig.json tsconfig.build.json drizzle.config.ts vitest.config.ts ./
COPY src ./src
COPY tests ./tests
COPY drizzle ./drizzle
COPY init_db.sh run_tests.sh ./
RUN chmod +x ./init_db.sh ./run_tests.sh

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY init_db.sh run_tests.sh ./
RUN chmod +x ./init_db.sh ./run_tests.sh

ENV NODE_ENV=production
ENV PORT=3000

CMD ["bash", "-lc", "./init_db.sh && node dist/app/server.js"]
