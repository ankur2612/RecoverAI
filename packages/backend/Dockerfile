# Build stage — compile TypeScript to dist/
FROM node:22-alpine AS build
WORKDIR /app

# Both workspace manifests: npm ci validates the lockfile against every
# workspace it records, and errors if one is missing.
COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/
# Install the BACKEND workspace only (with its devDependencies — tsc and the
# @types packages are required to compile) and skip the frontend's toolchain.
RUN npm ci --workspace @recoverai/backend --include-workspace-root

COPY packages/backend ./packages/backend
RUN npm run build --workspace @recoverai/backend

# Runtime stage — production dependencies only
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/
RUN npm ci --workspace @recoverai/backend --include-workspace-root --omit=dev && npm cache clean --force

# The build stage's `npm run build` already copies the .sql migrations into
# dist/db/migrations, so this single COPY carries both the compiled runner and
# its migration assets.
COPY --from=build /app/packages/backend/dist ./packages/backend/dist

# Run unprivileged: the node image ships a non-root `node` user.
USER node

EXPOSE 8080
# Apply pending migrations, ensure demo data, then start the API. `&&`
# short-circuits: if the migration runner exits non-zero the server never
# starts, so the container fails loudly instead of serving traffic against a
# missing schema.
#
# The demo step is a no-op unless DEMO_MODE=true, and it exits 0 even on
# failure, so it can never block an ordinary deployment from starting.
CMD ["sh", "-c", "node packages/backend/dist/db/migrate.js && node packages/backend/dist/datasets/demo-cli.js && node packages/backend/dist/index.js"]
