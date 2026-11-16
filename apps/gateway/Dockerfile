# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM rust:1-bookworm AS builder
WORKDIR /workspace
COPY SynapseCity/apps/gateway/Cargo.toml SynapseCity/apps/gateway/Cargo.lock ./
COPY SynapseCity/apps/gateway/src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home app

COPY --from=builder /workspace/target/release/synapsecity-gateway /usr/local/bin/synapsecity-gateway

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
