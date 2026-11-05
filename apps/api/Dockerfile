# Free Me API. Build from the repository root:
#   docker build -f apps/api/Dockerfile --target runtime -t freeme/api .
#   docker build -f apps/api/Dockerfile --target migrate -t freeme/api-migrate .
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --ignore-scripts
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npx prisma generate && npm run build -w @free-me/shared && npm run build -w @free-me/api && npm prune --omit=dev --ignore-scripts

# One-off job before starting new API containers: applies migrations, then upserts reference data (idempotent).
#   docker run --rm --env-file api.env freeme/api-migrate
FROM node:22-bookworm-slim AS migrate
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY prisma ./prisma
RUN echo '{"private":true}' > package.json && npm install --no-save --ignore-scripts prisma@6.19.3 @prisma/client@6.19.3 tsx@4.21.0 && npx prisma generate --schema prisma/schema.prisma
CMD ["sh", "-c", "npx prisma migrate deploy --schema prisma/schema.prisma && node --import tsx prisma/seed.ts"]

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl tini && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=4000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/api/dist apps/api/dist
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --retries=4 CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/main.js"]
