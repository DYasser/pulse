# Multi-stage: the toolchain and dev dependencies never reach the runtime image.
FROM node:22-alpine AS build

WORKDIR /app

# Copied first so a source-only change does not re-run npm ci.
COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci

COPY . .
RUN npx prisma generate && npm run build

# ---

FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# --omit=dev leaves out the compiler, the test runner and everything else that
# only mattered at build time.
COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci --omit=dev && npx prisma generate && npm cache clean --force

COPY --from=build /app/dist ./dist

# Run unprivileged. The node image ships a `node` user for exactly this.
USER node

EXPOSE 3000

# Migrations run on start rather than in the build, because the build has no
# database to talk to. `migrate deploy` only applies committed migrations - it
# never generates or resets, so it is safe to run on every boot.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
