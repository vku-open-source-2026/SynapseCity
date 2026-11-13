# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
#
# Build from the workspace root because the Rust backend depends on the
# sibling SynapseOne Rust SDK:
#   docker build -f SynapseCity/apps/contribution-service/Dockerfile \
#     -t synapsecity-contribution-service:latest .
FROM rust:1.100-bookworm AS builder
WORKDIR /build
COPY SynapseOne/sdks/sdk-rust ./SynapseOne/sdks/sdk-rust
COPY SynapseCity/apps/contribution-service ./SynapseCity/apps/contribution-service
WORKDIR /build/SynapseCity/apps/contribution-service
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home app
COPY --from=builder \
    /build/SynapseCity/apps/contribution-service/target/release/contribution-backend \
    /usr/local/bin/contribution-backend
COPY SynapseCity/LICENSE /usr/share/doc/contribution-backend/LICENSE
COPY SynapseCity/apps/contribution-service/README.md /usr/share/doc/contribution-backend/README.md
COPY SynapseOne/sdks/sdk-rust/LICENSE /usr/share/doc/contribution-backend/SYNAPSEONE-SDK-LICENSE
COPY SynapseOne/sdks/sdk-rust/NOTICE /usr/share/doc/contribution-backend/SYNAPSEONE-SDK-NOTICE
ENV BIND_ADDR=0.0.0.0:8000
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["/usr/local/bin/contribution-backend", "--healthcheck"]
USER app
ENTRYPOINT ["/usr/local/bin/contribution-backend"]
