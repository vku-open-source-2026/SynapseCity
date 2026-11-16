# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM node:26-bookworm-slim AS build
WORKDIR /workspace
COPY SynapseCity/package*.json ./SynapseCity/
COPY SynapseCity/vendor ./SynapseCity/vendor
COPY SynapseCity/scripts ./SynapseCity/scripts
COPY SynapseCity/apps/city-service/package*.json SynapseCity/apps/city-service/tsconfig.json ./SynapseCity/apps/city-service/
COPY SynapseCity/apps/city-service/src ./SynapseCity/apps/city-service/src
RUN cd SynapseCity && npm ci && npm run check:release && npm run build --workspace=@synapsecity/city-service

FROM node:26-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/SynapseCity/package*.json ./
COPY --from=build /workspace/SynapseCity/node_modules ./node_modules
COPY --from=build /workspace/SynapseCity/apps/city-service/dist ./apps/city-service/dist
COPY --from=build /workspace/SynapseCity/apps/city-service/package.json ./apps/city-service/
EXPOSE 8083
CMD ["node", "apps/city-service/dist/src/server.js"]
