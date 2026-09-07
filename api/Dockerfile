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

# --omit=dev leaves out the compiler and the test runner. The prisma CLI is a
# runtime dependency, not a dev one, because migrations run on start: with it in
# devDependencies, `npx prisma` would silently fetch an unpinned copy from the
# network on every boot, and a machine with no registry egress would not start.
COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci --omit=dev && npm cache clean --force

# The generated client is copied rather than regenerated, so the runtime image is
# built from exactly what the build stage produced.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist

# Run unprivileged. The node image ships a `node` user for exactly this.
USER node

EXPOSE 3000

# Migrations run on start rather than in the build, because the build has no
# database to talk to. `migrate deploy` only applies committed migrations - it
# never generates or resets - and takes an advisory lock, so concurrent machines
# serialise rather than corrupt. Fly runs it once via release_command as well;
# this covers a machine that starts outside a deploy.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
