# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM node:20-bookworm-slim AS build
WORKDIR /workspace
COPY SynapseDX/sdks/capabilities-js/package*.json ./SynapseDX/sdks/capabilities-js/
COPY SynapseDX/sdks/capabilities-js/tsconfig.json ./SynapseDX/sdks/capabilities-js/
COPY SynapseDX/sdks/capabilities-js/src ./SynapseDX/sdks/capabilities-js/src
RUN cd SynapseDX/sdks/capabilities-js && npm ci && npm run build
COPY SynapseCity/package*.json ./SynapseCity/
COPY SynapseCity/apps/city-service/package*.json SynapseCity/apps/city-service/tsconfig.json ./SynapseCity/apps/city-service/
COPY SynapseCity/apps/city-service/src ./SynapseCity/apps/city-service/src
RUN cd SynapseCity && npm ci && npm run build --workspace=@synapsecity/city-service
FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/SynapseCity/package*.json ./
COPY --from=build /workspace/SynapseCity/node_modules ./node_modules
RUN rm -f /app/node_modules/@synapsedx/capabilities
COPY --from=build /workspace/SynapseDX/sdks/capabilities-js ./node_modules/@synapsedx/capabilities
COPY --from=build /workspace/SynapseCity/apps/city-service/dist ./apps/city-service/dist
COPY --from=build /workspace/SynapseCity/apps/city-service/package.json ./apps/city-service/
EXPOSE 8083
CMD ["node", "apps/city-service/dist/src/server.js"]
