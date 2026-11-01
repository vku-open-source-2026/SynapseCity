FROM node:20-bookworm-slim AS build
WORKDIR /workspace
COPY SynapseDX/sdk-js/package*.json ./SynapseDX/sdk-js/
COPY SynapseDX/sdk-js/tsconfig.json ./SynapseDX/sdk-js/
COPY SynapseDX/sdk-js/src ./SynapseDX/sdk-js/src
RUN cd SynapseDX/sdk-js && npm ci && npm run build
COPY SynapseCity/package*.json ./SynapseCity/
COPY SynapseCity/tsconfig.json ./SynapseCity/
COPY SynapseCity/src ./SynapseCity/src
RUN cd SynapseCity && npm ci && npm run build

FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/SynapseCity/package*.json ./
COPY --from=build /workspace/SynapseCity/node_modules ./node_modules
COPY --from=build /workspace/SynapseCity/dist ./dist
EXPOSE 8083
CMD ["node", "dist/src/server.js"]
