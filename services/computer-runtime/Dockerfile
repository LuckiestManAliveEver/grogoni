FROM mcr.microsoft.com/playwright:v1.61.1-noble AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY services/computer-runtime/package.json services/computer-runtime/package.json
ENV HUSKY=0 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN pnpm install --frozen-lockfile --filter @grogoni/computer-runtime...
COPY packages/shared-types/ packages/shared-types/
COPY services/computer-runtime/ services/computer-runtime/
RUN pnpm --filter @grogoni/shared-types build \
    && pnpm --filter @grogoni/computer-runtime build \
    && pnpm --filter @grogoni/computer-runtime deploy --legacy --prod /runtime

FROM mcr.microsoft.com/playwright:v1.61.1-noble
WORKDIR /app
COPY --from=build --chown=pwuser:pwuser /runtime/ ./
ENV NODE_ENV=production PORT=8790
USER pwuser
EXPOSE 8790
CMD ["node", "dist/server.js"]
