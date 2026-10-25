FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile

# Database settings and secrets are supplied only when the container starts.
# The Node server supplies public configuration to the dashboard at runtime.
RUN pnpm typecheck:source && pnpm build:web

ENV NODE_ENV=production
ENV PORT=3003
EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3003) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "--import", "tsx", "scripts/runner-server.ts"]
