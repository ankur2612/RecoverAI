# Build stage — compile TypeScript to dist/
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/
RUN npm ci

COPY packages/backend ./packages/backend
RUN npm run build --workspace @recoverai/backend

# Runtime stage — production dependencies only
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/packages/backend/dist ./packages/backend/dist
# Migrations are .sql assets, not compiled output, so copy them explicitly.
COPY packages/backend/src/db/migrations ./packages/backend/dist/db/migrations

# Run unprivileged: the node image ships a non-root `node` user.
USER node

EXPOSE 8080
CMD ["node", "packages/backend/dist/index.js"]
