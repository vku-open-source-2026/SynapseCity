# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM node:20-bookworm-slim AS build
WORKDIR /workspace
COPY SynapseCity/package*.json ./SynapseCity/
COPY SynapseCity/vendor ./SynapseCity/vendor
COPY SynapseCity/apps/gateway/package*.json SynapseCity/apps/gateway/tsconfig.json ./SynapseCity/apps/gateway/
COPY SynapseCity/apps/gateway/src ./SynapseCity/apps/gateway/src
RUN cd SynapseCity && npm ci && npm run build --workspace=@synapsecity/gateway
FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/SynapseCity/package*.json ./
COPY --from=build /workspace/SynapseCity/node_modules ./node_modules
COPY --from=build /workspace/SynapseCity/apps/gateway/dist ./apps/gateway/dist
COPY --from=build /workspace/SynapseCity/apps/gateway/package.json ./apps/gateway/
EXPOSE 8080
CMD ["node", "apps/gateway/dist/src/index.js"]
