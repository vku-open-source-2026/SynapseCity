# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM node:22-alpine AS build

WORKDIR /app/apps/console

COPY apps/console/package*.json ./
RUN npm ci

COPY apps/console ./
COPY scripts/copy-notices.mjs /app/scripts/copy-notices.mjs
COPY LICENSE NOTICE THIRD-PARTY.md /app/
COPY licenses /app/licenses

ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=${SOURCE_COMMIT}
RUN npm run build

FROM nginx:1.27-alpine
ARG SOURCE_COMMIT
LABEL org.opencontainers.image.title="SynapseCity console" \
      org.opencontainers.image.source="https://github.com/vku-open-source-2026/SynapseCity" \
      org.opencontainers.image.revision=${SOURCE_COMMIT}

COPY ./apps/console/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/console/dist /usr/share/nginx/html
COPY LICENSE NOTICE THIRD-PARTY.md /usr/share/doc/synapsecity-console/
COPY licenses /usr/share/doc/synapsecity-console/licenses
RUN test -n "${SOURCE_COMMIT}" \
    && sed -i "s/SOURCE_COMMIT/${SOURCE_COMMIT}/g" /usr/share/doc/synapsecity-console/licenses/SOURCE-OFFER.md \
    && cp /usr/share/doc/synapsecity-console/licenses/SOURCE-OFFER.md /usr/share/doc/synapsecity-console/SOURCE-OFFER.txt \
    && if [ -f /usr/share/doc/synapsecity-console/licenses/THIRD-PARTY-NOTICES.generated.txt ]; then \
         cp /usr/share/doc/synapsecity-console/licenses/THIRD-PARTY-NOTICES.generated.txt /usr/share/doc/synapsecity-console/licenses/THIRD-PARTY-NOTICES.txt; \
       fi

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
