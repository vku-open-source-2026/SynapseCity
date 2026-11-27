FROM node:20-alpine AS build

WORKDIR /app/apps/contribution-console

COPY apps/contribution-console/package*.json ./
RUN npm ci

COPY apps/contribution-console ./
COPY scripts/copy-notices.mjs /app/scripts/copy-notices.mjs
COPY LICENSE NOTICE THIRD-PARTY.md /app/
COPY licenses /app/licenses

ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=${SOURCE_COMMIT}
RUN npm run build

FROM node:20-alpine AS runtime
ARG SOURCE_COMMIT
LABEL org.opencontainers.image.title="SynapseCity contribution console" \
      org.opencontainers.image.source="https://github.com/vku-open-source-2026/SynapseCity" \
      org.opencontainers.image.revision=${SOURCE_COMMIT}
RUN npm install -g serve
WORKDIR /app
COPY --from=build /app/apps/contribution-console/dist ./dist
COPY LICENSE NOTICE THIRD-PARTY.md /usr/share/doc/synapsecity-contribution-console/
COPY licenses /usr/share/doc/synapsecity-contribution-console/licenses
RUN test -n "${SOURCE_COMMIT}" \
    && sed -i "s/SOURCE_COMMIT/${SOURCE_COMMIT}/g" /usr/share/doc/synapsecity-contribution-console/licenses/SOURCE-OFFER.md \
    && cp /usr/share/doc/synapsecity-contribution-console/licenses/SOURCE-OFFER.md /usr/share/doc/synapsecity-contribution-console/SOURCE-OFFER.txt \
    && if [ -f /usr/share/doc/synapsecity-contribution-console/licenses/THIRD-PARTY-NOTICES.generated.txt ]; then \
         cp /usr/share/doc/synapsecity-contribution-console/licenses/THIRD-PARTY-NOTICES.generated.txt /usr/share/doc/synapsecity-contribution-console/licenses/THIRD-PARTY-NOTICES.txt; \
       fi

EXPOSE 5173

CMD ["serve", "-s", "dist", "-l", "5173"]
