# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM rust:1.100-bookworm AS builder
ARG CARGO_BUILD_JOBS=1
WORKDIR /app
COPY SynapseCity/apps/city-service/Cargo.toml SynapseCity/apps/city-service/Cargo.lock ./
COPY SynapseCity/apps/city-service/src ./src
RUN cargo build --release --locked --jobs=${CARGO_BUILD_JOBS}

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home app
COPY --from=builder /app/target/release/synapsecity-city /usr/local/bin/synapsecity-city
ENV PORT=8083
EXPOSE 8083
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/usr/local/bin/synapsecity-city", "--healthcheck"]
USER app
ENTRYPOINT ["/usr/local/bin/synapsecity-city"]
