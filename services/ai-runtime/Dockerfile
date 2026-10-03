FROM node:22-bookworm-slim AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libgomp1 cmake build-essential python3 git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY services/ai-runtime/package.json services/ai-runtime/package.json
ENV HUSKY=0
RUN pnpm install --frozen-lockfile --filter @grogoni/ai-runtime...
COPY packages/shared-types/ packages/shared-types/
COPY services/ai-runtime/ services/ai-runtime/
RUN pnpm --filter @grogoni/ai-runtime build \
    && pnpm --filter @grogoni/ai-runtime deploy --legacy --prod /runtime \
    && rm -rf /runtime/node_modules/.pnpm/@node-llama-cpp+linux-x64-cuda* \
              /runtime/node_modules/.pnpm/@node-llama-cpp+linux-x64-vulkan*

FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /runtime/ ./
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
