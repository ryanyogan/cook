# Build context is the repository root (see wrangler.jsonc: image_build_context).
# Dockerfile.dockerignore next to this file limits what is sent.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
COPY fixtures/react_app/package.json fixtures/react_app/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY fixtures/react_app/tsconfig.json fixtures/react_app/vite.config.ts fixtures/react_app/playwright.config.ts ./
COPY fixtures/react_app/src ./src
COPY fixtures/react_app/e2e ./e2e

COPY spike/cloudflare/container/server.mjs /control/server.mjs

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
EXPOSE 8080
CMD ["node", "/control/server.mjs"]
