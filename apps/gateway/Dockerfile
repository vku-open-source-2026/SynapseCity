# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM rust:1-bookworm AS builder
WORKDIR /workspace
COPY apps/gateway/Cargo.toml apps/gateway/Cargo.lock ./
COPY apps/gateway/src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
ARG SOURCE_COMMIT
LABEL org.opencontainers.image.title="SynapseCity gateway" \
      org.opencontainers.image.source="https://github.com/vku-open-source-2026/SynapseCity" \
      org.opencontainers.image.revision=${SOURCE_COMMIT}
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home app

COPY --from=builder /workspace/target/release/synapsecity-gateway /usr/local/bin/synapsecity-gateway
COPY LICENSE NOTICE THIRD-PARTY.md /usr/share/doc/synapsecity-gateway/
COPY licenses /usr/share/doc/synapsecity-gateway/licenses
RUN test -n "${SOURCE_COMMIT}" \
    && sed -i "s/SOURCE_COMMIT/${SOURCE_COMMIT}/g" /usr/share/doc/synapsecity-gateway/licenses/SOURCE-OFFER.md \
    && cp /usr/share/doc/synapsecity-gateway/licenses/SOURCE-OFFER.md /usr/share/doc/synapsecity-gateway/SOURCE-OFFER.txt \
    && if [ -f /usr/share/doc/synapsecity-gateway/licenses/THIRD-PARTY-NOTICES.generated.txt ]; then \
         cp /usr/share/doc/synapsecity-gateway/licenses/THIRD-PARTY-NOTICES.generated.txt /usr/share/doc/synapsecity-gateway/licenses/THIRD-PARTY-NOTICES.txt; \
       fi

# Compatibility wrapper for node-based healthchecks if invoked
RUN printf '#!/bin/sh\nif [ "$1" = "-e" ]; then\n  exec /usr/local/bin/synapsecity-gateway --healthcheck\nfi\nexec /usr/local/bin/synapsecity-gateway "$@"\n' > /usr/local/bin/node \
    && chmod +x /usr/local/bin/node

ENV PORT=8080 \
    NODE_ENV=production

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/usr/local/bin/synapsecity-gateway", "--healthcheck"]

USER app
ENTRYPOINT ["/usr/local/bin/synapsecity-gateway"]
