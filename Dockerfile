FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY . .
RUN pnpm install --frozen-lockfile

# The database address and name are public browser settings, baked into the
# dashboard. Secrets are supplied only when the container starts.
ARG SPACETIME_URI
ARG SPACETIMEDB_DATABASE
ARG VITE_SYNC_RUNNER_URL=/feed
ENV SPACETIME_URI=$SPACETIME_URI
ENV SPACETIMEDB_DATABASE=$SPACETIMEDB_DATABASE
ENV VITE_SYNC_RUNNER_URL=$VITE_SYNC_RUNNER_URL
RUN pnpm typecheck:source && pnpm build:web

ENV NODE_ENV=production
EXPOSE 3003
CMD ["pnpm", "start:runner"]
